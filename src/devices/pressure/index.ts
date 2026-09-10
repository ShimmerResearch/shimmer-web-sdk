/**
 * Pressure and temperature: the four Bosch parts a Shimmer3 or Shimmer3R can
 * carry, their factory trim coefficients, and the compensation a host has to
 * run because the firmware does not.
 *
 * The firmware streams the chips' raw registers and relays their trim block
 * uninterpreted, so kPa and °C are entirely the host's job — see
 * `SHIMMER3_STREAMING_DATA_FORMAT.md` §7.4.
 */

export { parseBmp180Coefficients, compensateBmp180 } from './bmp180.js';
export { parseBmp280Coefficients, compensateBmp280 } from './bmp280.js';
export { parseBmp390Coefficients, compensateBmp390 } from './bmp390.js';
export { compensateBmp581 } from './bmp581.js';
export { parsePressureCalibrationResponse } from './response.js';
export { compensatePressure } from './compensate.js';
export {
  PRESSURE_SENSOR_ID,
  PRESSURE_SENSOR_ID_BY_KIND,
  PRESSURE_COEFFICIENT_BYTES,
  PRESSURE_CALIBRATION_RESPONSE_MAX_PAYLOAD,
} from './types.js';
export type {
  PressureSensorKind,
  PressureCalibration,
  PressureCoefficients,
  CompensatedPressure,
  Bmp180Coefficients,
  Bmp280Coefficients,
  Bmp390Coefficients,
} from './types.js';
