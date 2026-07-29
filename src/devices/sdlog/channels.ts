/**
 * SD-log channel tables and raw datatype decoding.
 *
 * Ported from the Shimmer Java driver:
 *   ShimmerSDLog#interpretdatapacketformat  — Shimmer3 enabled-sensors channel order
 *   ShimmerObject#interpretDataPacketFormat(nChannels, signalIds) — Shimmer3R
 *     dynamic signal-ID table (HW_ID.SHIMMER_3R branches)
 *   UtilParseData#parseData(byte[], String[]) — datatype byte semantics
 *
 * Datatype string conventions (UtilParseData): suffix `r` = big-endian,
 * otherwise little-endian; `i` = signed two's complement, `u` = unsigned;
 * `i12*>` = Shimmer3R high-g accel packing (MSB << 4 | LSB >> 4).
 */

import { SDLogHeaderBitmask as BM, hasSensorBit } from './constants.js';
import type { SdLogChannel } from './types.js';

/** Raw encodings used by SD-log channels (subset of UtilParseData's set). */
export type SdLogDataType =
  | 'u8'
  | 'u12'
  | 'u14'
  | 'u16'
  | 'u16r'
  | 'i16'
  | 'i16r'
  | 'u24'
  | 'u24r'
  | 'i24r'
  | 'u32r'
  | 'i32r'
  | 'i12*>';

export const SDLOG_DATA_TYPE_BYTES: Readonly<Record<SdLogDataType, number>> = Object.freeze({
  u8: 1,
  u12: 2,
  u14: 2,
  u16: 2,
  u16r: 2,
  i16: 2,
  i16r: 2,
  u24: 3,
  u24r: 3,
  i24r: 3,
  u32r: 4,
  i32r: 4,
  'i12*>': 2,
});

/** Internal channel descriptor: public shape plus the raw encoding. */
export interface SdLogChannelSpec extends SdLogChannel {
  dataType: SdLogDataType;
  sizeBytes: number;
}

function sign(value: number, bits: number): number {
  return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
}

/**
 * Decode one channel value at `off` in `bytes`.
 *
 * Mirrors UtilParseData.parseData(byte[], String[]) exactly — including the
 * quirk that `u12`/`u14` are read as full unsigned 16-bit little-endian values
 * with no masking (the firmware guarantees the upper bits are zero).
 */
export function decodeSdLogValue(bytes: Uint8Array, off: number, type: SdLogDataType): number {
  switch (type) {
    case 'u8':
      return bytes[off];
    case 'u12':
    case 'u14':
    case 'u16':
      return bytes[off] | (bytes[off + 1] << 8);
    case 'u16r':
      return (bytes[off] << 8) | bytes[off + 1];
    case 'i16':
      return sign(bytes[off] | (bytes[off + 1] << 8), 16);
    case 'i16r':
      return sign((bytes[off] << 8) | bytes[off + 1], 16);
    case 'u24':
      return bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16);
    case 'u24r':
      return (bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2];
    case 'i24r':
      return sign((bytes[off] << 16) | (bytes[off + 1] << 8) | bytes[off + 2], 24);
    case 'u32r':
      return bytes[off] * 2 ** 24 + (bytes[off + 1] << 16) + (bytes[off + 2] << 8) + bytes[off + 3];
    case 'i32r':
      // JS 32-bit bitwise OR yields the signed two's-complement result directly.
      return (bytes[off] << 24) | (bytes[off + 1] << 16) | (bytes[off + 2] << 8) | bytes[off + 3];
    case 'i12*>':
      // Shimmer3R high-g accel: MSB byte << 4 OR'd with upper nibble of the
      // LSB byte, then 12-bit two's complement (UtilParseData "i12*>").
      return sign((bytes[off] << 4) | (bytes[off + 1] >> 4), 12);
  }
}

const uncal = (name: string, dataType: SdLogDataType): SdLogChannelSpec => ({
  name,
  unit: null,
  calibrated: false,
  dataType,
  sizeBytes: SDLOG_DATA_TYPE_BYTES[dataType],
});

/**
 * GSR is the one channel with a reusable calibration path in this SDK (the
 * amplifier-equation conversion shared by Shimmer3Client/Shimmer3RClient), so
 * the decoder emits it calibrated, in µS.
 */
const gsrChannel = (): SdLogChannelSpec => ({
  name: 'GSR',
  unit: 'uSiemens',
  calibrated: true,
  dataType: 'u16',
  sizeBytes: 2,
});

/**
 * Build the Shimmer3 (256-byte header) channel list from the enabled-sensors
 * value. The order and datatypes replicate the "modern Shimmer3" branch of
 * ShimmerSDLog#interpretdatapacketformat (ShimmerSDLog.java lines 817-1271)
 * exactly, including the legacy-magnetometer X, Z, Y ordering.
 *
 * @param enabledSensors 40-bit enabled-sensors value from the header.
 * @param newImuSensors  True when the expansion-board bytes identify a
 *   new-IMU board (LSM303AHTR/MPU9250/BMP280 generation) — flips the mag
 *   channels to little-endian X, Y, Z and renames the BMP channels.
 */
export function buildShimmer3SdLogChannels(
  enabledSensors: number,
  newImuSensors: boolean,
): SdLogChannelSpec[] {
  const has = (mask: number): boolean => hasSensorBit(enabledSensors, mask);
  const ch: SdLogChannelSpec[] = [];

  if (has(BM.ACCEL_LN)) {
    ch.push(uncal('LN_ACCEL_X', 'u12'), uncal('LN_ACCEL_Y', 'u12'), uncal('LN_ACCEL_Z', 'u12'));
  }
  if (has(BM.BATTERY)) ch.push(uncal('BATTERY', 'u12'));
  if (has(BM.EXT_EXP_A7)) ch.push(uncal('EXT_EXP_ADC_A7', 'u12'));
  if (has(BM.EXT_EXP_A6)) ch.push(uncal('EXT_EXP_ADC_A6', 'u12'));
  if (has(BM.EXT_EXP_A15)) ch.push(uncal('EXT_EXP_ADC_A15', 'u12'));
  if (has(BM.INT_EXP_A12)) ch.push(uncal('INT_EXP_ADC_A12', 'u12'));
  if (has(BM.INT_EXP_A13)) ch.push(uncal('INT_EXP_ADC_A13', 'u12'));
  if (has(BM.INT_EXP_A14)) ch.push(uncal('INT_EXP_ADC_A14', 'u12'));
  if (has(BM.BRIDGE_AMP)) {
    ch.push(uncal('BRIDGE_AMP_HIGH', 'u12'), uncal('BRIDGE_AMP_LOW', 'u12'));
  }
  if (has(BM.GSR)) ch.push(gsrChannel());
  if (has(BM.INT_EXP_A1)) ch.push(uncal('INT_EXP_ADC_A1', 'u12'));
  if (has(BM.GYRO)) {
    // Modern (non-legacy) SD logs store the MPU gyro big-endian.
    ch.push(uncal('GYRO_X', 'i16r'), uncal('GYRO_Y', 'i16r'), uncal('GYRO_Z', 'i16r'));
  }
  if (has(BM.ACCEL_WR)) {
    ch.push(uncal('WR_ACCEL_X', 'i16'), uncal('WR_ACCEL_Y', 'i16'), uncal('WR_ACCEL_Z', 'i16'));
  }
  if (has(BM.MAG)) {
    if (newImuSensors) {
      // LSM303AHTR: little-endian, natural X, Y, Z order.
      ch.push(uncal('MAG_X', 'i16'), uncal('MAG_Y', 'i16'), uncal('MAG_Z', 'i16'));
    } else {
      // LSM303DLHC: big-endian, X, Z, Y on-disk order.
      // HARDWARE-VERIFY: old-IMU mag channel order (X, Z, Y) and endianness
      // taken from ShimmerSDLog.java:980-990; verify against a real SR31<6 log.
      ch.push(uncal('MAG_X', 'i16r'), uncal('MAG_Z', 'i16r'), uncal('MAG_Y', 'i16r'));
    }
  }
  if (has(BM.ACCEL_MPU)) {
    ch.push(
      uncal('ACCEL_MPU_X', 'i16r'),
      uncal('ACCEL_MPU_Y', 'i16r'),
      uncal('ACCEL_MPU_Z', 'i16r'),
    );
  }
  if (has(BM.MAG_MPU)) {
    ch.push(uncal('MAG_MPU_X', 'i16'), uncal('MAG_MPU_Y', 'i16'), uncal('MAG_MPU_Z', 'i16'));
  }
  if (has(BM.BMPX80)) {
    const suffix = newImuSensors ? 'BMP280' : 'BMP180';
    ch.push(uncal(`TEMPERATURE_${suffix}`, 'u16r'));
    ch.push(uncal(`PRESSURE_${suffix}`, 'u24r'));
  }
  if (has(BM.EXG1_24BIT)) {
    ch.push(
      uncal('Exg1_Status', 'u8'),
      uncal('Exg1_CH1_24Bit', 'i24r'),
      uncal('Exg1_CH2_24Bit', 'i24r'),
    );
  }
  if (has(BM.EXG2_24BIT)) {
    ch.push(
      uncal('Exg2_Status', 'u8'),
      uncal('Exg2_CH1_24Bit', 'i24r'),
      uncal('Exg2_CH2_24Bit', 'i24r'),
    );
  }
  if (has(BM.EXG1_16BIT)) {
    ch.push(
      uncal('Exg1_Status', 'u8'),
      uncal('Exg1_CH1_16Bit', 'i16r'),
      uncal('Exg1_CH2_16Bit', 'i16r'),
    );
  }
  if (has(BM.EXG2_16BIT)) {
    ch.push(
      uncal('Exg2_Status', 'u8'),
      uncal('Exg2_CH1_16Bit', 'i16r'),
      uncal('Exg2_CH2_16Bit', 'i16r'),
    );
  }
  if (has(BM.MPL_QUAT_6DOF)) {
    ch.push(
      uncal('QUAT_MPL_6DOF_W', 'i32r'),
      uncal('QUAT_MPL_6DOF_X', 'i32r'),
      uncal('QUAT_MPL_6DOF_Y', 'i32r'),
      uncal('QUAT_MPL_6DOF_Z', 'i32r'),
    );
  }
  if (has(BM.MPL_QUAT_9DOF)) {
    ch.push(
      uncal('QUAT_MPL_9DOF_W', 'i32r'),
      uncal('QUAT_MPL_9DOF_X', 'i32r'),
      uncal('QUAT_MPL_9DOF_Y', 'i32r'),
      uncal('QUAT_MPL_9DOF_Z', 'i32r'),
    );
  }
  if (has(BM.MPL_EULER_6DOF)) {
    ch.push(
      uncal('EULER_MPL_6DOF_X', 'i32r'),
      uncal('EULER_MPL_6DOF_Y', 'i32r'),
      uncal('EULER_MPL_6DOF_Z', 'i32r'),
    );
  }
  if (has(BM.MPL_EULER_9DOF)) {
    ch.push(
      uncal('EULER_MPL_9DOF_X', 'i32r'),
      uncal('EULER_MPL_9DOF_Y', 'i32r'),
      uncal('EULER_MPL_9DOF_Z', 'i32r'),
    );
  }
  if (has(BM.MPL_HEADING)) ch.push(uncal('MPL_HEADING', 'i32r'));
  if (has(BM.MPL_TEMPERATURE)) ch.push(uncal('MPL_TEMPERATURE', 'i32r'));
  if (has(BM.MPL_PEDOMETER)) {
    ch.push(uncal('MPL_PEDOM_CNT', 'u32r'), uncal('MPL_PEDOM_TIME', 'u32r'));
  }
  if (has(BM.MPL_TAP)) ch.push(uncal('TAPDIRANDTAPCNT', 'u8'));
  if (has(BM.MPL_MOTION_ORIENT)) ch.push(uncal('MOTIONANDORIENT', 'u8'));
  if (has(BM.GYRO_MPU_MPL)) {
    ch.push(
      uncal('GYRO_MPU_MPL_X', 'i32r'),
      uncal('GYRO_MPU_MPL_Y', 'i32r'),
      uncal('GYRO_MPU_MPL_Z', 'i32r'),
    );
  }
  if (has(BM.ACCEL_MPU_MPL)) {
    ch.push(
      uncal('ACCEL_MPU_MPL_X', 'i32r'),
      uncal('ACCEL_MPU_MPL_Y', 'i32r'),
      uncal('ACCEL_MPU_MPL_Z', 'i32r'),
    );
  }
  if (has(BM.MAG_MPU_MPL)) {
    ch.push(
      uncal('MAG_MPU_MPL_X', 'i32r'),
      uncal('MAG_MPU_MPL_Y', 'i32r'),
      uncal('MAG_MPU_MPL_Z', 'i32r'),
    );
  }
  if (has(BM.MPL_QUAT_6DOF_RAW)) {
    ch.push(
      uncal('QUAT_DMP_6DOF_W', 'i32r'),
      uncal('QUAT_DMP_6DOF_X', 'i32r'),
      uncal('QUAT_DMP_6DOF_Y', 'i32r'),
      uncal('QUAT_DMP_6DOF_Z', 'i32r'),
    );
  }
  if (has(BM.ECG_TO_HR_FW)) ch.push(uncal('ECG_TO_HR_FW', 'u8'));

  return ch;
}

/**
 * Shimmer3R signal-ID → channel mapping, replicating the HW_ID.SHIMMER_3R
 * branches of ShimmerObject#interpretDataPacketFormat(nChannels, signalIds).
 * Names follow the SDK's streaming CHANNEL_FORMATS where an equivalent exists.
 */
const SHIMMER3R_SIGNAL_ID_TABLE: Readonly<Record<number, SdLogChannelSpec>> = Object.freeze({
  0x00: uncal('LN_ACCEL_X', 'i16'),
  0x01: uncal('LN_ACCEL_Y', 'i16'),
  0x02: uncal('LN_ACCEL_Z', 'i16'),
  // HARDWARE-VERIFY: the Shimmer3R dynamic table types BATTERY as signed i16
  // (ShimmerObject.java:3030-3033) even though the ADC value is unsigned —
  // ported as-is; confirm against a real Shimmer3R log with battery enabled.
  0x03: uncal('BATTERY', 'i16'),
  0x04: uncal('WR_ACCEL_X', 'i16'),
  0x05: uncal('WR_ACCEL_Y', 'i16'),
  0x06: uncal('WR_ACCEL_Z', 'i16'),
  0x07: uncal('MAG_X', 'i16'),
  0x08: uncal('MAG_Y', 'i16'),
  0x09: uncal('MAG_Z', 'i16'),
  0x0a: uncal('GYRO_X', 'i16'),
  0x0b: uncal('GYRO_Y', 'i16'),
  0x0c: uncal('GYRO_Z', 'i16'),
  0x0d: uncal('EXT_ADC_0', 'u14'),
  0x0e: uncal('EXT_ADC_1', 'u14'),
  0x0f: uncal('EXT_ADC_2', 'u14'),
  0x10: uncal('INT_ADC_3', 'u14'),
  0x11: uncal('INT_ADC_0', 'u14'),
  0x12: uncal('INT_ADC_1', 'u14'),
  0x13: uncal('INT_ADC_2', 'u14'),
  0x14: uncal('HG_ACCEL_X', 'i12*>'),
  0x15: uncal('HG_ACCEL_Y', 'i12*>'),
  0x16: uncal('HG_ACCEL_Z', 'i12*>'),
  0x17: uncal('ALT_MAG_X', 'i16'),
  0x18: uncal('ALT_MAG_Y', 'i16'),
  0x19: uncal('ALT_MAG_Z', 'i16'),
  0x1a: uncal('TEMPERATURE_BMP390', 'u24'),
  0x1b: uncal('PRESSURE_BMP390', 'u24'),
  0x1c: gsrChannel(),
  0x1d: uncal('Exg1_Status', 'u8'),
  0x1e: uncal('Exg1_CH1_24Bit', 'i24r'),
  0x1f: uncal('Exg1_CH2_24Bit', 'i24r'),
  0x20: uncal('Exg2_Status', 'u8'),
  0x21: uncal('Exg2_CH1_24Bit', 'i24r'),
  0x22: uncal('Exg2_CH2_24Bit', 'i24r'),
  0x23: uncal('Exg1_CH1_16Bit', 'i16r'),
  0x24: uncal('Exg1_CH2_16Bit', 'i16r'),
  0x25: uncal('Exg2_CH1_16Bit', 'i16r'),
  0x26: uncal('Exg2_CH2_16Bit', 'i16r'),
  0x27: uncal('BRIDGE_AMP_HIGH', 'u12'),
  0x28: uncal('BRIDGE_AMP_LOW', 'u12'),
});

/**
 * Build the Shimmer3R (384-byte header) channel list from the dynamic
 * channel table stored in the header (byte 314 = nChannels, bytes 315.. =
 * signal IDs). Unknown IDs fall back to a `u12` channel named after the ID,
 * matching the Java catch-all (ShimmerObject.java:3579-3583).
 */
export function buildShimmer3RSdLogChannels(signalIds: ArrayLike<number>): SdLogChannelSpec[] {
  const ch: SdLogChannelSpec[] = [];
  for (let i = 0; i < signalIds.length; i++) {
    const id = signalIds[i];
    const spec = SHIMMER3R_SIGNAL_ID_TABLE[id];
    ch.push(spec ? { ...spec } : uncal(String(id), 'u12'));
  }
  return ch;
}
