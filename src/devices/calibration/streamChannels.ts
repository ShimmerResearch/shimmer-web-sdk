/**
 * Per-channel streaming calibration: one registry, both clients.
 *
 * Every channel a Shimmer3 or Shimmer3R can stream gets a calibrated value
 * with a unit here, so a host can plot and record engineering units for all of
 * them rather than for the inertial triples and GSR alone.
 *
 * **What the device calibrates, and what it does not.** Only the kinematic
 * sensors carry per-device calibration: the firmware seeds exactly those
 * (`Calibration/shimmer_calibration.c` `ShimCalib_defaultAll`) and
 * `ShimCalib_findLength` answers zero for every other sensor id. Battery, the
 * ADC lines, PPG, GSR, the bridge amplifier and both ExG chips have no stored
 * parameters at all — a host converts them with fixed formulas, and this module
 * is that. Pressure sits between the two: nothing per-device is stored, but the
 * part's own factory trim has to be fetched once
 * (`Shimmer3RClient.readPressureCalibration()`).
 *
 * **The ADC reference is 3.0 V at 12 bits, on both generations.** On a
 * Shimmer3R every analog path right-aligns a 12-bit result and converts against
 * `VREF_EXTERNAL_SUPPLY_MV` = 3000: the ADS7028 packer masks with `0x0FFF`
 * (`Core/Src/spi.c:1415-1419`), the driver's own conversion is
 * `adcValue * 3000 / 4095`
 * (`Shimmer_Driver/ADS7028_38/hal_ads7028_38.c:614`), and the STM32's ADC runs
 * at `ADC_RESOLUTION_12B`. The Java driver's `u14` type string for these
 * channels describes no shipping firmware path — the only 14-bit resolution in
 * the platform code is under `SHIMMER4_SDK` — so dividing by 16383 would report
 * values four times too small.
 */

import { CHANNEL_UNITS } from '../../core/units.js';
import type { ObjectCluster } from '../../core/ObjectCluster.js';
import type { ShimmerGeneration } from '../shimmer3r/channelFormats.js';
import { calibrateU12AdcValue } from '../shimmer3r/calibration.js';
import { calibrateExgSample, type ExgSampleResolution } from '../exg/calibration.js';
import type { ExgBanks } from '../exg/knobs.js';
import { compensatePressure } from '../pressure/compensate.js';
import type { PressureCalibration } from '../pressure/types.js';
import { calibrateGsrChannel } from './gsr.js';
import { applyStreamingCalibration, type StreamingImuRanges } from './streaming.js';
import type { KinematicCalibration } from './kinematic.js';
import type { ImuFamily, InertialGroup } from './defaults.js';

// ---------------------------------------------------------------------------
// ADC constants
// ---------------------------------------------------------------------------

/** ADC reference, in volts. `Shimmer_Driver/hal_Board.h` `VREF_EXTERNAL_SUPPLY_MV`. */
export const ADC_VREF_VOLTS = 3;

/** ADC resolution in bits, both generations. */
export const ADC_BITS = 12;

/**
 * The battery input's resistive divider.
 *
 * The firmware's own conversions are `((raw * 3000) >> 12) * 2` on Shimmer3 and
 * `raw * 3000 / 4095 * 2` on Shimmer3R (`Shimmer_Driver/hal_adc.c`,
 * `saveBatteryVoltageAndUpdateStatus`), and the Java driver's live path also
 * doubles (`ShimmerObject.java:1343`). Java's `SensorBattVoltage` class instead
 * carries 1.988; the firmware's figure wins, and the two differ by 0.6%.
 */
export const BATTERY_DIVIDER_RATIO = 2;

/** Raw ADC counts → millivolts, the one formula every analog channel uses. */
const adcMillivolts = (raw: number): number => calibrateU12AdcValue(raw, 0, ADC_VREF_VOLTS, 1);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Everything {@link calibrateStreamFrame} needs from the client. */
export interface StreamCalibrationState {
  /** Which generation's channel names this frame carries. */
  generation: ShimmerGeneration;
  /** Which IMU family's default calibrations apply. */
  family: ImuFamily;
  /** The configured hardware range per inertial group. */
  ranges: StreamingImuRanges;
  /** Per-device kinematic calibration, where the host has read any. */
  device?: Partial<Record<InertialGroup, KinematicCalibration>>;
  /** Whether to calibrate the inertial groups at all. */
  emitInertial: boolean;
  /** The configured GSR range: 0-3 fixed, 4 auto. */
  gsrRange: number;
  /** Both ExG chips' register banks, or `null` when the host has not read them. */
  exg: ExgBanks | null;
  /** The fitted pressure part's calibration, or `null` when unread/unavailable. */
  pressure: PressureCalibration | null;
  /** Configured pressure oversampling, 0-3. Only the BMP180 uses it. */
  pressureOversampling: number;
}

// ---------------------------------------------------------------------------
// Scalar channels
// ---------------------------------------------------------------------------

interface ScalarCalibrator {
  unit: string;
  calibrate(raw: number, state: StreamCalibrationState): number;
}

/** An ADC line reported in millivolts, with no scaling of its own. */
const adcChannel: ScalarCalibrator = {
  unit: CHANNEL_UNITS.MILLIVOLTS,
  calibrate: (raw) => adcMillivolts(raw),
};

/** An ExG signal channel. */
const exgChannel = (
  chip: 1 | 2,
  channel: 1 | 2,
  resolution: ExgSampleResolution,
): ScalarCalibrator => ({
  unit: CHANNEL_UNITS.MILLIVOLTS,
  calibrate: (raw, state) =>
    calibrateExgSample(
      raw,
      chip === 1 ? (state.exg?.exg1 ?? null) : (state.exg?.exg2 ?? null),
      channel,
      resolution,
    ),
});

/**
 * Every channel whose calibration is a function of one raw value, keyed by the
 * name the stream decoder emits.
 *
 * Both generations' names appear: the ADC block's ids are reused with different
 * meanings on the two platforms (`EXT_EXP_ADC_A7` on a Shimmer3 is `EXT_ADC_0`
 * on a Shimmer3R), and the numbers are identical either way, so a name-keyed
 * table serves both without a generation branch.
 *
 * Absent by design: the six inertial triples and GSR (whole-group
 * calibrations, below), `PRESSURE`/`TEMPERATURE` (a pair, and needing the
 * fetched coefficients), and `TIMESTAMP` (a clock, handled by the client).
 */
export const SCALAR_CALIBRATORS: Readonly<Record<string, ScalarCalibrator>> = Object.freeze({
  // Battery: an ADC line behind a x2 divider.
  BATTERY: {
    unit: CHANNEL_UNITS.MILLIVOLTS,
    calibrate: (raw) => adcMillivolts(raw) * BATTERY_DIVIDER_RATIO,
  },

  // External ADC — Shimmer3 names, then Shimmer3R names for the same lines.
  EXT_EXP_ADC_A7: adcChannel,
  EXT_EXP_ADC_A6: adcChannel,
  EXT_EXP_ADC_A15: adcChannel,
  EXT_ADC_0: adcChannel,
  EXT_ADC_1: adcChannel,
  EXT_ADC_2: adcChannel,

  // Internal ADC.
  INT_EXP_ADC_A1: adcChannel,
  INT_EXP_ADC_A12: adcChannel,
  INT_EXP_ADC_A14: adcChannel,
  INT_ADC_3: adcChannel,
  INT_ADC_0: adcChannel,
  INT_ADC_2: adcChannel,

  /*
   * PPG is the internal ADC line the optical front end sits on, and the Java
   * driver calibrates it as exactly that — `SensorPPG.processDataCustom`
   * delegates to `SensorADC.processMspAdcChannel` (:853-855). There is no
   * optical scaling to apply: millivolts at the ADC is what the sensor
   * measures.
   */
  PPG: adcChannel,

  /*
   * Bridge amplifier, Shimmer3 only. Offset and gain are the SR49 board's, held
   * host-side because the firmware does not know them
   * (`SensorBridgeAmp.java:315-337`).
   */
  BRIDGE_AMP_HIGH: {
    unit: CHANNEL_UNITS.MILLIVOLTS,
    calibrate: (raw) => calibrateU12AdcValue(raw, 60, ADC_VREF_VOLTS, 551),
  },
  BRIDGE_AMP_LOW: {
    unit: CHANNEL_UNITS.MILLIVOLTS,
    calibrate: (raw) => calibrateU12AdcValue(raw, 1950, ADC_VREF_VOLTS, 183.7),
  },

  // ExG signal channels, both chips at both widths.
  Exg1_CH1_24Bit: exgChannel(1, 1, '24bit'),
  Exg1_CH2_24Bit: exgChannel(1, 2, '24bit'),
  Exg2_CH1_24Bit: exgChannel(2, 1, '24bit'),
  Exg2_CH2_24Bit: exgChannel(2, 2, '24bit'),
  Exg1_CH1_16Bit: exgChannel(1, 1, '16bit'),
  Exg1_CH2_16Bit: exgChannel(1, 2, '16bit'),
  Exg2_CH1_16Bit: exgChannel(2, 1, '16bit'),
  Exg2_CH2_16Bit: exgChannel(2, 2, '16bit'),

  /*
   * The ExG status byte is the chip's lead-off register passed through
   * untouched, so its "calibrated" value is the same number with no unit —
   * which is what the Java driver emits for it (`SensorEXG.java:1127`,
   * `ShimmerObject.java:1767`). Emitting it keeps a CSV's lead-off columns
   * present when a host records calibrated values only.
   */
  Exg1_Status: {
    unit: CHANNEL_UNITS.NO_UNITS,
    calibrate: (raw) => raw,
  },
  Exg2_Status: {
    unit: CHANNEL_UNITS.NO_UNITS,
    calibrate: (raw) => raw,
  },
});

// ---------------------------------------------------------------------------
// Pressure / temperature
// ---------------------------------------------------------------------------

/** `'PRESSURE'`, in kPa once compensated. */
export const PRESSURE_NAME = 'PRESSURE';
/** `'TEMPERATURE'`, in °C once compensated. */
export const TEMPERATURE_NAME = 'TEMPERATURE';

/**
 * Compensate the pressure/temperature pair, or leave both raw-only.
 *
 * The two are compensated together — the pressure maths needs the linearised
 * temperature — so either both cal fields appear or neither does. Nothing
 * appears at all without the part's coefficients: a Bosch compensation run
 * against a blank block returns a confident, wrong pressure, so the honest
 * answer is to say nothing and let the host report that the channels are
 * raw-only.
 */
function calibratePressurePair(oc: ObjectCluster, state: StreamCalibrationState): void {
  const pressure = oc.get(PRESSURE_NAME, 'raw')?.value;
  const temperature = oc.get(TEMPERATURE_NAME, 'raw')?.value;
  if (!Number.isFinite(pressure) || !Number.isFinite(temperature)) return;
  const out = compensatePressure(
    state.pressure,
    pressure as number,
    temperature as number,
    state.pressureOversampling,
  );
  if (!out) return;
  oc.add(PRESSURE_NAME, out.pressureKPa, CHANNEL_UNITS.KPASCAL, 'cal');
  oc.add(TEMPERATURE_NAME, out.temperatureC, CHANNEL_UNITS.DEGREES_CELSIUS, 'cal');
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Add a calibrated (`'cal'`) field, with a unit, for every channel in `oc` this
 * SDK can convert.
 *
 * Purely additive: the raw fields are left exactly as the decoder wrote them,
 * so a host can plot either and a CSV can carry both. A channel this SDK has no
 * conversion for keeps its raw field alone rather than gaining a `'cal'` field
 * that is the same number — which would claim a calibration that does not
 * exist.
 */
export function calibrateStreamFrame(oc: ObjectCluster, state: StreamCalibrationState): void {
  // Snapshot first: the loop adds fields, and iterating the live array would
  // then walk over its own output.
  for (const field of [...oc.fields]) {
    if (field.kind !== 'raw') continue;
    const calibrator = SCALAR_CALIBRATORS[field.name];
    if (!calibrator) continue;
    if (!Number.isFinite(field.value)) continue;
    oc.add(field.name, calibrator.calibrate(field.value, state), calibrator.unit, 'cal');
  }

  calibrateGsrChannel(oc, state.gsrRange);
  calibratePressurePair(oc, state);

  if (state.emitInertial) {
    applyStreamingCalibration(oc, {
      family: state.family,
      ranges: state.ranges,
      device: state.device,
    });
  }
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Where an inertial group's calibration came from. */
export type StreamCalibrationSource = 'radio-dump' | 'bt-command' | 'default';

/** Where the ExG conversion's gain and reference came from. */
export type ExgCalibrationSource = 'device' | 'infomem' | 'default';

/**
 * What a client is calibrating each streamed channel against.
 *
 * Field names follow `SdLogChannelCalibrationInfo` so a host can report the
 * provenance of live and logged data the same way.
 */
export interface StreamCalibrationInfo {
  /** Per inertial group: the configured range, and whose numbers are in force. */
  inertial: Partial<
    Record<
      InertialGroup,
      {
        range: number;
        source: StreamCalibrationSource;
        usingDefaultCalibration: boolean;
        unit: string;
      }
    >
  >;
  gsr: { range: number };
  exg: {
    source: ExgCalibrationSource;
    chip1: { vrefVolts: number; gainCh1: number; gainCh2: number };
    chip2: { vrefVolts: number; gainCh1: number; gainCh2: number };
  };
  pressure: {
    /** The fitted part, or `null` when the host has not asked. */
    sensor: string | null;
    /** Whether PRESSURE/TEMPERATURE are being converted at all. */
    calibrated: boolean;
    oversampling: number;
  };
  adc: { vrefVolts: number; bits: number };
}
