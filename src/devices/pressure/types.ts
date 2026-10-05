/**
 * Pressure/temperature sensor identity, coefficient block sizes and the shapes
 * the compensation functions exchange.
 *
 * Four Bosch parts appear across the Shimmer3 family, and a host needs to know
 * which one is fitted before it can turn a raw reading into kPa: three of them
 * need their factory trim coefficients, and the fourth needs none because it
 * compensates on-chip.
 *
 * The firmware answers that question in-band. `GET_PRESSURE_CALIBRATION_COEFFICIENTS`
 * (0xA7) replies `[0xA6][1 + n][sensorId][coeffs × n]`, where the length byte
 * counts the id (`log-and-stream-common/Comms/shimmer_bt_uart.c:2064-2099`, ids
 * at `Comms/shimmer_bt_uart.h:297-300`). A BMP581 answers with the id and
 * nothing else, which is a success rather than a refusal — the firmware's own
 * comment says the id is sent in-band precisely so a host can tell it from an
 * older firmware's NACK.
 */

/** Which Bosch part is fitted. */
export type PressureSensorKind = 'bmp180' | 'bmp280' | 'bmp390' | 'bmp581';

/**
 * `sensorId` byte in a `PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE`.
 * `Comms/shimmer_bt_uart.h:297-300`.
 */
export const PRESSURE_SENSOR_ID: Readonly<Record<number, PressureSensorKind>> = Object.freeze({
  0: 'bmp180',
  1: 'bmp280',
  2: 'bmp390',
  3: 'bmp581',
});

/** Inverse of {@link PRESSURE_SENSOR_ID}. */
export const PRESSURE_SENSOR_ID_BY_KIND: Readonly<Record<PressureSensorKind, number>> =
  Object.freeze({
    bmp180: 0,
    bmp280: 1,
    bmp390: 2,
    bmp581: 3,
  });

/**
 * Coefficient bytes each part sends after the id byte.
 *
 * BMP180 22 and BMP280 24 (`Shimmer_Driver/BMP280_driver/bmp280.h:693,740`),
 * BMP390 21 (`BMP3_LEN_CALIB_DATA`, `Shimmer_Driver/BMP3/hal_bmp3.h:16`),
 * BMP581 **zero** — it streams pre-compensated values.
 */
export const PRESSURE_COEFFICIENT_BYTES: Readonly<Record<PressureSensorKind, number>> =
  Object.freeze({
    bmp180: 22,
    bmp280: 24,
    bmp390: 21,
    bmp581: 0,
  });

/**
 * Largest payload a 0xA6 response can carry, after the length byte: the id plus
 * the biggest coefficient block (BMP280's 24). Used to bound the framer so a
 * corrupt length cannot make a reader wait for bytes that will never come.
 */
export const PRESSURE_CALIBRATION_RESPONSE_MAX_PAYLOAD = 1 + 24;

/** BMP180 trim coefficients (BST-BMP180-DS000 §3.4). */
export interface Bmp180Coefficients {
  ac1: number;
  ac2: number;
  ac3: number;
  ac4: number;
  ac5: number;
  ac6: number;
  b1: number;
  b2: number;
  mb: number;
  mc: number;
  md: number;
}

/** BMP280 trim coefficients (BST-BMP280-DS001 §3.11.2). */
export interface Bmp280Coefficients {
  digT1: number;
  digT2: number;
  digT3: number;
  digP1: number;
  digP2: number;
  digP3: number;
  digP4: number;
  digP5: number;
  digP6: number;
  digP7: number;
  digP8: number;
  digP9: number;
}

/**
 * BMP390 coefficients, already quantized — i.e. each register value divided by
 * its scale factor, the form Bosch's floating-point compensation consumes
 * directly (`BMP3_SensorAPI/bmp3.c` `parse_calib_data`).
 */
export interface Bmp390Coefficients {
  parT1: number;
  parT2: number;
  parT3: number;
  parP1: number;
  parP2: number;
  parP3: number;
  parP4: number;
  parP5: number;
  parP6: number;
  parP7: number;
  parP8: number;
  parP9: number;
  parP10: number;
  parP11: number;
}

/** Coefficients for whichever part is fitted; `null` for a BMP581. */
export type PressureCoefficients =
  Bmp180Coefficients | Bmp280Coefficients | Bmp390Coefficients | null;

/** What {@link parsePressureCalibrationResponse} hands back. */
export interface PressureCalibration {
  /** Which part answered. */
  sensor: PressureSensorKind;
  /**
   * Parsed coefficients, or `null` when the part needs none (BMP581) **or**
   * when the block it sent was blank — all `0x00`, all `0xFF`, or the `0x01`
   * filler a Shimmer3 sends for the wrong legacy command (see
   * {@link parsePressureCalibrationResponse}).
   */
  coefficients: PressureCoefficients;
  /**
   * True when this SDK can convert this part's raw readings to kPa and °C.
   * A BMP581 is `true` with no coefficients; a BMP390 whose block was blank is
   * `false`, because a compensation run against zeros is not a measurement.
   */
  calibrated: boolean;
  /** The coefficient bytes exactly as received, for a host that wants them. */
  raw: Uint8Array;
}

/** Compensated output, in the units this SDK emits. */
export interface CompensatedPressure {
  /** Pressure in kilopascals. */
  pressureKPa: number;
  /** Temperature in degrees Celsius. */
  temperatureC: number;
}
