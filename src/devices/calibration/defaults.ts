/**
 * Hard-coded default kinematic calibration matrices, ported from the Shimmer
 * Java driver's per-sensor default constants. These are the already-scaled real
 * values (e.g. gyro sensitivity 131, not 13100) the driver instantiates each
 * CalibDetailsKinematic with when no per-device calibration is available.
 *
 * Sources (all READ-ONLY oracle):
 *   Shimmer3 low-noise accel  : SensorKionixKXRB52042 (:38-55)
 *   Shimmer3 wide-range accel + mag (old IMU) : SensorLSM303DLHC (:79-183, :325-358)
 *   Shimmer3 wide-range accel + mag (new IMU) : SensorLSM303AH (:41-89, :174-206)
 *   Shimmer3 gyro (MPU9x50)   : SensorMPU9X50 (:121-158, gyro scale ×100)
 *   Shimmer3R LN accel + gyro : SensorLSM6DSV (:53-165, gyro scale ×100)
 *   Shimmer3R WR accel        : SensorLIS2DW12 (:124-160)
 *   Shimmer3R mag             : SensorLIS2MDL (:58-66)
 *   Shimmer3R alt (high-g)    : SensorADXL371 (:113-124)
 *   Shimmer3R alt mag         : SensorLIS3MDL (:59-89)
 *
 * NB: alignment matrices below are written row-major; the values are the true
 * ±1/0 alignment entries (the driver stores them ×100 on the wire — see
 * generateKinematicCalibBlock — but keeps the real values in these constants).
 */

import { makeKinematicCalibration, type KinematicCalibration } from './kinematic.js';

/** IMU sensor family selected from HW version + new-IMU detection. */
export type ImuFamily = 'shimmer3-old' | 'shimmer3-new' | 'shimmer3r';

/** Inertial channel group. */
export type InertialGroup = 'lnAccel' | 'wrAccel' | 'gyro' | 'mag' | 'altAccel' | 'altMag';

/** Emitted unit strings — exact Java strings (Configuration.java :162-164). */
export const INERTIAL_UNITS = Object.freeze({
  accel: 'm/(s^2)',
  gyro: 'deg/s',
  mag: 'local_flux',
} as const);

interface RawCal {
  align: number[]; // row-major 3x3
  sens: [number, number, number];
  offset: [number, number, number];
}

/** Default calibration info for one channel group of one family. */
export interface GroupDefaults {
  /** Emitted unit string. */
  unit: string;
  /** Sensitivity scale factor for parsing a device block of this group (gyro=100). */
  sensitivityScale: number;
  /** Default calibration keyed by hardware range value. */
  byRange: Readonly<Record<number, KinematicCalibration>>;
  /** Range value to fall back to when the active range is unknown/unmapped. */
  fallbackRange: number;
}

const cal = (r: RawCal): KinematicCalibration =>
  makeKinematicCalibration(r.offset, r.sens, r.align);

// --- Common alignment matrices -----------------------------------------------
const ALIGN_KIONIX_LN = [0, -1, 0, -1, 0, 0, 0, 0, -1]; // Kionix KXRB LN accel (S3)
const ALIGN_MPU_GYRO = [0, -1, 0, -1, 0, 0, 0, 0, -1]; // MPU9x50 gyro (S3)
const ALIGN_LSM303DLHC = [-1, 0, 0, 0, 1, 0, 0, 0, -1]; // WR accel + mag (S3 old IMU)
const ALIGN_LSM303AH = [0, -1, 0, 1, 0, 0, 0, 0, -1]; // WR accel + mag (S3 new IMU)
const ALIGN_LSM6DSV = [-1, 0, 0, 0, 1, 0, 0, 0, -1]; // LN accel + gyro (S3R)
const ALIGN_LIS2DW12 = [0, -1, 0, -1, 0, 0, 0, 0, -1]; // WR accel (S3R)
const ALIGN_LIS2MDL = [-1, 0, 0, 0, -1, 0, 0, 0, -1]; // mag (S3R)
const ALIGN_LIS3MDL = [1, 0, 0, 0, -1, 0, 0, 0, -1]; // alt mag (S3R)
const ALIGN_ADXL371 = [0, 1, 0, 1, 0, 0, 0, 0, -1]; // high-g accel (S3R)

const ZERO_OFFSET: [number, number, number] = [0, 0, 0];
const diag = (s: number): [number, number, number] => [s, s, s];

// -----------------------------------------------------------------------------
// Shimmer3, old IMU (LSM303DLHC accel+mag, MPU9x50 gyro, Kionix LN accel)
// -----------------------------------------------------------------------------
const SHIMMER3_OLD: Readonly<Record<InertialGroup, GroupDefaults>> = Object.freeze({
  lnAccel: {
    unit: INERTIAL_UNITS.accel,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_KIONIX_LN, sens: diag(83), offset: [2047, 2047, 2047] }),
    },
  },
  wrAccel: {
    unit: INERTIAL_UNITS.accel,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LSM303DLHC, sens: diag(1631), offset: ZERO_OFFSET }),
      1: cal({ align: ALIGN_LSM303DLHC, sens: diag(815), offset: ZERO_OFFSET }),
      2: cal({ align: ALIGN_LSM303DLHC, sens: diag(408), offset: ZERO_OFFSET }),
      3: cal({ align: ALIGN_LSM303DLHC, sens: diag(135), offset: ZERO_OFFSET }),
    },
  },
  gyro: {
    unit: INERTIAL_UNITS.gyro,
    sensitivityScale: 100,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_MPU_GYRO, sens: diag(131), offset: ZERO_OFFSET }),
      1: cal({ align: ALIGN_MPU_GYRO, sens: diag(65.5), offset: ZERO_OFFSET }),
      2: cal({ align: ALIGN_MPU_GYRO, sens: diag(32.8), offset: ZERO_OFFSET }),
      3: cal({ align: ALIGN_MPU_GYRO, sens: diag(16.4), offset: ZERO_OFFSET }),
    },
  },
  mag: {
    unit: INERTIAL_UNITS.mag,
    sensitivityScale: 1,
    fallbackRange: 1, // LSM303DLHC has no range 0; driver default is 1.3 Ga (range 1)
    byRange: {
      1: cal({ align: ALIGN_LSM303DLHC, sens: [1100, 1100, 980], offset: ZERO_OFFSET }),
      2: cal({ align: ALIGN_LSM303DLHC, sens: [855, 855, 760], offset: ZERO_OFFSET }),
      3: cal({ align: ALIGN_LSM303DLHC, sens: [670, 670, 600], offset: ZERO_OFFSET }),
      4: cal({ align: ALIGN_LSM303DLHC, sens: [450, 450, 400], offset: ZERO_OFFSET }),
      5: cal({ align: ALIGN_LSM303DLHC, sens: [400, 400, 355], offset: ZERO_OFFSET }),
      6: cal({ align: ALIGN_LSM303DLHC, sens: [330, 330, 295], offset: ZERO_OFFSET }),
      7: cal({ align: ALIGN_LSM303DLHC, sens: [230, 230, 205], offset: ZERO_OFFSET }),
    },
  },
} as unknown as Record<InertialGroup, GroupDefaults>);

// -----------------------------------------------------------------------------
// Shimmer3, new IMU (LSM303AHTR accel+mag, MPU9x50 gyro, Kionix LN accel).
// LSM303AH accel range→sensitivity mapping uses config values {0,2,3,1}
// (ListofLSM303AccelRangeConfigValues) → 2g/4g/8g/16g respectively.
// -----------------------------------------------------------------------------
const SHIMMER3_NEW: Readonly<Record<InertialGroup, GroupDefaults>> = Object.freeze({
  lnAccel: SHIMMER3_OLD.lnAccel, // Kionix LN accel unchanged on new-IMU boards
  wrAccel: {
    unit: INERTIAL_UNITS.accel,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LSM303AH, sens: diag(1671), offset: ZERO_OFFSET }), // 2g
      2: cal({ align: ALIGN_LSM303AH, sens: diag(836), offset: ZERO_OFFSET }), // 4g
      3: cal({ align: ALIGN_LSM303AH, sens: diag(418), offset: ZERO_OFFSET }), // 8g
      1: cal({ align: ALIGN_LSM303AH, sens: diag(209), offset: ZERO_OFFSET }), // 16g
    },
  },
  gyro: SHIMMER3_OLD.gyro, // MPU9x50 gyro unchanged
  mag: {
    unit: INERTIAL_UNITS.mag,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LSM303AH, sens: diag(667), offset: ZERO_OFFSET }),
    },
  },
} as unknown as Record<InertialGroup, GroupDefaults>);

// -----------------------------------------------------------------------------
// Shimmer3R (LSM6DSV LN accel+gyro, LIS2DW12 WR accel, LIS2MDL mag,
// ADXL371 high-g alt accel, LIS3MDL alt mag).
// -----------------------------------------------------------------------------
const SHIMMER3R: Readonly<Record<InertialGroup, GroupDefaults>> = Object.freeze({
  lnAccel: {
    unit: INERTIAL_UNITS.accel,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LSM6DSV, sens: diag(1672), offset: ZERO_OFFSET }),
      1: cal({ align: ALIGN_LSM6DSV, sens: diag(836), offset: ZERO_OFFSET }),
      2: cal({ align: ALIGN_LSM6DSV, sens: diag(418), offset: ZERO_OFFSET }),
      3: cal({ align: ALIGN_LSM6DSV, sens: diag(209), offset: ZERO_OFFSET }),
    },
  },
  gyro: {
    unit: INERTIAL_UNITS.gyro,
    sensitivityScale: 100,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LSM6DSV, sens: diag(229), offset: ZERO_OFFSET }), // 125 dps
      1: cal({ align: ALIGN_LSM6DSV, sens: diag(114), offset: ZERO_OFFSET }), // 250 dps
      2: cal({ align: ALIGN_LSM6DSV, sens: diag(57), offset: ZERO_OFFSET }), // 500 dps
      3: cal({ align: ALIGN_LSM6DSV, sens: diag(29), offset: ZERO_OFFSET }), // 1000 dps
      4: cal({ align: ALIGN_LSM6DSV, sens: diag(14), offset: ZERO_OFFSET }), // 2000 dps
      5: cal({ align: ALIGN_LSM6DSV, sens: diag(7), offset: ZERO_OFFSET }), // 4000 dps
    },
  },
  wrAccel: {
    unit: INERTIAL_UNITS.accel,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LIS2DW12, sens: diag(1671), offset: ZERO_OFFSET }),
      1: cal({ align: ALIGN_LIS2DW12, sens: diag(836), offset: ZERO_OFFSET }),
      2: cal({ align: ALIGN_LIS2DW12, sens: diag(418), offset: ZERO_OFFSET }),
      3: cal({ align: ALIGN_LIS2DW12, sens: diag(209), offset: ZERO_OFFSET }),
    },
  },
  mag: {
    unit: INERTIAL_UNITS.mag,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LIS2MDL, sens: diag(667), offset: ZERO_OFFSET }),
    },
  },
  altAccel: {
    unit: INERTIAL_UNITS.accel,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_ADXL371, sens: diag(1), offset: [10, 10, 10] }),
    },
  },
  altMag: {
    unit: INERTIAL_UNITS.mag,
    sensitivityScale: 1,
    fallbackRange: 0,
    byRange: {
      0: cal({ align: ALIGN_LIS3MDL, sens: diag(6842), offset: ZERO_OFFSET }), // 4 Ga
      1: cal({ align: ALIGN_LIS3MDL, sens: diag(3421), offset: ZERO_OFFSET }), // 8 Ga
      2: cal({ align: ALIGN_LIS3MDL, sens: diag(2281), offset: ZERO_OFFSET }), // 12 Ga
      3: cal({ align: ALIGN_LIS3MDL, sens: diag(1711), offset: ZERO_OFFSET }), // 16 Ga
    },
  },
} as unknown as Record<InertialGroup, GroupDefaults>);

const FAMILY_DEFAULTS: Readonly<Record<ImuFamily, Record<InertialGroup, GroupDefaults>>> =
  Object.freeze({
    'shimmer3-old': SHIMMER3_OLD,
    'shimmer3-new': SHIMMER3_NEW,
    shimmer3r: SHIMMER3R,
  });

/** Return the default group table for a family, or null if the group is absent. */
export function getGroupDefaults(family: ImuFamily, group: InertialGroup): GroupDefaults | null {
  return FAMILY_DEFAULTS[family][group] ?? null;
}

/**
 * Select the default {@link KinematicCalibration} for a family/group/range.
 * Falls back to the group's `fallbackRange` when the range value has no entry.
 * Returns `null` when the family has no such group.
 */
export function getDefaultCalibration(
  family: ImuFamily,
  group: InertialGroup,
  range: number,
): { calibration: KinematicCalibration; unit: string; sensitivityScale: number } | null {
  const g = getGroupDefaults(family, group);
  if (!g) return null;
  const calibration = g.byRange[range] ?? g.byRange[g.fallbackRange];
  if (!calibration) return null;
  return { calibration, unit: g.unit, sensitivityScale: g.sensitivityScale };
}
