/**
 * Derive a sensor's output rate from the configured packet rate, the way the
 * Java driver does.
 *
 * In Consensys a user never writes an ODR: they set the trial rate or toggle a
 * sensor, and `ShimmerDevice.setShimmerAndSensorsSamplingRate` /
 * `setSensorEnabledState` fan that out to each sensor
 * (`ShimmerDevice.java:3399`, `:2357`). A host that edits the InfoMem fields
 * independently has to do the same fan-out, or it produces pairs the driver
 * never would — a 51.2 Hz packet rate against a 1.875 Hz IMU being the one that
 * cost bench time.
 *
 * Ported from `SensorLSM6DSV.getGyroRateFromFreq` (`SensorLSM6DSV.java:676`)
 * and `setDefaultLSM6DSVGyroSensorConfig`, against the checkouts in
 * `eclipse-java-workspace_2024`.
 */

/** ODR codes with a meaning beyond "this many Hz". */
export const LSM6DSV_ODR = Object.freeze({
  /** Sensor off. What the driver writes when neither channel is enabled. */
  POWER_DOWN: 0,
  /**
   * 1.875 Hz — and *also* how the driver represents "low-power gyro". There is
   * no separate bit: `checkLowPowerGyro` (`SensorLSM6DSV.java:752`) reads the
   * flag back **from** the rate. So this value is self-perpetuating — a
   * re-derivation from an existing 1 keeps 1, because it reads as a low-power
   * request. Only enabling the sensor clears it, which is why
   * {@link deriveLsm6dsvAccelGyroRate} takes `lowPower` explicitly rather than
   * inferring it from the current value.
   */
  LOW_POWER: 1,
} as const);

/**
 * The ladder from `getGyroRateFromFreq`, as `[maxFreqHz, code]` pairs in the
 * order Java tests them. Code 3 (12 Hz) is absent because the Java ladder skips
 * it — 2 goes straight to 4.
 */
const LSM6DSV_LADDER: readonly (readonly [number, number])[] = Object.freeze([
  [7.5, 2],
  [30, 4],
  [60, 5],
  [120, 6],
  [240, 7],
  [480, 8],
  [960, 9],
  [1920, 10],
  [3840, 11],
  [7680, 12],
]);

/**
 * The LSM6DSV accel+gyro ODR code for a packet rate — "as close to the Shimmer
 * sampling rate as possible, sensor rate >= shimmer rate", which is the
 * invariant the driver states in comment after comment and the firmware's own
 * defaults follow (`shimmer_config.c:183`, *"next highest to 51.2Hz"*).
 *
 * @param opts.enabled whether EITHER the low-noise accelerometer or the
 *   gyroscope is enabled — the two share this one rate field, and Java tests
 *   them with `||` (`SensorLSM6DSV.java:664-667`)
 * @param opts.samplingRateHz the configured packet rate
 * @param opts.lowPower request the low-power rate regardless of the packet
 *   rate, as Java's disabled-sensor default does. Pass it explicitly; do not
 *   infer it from the stored value, or a device already at 1.875 Hz stays there
 * @returns the ODR code to store in `ConfigSetupByte1`
 */
export function deriveLsm6dsvAccelGyroRate(opts: {
  enabled: boolean;
  samplingRateHz: number;
  lowPower?: boolean;
}): number {
  if (!opts.enabled) return LSM6DSV_ODR.POWER_DOWN;
  if (opts.lowPower) return LSM6DSV_ODR.LOW_POWER;
  const hz = opts.samplingRateHz;
  if (!Number.isFinite(hz) || hz <= 0) return LSM6DSV_ODR.POWER_DOWN;
  for (const [maxHz, code] of LSM6DSV_LADDER) {
    if (hz <= maxHz) return code;
  }
  // Above the top of the ladder Java falls through with the last assignment;
  // the fastest ODR is the only sane answer either way.
  return LSM6DSV_LADDER[LSM6DSV_LADDER.length - 1][1];
}

/**
 * The rate to store when the IMU's enabled state has just changed, mirroring
 * `setDefaultLSM6DSVGyroSensorConfig`: enabling clears low-power, disabling
 * sets it.
 *
 * Disabling therefore parks the sensor at 1.875 Hz rather than powering it
 * down, which is what Java does and is the state that stranded a device when
 * something later enabled the channel without re-deriving. Enabling is the only
 * thing that clears it.
 *
 * @param opts.enabled the state being applied
 * @param opts.samplingRateHz the configured packet rate
 */
export function deriveLsm6dsvRateOnEnableChange(opts: {
  enabled: boolean;
  samplingRateHz: number;
}): number {
  return opts.enabled
    ? deriveLsm6dsvAccelGyroRate({
        enabled: true,
        samplingRateHz: opts.samplingRateHz,
        lowPower: false,
      })
    : LSM6DSV_ODR.LOW_POWER;
}
