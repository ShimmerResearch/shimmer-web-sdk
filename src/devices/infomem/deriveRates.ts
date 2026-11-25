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
 * `eclipse-java-workspace_2024`, and from `SensorLIS2DW12` for the wide-range
 * accelerometer (below), against `Shimmer-Java-Android-API` master.
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

// ---------------------------------------------------------------------------
// LIS2DW12 — Shimmer3R wide-range accelerometer
// ---------------------------------------------------------------------------
//
// Ported from `SensorLIS2DW12.getAccelRateFromFreq` and
// `setDefaultLIS2DW12AccelSensorConfig` (Shimmer-Java-Android-API
// `ShimmerDriver/.../sensors/lis2dw12/SensorLIS2DW12.java`, master).
//
// Unlike the LSM6DSV, the LIS2DW12's low-power state is NOT read back from its
// rate. It is two bits of ConfigSetupByte0 beside the rate:
//
//   bit 1  `wrAccelLpModeLsb` — Java's `mLowPowerAccelWR`
//   bit 0  `wrAccelHrMode`    — Java's `mHighPerModeAccelWR`
//
// and the firmware hands the part `(wrAccelHrMode << 2) | lpMode` as its power
// mode (`ShimConfig_wrAccelModeGet`, log-and-stream-common
// `Configuration/shimmer_config.c`). `LIS2DW12_HIGH_PERFORMANCE` is 0x04, so
// **bit 0 alone decides high performance against low power**: with it clear
// the part runs in one of its continuous low-power modes whatever bit 1 says,
// and no low-power mode goes faster than 200 Hz. Java never lets the two
// disagree — `setLowPowerAccelWR(enable)` sets bit 1 to `enable` and bit 0 to
// `!enable` — which is why the defaults below always return them as a pair.

/** LIS2DW12 ODR codes with a meaning beyond "this many Hz". */
export const LIS2DW12_ODR = Object.freeze({
  /** Sensor off. What the driver writes for a disabled wide-range accelerometer. */
  POWER_DOWN: 0,
  /**
   * `LIS2DW12_XL_ODR_1Hz6_LP_ONLY`: 1.6 Hz in a low-power mode, 12.5 Hz in high
   * performance. Java's ladder gives it for `freq <= 12.5` (high performance,
   * where it really is 12.5 Hz) and for every rate when low-power is asked for
   * (where it is 1.6 Hz).
   */
  LOW_POWER: 1,
} as const);

/**
 * The fastest output rate the LIS2DW12 delivers in any low-power mode. ODR
 * codes 7-9 saturate here (`SensorLIS2DW12.ListofLIS2DW12AccelRateLpm`, and the
 * firmware's `ShimConfig_lis2dw12OdrToHz`).
 */
export const LIS2DW12_LOW_POWER_MAX_HZ = 200;

/**
 * The ladder from `getAccelRateFromFreq`'s high-performance branch, as
 * `[maxFreqHz, code]` pairs in the order Java tests them. Code 2 is absent
 * because Java gives code 1 for `freq <= 12.5` — 12.5 Hz in high performance,
 * the only mode this branch is ever paired with.
 */
const LIS2DW12_LADDER: readonly (readonly [number, number])[] = Object.freeze([
  [12.5, 1],
  [25, 3],
  [50, 4],
  [100, 5],
  [200, 6],
  [400, 7],
  [800, 8],
]);

/** The fastest ODR code, 1600 Hz in high performance. */
const LIS2DW12_TOP_CODE = 9;

/**
 * The LIS2DW12 ODR code for a packet rate — `getAccelRateFromFreq(isEnabled,
 * freq, isLowPowerMode)`, same inputs, same results.
 *
 * @param opts.enabled whether the wide-range accelerometer is enabled
 * @param opts.samplingRateHz the configured packet rate
 * @param opts.lowPower Java's `mLowPowerAccelWR`. When set, Java answers code 1
 *   (1.6 Hz in a low-power mode) whatever the packet rate. A host that never
 *   wants a rate below its packet rate passes false
 * @returns the ODR code to store in ConfigSetupByte0 bits 4-7. A non-finite or
 *   non-positive packet rate gives power-down, as
 *   {@link deriveLsm6dsvAccelGyroRate} does, rather than Java's fall-through
 */
export function deriveLis2dw12AccelRate(opts: {
  enabled: boolean;
  samplingRateHz: number;
  lowPower?: boolean;
}): number {
  if (!opts.enabled) return LIS2DW12_ODR.POWER_DOWN;
  if (opts.lowPower) return LIS2DW12_ODR.LOW_POWER;
  const hz = opts.samplingRateHz;
  if (!Number.isFinite(hz) || hz <= 0) return LIS2DW12_ODR.POWER_DOWN;
  for (const [maxHz, code] of LIS2DW12_LADDER) {
    if (hz <= maxHz) return code;
  }
  return LIS2DW12_TOP_CODE;
}

/** The ConfigSetupByte0 fields a LIS2DW12 enable or disable sets. */
export interface Lis2dw12AccelDefaults {
  /** ODR code, bits 4-7. */
  rate: number;
  /** Range code, bits 2-3; null leaves the stored range alone. */
  range: number | null;
  /** Bit 1, `wrAccelLpModeLsb` (Java `mLowPowerAccelWR`). */
  lowPower: boolean;
  /** Bit 0, `wrAccelHrMode` (Java `mHighPerModeAccelWR`); always `!lowPower`. */
  highPerformance: boolean;
}

/**
 * What to store when the wide-range accelerometer's enabled state has just
 * changed — `setDefaultLIS2DW12AccelSensorConfig(isSensorEnabled)`.
 *
 * - **Enabled:** `setLowPowerAccelWR(false)` — low-power off, high-performance
 *   on, and the rate re-derived from the packet rate. The range is kept.
 * - **Disabled:** `setLIS2DW12AccelRange(0)` then `setLowPowerAccelWR(true)` —
 *   ±2 g, low-power on, high-performance off, and the rate re-derived. Java
 *   sets the enabled state before it applies these defaults
 *   (`ShimmerDevice.setSensorEnabledState`), so that re-derivation sees a
 *   disabled sensor and gives power-down. ConfigSetupByte0 ends up `0x02`.
 *
 * The disabled default is the state that stranded a Shimmer3R: a host that
 * later enables the channel without applying the enabled default leaves bit 0
 * clear, and the part in a low-power mode that cannot pass 200 Hz.
 *
 * @param opts.enabled the state being applied
 * @param opts.samplingRateHz the configured packet rate
 */
export function deriveLis2dw12ConfigOnEnableChange(opts: {
  enabled: boolean;
  samplingRateHz: number;
}): Lis2dw12AccelDefaults {
  if (opts.enabled) {
    return {
      rate: deriveLis2dw12AccelRate({
        enabled: true,
        samplingRateHz: opts.samplingRateHz,
        lowPower: false,
      }),
      range: null,
      lowPower: false,
      highPerformance: true,
    };
  }
  return {
    rate: LIS2DW12_ODR.POWER_DOWN,
    range: 0,
    lowPower: true,
    highPerformance: false,
  };
}
