import { describe, it, expect } from 'vitest';
import {
  VERISENSE_CALIBRATION_MIN_FW,
  supportsVerisenseCalibration,
  unixSecondsToCalibTsBytes,
  calibTsBytesToUnixSeconds,
  getVerisenseCalibrationSensors,
  buildDefaultVerisenseCalibrationSet,
  getVerisenseCalibrationSensorAvailability,
} from '../../src/devices/verisense/calibrationDefaults.js';
import {
  parseCalibrationBlob,
  serializeCalibrationBlob,
  CalibSensorId,
} from '../../src/devices/verisense/calibration.js';
import { getVerisenseHardwareSensorSupport } from '../../src/devices/verisense/hardwareModels.js';

const det3 = (m: number[]) =>
  m[0] * (m[4] * m[8] - m[5] * m[7]) -
  m[1] * (m[3] * m[8] - m[5] * m[6]) +
  m[2] * (m[3] * m[7] - m[4] * m[6]);

describe('supportsVerisenseCalibration', () => {
  it('requires FW >= 2.0.4', () => {
    expect(VERISENSE_CALIBRATION_MIN_FW).toEqual({ major: 2, minor: 0, internal: 4 });
    expect(supportsVerisenseCalibration({ major: 2, minor: 0, internal: 4 })).toBe(true);
    expect(supportsVerisenseCalibration({ major: 2, minor: 0, internal: 5 })).toBe(true);
    expect(supportsVerisenseCalibration({ major: 2, minor: 1, internal: 0 })).toBe(true);
    expect(supportsVerisenseCalibration({ major: 2, minor: 0, internal: 3 })).toBe(false);
    expect(supportsVerisenseCalibration({ major: 1, minor: 9, internal: 9 })).toBe(false);
    expect(supportsVerisenseCalibration(null)).toBe(false);
  });
});

describe('calibration ts (8-byte LE Unix seconds)', () => {
  it('round-trips and is little-endian', () => {
    const secs = 1750000000; // 2025-ish
    const ts = unixSecondsToCalibTsBytes(secs);
    expect(ts).toHaveLength(8);
    expect(calibTsBytesToUnixSeconds(ts)).toBe(secs);
    // LE: byte 0 is the least-significant.
    expect(ts[0]).toBe(secs & 0xff);
    // high bytes unused for a real date.
    expect(ts[5]).toBe(0);
    expect(ts[6]).toBe(0);
    expect(ts[7]).toBe(0);
  });
  it('treats 0 / empty as default', () => {
    expect(Array.from(unixSecondsToCalibTsBytes(0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(calibTsBytesToUnixSeconds(new Uint8Array(8))).toBe(0);
    expect(calibTsBytesToUnixSeconds(null)).toBe(0);
  });
});

describe('getVerisenseCalibrationSensors (defaults catalog)', () => {
  const sensors = getVerisenseCalibrationSensors();
  it('covers the gen-2 calibration set with the expected alignment determinants', () => {
    const byId = Object.fromEntries(sensors.map((s) => [s.id, s]));
    expect(Object.keys(byId).map(Number).sort((a, b) => a - b)).toEqual([37, 38, 39, 42]);
    // accel/gyro are proper rotations; the LIS2MDL frame is left-handed.
    expect(det3(byId[CalibSensorId.LSM6DSV_ACCEL].align)).toBe(1);
    expect(det3(byId[CalibSensorId.LSM6DSV_GYRO].align)).toBe(1);
    expect(det3(byId[CalibSensorId.LIS2DW12_ACCEL].align)).toBe(1);
    expect(det3(byId[CalibSensorId.LIS2MDL_MAG].align)).toBe(-1);
    // every sensor's +Z maps to common +Y (third column = [0,1,0]).
    for (const s of sensors) expect([s.align[2], s.align[5], s.align[8]]).toEqual([0, 1, 0]);
  });

  it('1st-gen hardware returns the LIS2DW12 + LSM6DS3 set (transposed doc R)', () => {
    const g1 = getVerisenseCalibrationSensors(62, 1); // SR62 = 1st-gen
    const byId = Object.fromEntries(g1.map((s) => [s.id, s]));
    expect(Object.keys(byId).map(Number).sort((a, b) => a - b)).toEqual([39, 40, 41]);
    // align = Rᵀ of the doc's R (Shimmer Java applies R⁻¹). All proper rotations.
    expect(byId[CalibSensorId.LIS2DW12_ACCEL].align).toEqual([0, 1, 0, 0, 0, 1, 1, 0, 0]);
    expect(byId[CalibSensorId.LSM6DS3_ACCEL].align).toEqual([0, -1, 0, 0, 0, -1, 1, 0, 0]);
    expect(byId[CalibSensorId.LSM6DS3_GYRO].align).toEqual([0, -1, 0, 0, 0, -1, 1, 0, 0]);
    for (const s of g1) expect(det3(s.align)).toBe(1);
    // opposite-face anchor: top-face LIS2DW12 chipZ→+commonY; bottom-face LSM6DS3 chipZ→−commonY.
    expect([byId[39].align[2], byId[39].align[5], byId[39].align[8]]).toEqual([0, 1, 0]);
    expect([byId[40].align[2], byId[40].align[5], byId[40].align[8]]).toEqual([0, -1, 0]);
    // LSM6DS3 gyro exposes 4 ranges (250..2000 dps), code 0 = 250 dps.
    expect(byId[CalibSensorId.LSM6DS3_GYRO].ranges.map((r) => r.code)).toEqual([0, 1, 2, 3]);
    expect(byId[CalibSensorId.LSM6DS3_GYRO].ranges[0].label).toBe('±250dps');
  });

  it('2nd-gen hardware still returns the gen-2 set', () => {
    expect(
      getVerisenseCalibrationSensors(68, 9)
        .map((s) => s.id)
        .sort((a, b) => a - b),
    ).toEqual([37, 38, 39, 42]);
  });
});

describe('getVerisenseCalibrationSensorAvailability', () => {
  it('2nd-gen (SR68.9): LSM6DSV+mag enabled, LIS2DW12 disabled, LSM6DS3 hidden', () => {
    const a = getVerisenseCalibrationSensorAvailability(getVerisenseHardwareSensorSupport(68, 9));
    expect(a[CalibSensorId.LSM6DSV_ACCEL]).toBe('enabled');
    expect(a[CalibSensorId.LSM6DSV_GYRO]).toBe('enabled');
    expect(a[CalibSensorId.LIS2MDL_MAG]).toBe('enabled');
    expect(a[CalibSensorId.LIS2DW12_ACCEL]).toBe('disabled');
    expect(a[CalibSensorId.LSM6DS3_ACCEL]).toBe('hidden');
    expect(a[CalibSensorId.LSM6DS3_GYRO]).toBe('hidden');
  });
  it('1st-gen (SR62): LIS2DW12 + LSM6DS3 enabled, LSM6DSV+mag hidden', () => {
    const a = getVerisenseCalibrationSensorAvailability(getVerisenseHardwareSensorSupport(62, 1));
    expect(a[CalibSensorId.LIS2DW12_ACCEL]).toBe('enabled');
    expect(a[CalibSensorId.LSM6DS3_ACCEL]).toBe('enabled');
    expect(a[CalibSensorId.LSM6DS3_GYRO]).toBe('enabled');
    expect(a[CalibSensorId.LSM6DSV_ACCEL]).toBe('hidden');
    expect(a[CalibSensorId.LIS2MDL_MAG]).toBe('hidden');
  });
  it('offline / null support: everything enabled', () => {
    const a = getVerisenseCalibrationSensorAvailability(null);
    expect(a[CalibSensorId.LSM6DSV_ACCEL]).toBe('enabled');
    expect(a[CalibSensorId.LIS2DW12_ACCEL]).toBe('enabled');
    expect(a[CalibSensorId.LIS2MDL_MAG]).toBe('enabled');
  });
});

describe('buildDefaultVerisenseCalibrationSet', () => {
  it('produces a serializable seed (14 IMU blocks) that round-trips', () => {
    const input = buildDefaultVerisenseCalibrationSet({
      hwVerMajor: 68,
      hwVerMinor: 9,
      fwVerMajor: 2,
      fwVerMinor: 0,
      fwVerPatch: 4,
    });
    expect(input.blocks).toHaveLength(4 + 5 + 4 + 1); // 14
    const set = parseCalibrationBlob(serializeCalibrationBlob(input));
    expect(set.blocks).toHaveLength(14);
    // default: zero bias, ts=0 (isDefault), datasheet sensitivity, gen-2 alignment.
    const accel2g = set.getImu(CalibSensorId.LSM6DSV_ACCEL, 0)!;
    expect(accel2g.bias).toEqual([0, 0, 0]);
    expect(accel2g.sens[0]).toBe(Math.fround(1671.665922915));
    expect(accel2g.align).toEqual([0, -1, 0, 0, 0, 1, -1, 0, 0]);
    expect(set.blocks.every((b) => b.isDefault)).toBe(true);
  });
});
