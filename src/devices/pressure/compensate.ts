/**
 * One entry point for "turn these two raw channel values into kPa and °C".
 */

import { compensateBmp180 } from './bmp180.js';
import { compensateBmp280 } from './bmp280.js';
import { compensateBmp390 } from './bmp390.js';
import { compensateBmp581 } from './bmp581.js';
import type {
  Bmp180Coefficients,
  Bmp280Coefficients,
  Bmp390Coefficients,
  CompensatedPressure,
  PressureCalibration,
} from './types.js';

/**
 * Compensate one pressure/temperature pair.
 *
 * @param calibration  What {@link parsePressureCalibrationResponse} returned,
 *   or `null` when the host never read it (or the firmware refused).
 * @param rawPressure    The `PRESSURE` channel value for this frame.
 * @param rawTemperature The `TEMPERATURE` channel value for this frame.
 * @param oversampling   The configured pressure oversampling, 0-3. Only the
 *   BMP180 uses it; the others ignore it.
 * @returns the compensated pair, or `null` when there is nothing to compensate
 *   with — no calibration read, a blank coefficient block, or a part whose
 *   coefficients this SDK could not parse. `null` is the honest answer and
 *   callers treat it as one: the channels stay raw-only for that frame rather
 *   than carrying a number derived from zeros.
 */
export function compensatePressure(
  calibration: PressureCalibration | null,
  rawPressure: number,
  rawTemperature: number,
  oversampling = 0,
): CompensatedPressure | null {
  if (!calibration?.calibrated) return null;
  switch (calibration.sensor) {
    case 'bmp180':
      return calibration.coefficients
        ? compensateBmp180(
            rawPressure,
            rawTemperature,
            calibration.coefficients as Bmp180Coefficients,
            oversampling,
          )
        : null;
    case 'bmp280':
      return calibration.coefficients
        ? compensateBmp280(
            rawPressure,
            rawTemperature,
            calibration.coefficients as Bmp280Coefficients,
          )
        : null;
    case 'bmp390':
      return calibration.coefficients
        ? compensateBmp390(
            rawPressure,
            rawTemperature,
            calibration.coefficients as Bmp390Coefficients,
          )
        : null;
    case 'bmp581':
      return compensateBmp581(rawPressure, rawTemperature);
  }
}
