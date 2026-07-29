/**
 * Constants for the Shimmer3 / Shimmer3R binary SD-log file format.
 *
 * Ported from the Shimmer Java driver:
 *   com.shimmerresearch.binaryfile.ShimmerSDLog (header layout + read loop)
 *   com.shimmerresearch.driver.ShimmerObject.SDLogHeader (sensor bitmasks)
 *   com.shimmerresearch.driverUtilities.ShimmerVerDetails (HW_ID / FW_ID)
 */

/** Shimmer hardware identifiers (ShimmerVerDetails.HW_ID). */
export const SDLOG_HW_ID = Object.freeze({
  SHIMMER_3: 3,
  SHIMMER_3R: 10,
} as const);

/** Firmware identifiers (ShimmerVerDetails.FW_ID). */
export const SDLOG_FW_ID = Object.freeze({
  BTSTREAM: 1,
  SDLOG: 2,
  LOGANDSTREAM: 3,
  GQ_BLE: 5,
  GQ_802154: 9,
  STROKARE: 15,
} as const);

/** SD-log header lengths in bytes, keyed by generation. */
export const SDLOG_HEADER_LENGTH = Object.freeze({
  /** SDLog v0.5.x (unsupported — rejected with LEGACY_UNSUPPORTED). */
  LEGACY: 178,
  /** Modern Shimmer3 (SDLog >= 0.8.69, LogAndStream >= 0.5.0). */
  SHIMMER3: 256,
  /** Shimmer3R. */
  SHIMMER3R: 384,
} as const);

/** The 32 kHz sampling/RTC clock frequency shared by Shimmer3 and Shimmer3R. */
export const SDLOG_CLOCK_FREQ = 32768;

/**
 * Length in bytes of the sync timestamp-offset field prefixed to the first
 * sample of each 512-byte block when "sync when logging" is enabled
 * (ShimmerObject.OFFSET_LENGTH — always 9 for modern firmware; the 5-byte
 * variant only exists on legacy SDLog 0.5.x, which is out of scope).
 */
export const SDLOG_SYNC_OFFSET_LENGTH = 9;

/** SD sector size used for the sync-when-logging block framing. */
export const SDLOG_SYNC_BLOCK_LENGTH = 512;

/**
 * Enabled-sensor bitmasks as stored in SD-log header bytes 3-7 (40-bit,
 * LSB-first). Ported verbatim from ShimmerObject.SDLogHeader (values > 2^31
 * are plain numbers — always test them with {@link hasSensorBit}, never with
 * 32-bit bitwise operators).
 */
export const SDLogHeaderBitmask = Object.freeze({
  ACCEL_LN: 1 << 7,
  GYRO: 1 << 6,
  MAG: 1 << 5,
  EXG1_24BIT: 1 << 4,
  EXG2_24BIT: 1 << 3,
  GSR: 1 << 2,
  EXT_EXP_A7: 1 << 1,
  EXT_EXP_A6: 1 << 0,
  BRIDGE_AMP: 1 << 15,
  ECG_TO_HR_FW: 1 << 14,
  BATTERY: 1 << 13,
  ACCEL_WR: 1 << 12,
  EXT_EXP_A15: 1 << 11,
  INT_EXP_A1: 1 << 10,
  INT_EXP_A12: 1 << 9,
  INT_EXP_A13: 1 << 8,
  INT_EXP_A14: 1 << 23,
  ACCEL_MPU: 1 << 22,
  MAG_MPU: 1 << 21,
  EXG1_16BIT: 1 << 20,
  EXG2_16BIT: 1 << 19,
  BMPX80: 1 << 18,
  MPL_TEMPERATURE: 1 << 17,
  MPL_QUAT_6DOF: 2 ** 31,
  MPL_QUAT_9DOF: 1 << 30,
  MPL_EULER_6DOF: 1 << 29,
  MPL_EULER_9DOF: 1 << 28,
  MPL_HEADING: 1 << 27,
  MPL_PEDOMETER: 1 << 26,
  MPL_TAP: 1 << 25,
  MPL_MOTION_ORIENT: 1 << 24,
  GYRO_MPU_MPL: 2 ** 39,
  ACCEL_MPU_MPL: 2 ** 38,
  MAG_MPU_MPL: 2 ** 37,
  MPL_QUAT_6DOF_RAW: 2 ** 36,
} as const);

/**
 * Test a bit in the (up to 40-bit) enabled-sensors value. JavaScript bitwise
 * operators truncate to 32 bits, so masks >= 2^31 must be tested arithmetically.
 */
export function hasSensorBit(enabledSensors: number, mask: number): boolean {
  return Math.floor(enabledSensors / mask) % 2 === 1;
}

/**
 * Expansion-board hardware SR codes used by the "new IMU" detection
 * (ShimmerVerDetails.HW_ID_SR_CODES).
 */
export const SDLOG_EXP_BRD_ID = Object.freeze({
  SHIMMER3: 31,
  PROTO3_MINI: 36,
  PROTO3_DELUXE: 38,
  ADXL377_ACCEL_200G: 44,
  EXG_UNIFIED: 47,
  GSR_UNIFIED: 48,
  BR_AMP_UNIFIED: 49,
} as const);
