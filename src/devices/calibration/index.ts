/**
 * Inertial (accel/gyro/mag) calibration — phase P3.
 *
 * Pure, transport-free port of the Shimmer Java driver's kinematic calibration
 * pipeline (CalibDetailsKinematic + UtilCalibration + per-sensor default
 * matrices). Consumed by both the SD-log decoder and the streaming clients so
 * inertial channels are emitted calibrated, exactly like GSR already is.
 */

export {
  matrixInverse3x3,
  matrixMultiply3x3,
  makeKinematicCalibration,
  calibrateVector3,
  parseKinematicCalibBlock,
  generateKinematicCalibBlock,
} from './kinematic.js';
export type { KinematicCalibration, ParseKinematicOptions } from './kinematic.js';

export { INERTIAL_UNITS, getGroupDefaults, getDefaultCalibration } from './defaults.js';
export type { ImuFamily, InertialGroup, GroupDefaults } from './defaults.js';

export {
  parseCalibDump,
  generateCalibDump,
  CALIB_READ_SOURCE,
  shouldOverrideCalibration,
} from './dump.js';
export type { CalibDump, CalibDumpRecord, CalibDumpVersion, CalibReadSource } from './dump.js';

export { applyStreamingCalibration } from './streaming.js';
export type { StreamingCalibrationState, StreamingImuRanges } from './streaming.js';
