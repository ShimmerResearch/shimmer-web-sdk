/**
 * Gyro on-the-fly offset calibration.
 *
 * Port of the Shimmer Java driver's
 *   com.shimmerresearch.algorithms.gyroOnTheFlyCal.GyroOnTheFlyCalModule
 *   com.shimmerresearch.algorithms.gyroOnTheFlyCal.OnTheFlyGyroOffsetCal
 * which Consensys runs whenever derived-sensor bit 29 (`GYRO_ON_THE_FLY_CAL`)
 * is set in the configuration (InfoMem over Bluetooth, the header on SD).
 *
 * While the sensor lies still it re-estimates the gyro offset. Every sample's
 * calibrated and raw triples go into a sliding window of round(fs) samples;
 * once the window is full and every calibrated axis has a standard deviation
 * under 1.2 deg/s, the mean of the raw window becomes the gyro offset
 * (`CalibDetailsKinematic.updateCurrentOffsetVector`), from the next sample on.
 *
 * The arithmetic is Apache Commons Math 2.2's — `Mean.evaluate` with its
 * correction pass, and the bias-corrected `Variance` — because that is what
 * makes the result bit-exact with Java. shimmer-host-core carries the same
 * port (`src/calibration.rs`, `GyroOnTheFly`), held to Java's output to the
 * last bit, and this one is checked against host-core's traces.
 */

import type { KinematicCalibration } from './kinematic.js';

/** Derived-sensor bit 29: `DerivedSensorsBitMask.GYRO_ON_THE_FLY_CAL`. */
export const DERIVED_GYRO_ON_THE_FLY_CAL = 1n << 29n;

/** `OnTheFlyGyroOffsetCal.DEFAULT_THRESHOLD`, in deg/s. */
export const GYRO_ON_THE_FLY_THRESHOLD_DPS = 1.2;

/** Whether a derived-sensors bitmap has the on-the-fly calibration enabled. */
export function isGyroOnTheFlyEnabled(derivedSensors: bigint | number): boolean {
  const bits = typeof derivedSensors === 'bigint' ? derivedSensors : BigInt(derivedSensors);
  return (bits & DERIVED_GYRO_ON_THE_FLY_CAL) !== 0n;
}

/**
 * The window length for a sampling rate: `(int) Math.round(fs)`, so halves
 * round up (`OnTheFlyGyroOffsetCal.setBufferSizeFromSamplingRate`). Zero for a
 * rate that is not known.
 */
export function gyroOnTheFlyWindow(samplingRateHz: number): number {
  if (!Number.isFinite(samplingRateHz) || samplingRateHz <= 0) return 0;
  return Math.floor(samplingRateHz + 0.5);
}

/** Commons Math 2.2 `Mean.evaluate`: the sum's mean, then a correction pass. */
export function commonsMean(values: readonly number[]): number {
  const n = values.length;
  let total = 0;
  for (const v of values) total += v;
  const xbar = total / n;
  let correction = 0;
  for (const v of values) correction += v - xbar;
  return xbar + correction / n;
}

/**
 * Commons Math 2.2 `DescriptiveStatistics.getStandardDeviation`: the square
 * root of the bias-corrected `Variance`, with its own correction term. Zero for
 * one value.
 */
export function commonsStandardDeviation(values: readonly number[]): number {
  const n = values.length;
  if (n === 1) return 0;
  const m = commonsMean(values);
  let accum = 0;
  let accum2 = 0;
  for (const v of values) {
    const dev = v - m;
    accum += dev * dev;
    accum2 += dev;
  }
  return Math.sqrt((accum - (accum2 * accum2) / n) / (n - 1));
}

type Triple = [number, number, number];

/**
 * The on-the-fly estimator for one device, plus the offsets it has estimated.
 *
 * Java writes an estimate into the calibration object in force
 * (`getCurrentCalibDetailsGyro()`, the one for the configured range), so it
 * lives exactly as long as that object does: a range change moves to another
 * object with its own offset, and re-reading the calibration replaces the
 * objects and with them every estimate. The offsets here are keyed the same
 * way — by the {@link KinematicCalibration} the estimate was made against —
 * which gives the same lifetimes without mutating a shared default.
 */
export class GyroOnTheFlyCal {
  private _window = 0;
  private readonly _cal: [number[], number[], number[]] = [[], [], []];
  private readonly _raw: [number[], number[], number[]] = [[], [], []];
  private _offsets = new WeakMap<KinematicCalibration, Triple>();
  private _updates = 0;
  private _lastOffset: Triple | null = null;

  /** Samples in the window, or 0 before a sampling rate is known. */
  get windowSamples(): number {
    return this._window;
  }

  /** How many times an estimate has replaced the offset. */
  get updates(): number {
    return this._updates;
  }

  /** The most recent estimate, or `null` before the first. */
  get lastOffset(): Readonly<Triple> | null {
    return this._lastOffset;
  }

  /**
   * Size the window from the sampling rate. Values already in it are kept,
   * oldest first to go if it shrinks, as `DescriptiveStatistics.setWindowSize`
   * does. Java does this when streaming starts (`initializeAlgorithms`) and
   * when the rate changes.
   */
  setSamplingRate(samplingRateHz: number): void {
    this._window = gyroOnTheFlyWindow(samplingRateHz);
    for (const d of [...this._cal, ...this._raw]) {
      if (d.length > this._window) d.splice(0, d.length - this._window);
    }
  }

  /** Empty the window and forget every estimate: a new SD file, a new device. */
  reset(): void {
    for (const d of [...this._cal, ...this._raw]) d.length = 0;
    this._offsets = new WeakMap();
    this._updates = 0;
    this._lastOffset = null;
  }

  /**
   * The calibration to apply to the next sample: `base` with the estimated
   * offset in place of its own, once there is an estimate for it.
   */
  calibrationFor(base: KinematicCalibration): KinematicCalibration {
    const offset = this._offsets.get(base);
    return offset ? { ...base, offset } : base;
  }

  /** Whether an estimate is in force for `base`. */
  isActiveFor(base: KinematicCalibration): boolean {
    return this._offsets.has(base);
  }

  /**
   * Feed one sample (`updateGyroOnTheFlyGyroOVCal`): its calibrated triple and
   * the raw triple it came from. When the window is full and still, the raw
   * mean becomes the offset for `base` and is returned; otherwise `null`.
   */
  update(
    base: KinematicCalibration,
    cal: readonly [number, number, number],
    raw: readonly [number, number, number],
  ): Readonly<Triple> | null {
    // A window of 0 is not a window: Java builds no buffers for it.
    if (this._window < 1) return null;
    for (let axis = 0; axis < 3; axis++) {
      if (this._cal[axis].length === this._window) {
        this._cal[axis].shift();
        this._raw[axis].shift();
      }
      this._cal[axis].push(cal[axis]);
      this._raw[axis].push(raw[axis]);
    }
    if (this._cal[1].length !== this._window) return null;
    for (const d of this._cal) {
      if (!(commonsStandardDeviation(d) < GYRO_ON_THE_FLY_THRESHOLD_DPS)) return null;
    }
    const offset: Triple = [
      commonsMean(this._raw[0]),
      commonsMean(this._raw[1]),
      commonsMean(this._raw[2]),
    ];
    this._offsets.set(base, offset);
    this._updates++;
    this._lastOffset = offset;
    return offset;
  }
}

/** What a client or decoder reports about the on-the-fly calibration. */
export interface GyroOnTheFlyInfo {
  /** Derived-sensor bit 29 is set, so the offset is being re-estimated. */
  enabled: boolean;
  /** An estimate is replacing the stored offset of the calibration in force. */
  active: boolean;
  /** Window length in samples, round(fs); 0 before the rate is known. */
  windowSamples: number;
  /** Per-axis standard deviation under which the window counts as still. */
  thresholdDps: number;
  /** How many times an estimate has replaced the offset. */
  updates: number;
  /** The most recent estimated offset, in raw counts, or `null`. */
  offset: [number, number, number] | null;
}

/** Summarise an estimator for {@link GyroOnTheFlyInfo}. */
export function gyroOnTheFlyInfo(
  otf: GyroOnTheFlyCal,
  enabled: boolean,
  base: KinematicCalibration | null,
): GyroOnTheFlyInfo {
  const last = otf.lastOffset;
  return {
    enabled,
    active: enabled && base !== null && otf.isActiveFor(base),
    windowSamples: otf.windowSamples,
    thresholdDps: GYRO_ON_THE_FLY_THRESHOLD_DPS,
    updates: otf.updates,
    offset: last ? [last[0], last[1], last[2]] : null,
  };
}
