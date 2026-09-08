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
 * Deliberately scoped to the LSM6DSV accel/gyro pair. The same trap exists for
 * the wide-range accelerometer and the magnetometers, but each has its own
 * enable bits and its own ODR table, and a warning that fires on a sensor the
 * user has not enabled is worse than no warning at all.
 */

import { SensorBitmapShimmer3 } from '../shimmer3r/SensorBitmap.js';
import { SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS } from '../shimmer3/sensorOptions.js';
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
