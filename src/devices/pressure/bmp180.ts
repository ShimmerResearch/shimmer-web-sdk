/**
 * BMP180 — coefficient parsing and Bosch's integer compensation, in floating
 * point.
 *
 * Ported from the Java driver's `CalibDetailsBmp180.parseCalParamByteArray`
 * (:44-66) and `calibratePressureSensorData` (:93-124), which is itself the
 * datasheet's algorithm (BST-BMP180-DS000 §3.5) with the integer divisions left
 * as real divisions. The firmware does not implement any of this: it relays the
 * chip's trim registers and its raw readings untouched.
 *
 * The oversampling setting is part of the pressure maths, not a scale applied
 * afterwards — it appears twice, as `1 << oss` and `50000 >> oss` — which is why
 * {@link compensateBmp180} takes it as an argument rather than letting a caller
 * pre-scale.
 */

import { i16be, u16be } from './bytes.js';
import type { Bmp180Coefficients, CompensatedPressure } from './types.js';

/**
 * Parse the 22-byte BMP180 trim block.
 *
 * Byte order is **big-endian per coefficient** — byte 0 is the MSB of `AC1`.
 * `AC4`, `AC5` and `AC6` are unsigned; the other eight are signed.
 *
 * @returns the coefficients, or `null` when the block carries nothing (see
 *   {@link parsePressureCalibrationResponse} for which fill patterns count).
 */
export function parseBmp180Coefficients(bytes: Uint8Array): Bmp180Coefficients | null {
  if (bytes.length < 22) return null;
  return {
    ac1: i16be(bytes, 0),
    ac2: i16be(bytes, 2),
    ac3: i16be(bytes, 4),
    ac4: u16be(bytes, 6),
    ac5: u16be(bytes, 8),
    ac6: u16be(bytes, 10),
    b1: i16be(bytes, 12),
    b2: i16be(bytes, 14),
    mb: i16be(bytes, 16),
    mc: i16be(bytes, 18),
    md: i16be(bytes, 20),
  };
}

/**
 * Compensate one BMP180 sample.
 *
 * @param rawPressure    The 24-bit `BMP_PRESSURE` channel value, **unshifted**.
 *   The chip left-aligns its result by `8 - oss` bits and the datasheet's `UP`
 *   is the right-aligned value, so this function performs that shift itself
 *   (Java does it one layer up, `SensorBMP180.java:509`).
 * @param rawTemperature The 16-bit `BMP_TEMPERATURE` channel value.
 * @param c              Trim coefficients from {@link parseBmp180Coefficients}.
 * @param oversampling   The configured oversampling setting, 0-3.
 */
export function compensateBmp180(
  rawPressure: number,
  rawTemperature: number,
  c: Bmp180Coefficients,
  oversampling: number,
): CompensatedPressure {
  const oss = Math.max(0, Math.min(3, Math.trunc(oversampling)));
  const up = rawPressure / 2 ** (8 - oss);
  const ut = rawTemperature;

  // Temperature.
  let x1 = (ut - c.ac6) * (c.ac5 / 32768);
  let x2 = (c.mc * 2048) / (x1 + c.md);
  const b5 = x1 + x2;
  const t = (b5 + 8) / 16;

  // Pressure.
  const b6 = b5 - 4000;
  x1 = (c.b2 * (b6 ** 2 / 4096)) / 2048;
  x2 = (c.ac2 * b6) / 2048;
  let x3 = x1 + x2;
  const b3 = ((c.ac1 * 4 + x3) * (1 << oss) + 2) / 4;
  x1 = (c.ac3 * b6) / 8192;
  x2 = (c.b1 * (b6 ** 2 / 4096)) / 65536;
  x3 = (x1 + x2 + 2) / 4;
  const b4 = (c.ac4 * (x3 + 32768)) / 32768;
  const b7 = (up - b3) * (50000 >> oss);
  // The datasheet's branch on 0x80000000 is an unsigned-overflow guard for
  // 32-bit integer maths. It is kept because it changes the rounding, not
  // because it can overflow here.
  let p = b7 < 2147483648 ? (b7 * 2) / b4 : (b7 / b4) * 2;
  x1 = ((p / 256) * (p / 256) * 3038) / 65536;
  x2 = (-7357 * p) / 65536;
  p = p + (x1 + x2 + 3791) / 16;

  return { pressureKPa: p / 1000, temperatureC: t / 10 };
}
