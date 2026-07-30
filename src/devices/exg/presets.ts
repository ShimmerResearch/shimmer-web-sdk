/**
 * ADS1292R (EXG) preset detection and resolution derivation.
 *
 * Pure port of the Java oracle:
 *   - preset register arrays : SensorEXG.setDefault... / setEXG... (the commented
 *     reference byte arrays in SensorEXG.java:1782-1783 ECG, 1813-1814 EMG,
 *     1845 test, 1872-1873 respiration, 1921-1922 custom)
 *   - preset detection       : SensorEXG.isEXGUsingDefault*
 *     (SensorEXG.java:2680-2763), invoked in the order
 *     Respiration → ECG → EMG → TestSignal → Custom
 *     (ShimmerObject.java:1791-1820)
 *   - resolution ↔ bitmap    : ShimmerObject.checkExgResolutionFromEnabledSensorsVar
 *     (ShimmerObject.java:7255-7279), using the ConfigByteLayoutShimmer3
 *     sensor-bitmap masks (ConfigByteLayoutShimmer3.java:300-303).
 */

import { EXG_BANK_LENGTH } from './registers.js';

/** A recognised EXG preset, or 'custom' / 'off'. */
export type ExgPreset = 'ecg' | 'emg' | 'test-signal' | 'respiration' | 'custom' | 'off';

/** EXG resolution derived from the sensor bitmap. */
export type ExgResolution = '16bit' | '24bit';

/**
 * Canonical per-chip register arrays for each preset, verbatim from the Java
 * oracle's reference byte arrays (SensorEXG.java, decimal values). The register
 * bytes are identical for the 16-bit and 24-bit variants of a preset — only the
 * sensor bitmap differs (see {@link exgResolutionFromSensors}).
 */
export const EXG_PRESET_ARRAYS = Object.freeze({
  /** SensorEXG.java:1782-1783 */
  ecg: {
    exg1: Object.freeze([2, 160, 16, 64, 64, 45, 0, 0, 2, 3]),
    exg2: Object.freeze([2, 160, 16, 64, 71, 0, 0, 0, 2, 1]),
  },
  /** SensorEXG.java:1813-1814 */
  emg: {
    exg1: Object.freeze([2, 160, 16, 105, 96, 32, 0, 0, 2, 3]),
    exg2: Object.freeze([2, 160, 16, 129, 129, 0, 0, 0, 2, 1]),
  },
  /** SensorEXG.java:1845 */
  'test-signal': {
    exg1: Object.freeze([2, 163, 16, 5, 5, 0, 0, 0, 2, 1]),
    exg2: Object.freeze([2, 163, 16, 5, 5, 0, 0, 0, 2, 1]),
  },
  /** SensorEXG.java:1872-1873 */
  respiration: {
    exg1: Object.freeze([2, 160, 16, 64, 64, 32, 0, 0, 2, 3]),
    exg2: Object.freeze([2, 160, 16, 64, 71, 0, 0, 0, 234, 1]),
  },
  /** SensorEXG.java:1921-1922 */
  custom: {
    exg1: Object.freeze([2, 163, 16, 7, 7, 0, 0, 0, 2, 1]),
    exg2: Object.freeze([2, 163, 16, 7, 7, 0, 0, 0, 2, 1]),
  },
} as const);

// Sensor-bitmap masks (ConfigByteLayoutShimmer3.java:300-303 == SensorBitmapShimmer3).
const MASK_EXG1_24BIT = 0x000010;
const MASK_EXG2_24BIT = 0x000008;
const MASK_EXG1_16BIT = 0x100000;
const MASK_EXG2_16BIT = 0x080000;

interface ResolutionFlags {
  exg1_16: boolean;
  exg2_16: boolean;
  exg1_24: boolean;
  exg2_24: boolean;
}

function resolutionFlags(enabledSensors: number): ResolutionFlags {
  const es = enabledSensors >>> 0;
  return {
    exg1_24: (es & MASK_EXG1_24BIT) !== 0,
    exg2_24: (es & MASK_EXG2_24BIT) !== 0,
    exg1_16: (es & MASK_EXG1_16BIT) !== 0,
    exg2_16: (es & MASK_EXG2_16BIT) !== 0,
  };
}

/**
 * Derive EXG resolution from the enabled-sensors bitmap. Resolution is not a
 * register field — it lives entirely in the sensor bitmap. Mirrors
 * ShimmerObject.checkExgResolutionFromEnabledSensorsVar (:7255-7279): the
 * 16-bit flags take precedence over the 24-bit flags.
 *
 * @returns '16bit' | '24bit', or null when no EXG chip is enabled.
 */
export function exgResolutionFromSensors(enabledSensors: number): ExgResolution | null {
  const f = resolutionFlags(enabledSensors);
  if (f.exg1_16 || f.exg2_16) return '16bit';
  if (f.exg1_24 || f.exg2_24) return '24bit';
  return null;
}

function allZero(bank: Uint8Array): boolean {
  for (const b of bank) if (b !== 0) return false;
  return true;
}

/**
 * Detect which preset a pair of register banks represents.
 *
 * Detection is TOLERANT, exactly as the Java oracle's isEXGUsingDefault*
 * checks (SensorEXG.java:2680-2763): it keys only off the CH1/CH2
 * input-selection nibbles (byte3/byte4 low nibble) plus the chip-2 respiration
 * modulation/demodulation bits, and — when {@link enabledSensors} is supplied
 * — the resolution flags. It does NOT compare the full byte arrays, so the
 * fields the firmware rewrites (the data-rate/oversampling bits in byte0, the
 * oscillator-clock bit in byte1, PGA gain, etc.) do not affect the result.
 * This is why the 16-bit-only hardcoded 3R preset arrays — which differ from
 * the Java reference arrays in byte1 (oscillator-clock bit) and the rate bits —
 * still detect correctly.
 *
 * The resolution gate mirrors Java: ECG/TestSignal/Respiration require both
 * chips at the same resolution; EMG requires chip 1 only. When
 * {@link enabledSensors} is omitted the resolution gate is relaxed (detection
 * proceeds purely on the input-selection/respiration fields), and empty banks
 * report 'off'.
 *
 * Evaluation order is Respiration → ECG → EMG → TestSignal → Custom
 * (ShimmerObject.java:1791-1820): respiration shares the ECG input selections
 * and is distinguished only by its modulation/demodulation bits, so it must be
 * tested first.
 *
 * @throws RangeError when either bank is not exactly 10 bytes.
 */
export function detectExgPreset(
  exg1: Uint8Array,
  exg2: Uint8Array,
  enabledSensors?: number,
): ExgPreset {
  if (exg1.length !== EXG_BANK_LENGTH || exg2.length !== EXG_BANK_LENGTH) {
    throw new RangeError(
      `EXG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ${exg1.length}/${exg2.length}.`,
    );
  }

  const flags = enabledSensors != null ? resolutionFlags(enabledSensors) : null;
  const bothChips = flags
    ? (flags.exg1_16 && flags.exg2_16) || (flags.exg1_24 && flags.exg2_24)
    : true;
  const chip1Only = flags
    ? (flags.exg1_16 && !flags.exg2_16) || (flags.exg1_24 && !flags.exg2_24)
    : true;
  const anyExg = flags
    ? flags.exg1_16 || flags.exg2_16 || flags.exg1_24 || flags.exg2_24
    : !(allZero(exg1) && allZero(exg2));

  if (!anyExg) return 'off';

  const c1ch1 = exg1[3] & 0x0f;
  const c1ch2 = exg1[4] & 0x0f;
  const c2ch1 = exg2[3] & 0x0f;
  const c2ch2 = exg2[4] & 0x0f;
  // Chip-2 REG9: demod (bit7) and mod (bit6) circuitry on (SensorEXG.java:2733-2734).
  const respirationOn = ((exg2[8] >> 7) & 1) === 1 && ((exg2[8] >> 6) & 1) === 1;

  // NORMAL=0, SHORTED=1, TEST_SIGNAL=5, RLDIN_TO_NEG=7, ROUTE_CH3_TO_CH1=9
  // (ExGConfigBytesDetails.java:196-234).
  if (bothChips && respirationOn) return 'respiration';
  if (bothChips && c1ch1 === 0 && c1ch2 === 0 && c2ch1 === 0 && c2ch2 === 7) return 'ecg';
  if (chip1Only && c1ch1 === 9 && c1ch2 === 0 && c2ch1 === 1 && c2ch2 === 1) return 'emg';
  if (bothChips && c1ch1 === 5 && c1ch2 === 5 && c2ch1 === 5 && c2ch2 === 5) return 'test-signal';
  return 'custom';
}

/** Human-readable label for a detected preset (for read-only display). */
export function exgPresetLabel(preset: ExgPreset): string {
  switch (preset) {
    case 'ecg':
      return 'ECG';
    case 'emg':
      return 'EMG';
    case 'test-signal':
      return 'ExG Test Signal';
    case 'respiration':
      return 'Respiration';
    case 'custom':
      return 'Custom';
    case 'off':
      return 'Off';
  }
}
