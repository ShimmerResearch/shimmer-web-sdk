import { describe, it, expect } from 'vitest';
import { SensorLIS2DW12 } from '../../src/devices/verisense/sensors/SensorLIS2DW12.js';
import {
  parseCalibrationBlob,
  serializeCalibrationBlob,
  CalibSensorId,
} from '../../src/devices/verisense/calibration.js';

// raw = [1000, -2000, 3000] encoded as 3x i16 little-endian (6 bytes/sample).
const RAW = [1000, -2000, 3000] as const;
const SAMPLE = new Uint8Array([0xe8, 0x03, 0x30, 0xf8, 0xb8, 0x0b]);
const S = 1671.665922915; // datasheet 2g sensitivity, LSB/(m/s^2)

function calibrationWith2gIdentity() {
  const blob = serializeCalibrationBlob({
    hwVerMajor: 68,
    hwVerMinor: 8,
    fwVerMajor: 1,
    fwVerMinor: 2,
    fwVerPatch: 73,
    blocks: [
      {
        sensorId: CalibSensorId.LIS2DW12_ACCEL,
        range: 0, // 2g
        imu: { bias: [0, 0, 0], sens: [S, S, S], align: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
      },
    ],
  });
  return parseCalibrationBlob(blob);
}

describe('SensorLIS2DW12 calibration application', () => {
  it('uses device calibration (identity → raw/sens, no axis swap) when present', () => {
    const s = new SensorLIS2DW12();
    s.applyCalibration(calibrationWith2gIdentity());
    const [sample] = s.parsePayload(SAMPLE);
    expect(sample.cal[0]).toBeCloseTo(RAW[0] / S, 3);
    expect(sample.cal[1]).toBeCloseTo(RAW[1] / S, 3);
    expect(sample.cal[2]).toBeCloseTo(RAW[2] / S, 3);
  });

  it('falls back to the built-in align + sensitivity when no calibration is set', () => {
    const s = new SensorLIS2DW12();
    const [sample] = s.parsePayload(SAMPLE);
    // Built-in align [[0,0,1],[1,0,0],[0,1,0]] swaps axes: [z, x, y] / sens.
    expect(sample.cal[0]).toBeCloseTo(RAW[2] / S, 3);
    expect(sample.cal[1]).toBeCloseTo(RAW[0] / S, 3);
    expect(sample.cal[2]).toBeCloseTo(RAW[1] / S, 3);
  });

  it('falls back when calibration lacks the active range block', () => {
    const s = new SensorLIS2DW12();
    // Provide a calibration set with only a 16g block; the sensor defaults to 2g (range 0).
    const blob = serializeCalibrationBlob({
      hwVerMajor: 68,
      hwVerMinor: 8,
      fwVerMajor: 1,
      fwVerMinor: 2,
      fwVerPatch: 73,
      blocks: [
        {
          sensorId: CalibSensorId.LIS2DW12_ACCEL,
          range: 3,
          imu: { bias: [0, 0, 0], sens: [1, 1, 1], align: [1, 0, 0, 0, 1, 0, 0, 0, 1] },
        },
      ],
    });
    s.applyCalibration(parseCalibrationBlob(blob));
    const [sample] = s.parsePayload(SAMPLE);
    // No range-0 block → fallback (axis swap), NOT the range-3 identity block.
    expect(sample.cal[0]).toBeCloseTo(RAW[2] / S, 3);
  });
});
