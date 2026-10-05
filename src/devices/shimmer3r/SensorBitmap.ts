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

/**
 * Map a channel/signal ID from an inquiry response onto the
 * {@link SensorBitmapShimmer3} bit that enables it, or 0 when the ID has no
 * enable bit of its own.
 *
 * ORing these over a channel list reconstructs the enabled-sensor mask the
 * device is actually running, which is what `SET_SENSORS_CMD` would have to
 * send to reproduce it. Ported from
 * `ShimmerObject#interpretDataPacketFormat`, whose Shimmer3 and Shimmer3R
 * branches map the two generations' names for the shared ADC IDs onto the same
 * bits (`ShimmerObject.java:4081-4126`) — e.g. 0x0D is `ExtAdc7` on a Shimmer3
 * and `ExtAdc9` on a Shimmer3R, and both set `SENSOR_EXT_A0`. So this mapping
 * needs no generation of its own, unlike the channel *format* table.
 */
export function channelIdToSensorBit(id: number): number {
  switch (id) {
    case 0x00:
    case 0x01:
    case 0x02:
      return SensorBitmapShimmer3.SENSOR_A_ACCEL;
    case 0x03:
      return SensorBitmapShimmer3.SENSOR_VBATT;
    case 0x04:
    case 0x05:
    case 0x06:
      return SensorBitmapShimmer3.SENSOR_D_ACCEL;
    case 0x07:
    case 0x08:
    case 0x09:
      return SensorBitmapShimmer3.SENSOR_MAG;
    case 0x0a:
    case 0x0b:
    case 0x0c:
      return SensorBitmapShimmer3.SENSOR_GYRO;
    case 0x0d:
      return SensorBitmapShimmer3.SENSOR_EXT_A0;
    case 0x0e:
      return SensorBitmapShimmer3.SENSOR_EXT_A1;
    case 0x0f:
      return SensorBitmapShimmer3.SENSOR_EXT_A2;
    case 0x10:
      return SensorBitmapShimmer3.SENSOR_INT_A3;
    case 0x11:
      return SensorBitmapShimmer3.SENSOR_INT_A0;
    case 0x12:
      return SensorBitmapShimmer3.SENSOR_INT_A1;
    case 0x13:
      return SensorBitmapShimmer3.SENSOR_INT_A2;
    case 0x14:
    case 0x15:
    case 0x16:
      return SensorBitmapShimmer3.SENSOR_ACCEL_ALT;
    case 0x17:
    case 0x18:
    case 0x19:
      return SensorBitmapShimmer3.SENSOR_MAG_ALT;
    // Pressure and temperature are enabled together by one bit — the firmware
    // packs the pair or neither (`chEnPressureAndTemperature`).
    case 0x1a:
    case 0x1b:
      return SensorBitmapShimmer3.SENSOR_PRESSURE;
    case 0x1c:
      return SensorBitmapShimmer3.SENSOR_GSR;
    case 0x1e:
    case 0x1f:
      return SensorBitmapShimmer3.SENSOR_EXG1_24BIT;
    case 0x21:
    case 0x22:
      return SensorBitmapShimmer3.SENSOR_EXG2_24BIT;
    case 0x23:
    case 0x24:
      return SensorBitmapShimmer3.SENSOR_EXG1_16BIT;
    case 0x25:
    case 0x26:
      return SensorBitmapShimmer3.SENSOR_EXG2_16BIT;
    case 0x27:
    case 0x28:
      return SensorBitmapShimmer3.SENSOR_BRIDGE_AMP;
    // 0x1D / 0x20 are the ExG status bytes: they ride along with whichever ExG
    // block is enabled and have no bit of their own.
    default:
      return 0;
  }
}
