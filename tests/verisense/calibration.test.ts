import { describe, it, expect } from 'vitest';
import {
  parseCalibrationBlob,
  serializeCalibrationBlob,
  calibrationBlobCrc,
  applyImuCalibration,
  CalibSensorId,
  CalibQuality,
  SC_GLOBAL_HEADER_BYTES,
  SC_BLOCK_HEADER_BYTES,
  SC_DATA_LEN_IMU,
  type CalibrationSetInput,
  type ImuCalibration,
} from '../../src/devices/verisense/calibration.js';
import { crc16_ccitt_false } from '../../src/devices/verisense/protocolUtils.js';

const sampleInput = (): CalibrationSetInput => ({
  hwVerMajor: 68,
  hwVerMinor: 8,
  fwVerMajor: 1,
  fwVerMinor: 2,
  fwVerPatch: 73,
  blocks: [
    // Default LSM6DSV accel @ 2g: datasheet sensitivity, zero bias, identity rotation, ts=0.
    {
      sensorId: CalibSensorId.LSM6DSV_ACCEL,
      range: 0,
      imu: {
        bias: [0, 0, 0],
        sens: [1671.665922915, 1671.665922915, 1671.665922915],
        align: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      },
    },
    // Per-unit LSM6DSV accel @ 16g: signed bias, real ts, axis-swap rotation.
    {
      sensorId: CalibSensorId.LSM6DSV_ACCEL,
      range: 3,
      ts: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
      imu: {
        bias: [-1.5, 2.25, -3.75],
        sens: [208.95, 208.95, 208.95],
        align: [0, 0, 1, 1, 0, 0, 0, 1, 0],
      },
    },
  ],
});

describe('Verisense calibration TLV codec', () => {
  it('round-trips header fields, blocks, and IMU (float32) payloads', () => {
    const blob = serializeCalibrationBlob(sampleInput());
    const set = parseCalibrationBlob(blob);

    expect(set.formatVersion).toBe(1);
    expect(set.hwVerMajor).toBe(68);
    expect(set.hwVerMinor).toBe(8);
    expect(set.fwVerMajor).toBe(1);
    expect(set.fwVerMinor).toBe(2);
    expect(set.fwVerPatch).toBe(73);
    expect(set.blocks).toHaveLength(2);

    // Block 0 — default accel: float32 round-trip equals Math.fround(input).
    const b0 = set.blocks[0];
    expect(b0.sensorId).toBe(CalibSensorId.LSM6DSV_ACCEL);
    expect(b0.range).toBe(0);
    expect(b0.dataLen).toBe(SC_DATA_LEN_IMU);
    expect(b0.isDefault).toBe(true);
    expect(b0.imu!.bias).toEqual([0, 0, 0]);
    expect(b0.imu!.sens[0]).toBe(Math.fround(1671.665922915));
    expect(b0.imu!.align).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(b0.quality).toBe(0); // unknown by default (no producer yet)

    // Block 1 — per-unit accel: signed bias + non-zero ts + axis-swap rotation.
    const b1 = set.blocks[1];
    expect(b1.range).toBe(3);
    expect(b1.isDefault).toBe(false);
    expect(Array.from(b1.ts)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(b1.imu!.bias).toEqual([-1.5, 2.25, -3.75]); // exactly representable in f32
    expect(b1.imu!.sens[0]).toBe(Math.fround(208.95));
    expect(b1.imu!.align).toEqual([0, 0, 1, 1, 0, 0, 0, 1, 0]);
  });

  it('exposes getImu(id,range) accessor', () => {
    const set = parseCalibrationBlob(serializeCalibrationBlob(sampleInput()));
    expect(set.getImu(CalibSensorId.LSM6DSV_ACCEL, 3)!.bias).toEqual([-1.5, 2.25, -3.75]);
    expect(set.getImu(CalibSensorId.LSM6DSV_ACCEL, 0)!.sens[0]).toBe(Math.fround(1671.665922915));
    expect(set.getImu(CalibSensorId.LIS2DW12_ACCEL, 0)).toBeNull(); // not present
  });

  it('packs calibration quality into range-byte bits [7:6] without disturbing the index', () => {
    const input = sampleInput();
    input.blocks[1].range = 3;
    input.blocks[1].quality = CalibQuality.GOOD; // 3
    const blob = serializeCalibrationBlob(input);

    // Wire byte = index (bits 5:0) | quality<<6 = 3 | (3<<6) = 0xC3.
    const b1Off = SC_GLOBAL_HEADER_BYTES + (SC_BLOCK_HEADER_BYTES + SC_DATA_LEN_IMU);
    expect(blob[b1Off + 2]).toBe(0x03 | (0x03 << 6));

    const set = parseCalibrationBlob(blob);
    expect(set.blocks[1].range).toBe(3); // index unaffected
    expect(set.blocks[1].quality).toBe(CalibQuality.GOOD);
    // Lookup still keys on the index, ignoring the quality bits.
    expect(set.getImu(CalibSensorId.LSM6DSV_ACCEL, 3)!.bias).toEqual([-1.5, 2.25, -3.75]);
  });

  it('writes a spec-exact byte layout (offsets, totalLen, block headers)', () => {
    const blob = serializeCalibrationBlob(sampleInput());

    // totalLen field = blob.length - 2.
    expect(blob[0] | (blob[1] << 8)).toBe(blob.length - 2);
    expect(blob[2]).toBe(1); // calibFormatVersion
    expect(blob[9]).toBe(2); // sensorBlockCount

    // First block header at offset 12.
    expect(blob[SC_GLOBAL_HEADER_BYTES + 0]).toBe(37); // sensorId LSB (LSM6DSV_ACCEL)
    expect(blob[SC_GLOBAL_HEADER_BYTES + 1]).toBe(0); // sensorId MSB
    expect(blob[SC_GLOBAL_HEADER_BYTES + 2]).toBe(0); // range
    expect(blob[SC_GLOBAL_HEADER_BYTES + 3]).toBe(SC_DATA_LEN_IMU); // dataLen

    // Total size = header + 2 IMU blocks (12+60).
    expect(blob.length).toBe(SC_GLOBAL_HEADER_BYTES + 2 * (12 + 60));
  });

  it('CRC matches crc16_ccitt_false over the whole blob and detects mutation', () => {
    const blob = serializeCalibrationBlob(sampleInput());
    const set = parseCalibrationBlob(blob);
    expect(set.crc16).toBe(crc16_ccitt_false(blob));
    expect(set.crc16).toBe(calibrationBlobCrc(blob));

    const mutated = blob.slice();
    mutated[SC_GLOBAL_HEADER_BYTES + 12] ^= 0xff; // flip a payload byte
    expect(calibrationBlobCrc(mutated)).not.toBe(set.crc16);
  });

  it('rejects malformed blobs', () => {
    expect(() => parseCalibrationBlob(new Uint8Array(4))).toThrow(/too short/);

    const blob = serializeCalibrationBlob(sampleInput());
    const truncated = blob.slice(0, blob.length - 1); // totalLen no longer matches
    expect(() => parseCalibrationBlob(truncated)).toThrow(/totalLen/);
  });
});

describe('applyImuCalibration (physical = align · K⁻¹ · (raw − bias))', () => {
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];

  it('identity align + zero bias divides by sensitivity', () => {
    const cal: ImuCalibration = { bias: [0, 0, 0], sens: [10, 20, 30], align: identity };
    expect(applyImuCalibration([100, 200, 300], cal)).toEqual([10, 10, 10]);
  });

  it('subtracts bias before scaling', () => {
    const cal: ImuCalibration = { bias: [10, 20, 30], sens: [10, 20, 30], align: identity };
    expect(applyImuCalibration([110, 220, 330], cal)).toEqual([10, 10, 10]);
  });

  it('applies the rotation matrix (row-major) to the scaled vector', () => {
    // row0→v2, row1→v0, row2→v1
    const swap = [0, 0, 1, 1, 0, 0, 0, 1, 0];
    const cal: ImuCalibration = { bias: [0, 0, 0], sens: [1, 1, 1], align: swap };
    expect(applyImuCalibration([100, 200, 300], cal)).toEqual([300, 100, 200]);
  });

  it('applies K⁻¹ before the rotation (anisotropic sensitivity)', () => {
    const swap = [0, 0, 1, 1, 0, 0, 0, 1, 0];
    const cal: ImuCalibration = { bias: [0, 0, 0], sens: [10, 20, 30], align: swap };
    // v = [10/10, 40/20, 90/30] = [1,2,3]; swapped → [3,1,2]
    expect(applyImuCalibration([10, 40, 90], cal)).toEqual([3, 1, 2]);
  });
});
