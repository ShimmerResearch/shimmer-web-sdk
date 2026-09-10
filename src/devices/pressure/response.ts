/**
 * `PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE` (0xA6) payload parsing.
 */

import { isUniformByteArray } from '../../core/arrayBuffer.js';
import { parseBmp180Coefficients } from './bmp180.js';
import { parseBmp280Coefficients } from './bmp280.js';
import { parseBmp390Coefficients } from './bmp390.js';
import {
  PRESSURE_COEFFICIENT_BYTES,
  PRESSURE_SENSOR_ID,
  type PressureCalibration,
  type PressureCoefficients,
  type PressureSensorKind,
} from './types.js';

/**
 * Fill patterns that mean "there is nothing here".
 *
 * `0xFF` is erased flash and `0x00` an unwritten block — the two the Java
 * driver rejects (`CalibDetailsBmp180.parseCalParamByteArray:46-49`). `0x01` is
 * this SDK's addition, and it is not hypothetical: asked for BMP180
 * coefficients on a board carrying a BMP280, the classic Shimmer3 firmware
 * answers a full-length block of `0x01` filler rather than refusing
 * (`ccs_workspace/FW_Shimmer3/LogAndStream/main.c` `GET_BMP180_CALIBRATION_…`,
 * and the same `memset(…, 0x01, …)` survives in
 * `log-and-stream-common/Comms/shimmer_bt_uart.c:2033-2037`). Compensating
 * against it yields a confident, wrong pressure.
 */
const BLANK_FILL_BYTES = [0x00, 0xff, 0x01] as const;

const isBlankBlock = (bytes: Uint8Array): boolean =>
  bytes.length === 0 || BLANK_FILL_BYTES.some((fill) => isUniformByteArray(bytes, fill));

function parseCoefficients(sensor: PressureSensorKind, bytes: Uint8Array): PressureCoefficients {
  switch (sensor) {
    case 'bmp180':
      return parseBmp180Coefficients(bytes);
    case 'bmp280':
      return parseBmp280Coefficients(bytes);
    case 'bmp390':
      return parseBmp390Coefficients(bytes);
    case 'bmp581':
      return null;
  }
}

/**
 * Parse a 0xA6 payload — `[sensorId][coeffs…]`, i.e. everything after the
 * opcode and its length byte.
 *
 * @throws RangeError when the payload is empty, the sensor id is not one of the
 *   four the firmware can report, or the block is not the length that part
 *   sends. All three mean the bytes are not what they claim to be, and a
 *   silently accepted short block would be compensated against whatever
 *   followed it in memory.
 */
export function parsePressureCalibrationResponse(payload: Uint8Array): PressureCalibration {
  if (payload.length < 1) {
    throw new RangeError('Pressure calibration response carried no sensor id.');
  }
  const id = payload[0];
  const sensor = PRESSURE_SENSOR_ID[id];
  if (!sensor) {
    throw new RangeError(
      `Pressure calibration response reported unknown sensor id ${id}; ` +
        `expected 0 (BMP180), 1 (BMP280), 2 (BMP390) or 3 (BMP581).`,
    );
  }
  const raw = payload.slice(1);
  const expected = PRESSURE_COEFFICIENT_BYTES[sensor];
  if (raw.length !== expected) {
    throw new RangeError(
      `Pressure calibration response for ${sensor} carried ${raw.length} coefficient ` +
        `byte(s); expected ${expected}.`,
    );
  }

  // A BMP581 sends no block, and that is the whole point — it needs none.
  if (sensor === 'bmp581') {
    return { sensor, coefficients: null, calibrated: true, raw };
  }

  if (isBlankBlock(raw)) {
    return { sensor, coefficients: null, calibrated: false, raw };
  }

  const coefficients = parseCoefficients(sensor, raw);
  return { sensor, coefficients, calibrated: coefficients !== null, raw };
}
