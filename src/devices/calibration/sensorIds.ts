/**
 * Calibration-domain sensor ids, and the mapping from a calibration dump's
 * records onto this SDK's inertial channel groups.
 *
 * The ids are the firmware's own `SC_SENSOR_*`
 * (`log-and-stream-common/Calibration/shimmer_calibration.h:99-116`). They are
 * **not** the SDK's Verisense `CalibSensorId`, which disagrees on two values:
 * there 40 is an LSM6DS3 accelerometer and 41 an LSM6DS3 gyroscope, where
 * Shimmer3R firmware uses 40 for the ADXL371 high-g accelerometer and 41 for
 * the LIS3MDL alternative magnetometer. Reading a Shimmer3R dump through the
 * Verisense table mislabels two of its six sensors, so the two tables stay
 * separate and this one is named for the firmware it came from.
 */

import { parseKinematicCalibBlock, type KinematicCalibration } from './kinematic.js';
import { getDefaultCalibration, type ImuFamily, type InertialGroup } from './defaults.js';
import type { CalibDump } from './dump.js';

/**
 * `SC_SENSOR_*` from the firmware. The Shimmer3 and Shimmer3R sets are in
 * mutually exclusive `#if` blocks there; both are listed here because one host
 * talks to both platforms and a dump carries its own hardware id.
 */
export const SC_SENSOR = Object.freeze({
  ANALOG_ACCEL: 2,
  MPU9X50_GYRO: 30,
  LSM303_ACCEL: 31,
  LSM303_MAG: 32,
  MPU9X50_ACCEL: 33,
  MPU9X50_MAG: 34,
  BMP180_PRESSURE: 36,
  LSM6DSV_ACCEL: 37,
  LSM6DSV_GYRO: 38,
  LIS2DW12_ACCEL: 39,
  ADXL371_ACCEL: 40,
  LIS3MDL_MAG: 41,
  LIS2MDL_MAG: 42,
  BMP390_PRESSURE: 43,
  BMP581_PRESSURE: 44,
  HOST_ECG: 100,
  ALL: 0xff,
} as const);

/** Human-readable name per id, for a log line or a card title. */
export const SC_SENSOR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  [SC_SENSOR.ANALOG_ACCEL]: 'Low-noise accelerometer (analog)',
  [SC_SENSOR.MPU9X50_GYRO]: 'Gyroscope (MPU9x50/ICM20948)',
  [SC_SENSOR.LSM303_ACCEL]: 'Wide-range accelerometer (LSM303)',
  [SC_SENSOR.LSM303_MAG]: 'Magnetometer (LSM303)',
  [SC_SENSOR.MPU9X50_ACCEL]: 'Accelerometer (MPU9x50/ICM20948)',
  [SC_SENSOR.MPU9X50_MAG]: 'Magnetometer (MPU9x50/ICM20948)',
  [SC_SENSOR.BMP180_PRESSURE]: 'Pressure (BMP180/BMP280)',
  [SC_SENSOR.LSM6DSV_ACCEL]: 'Low-noise accelerometer (LSM6DSV)',
  [SC_SENSOR.LSM6DSV_GYRO]: 'Gyroscope (LSM6DSV)',
  [SC_SENSOR.LIS2DW12_ACCEL]: 'Wide-range accelerometer (LIS2DW12)',
  [SC_SENSOR.ADXL371_ACCEL]: 'High-g accelerometer (ADXL371)',
  [SC_SENSOR.LIS3MDL_MAG]: 'Alternative magnetometer (LIS3MDL)',
  [SC_SENSOR.LIS2MDL_MAG]: 'Magnetometer (LIS2MDL)',
  [SC_SENSOR.BMP390_PRESSURE]: 'Pressure (BMP390)',
  [SC_SENSOR.BMP581_PRESSURE]: 'Pressure (BMP581)',
  [SC_SENSOR.HOST_ECG]: 'ECG (host-derived)',
});

/**
 * Which `SC_SENSOR_*` id carries each channel group's calibration, per family.
 *
 * A Shimmer3 has no high-g accelerometer and no second magnetometer, so those
 * two groups are absent from both Shimmer3 rows — a dump from one cannot carry
 * them, and inventing an id would make a lookup succeed against the wrong
 * record.
 */
export const CALIB_SENSOR_ID_BY_GROUP: Readonly<
  Record<ImuFamily, Readonly<Partial<Record<InertialGroup, number>>>>
> = Object.freeze({
  'shimmer3-old': Object.freeze({
    lnAccel: SC_SENSOR.ANALOG_ACCEL,
    wrAccel: SC_SENSOR.LSM303_ACCEL,
    gyro: SC_SENSOR.MPU9X50_GYRO,
    mag: SC_SENSOR.LSM303_MAG,
  }),
  'shimmer3-new': Object.freeze({
    lnAccel: SC_SENSOR.ANALOG_ACCEL,
    wrAccel: SC_SENSOR.LSM303_ACCEL,
    gyro: SC_SENSOR.MPU9X50_GYRO,
    mag: SC_SENSOR.LSM303_MAG,
  }),
  shimmer3r: Object.freeze({
    lnAccel: SC_SENSOR.LSM6DSV_ACCEL,
    wrAccel: SC_SENSOR.LIS2DW12_ACCEL,
    gyro: SC_SENSOR.LSM6DSV_GYRO,
    mag: SC_SENSOR.LIS2MDL_MAG,
    altAccel: SC_SENSOR.ADXL371_ACCEL,
    altMag: SC_SENSOR.LIS3MDL_MAG,
  }),
});

/** The dump sensor id for one group, or `undefined` if that family lacks it. */
export function calibSensorIdForGroup(family: ImuFamily, group: InertialGroup): number | undefined {
  return CALIB_SENSOR_ID_BY_GROUP[family][group];
}

/** The group a dump sensor id belongs to, or `null` for one that is not inertial. */
export function groupForCalibSensorId(family: ImuFamily, sensorId: number): InertialGroup | null {
  const table = CALIB_SENSOR_ID_BY_GROUP[family];
  for (const group of Object.keys(table) as InertialGroup[]) {
    if (table[group] === sensorId) return group;
  }
  return null;
}

/** Per group, the calibration this dump holds for each range it covers. */
export type DumpCalibrationsByGroup = Partial<
  Record<InertialGroup, Record<number, KinematicCalibration>>
>;

/**
 * Pull every usable inertial calibration out of a parsed dump, keyed by group
 * and then by hardware range.
 *
 * Keyed by range rather than flattened to "the current one" because the dump
 * carries ranges that are not currently selected — that is most of the point of
 * it — and the selected range changes while a host is connected. A caller keeps
 * this and re-selects from it whenever a range setter runs.
 *
 * Records this SDK cannot use are dropped rather than guessed at: a sensor id
 * that is not an inertial group (a pressure coefficient block, say), and a
 * block that holds nothing — all `0xFF` or all `0x00`, which
 * {@link parseKinematicCalibBlock} answers `null` for. Dropping the latter is
 * what keeps a factory default in force instead of calibrating against zeros.
 */
export function selectDumpCalibrations(
  dump: CalibDump,
  family: ImuFamily,
): DumpCalibrationsByGroup {
  const out: DumpCalibrationsByGroup = {};
  for (const record of dump.records) {
    const group = groupForCalibSensorId(family, record.sensorId);
    if (!group) continue;
    const defaults = getDefaultCalibration(family, group, record.range);
    if (!defaults) continue;
    const parsed = parseKinematicCalibBlock(record.calibBytes, {
      sensitivityScale: defaults.sensitivityScale,
    });
    if (!parsed) continue;
    (out[group] ??= {})[record.range] = parsed;
  }
  return out;
}
