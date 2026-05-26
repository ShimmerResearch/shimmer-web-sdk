/**
 * Sensor enable bitmasks for Shimmer3 / Shimmer3R.
 *
 * Values are 24-bit integers sent as the payload of SET_SENSORS_CMD.
 * Multiple sensors are ORed together.
 *
 * @example
 * ```ts
 * const mask = SensorBitmapShimmer3.SENSOR_GYRO | SensorBitmapShimmer3.SENSOR_A_ACCEL;
 * await client.setSensors(mask);
 * ```
 */
export const SensorBitmapShimmer3 = Object.freeze({
  SENSOR_A_ACCEL: 0x000080,
  SENSOR_GYRO: 0x000040,
  SENSOR_MAG: 0x000020,
  SENSOR_GSR: 0x000004,

  SENSOR_VBATT: 0x002000,
  SENSOR_D_ACCEL: 0x001000,
  SENSOR_PRESSURE: 0x040000,
  SENSOR_EXG1_24BIT: 0x000010,
  SENSOR_EXG2_24BIT: 0x000008,
  SENSOR_EXG1_16BIT: 0x100000,
  SENSOR_EXG2_16BIT: 0x080000,
  SENSOR_BRIDGE_AMP: 0x008000,
  SENSOR_ACCEL_ALT: 0x400000,
  SENSOR_MAG_ALT: 0x200000,

  SENSOR_EXT_A0: 0x000002,
  SENSOR_EXT_A1: 0x000001,
  SENSOR_EXT_A2: 0x000800,
  SENSOR_INT_A3: 0x000400,
  SENSOR_INT_A0: 0x000200,
  SENSOR_INT_A1: 0x000100,
  SENSOR_INT_A2: 0x800000,
} as const);

export type SensorBitmapShimmer3Key = keyof typeof SensorBitmapShimmer3;
