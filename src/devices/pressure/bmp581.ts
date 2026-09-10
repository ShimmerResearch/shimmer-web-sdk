/**
 * BMP581 — no coefficients, two fixed scale factors.
 *
 * The BMP581 compensates on-chip, so the firmware relays its output registers
 * verbatim and there is nothing per-device to read: the 0xA7 reply carries the
 * sensor id and no coefficient bytes at all
 * (`log-and-stream-common/Comms/shimmer_bt_uart.c:2067-2077`).
 *
 * Scale factors and signedness are the Bosch driver's
 * (`Shimmer_Driver/BMP5/BMP5_SensorAPI/bmp5.c:682-720`): pressure is an
 * **unsigned** 24-bit value over 64 for pascals, temperature a **signed**
 * 24-bit value over 65536 for degrees Celsius. The Java driver agrees
 * (`CalibDetailsBmp581.java:26-31`).
 */

import { s24 } from './bytes.js';
import type { CompensatedPressure } from './types.js';

/**
 * Scale one BMP581 sample.
 *
 * @param rawPressure    Unsigned 24-bit pressure register value.
 * @param rawTemperature 24-bit temperature register value, two's complement.
 */
export function compensateBmp581(rawPressure: number, rawTemperature: number): CompensatedPressure {
  return {
    // Pa = raw / 64, and this SDK reports kPa.
    pressureKPa: rawPressure / 64 / 1000,
    temperatureC: s24(rawTemperature) / 65536,
  };
}
