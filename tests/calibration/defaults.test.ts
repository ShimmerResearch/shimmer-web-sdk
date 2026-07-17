import { describe, it, expect } from 'vitest';
import {
  getDefaultCalibration,
  getGroupDefaults,
  calibrateVector3,
  INERTIAL_UNITS,
} from '../../src/devices/calibration/index.js';

describe('default calibration tables', () => {
  it('exposes the exact Java unit strings', () => {
    expect(INERTIAL_UNITS.accel).toBe('m/(s^2)');
    expect(INERTIAL_UNITS.gyro).toBe('deg/s');
    expect(INERTIAL_UNITS.mag).toBe('local_flux');
  });

  it('Shimmer3 (old IMU) WR accel sensitivity per range (LSM303DLHC)', () => {
    const s = (r: number) =>
      getDefaultCalibration('shimmer3-old', 'wrAccel', r)!.calibration.sensitivity;
    expect(s(0)).toEqual([1631, 1631, 1631]);
    expect(s(1)).toEqual([815, 815, 815]);
    expect(s(2)).toEqual([408, 408, 408]);
    expect(s(3)).toEqual([135, 135, 135]);
  });

  it('Shimmer3 (new IMU) WR accel range→sensitivity uses the {0,2,3,1} config map (LSM303AH)', () => {
    const s = (r: number) =>
      getDefaultCalibration('shimmer3-new', 'wrAccel', r)!.calibration.sensitivity;
    expect(s(0)).toEqual([1671, 1671, 1671]); // 2g
    expect(s(2)).toEqual([836, 836, 836]); // 4g
    expect(s(3)).toEqual([418, 418, 418]); // 8g
    expect(s(1)).toEqual([209, 209, 209]); // 16g
  });

  it('Shimmer3R LN accel + gyro (LSM6DSV) and gyro uses the ×100 sensitivity scale', () => {
    expect(getDefaultCalibration('shimmer3r', 'lnAccel', 0)!.calibration.sensitivity).toEqual([
      1672, 1672, 1672,
    ]);
    const gyro = getGroupDefaults('shimmer3r', 'gyro')!;
    expect(gyro.sensitivityScale).toBe(100);
    expect(getDefaultCalibration('shimmer3r', 'gyro', 5)!.calibration.sensitivity).toEqual([
      7, 7, 7,
    ]);
    expect(getDefaultCalibration('shimmer3r', 'gyro', 0)!.unit).toBe('deg/s');
  });

  it('Shimmer3R alt mag (LIS3MDL) sensitivity per range and alt accel offset (ADXL371)', () => {
    const alt = (r: number) =>
      getDefaultCalibration('shimmer3r', 'altMag', r)!.calibration.sensitivity;
    expect(alt(0)).toEqual([6842, 6842, 6842]);
    expect(alt(1)).toEqual([3421, 3421, 3421]);
    expect(alt(2)).toEqual([2281, 2281, 2281]);
    expect(alt(3)).toEqual([1711, 1711, 1711]);
    expect(getDefaultCalibration('shimmer3r', 'altAccel', 0)!.calibration.offset).toEqual([
      10, 10, 10,
    ]);
  });

  it('LSM303DLHC mag falls back to range 1 (1.3 Ga) for the invalid range 0', () => {
    const def = getDefaultCalibration('shimmer3-old', 'mag', 0)!;
    expect(def.calibration.sensitivity).toEqual([1100, 1100, 980]);
    expect(def.unit).toBe('local_flux');
  });

  it('Shimmer3R WR accel default (LIS2DW12) range 0: raw [1671,1671,1671] → [~-1,~-1,~-1]', () => {
    // align [[0,-1,0],[-1,0,0],[0,0,-1]] (its own inverse), sens 1671, offset 0.
    const cal = getDefaultCalibration('shimmer3r', 'wrAccel', 0)!.calibration;
    const c = calibrateVector3([1671, 1671, 1671], cal).map((v) => Math.round(v));
    expect(c).toEqual([-1, -1, -1]);
  });

  it('returns null for a group a family does not have (Shimmer3 has no alt accel)', () => {
    expect(getDefaultCalibration('shimmer3-old', 'altAccel', 0)).toBeNull();
    expect(getGroupDefaults('shimmer3-old', 'altMag')).toBeNull();
  });
});
