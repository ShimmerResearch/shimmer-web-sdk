/**
 * BMP280 — coefficient parsing and Bosch's floating-point compensation.
 *
 * Ported from the Java driver's `CalibDetailsBmp280.parseCalParamByteArray`
 * (:56-81) and `calibratePressureSensorData` (:117-146), which is the
 * datasheet's `bmp280_compensate_T_double` / `_P_double` (BST-BMP280-DS001
 * §8.2).
 *
 * The raw shifts are the part that catches people. The datasheet's `adc_T` and
 * `adc_P` are **20-bit** values, but the Shimmer3 packet carries temperature in
 * 2 bytes and pressure in 3 — the chip's XLSB register never reaches the host.
 * So temperature has to be shifted up by 4 and pressure down by 4 before the
 * algorithm sees them, which is what `SensorBMP280.java:414-415` does and what
 * {@link compensateBmp280} does here.
 */

import { i16le, u16le } from './bytes.js';
import type { Bmp280Coefficients, CompensatedPressure } from './types.js';

/**
 * Parse the 24-byte BMP280 trim block.
 *
 * Byte order is **little-endian per coefficient**, the opposite of BMP180's
 * block. `digT1` and `digP1` are unsigned; the other ten are signed.
 */
export function parseBmp280Coefficients(bytes: Uint8Array): Bmp280Coefficients | null {
  if (bytes.length < 24) return null;
  return {
    digT1: u16le(bytes, 0),
    digT2: i16le(bytes, 2),
    digT3: i16le(bytes, 4),
    digP1: u16le(bytes, 6),
    digP2: i16le(bytes, 8),
    digP3: i16le(bytes, 10),
    digP4: i16le(bytes, 12),
    digP5: i16le(bytes, 14),
    digP6: i16le(bytes, 16),
    digP7: i16le(bytes, 18),
    digP8: i16le(bytes, 20),
    digP9: i16le(bytes, 22),
  };
}

/**
 * Compensate one BMP280 sample.
 *
 * @param rawPressure    The 24-bit `BMP_PRESSURE` channel value, unshifted.
 * @param rawTemperature The 16-bit `BMP_TEMPERATURE` channel value, unshifted.
 * @param c              Trim coefficients from {@link parseBmp280Coefficients}.
 */
export function compensateBmp280(
  rawPressure: number,
  rawTemperature: number,
  c: Bmp280Coefficients,
): CompensatedPressure {
  // Recover the 20-bit values the algorithm is written for.
  const adcT = rawTemperature * 16;
  const adcP = rawPressure / 16;

  let var1 = (adcT / 16384 - c.digT1 / 1024) * c.digT2;
  let var2 = (adcT / 131072 - c.digT1 / 8192) * (adcT / 131072 - c.digT1 / 8192) * c.digT3;
  const tFine = var1 + var2;
  const t = tFine / 5120;

  var1 = tFine / 2 - 64000;
  var2 = (var1 * var1 * c.digP6) / 32768;
  var2 = var2 + var1 * c.digP5 * 2;
  var2 = var2 / 4 + c.digP4 * 65536;
  var1 = ((c.digP3 * var1 * var1) / 524288 + c.digP2 * var1) / 524288;
  var1 = (1 + var1 / 32768) * c.digP1;
  // A zero `var1` would divide by zero below. The datasheet returns 0 Pa; the
  // Java port comments the guard out and lets it produce Infinity. Neither is
  // a measurement, so this reports it as one: NaN, which a plot breaks on
  // rather than drawing a spike to infinity.
  if (var1 === 0) return { pressureKPa: NaN, temperatureC: t };
  let p = 1048576 - adcP;
  p = ((p - var2 / 4096) * 6250) / var1;
  var1 = (c.digP9 * p * p) / 2147483648;
  var2 = (p * c.digP8) / 32768;
  p = p + (var1 + var2 + c.digP7) / 16;

  return { pressureKPa: p / 1000, temperatureC: t };
}
