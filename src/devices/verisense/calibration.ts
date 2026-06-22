/**
 * Verisense sensor-calibration TLV codec.
 *
 * Mirrors the firmware `asm_calibration.{c,h}` byte format. A calibration "blob"
 * is a self-describing block of per-sensor calibration that the device persists,
 * exposes over the `CALIBRATION` command, and stamps into every logged payload
 * header via a CRC-16 version tag.
 *
 * Layout (all little-endian):
 *
 *   Global header (12 bytes)
 *     0  u16  totalLen          (= blob.length - 2)
 *     2  u8   calibFormatVersion
 *     3  u8   hwVerMajor
 *     4  u8   hwVerMinor
 *     5  u8   fwVerMajor
 *     6  u8   fwVerMinor
 *     7  u16  fwVerPatch
 *     9  u8   sensorBlockCount
 *    10  u16  reserved
 *
 *   Per-sensor block (12-byte header + payload)
 *     0  u16  sensorId          (calibration-domain id, see {@link CalibSensorId})
 *     2  u8   range/quality     (bits[5:0] full-scale index; bits[7:6] calib quality)
 *     3  u8   dataLen
 *     4  u8[8] ts               (0 = default/seeded; RTC time = real per-unit cal)
 *    12  payload[dataLen]
 *
 *   IMU payload (60 bytes, float32): bias[3] · sens[3] · align[9] (row-major 3x3)
 *
 * Calibration math (ASM-DES04 §8): output = K·R·physical + b, so the host
 * recovers physical = R⁻¹·K⁻¹·(raw − b). K is the diagonal sensitivity, R the
 * rotation into the common ASM axes, b the offset bias.
 */

import { u16le_at, f32le, crc16_ccitt_false } from './protocolUtils.js';

export const SC_CALIB_FORMAT_VERSION = 1;
export const SC_GLOBAL_HEADER_BYTES = 12;
export const SC_BLOCK_HEADER_BYTES = 12;
export const SC_TS_BYTES = 8;
export const SC_DATA_LEN_IMU = 60;

/**
 * The per-block `range` byte packs the full-scale index in bits [5:0] and a 2-bit
 * calibration-quality indicator in bits [7:6]. Lookups/comparisons must use only
 * the index (`range & SC_CAL_RANGE_MASK`). Quality has no producer yet (always 0),
 * so it is reserved without growing the blob or bumping the format version.
 */
export const SC_CAL_RANGE_MASK = 0x3f;
export const SC_CAL_QUALITY_SHIFT = 6;
export const SC_CAL_QUALITY_MASK = 0x03;

/** Calibration-quality indicator (ST MotionAC / Android sensor-accuracy convention). */
export const CalibQuality = {
  UNKNOWN: 0,
  POOR: 1,
  OK: 2,
  GOOD: 3,
} as const;
export type CalibQuality = (typeof CalibQuality)[keyof typeof CalibQuality];

/**
 * Calibration-domain sensor IDs. Distinct from the data-stream sensor IDs
 * (1=ADC, 2=LIS2DW12, 3=LSM6DS3, 4=PPG, 6=LSM6DSV, 7=VD6283, 8=MAX32674,
 * 9=MLX90632). These reuse the Shimmer3 `SC_SENSOR_*` values where they exist,
 * so accel/gyro/mag can each carry their own calibration even though one
 * data-stream id (6) covers all three.
 *
 * Data-stream → calibration mapping: 6 → {37, 38, 42}, 2 → {39}, 3 → {40, 41}.
 */
export const CalibSensorId = {
  LSM6DSV_ACCEL: 37,
  LSM6DSV_GYRO: 38,
  LIS2DW12_ACCEL: 39,
  /** 1st-gen LSM6DS3 accel (data-stream id 3). */
  LSM6DS3_ACCEL: 40,
  /** 1st-gen LSM6DS3 gyro (data-stream id 3). */
  LSM6DS3_GYRO: 41,
  LIS2MDL_MAG: 42,
} as const;
export type CalibSensorId = (typeof CalibSensorId)[keyof typeof CalibSensorId];

/** Per-unit IMU calibration: offset bias, diagonal sensitivity, and 3x3 rotation. */
export interface ImuCalibration {
  /** Offset bias `b`, per axis (sensor LSB). */
  bias: [number, number, number];
  /** Diagonal sensitivity `K`, per axis (LSB per physical unit). */
  sens: [number, number, number];
  /** Rotation `R`, row-major 3x3 (length 9), mapping sensor axes to ASM axes. */
  align: number[];
}

export interface CalibrationBlock {
  sensorId: number;
  /** Full-scale index (the low 6 bits of the wire `range` byte). */
  range: number;
  /** Calibration quality, bits [7:6] of the wire `range` byte (0 = unknown today). */
  quality: number;
  dataLen: number;
  /** 8-byte calibration timestamp; all-zero means default/seeded. */
  ts: Uint8Array;
  isDefault: boolean;
  payload: Uint8Array;
  /** Decoded IMU calibration when the block is a 60-byte IMU payload. */
  imu?: ImuCalibration;
}

export interface CalibrationSet {
  formatVersion: number;
  hwVerMajor: number;
  hwVerMinor: number;
  fwVerMajor: number;
  fwVerMinor: number;
  fwVerPatch: number;
  reserved: number;
  blocks: CalibrationBlock[];
  /** CRC-16/CCITT-FALSE over the whole blob — equals the payload-header version tag. */
  crc16: number;
  /** Find the IMU calibration for a calibration-domain sensor id + range, else null. */
  getImu(sensorId: number, range: number): ImuCalibration | null;
}

function parseImuPayload(p: Uint8Array): ImuCalibration {
  return {
    bias: [f32le(p, 0), f32le(p, 4), f32le(p, 8)],
    sens: [f32le(p, 12), f32le(p, 16), f32le(p, 20)],
    align: [
      f32le(p, 24),
      f32le(p, 28),
      f32le(p, 32),
      f32le(p, 36),
      f32le(p, 40),
      f32le(p, 44),
      f32le(p, 48),
      f32le(p, 52),
      f32le(p, 56),
    ],
  };
}

/** Parse a calibration blob into a typed, indexable {@link CalibrationSet}. */
export function parseCalibrationBlob(blob: Uint8Array): CalibrationSet {
  if (blob.length < SC_GLOBAL_HEADER_BYTES) {
    throw new Error(
      `parseCalibrationBlob: blob too short (${blob.length} < ${SC_GLOBAL_HEADER_BYTES})`,
    );
  }
  const totalLen = u16le_at(blob, 0);
  if (totalLen + 2 !== blob.length) {
    throw new Error(
      `parseCalibrationBlob: totalLen ${totalLen} does not match blob.length-2 ${blob.length - 2}`,
    );
  }

  const formatVersion = blob[2];
  const hwVerMajor = blob[3];
  const hwVerMinor = blob[4];
  const fwVerMajor = blob[5];
  const fwVerMinor = blob[6];
  const fwVerPatch = u16le_at(blob, 7);
  const blockCount = blob[9];
  const reserved = u16le_at(blob, 10);

  const blocks: CalibrationBlock[] = [];
  let off = SC_GLOBAL_HEADER_BYTES;
  for (let i = 0; i < blockCount; i++) {
    if (off + SC_BLOCK_HEADER_BYTES > blob.length) {
      throw new Error(`parseCalibrationBlob: block ${i} header out of range`);
    }
    const sensorId = u16le_at(blob, off);
    const rangeByte = blob[off + 2];
    const range = rangeByte & SC_CAL_RANGE_MASK;
    const quality = (rangeByte >> SC_CAL_QUALITY_SHIFT) & SC_CAL_QUALITY_MASK;
    const dataLen = blob[off + 3];
    const ts = blob.slice(off + 4, off + 4 + SC_TS_BYTES);
    const payloadStart = off + SC_BLOCK_HEADER_BYTES;
    if (payloadStart + dataLen > blob.length) {
      throw new Error(`parseCalibrationBlob: block ${i} payload out of range`);
    }
    const payload = blob.slice(payloadStart, payloadStart + dataLen);
    const isDefault = ts.every((b) => b === 0);
    const block: CalibrationBlock = { sensorId, range, quality, dataLen, ts, isDefault, payload };
    if (dataLen === SC_DATA_LEN_IMU) {
      block.imu = parseImuPayload(payload);
    }
    blocks.push(block);
    off = payloadStart + dataLen;
  }

  const crc16 = crc16_ccitt_false(blob);

  return {
    formatVersion,
    hwVerMajor,
    hwVerMinor,
    fwVerMajor,
    fwVerMinor,
    fwVerPatch,
    reserved,
    blocks,
    crc16,
    getImu(sensorId: number, range: number): ImuCalibration | null {
      const b = blocks.find((x) => x.sensorId === sensorId && x.range === range && x.imu);
      return b?.imu ?? null;
    },
  };
}

export interface CalibrationBlockInput {
  sensorId: number;
  /** Full-scale index (only the low 6 bits are used). */
  range: number;
  /** Calibration quality (0-3); defaults to 0 (unknown). Packed into range byte bits [7:6]. */
  quality?: number;
  /** 8-byte timestamp; defaults to all-zero (a "default/seeded" marker). */
  ts?: Uint8Array | null;
  imu?: ImuCalibration;
  /** Raw payload override (used when `imu` is not supplied). */
  payload?: Uint8Array;
}

export interface CalibrationSetInput {
  formatVersion?: number;
  hwVerMajor: number;
  hwVerMinor: number;
  fwVerMajor: number;
  fwVerMinor: number;
  fwVerPatch: number;
  reserved?: number;
  blocks: CalibrationBlockInput[];
}

function serializeImuPayload(imu: ImuCalibration): Uint8Array {
  const out = new Uint8Array(SC_DATA_LEN_IMU);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < 3; i++) dv.setFloat32(i * 4, imu.bias[i] ?? 0, true);
  for (let i = 0; i < 3; i++) dv.setFloat32(12 + i * 4, imu.sens[i] ?? 0, true);
  for (let i = 0; i < 9; i++) dv.setFloat32(24 + i * 4, imu.align[i] ?? 0, true);
  return out;
}

/** Serialize a calibration set into a blob (inverse of {@link parseCalibrationBlob}). */
export function serializeCalibrationBlob(input: CalibrationSetInput): Uint8Array {
  const payloads = input.blocks.map((b) => {
    if (b.payload) return b.payload;
    if (b.imu) return serializeImuPayload(b.imu);
    throw new Error('serializeCalibrationBlob: each block needs imu or payload');
  });

  let total = SC_GLOBAL_HEADER_BYTES;
  for (const p of payloads) total += SC_BLOCK_HEADER_BYTES + p.length;

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);

  dv.setUint16(0, total - 2, true);
  out[2] = input.formatVersion ?? SC_CALIB_FORMAT_VERSION;
  out[3] = input.hwVerMajor & 0xff;
  out[4] = input.hwVerMinor & 0xff;
  out[5] = input.fwVerMajor & 0xff;
  out[6] = input.fwVerMinor & 0xff;
  dv.setUint16(7, input.fwVerPatch & 0xffff, true);
  out[9] = input.blocks.length & 0xff;
  dv.setUint16(10, (input.reserved ?? 0) & 0xffff, true);

  let off = SC_GLOBAL_HEADER_BYTES;
  input.blocks.forEach((b, i) => {
    const payload = payloads[i];
    dv.setUint16(off, b.sensorId & 0xffff, true);
    out[off + 2] =
      (b.range & SC_CAL_RANGE_MASK) |
      (((b.quality ?? 0) & SC_CAL_QUALITY_MASK) << SC_CAL_QUALITY_SHIFT);
    out[off + 3] = payload.length & 0xff;
    if (b.ts) out.set(b.ts.subarray(0, SC_TS_BYTES), off + 4); // else leave zero (default)
    out.set(payload, off + SC_BLOCK_HEADER_BYTES);
    off += SC_BLOCK_HEADER_BYTES + payload.length;
  });

  return out;
}

/** CRC-16/CCITT-FALSE over a serialized blob — the value stamped into payload headers. */
export function calibrationBlobCrc(blob: Uint8Array): number {
  return crc16_ccitt_false(blob);
}

/**
 * Apply IMU calibration to a raw tri-axial sample.
 *
 *   physical = align · (K⁻¹ · (raw − bias))
 *
 * `bias` (b) is subtracted and `sens` (K, diagonal) divided per axis, then the
 * `align` matrix (row-major 3x3) is applied directly to rotate the sensor frame
 * into the common ASM frame. With identity `align` and zero `bias` this reduces
 * to `raw / sens`.
 *
 * Convention note: `align` is the directly-applied sensor-frame → ASM-frame
 * matrix (= R⁻¹ in ASM-DES04 §8's `output = K·R·physical + b` notation). This
 * matches the cloud calibration CSV `rotation_*` columns one-to-one — the CSV
 * stores the same applied matrix, row-major — so the sensor-calibration parser
 * maps blob → CSV with NO transpose. (Confirmed against a LIS2DW12 sample CSV:
 * offset→bias, sensitivity→sens, rotation→align.)
 */
export function applyImuCalibration(
  raw: readonly [number, number, number],
  cal: ImuCalibration,
): [number, number, number] {
  const v0 = (raw[0] - cal.bias[0]) / cal.sens[0];
  const v1 = (raw[1] - cal.bias[1]) / cal.sens[1];
  const v2 = (raw[2] - cal.bias[2]) / cal.sens[2];
  const a = cal.align;
  return [
    a[0] * v0 + a[1] * v1 + a[2] * v2,
    a[3] * v0 + a[4] * v1 + a[5] * v2,
    a[6] * v0 + a[7] * v1 + a[8] * v2,
  ];
}
