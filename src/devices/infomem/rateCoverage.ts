/**
 * Does the configured sensor output rate keep up with the configured packet
 * rate?
 *
 * These are two independent InfoMem fields and nothing in the firmware relates
 * them. The packet rate (`samplingRate`, bytes 0-1) decides how often a frame
 * is assembled; the IMU's ODR (`ConfigSetupByte1`) decides how often the
 * LSM6DSV actually produces a new sample. Set the packet rate above the ODR and
 * the firmware dutifully packages the same sample several times over, with a
 * fresh timestamp on each - so the stream looks perfect (regular timestamps, no
 * loss, valid CRCs) while the plotted signal is a staircase of repeats.
 *
 * That the two are meant to agree is not an inference. The firmware's own
 * Shimmer3R defaults pair a 51.2 Hz packet rate with the ODR immediately above
 * it, and say so:
 *
 *     // LSM6DSV Gyro sampling rate, next highest to 51.2Hz
 *     ShimConfig_gyroRateSet(LSM6DSV_ODR_AT_60Hz);
 *     -- log-and-stream-common Configuration/shimmer_config.c:183-184
 *
 * Consensys maintains the invariant by deriving sensor ODRs from the trial
 * rate, which is why reconfiguring there makes the staircase disappear. A host
 * that edits the fields independently has to check it instead, and this is that
 * check.
 *
 * Each check covers one chip, with its own enable bits and its own ODR table,
 * and stays silent unless that sensor is enabled: a warning that fires on a
 * sensor the user has not enabled is worse than no warning at all. There are
 * two: the LSM6DSV accel/gyro pair ({@link checkImuRateCoversPacketRate}) and
 * the Shimmer3R's LIS2DW12 wide-range accelerometer
 * ({@link checkWrAccelRateCoversPacketRate}). The magnetometers have the same
 * trap and no check yet.
 */

import { SensorBitmapShimmer3 } from '../shimmer3r/SensorBitmap.js';
import {
  SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS,
} from '../shimmer3/sensorOptions.js';
import { LIS2DW12_LOW_POWER_MAX_HZ } from './deriveRates.js';
import { INFOMEM_SAMPLING_CLOCK_FREQ } from './parse.js';

/** A rate option label parsed to Hz, or null when it names no rate. */
function labelToHz(label: string): number | null {
  // "60.0Hz" / "1.875Hz" / "Power-down". Parsed from the option table rather
  // than duplicated as numbers, so the two cannot drift apart.
  const m = /^([\d.]+)\s*Hz$/i.exec(label.trim());
  if (!m) return null;
  const hz = Number(m[1]);
  return Number.isFinite(hz) && hz > 0 ? hz : null;
}

/**
 * Output rate of an LSM6DSV accel/gyro ODR code, in Hz.
 *
 * @param code the value stored in `ConfigSetupByte1`
 * @returns the rate in Hz, or null for power-down and for codes with no rate
 *   (the Java table carries one writable value it does not name)
 */
export function lsm6dsvAccelGyroRateHz(code: number): number | null {
  const hit = SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS.find(([value]) => value === code);
  return hit ? labelToHz(hit[1]) : null;
}

/** Packet rate in Hz from the stored `samplingRate` divider. */
export function samplingRateHzFromDivider(divider: number): number | null {
  if (!Number.isFinite(divider) || divider <= 0) return null;
  return INFOMEM_SAMPLING_CLOCK_FREQ / divider;
}

/** What {@link checkImuRateCoversPacketRate} found. */
export interface ImuRateCoverage {
  /** Configured packet rate in Hz, or null when the divider is unusable. */
  packetRateHz: number | null;
  /** Configured LSM6DSV ODR in Hz; null for power-down or an unnamed code. */
  imuRateHz: number | null;
  /** Whole frames the device will repeat per genuinely new sample, when short. */
  repeatsPerSample: number | null;
  /** True when the IMU cannot keep up with the packet rate. */
  short: boolean;
  /** A message to show the user, or null when the pair is coherent. */
  problem: string | null;
}

/**
 * Check the LSM6DSV ODR against the packet rate.
 *
 * @param opts.samplingRateDivider stored `samplingRate` (bytes 0-1)
 * @param opts.imuRateCode stored `ConfigSetupByte1`
 * @param opts.enabledSensors the sensor bitmap; the check is skipped unless the
 *   low-noise accelerometer or the gyroscope is actually enabled, since the ODR
 *   is irrelevant to a stream that carries neither
 */
export function checkImuRateCoversPacketRate(opts: {
  samplingRateDivider: number;
  imuRateCode: number;
  enabledSensors: number;
}): ImuRateCoverage {
  const packetRateHz = samplingRateHzFromDivider(opts.samplingRateDivider);
  const imuRateHz = lsm6dsvAccelGyroRateHz(opts.imuRateCode);

  const usesImu =
    (opts.enabledSensors &
      (SensorBitmapShimmer3.SENSOR_A_ACCEL | SensorBitmapShimmer3.SENSOR_GYRO)) !==
    0;

  const none: ImuRateCoverage = {
    packetRateHz,
    imuRateHz,
    repeatsPerSample: null,
    short: false,
    problem: null,
  };
  if (!usesImu || packetRateHz === null) return none;

  if (imuRateHz === null) {
    // Power-down with the IMU enabled is its own fault, and a worse one: the
    // sample never changes at all.
    return {
      ...none,
      short: true,
      problem:
        `The accelerometer/gyroscope output rate is set to "power-down" while those ` +
        `sensors are enabled, so every frame will carry the same reading. Raise it to ` +
        `at least ${packetRateHz.toFixed(1)} Hz.`,
    };
  }

  if (imuRateHz >= packetRateHz) return { ...none, short: false, problem: null };

  const repeats = packetRateHz / imuRateHz;
  return {
    packetRateHz,
    imuRateHz,
    repeatsPerSample: repeats,
    short: true,
    problem:
      `The accelerometer/gyroscope output rate (${imuRateHz} Hz) is below the sampling ` +
      `rate (${packetRateHz.toFixed(1)} Hz), so the sensor will repeat each reading about ` +
      `${repeats < 10 ? repeats.toFixed(1) : Math.round(repeats)} times instead of ` +
      `producing new data. Timestamps and packet loss will still look correct while the ` +
      `signal is a staircase. Raise "Gyro/Accel Rate" to the next value at or above ` +
      `${packetRateHz.toFixed(1)} Hz.`,
  };
}

// ---------------------------------------------------------------------------
// LIS2DW12 — Shimmer3R wide-range accelerometer
// ---------------------------------------------------------------------------

/** The LIS2DW12's fastest ODR code: 1600 Hz in high performance. */
const LIS2DW12_TOP_CODE = 9;

/**
 * Output rate of a LIS2DW12 ODR code, in Hz, as the part delivers it.
 *
 * Mode-dependent, unlike the LSM6DSV's: code 1 is 12.5 Hz in high performance
 * but 1.6 Hz in a low-power mode, and codes 7-9 deliver only 200 Hz in a
 * low-power mode. Read from the Java driver's two lists
 * (`SensorLIS2DW12.ListofLIS2DW12AccelRateHpm` / `...Lpm`), which agree with
 * the firmware's `ShimConfig_lis2dw12OdrToHz`.
 *
 * @param code ConfigSetupByte0 bits 4-7
 * @param highPerformance ConfigSetupByte0 bit 0 (`wrAccelHrMode`). With it
 *   clear the part is in a low-power mode, whatever bit 1 says
 * @returns the rate in Hz, or null for power-down and for codes with no rate
 */
export function lis2dw12AccelRateHz(code: number, highPerformance: boolean): number | null {
  const table = highPerformance
    ? SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS
    : SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS;
  const hit = table.find(([value]) => value === code);
  return hit ? labelToHz(hit[1]) : null;
}

/** What {@link checkWrAccelRateCoversPacketRate} found. */
export interface WrAccelRateCoverage {
  /** Configured packet rate in Hz, or null when the divider is unusable. */
  packetRateHz: number | null;
  /** The rate the LIS2DW12 will deliver in its configured mode; null for power-down. */
  wrAccelRateHz: number | null;
  /** True when bit 0 (high performance) is clear, so the part is in a low-power mode. */
  lowPower: boolean;
  /**
   * True when the shortfall is the low-power ceiling: the part is in a
   * low-power mode and the packet rate is above
   * {@link LIS2DW12_LOW_POWER_MAX_HZ}, so no rate code can fix it and only
   * high-performance mode (or a lower packet rate) does. A host should not
   * write this configuration.
   */
  lowPowerTooSlow: boolean;
  /**
   * The share of packets that will carry no new wide-range sample, when short.
   * At 256 Hz in a low-power mode it is about 0.22; a bench run measured 0.212,
   * because the part's real low-power ceiling is nearer 202 Hz.
   */
  unfilledFraction: number | null;
  /** True when the wide-range accelerometer cannot keep up with the packet rate. */
  short: boolean;
  /** A message to show the user, or null when the configuration is coherent. */
  problem: string | null;
}

/**
 * Check the Shimmer3R wide-range accelerometer (LIS2DW12) against the packet
 * rate, and above all flag a low-power mode above 200 Hz.
 *
 * That combination is what a Shimmer3R configured in Shimmer Capture at 256 Hz
 * was found holding: ConfigSetupByte0 `0x62`, high performance off. No
 * low-power mode passes 200 Hz, so the firmware lowers the rate to that cap,
 * and on the ticks the part has no new sample the slot goes out unfilled -
 * about one packet in five at 256 Hz, zero at first and a stale reading after
 * that. Consensys never writes it: enabling the sensor turns high performance
 * on (`SensorLIS2DW12.setDefaultLIS2DW12AccelSensorConfig`).
 *
 * Shimmer3R only. On a Shimmer3 the same bits drive an LSM303, whose modes and
 * rates are different.
 *
 * @param opts.samplingRateDivider stored `samplingRate` (bytes 0-1)
 * @param opts.wrAccelRateCode ConfigSetupByte0 bits 4-7
 * @param opts.highPerformance ConfigSetupByte0 bit 0
 * @param opts.enabledSensors the sensor bitmap; the check is skipped unless the
 *   wide-range accelerometer (`SENSOR_D_ACCEL`) is enabled
 */
export function checkWrAccelRateCoversPacketRate(opts: {
  samplingRateDivider: number;
  wrAccelRateCode: number;
  highPerformance: boolean;
  enabledSensors: number;
}): WrAccelRateCoverage {
  const packetRateHz = samplingRateHzFromDivider(opts.samplingRateDivider);
  const lowPower = !opts.highPerformance;
  const wrAccelRateHz = lis2dw12AccelRateHz(opts.wrAccelRateCode, opts.highPerformance);
  const enabled = (opts.enabledSensors & SensorBitmapShimmer3.SENSOR_D_ACCEL) !== 0;

  const none: WrAccelRateCoverage = {
    packetRateHz,
    wrAccelRateHz,
    lowPower,
    lowPowerTooSlow: false,
    unfilledFraction: null,
    short: false,
    problem: null,
  };
  if (!enabled || packetRateHz === null) return none;

  const hz = packetRateHz.toFixed(1);

  if (lowPower && packetRateHz > LIS2DW12_LOW_POWER_MAX_HZ) {
    const unfilled = 1 - LIS2DW12_LOW_POWER_MAX_HZ / packetRateHz;
    return {
      ...none,
      lowPowerTooSlow: true,
      unfilledFraction: unfilled,
      short: true,
      problem:
        `The wide-range accelerometer is in low-power mode, which cannot deliver more than ` +
        `${LIS2DW12_LOW_POWER_MAX_HZ} Hz, and the sampling rate is ${hz} Hz. About ` +
        `${Math.round(unfilled * 100)}% of packets will carry no new wide-range reading, ` +
        `while timestamps and packet loss still look correct. Turn on "WR Accel ` +
        `High-Performance Mode", as Consensys does whenever the sensor is enabled, or lower ` +
        `the sampling rate to ${LIS2DW12_LOW_POWER_MAX_HZ} Hz or below.`,
    };
  }

  if (wrAccelRateHz === null) {
    return {
      ...none,
      unfilledFraction: 1,
      short: true,
      problem:
        `The wide-range accelerometer output rate is set to "power-down" while the sensor ` +
        `is enabled, so it will produce no new readings. Raise "WR Accel Rate" to at least ` +
        `${hz} Hz.`,
    };
  }

  if (wrAccelRateHz >= packetRateHz) return none;

  // Below the packet rate the firmware gates the read on the part's data-ready
  // line, so the slots it has nothing for go out unfilled rather than repeated
  // (shimmer3r-firmware `hal_lis2dw12.c`, `lis2dw12_is_shimmer_freq_higher`).
  const unfilled = 1 - wrAccelRateHz / packetRateHz;
  const fastestHz = lis2dw12AccelRateHz(LIS2DW12_TOP_CODE, true) ?? 0;
  const advice =
    packetRateHz > fastestHz
      ? `The part has no faster rate, so lower the sampling rate to ${fastestHz} Hz or below.`
      : `Raise "WR Accel Rate" to the next value at or above ${hz} Hz.`;
  return {
    ...none,
    unfilledFraction: unfilled,
    short: true,
    problem:
      `The wide-range accelerometer output rate (${wrAccelRateHz} Hz` +
      `${lowPower ? ' in low-power mode' : ''}) is below the sampling rate (${hz} Hz), so ` +
      `about ${Math.round(unfilled * 100)}% of packets will carry no new wide-range reading. ` +
      advice,
  };
}
