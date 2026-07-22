/**
 * ADS1292R (EXG) preset APPLICATION — turn a chosen preset + resolution into the
 * two register banks and the enabled-sensors bitmap to write.
 *
 * Pure, transport-free port of the Java oracle's preset setters. Where EX1
 * (`presets.ts`) ships the reference register arrays and preset *detection*,
 * this module ships the *write* side: the resolution↔bitmap coupling, the
 * sampling-rate→data-rate coupling, and the sensor-conflict clearing that
 * desktop performs when a preset tile is clicked.
 *
 * Java oracle:
 *   - preset setters        : SensorEXG.setDefaultECGConfiguration (:1781),
 *     setDefaultEMGConfiguration (:1812), setEXGTestSignal (:1844),
 *     setDefaultRespirationConfiguration (:1871). Each calls clearExgConfig()
 *     then setExgChannelBitsPerMode(sensorId) then a series of named field
 *     writes then setDefaultExgCommon(samplingRate).
 *   - resolution↔bitmap     : SensorEXG.setExgChannelBitsPerMode (:2150-2183) +
 *     updateEnabledSensorsFromExgResolution (:2108-2148). Resolution is NOT a
 *     register field — it lives only in the sensor bitmap.
 *   - rate coupling         : SensorEXG.setDefaultExgCommon (:1999-2005) calls
 *     setExGRateFromFreq (:2784-2806), which rewrites REG1 data-rate on BOTH
 *     chips (setEXGRateSetting, :2468-2471) from the device sampling rate.
 *   - oscillator clock      : setDefaultExgCommon sets CHIP1 REG2 oscillator-
 *     clock-connection ON when the chip clocks are joined
 *     (ShimmerVerObject.isSupportedExgChipClocksJoined, :712-723).
 *   - conflict clearing     : ShimmerDevice.sensorMapConflictCheckandCorrect
 *     (:2497-2512) disables every sensor in a sensor's conflict list; EXG's
 *     conflict list is SensorEXG.sDRefEcg etc. (:332-344).
 */

import { EXG_BANK_LENGTH, applyExgMustBeBits } from './registers.js';
import { EXG_PRESET_ARRAYS, type ExgResolution } from './presets.js';

/** HW_ID codes (ShimmerVerDetails.HW_ID) — matches infomem/layout.ts HW_ID. */
const HW_ID_SHIMMER_3R = 10;

// Sensor-bitmap resolution masks (ConfigByteLayoutShimmer3, == SensorBitmapShimmer3).
const MASK_EXG1_24BIT = 0x000010;
const MASK_EXG2_24BIT = 0x000008;
const MASK_EXG1_16BIT = 0x100000;
const MASK_EXG2_16BIT = 0x080000;
const MASK_ALL_EXG_RESOLUTION =
  MASK_EXG1_24BIT | MASK_EXG2_24BIT | MASK_EXG1_16BIT | MASK_EXG2_16BIT;

/**
 * Sensors that conflict with any EXG preset, as the Shimmer3 streaming
 * enabled-sensors bitmap masks (Configuration.Shimmer3.SensorBitmap). Ported
 * from the EXG SensorDetailsRef conflict lists (SensorEXG.java:332-344 ECG,
 * identical set for EMG/Test/Respiration): the internal ADC channels, GSR, the
 * resistance amp, and the bridge amp. The resistance amp shares the bridge-amp
 * bit on Shimmer3 (Configuration.java:643), so clearing SENSOR_BRIDGE_AMP
 * covers both.
 */
export const EXG_CONFLICTING_SENSORS: ReadonlyArray<{ mask: number; label: string }> =
  Object.freeze([
    { mask: 0x000004, label: 'GSR' }, // SENSOR_GSR (Configuration.java:630)
    { mask: 0x000400, label: 'Internal ADC A1' }, // SENSOR_INT_A1 (:636)
    { mask: 0x000200, label: 'Internal ADC A12' }, // SENSOR_INT_A12 (:637)
    { mask: 0x000100, label: 'Internal ADC A13' }, // SENSOR_INT_A13 (:638)
    { mask: 0x800000, label: 'Internal ADC A14' }, // SENSOR_INT_A14 (:639)
    { mask: 0x008000, label: 'Bridge/Resistance Amp' }, // SENSOR_BRIDGE_AMP (:643)
  ]);

/**
 * Report which currently-enabled sensors conflict with turning on EXG. Ported
 * from ShimmerDevice.sensorMapConflictCheckandCorrect (ShimmerDevice.java:2497)
 * reading the EXG conflict list — desktop *disables* these when an EXG tile is
 * clicked, so {@link applyExgPreset} clears them from the returned bitmap and
 * the UI can warn "disables: …" ahead of the write.
 */
export function exgConflictingSensors(
  enabledSensors: number,
): Array<{ mask: number; label: string }> {
  const es = enabledSensors >>> 0;
  return EXG_CONFLICTING_SENSORS.filter((c) => (es & c.mask) !== 0);
}

/**
 * Map a device sampling rate (Hz) to the ADS1292R REG1 data-rate setting (0-6).
 * Byte-for-byte port of SensorEXG.setExGRateFromFreq (SensorEXG.java:2784-2806),
 * including the >8 kHz → 500 Hz fallback. NB the thresholds are `<=` here,
 * distinct from the Shimmer3R live-BT oversampling helper
 * `getOversamplingRatioADS1292R` (calibration.ts:89) which uses strict `<` and
 * so differs at the exact boundary rates — that helper is the live-BT streaming
 * path and is deliberately NOT used for the docked InfoMem write, which mirrors
 * the desktop config-generation path (this function).
 */
export function exgRateSettingFromFreq(freq: number): number {
  if (freq <= 125) return 0; // 125 Hz
  if (freq <= 250) return 1; // 250 Hz
  if (freq <= 500) return 2; // 500 Hz
  if (freq <= 1000) return 3; // 1000 Hz
  if (freq <= 2000) return 4; // 2000 Hz
  if (freq <= 4000) return 5; // 4000 Hz
  if (freq <= 8000) return 6; // 8000 Hz
  return 2; // > 8 kHz → 500 Hz (SensorEXG.java:2801-2802)
}

/** Whether the two ADS1292R chip clocks are joined for this hardware. */
function isExgChipClocksJoined(hardwareVersion: number | undefined): boolean {
  // ShimmerVerObject.isSupportedExgChipClocksJoined (:712-723): true for
  // Shimmer3R with the EXG-unified board (the only EXG board on 3R), and for
  // Shimmer4-SDK / Shimmer3 EXG-unified rev>=4. Only the 3R case is determinable
  // from the hardware version alone (no expansion-board rev in the docked
  // context), so classic Shimmer3 preserves whatever bit the device already had
  // (see applyExgPreset) rather than forcing it off.
  return hardwareVersion === HW_ID_SHIMMER_3R;
}

/** Byte0 REG1 data-rate field is the low 3 bits. */
const REG1_DATA_RATE_MASK = 0x07;
/** Byte1 REG2 oscillator-clock-connection is bit 3. */
const REG2_OSC_CLOCK_BIT = 0x08;

/** Inputs {@link applyExgPreset} needs from the current device configuration. */
export interface ExgApplyInput {
  /** Current EXG1 (chip-1) register bank — 10 bytes. */
  exg1: Uint8Array;
  /** Current EXG2 (chip-2) register bank — 10 bytes. */
  exg2: Uint8Array;
  /** Current enabled-sensors bitmap (Shimmer3 streaming bitmap). */
  enabledSensors: number;
  /**
   * Device sampling rate in Hz. When a sampling-rate edit is also pending in the
   * same batch, pass the EDITED rate so the preset's data-rate bits match the
   * rate the device will actually run at.
   */
  samplingRateHz: number;
  /** HW_ID (3 = Shimmer3, 10 = Shimmer3R). Drives the joined-clock bit. */
  hardwareVersion?: number;
}

/** The banks + bitmap {@link applyExgPreset} produces, ready to fold into a config. */
export interface ExgApplyResult {
  /** New EXG1 register bank (10 bytes). */
  exg1: Uint8Array;
  /** New EXG2 register bank (10 bytes). */
  exg2: Uint8Array;
  /** New enabled-sensors bitmap (resolution flags set, conflicts cleared). */
  enabledSensors: number;
}

/** A preset that can be *applied* (written). 'custom' is detect-only; 'off' clears EXG. */
export type ApplicableExgPreset = 'ecg' | 'emg' | 'test-signal' | 'respiration' | 'off';

/**
 * Clear the four EXG resolution flags (the bits that enable the ADS1292R chips
 * in the Shimmer3 streaming bitmap) from an enabled-sensors mask, leaving every
 * non-EXG sensor untouched. This is how the Java driver DISABLES EXG live: it
 * never pushes zeroed register banks to the chip — the ADS1292R forces the
 * must-be bits (CONFIG2 bit7=1 etc., ExGConfigBytesDetails.java:507-525) so an
 * all-zero write would fail read-back — it simply drops the EXG bits from the
 * enabled-sensors bitmap and re-writes that (writeEnabledSensors is "always the
 * last command", ShimmerBluetooth.java:2732,2735; readEXGConfigurations /
 * writeEXGConfiguration only run while EXG stays enabled, :2670,4010-4014). The
 * live `applyExgPresetLive('off')` path uses this instead of {@link applyExgPreset}
 * so it never writes — nor read-back-verifies — a zeroed bank. See the docked-vs-
 * live asymmetry note on {@link applyExgPreset} step (2).
 */
export function clearExgResolutionFlags(enabledSensors: number): number {
  return ((enabledSensors >>> 0) & ~MASK_ALL_EXG_RESOLUTION) >>> 0;
}

/**
 * Apply an EXG preset + resolution to a device configuration, returning the two
 * register banks and the updated enabled-sensors bitmap to write. Pure — does
 * not mutate the input.
 *
 * Ports the Java preset setters (SensorEXG.setDefault*) as a whole:
 *  1. Clears the four EXG resolution flags (clearExgConfig →
 *     setExgChannelBitsPerMode(-1) resets them, :2150-2154).
 *  2. For 'off', returns zeroed banks with no EXG flags set.
 *  3. Clears conflicting sensors from the bitmap
 *     (sensorMapConflictCheckandCorrect, ShimmerDevice.java:2497-2512).
 *  4. Sets the resolution flags for the chips this preset uses — EMG is chip-1
 *     only, every other preset is both chips (setExgChannelBitsPerMode,
 *     :2162-2182). Respiration is NOT forced to 24-bit: it honours the chosen
 *     resolution on both chips, exactly like ECG.
 *  5. Takes the preset register arrays (identical for 16- and 24-bit — the
 *     resolution lives only in the bitmap, see step 4).
 *  6. Rewrites REG1 data-rate on both chips from {@link ExgApplyInput.samplingRateHz}
 *     (setDefaultExgCommon → setExGRateFromFreq, :2003 / :2784).
 *  7. Sets the CHIP1 oscillator-clock-connection bit when the hardware joins the
 *     chip clocks (:2000-2002); otherwise preserves the device's existing bit.
 *  8. Re-applies the mandatory must-be bits.
 *
 * @throws RangeError when either input bank is not exactly 10 bytes.
 */
export function applyExgPreset(
  input: ExgApplyInput,
  preset: ApplicableExgPreset,
  resolution: ExgResolution,
): ExgApplyResult {
  if (input.exg1.length !== EXG_BANK_LENGTH || input.exg2.length !== EXG_BANK_LENGTH) {
    throw new RangeError(
      `EXG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ${input.exg1.length}/${input.exg2.length}.`,
    );
  }

  // (1) Clear all four resolution flags — clean slate for the new preset.
  let enabledSensors = (input.enabledSensors >>> 0) & ~MASK_ALL_EXG_RESOLUTION;

  // (2) 'off' — no EXG chips enabled; zero the banks so the read-back summary
  // reads 'off' rather than a stale preset.
  //
  // DOCKED vs LIVE ASYMMETRY. This function is the DOCKED (InfoMem) path: InfoMem
  // is passive storage with no chip enforcement, so zeroed banks are fine and are
  // in fact what EX1's detectExgPreset keys 'off' off (all-zero banks + no
  // resolution flags → 'off', presets.ts). Keeping the zeroed banks here preserves
  // that detection contract on the docked read-back.
  //
  // The LIVE (over-the-radio) path must NOT reuse this: the ADS1292R forces its
  // must-be bits on write (CONFIG2 bit7=1 etc., ExGConfigBytesDetails.java:507-525),
  // so a zeroed SET would read back non-zero and the read-back-verify would throw.
  // Java disables EXG live by clearing only the sensor bitmap, never by writing
  // zeroed registers (writeEnabledSensors is the disable path,
  // ShimmerBluetooth.java:2732,2735) — so `applyExgPresetLive('off')` calls
  // {@link clearExgResolutionFlags} and skips the register write entirely.
  if (preset === 'off') {
    return {
      exg1: new Uint8Array(EXG_BANK_LENGTH),
      exg2: new Uint8Array(EXG_BANK_LENGTH),
      enabledSensors: enabledSensors >>> 0,
    };
  }

  // (3) Clear conflicting sensors (desktop disables them on tile click).
  for (const c of EXG_CONFLICTING_SENSORS) enabledSensors &= ~c.mask;

  // (4) Resolution flags: EMG = chip 1 only; all others = both chips.
  const bothChips = preset !== 'emg';
  if (resolution === '24bit') {
    enabledSensors |= MASK_EXG1_24BIT;
    if (bothChips) enabledSensors |= MASK_EXG2_24BIT;
  } else {
    enabledSensors |= MASK_EXG1_16BIT;
    if (bothChips) enabledSensors |= MASK_EXG2_16BIT;
  }
  enabledSensors >>>= 0;

  // (5) Preset register arrays (same bytes for both resolutions).
  const ref = EXG_PRESET_ARRAYS[preset];
  const exg1 = Uint8Array.from(ref.exg1);
  const exg2 = Uint8Array.from(ref.exg2);

  // (6) Rewrite REG1 data-rate on both chips from the sampling rate.
  const rate = exgRateSettingFromFreq(input.samplingRateHz);
  exg1[0] = (exg1[0] & ~REG1_DATA_RATE_MASK) | rate;
  exg2[0] = (exg2[0] & ~REG1_DATA_RATE_MASK) | rate;

  // (7) Oscillator-clock-connection bit (CHIP1 only).
  if (isExgChipClocksJoined(input.hardwareVersion)) {
    exg1[1] |= REG2_OSC_CLOCK_BIT;
  } else {
    // Preserve whatever the device already had (correct for a Shimmer3 whose
    // EXG-unified board rev>=4 joins clocks — undetectable from HW id alone).
    exg1[1] = (exg1[1] & ~REG2_OSC_CLOCK_BIT) | (input.exg1[1] & REG2_OSC_CLOCK_BIT);
  }

  // (8) Mandatory must-be bits.
  applyExgMustBeBits(exg1);
  applyExgMustBeBits(exg2);

  return { exg1, exg2, enabledSensors: enabledSensors >>> 0 };
}
