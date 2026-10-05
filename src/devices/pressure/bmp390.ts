/**
 * BMP390 — coefficient parsing and Bosch's floating-point compensation.
 *
 * Ported from the Bosch Sensor API bundled with the firmware
 * (`Shimmer_Driver/BMP3/BMP3_SensorAPI/bmp3.c`: `parse_calib_data` :2371-2425,
 * and the `BMP3_FLOAT_COMPENSATION` arms of `compensate_temperature` /
 * `compensate_pressure`), cross-checked against the Java driver's
 * `CalibDetailsBmp390` (:109-268), which is the same algorithm.
 *
 * **Two coefficient types follow Bosch rather than Java.** Java reads `par_T1`
 * and `par_T2` through `(short)`, i.e. signed
 * (`CalibDetailsBmp390.java:210,214`), where Bosch declares both `uint16_t`
 * (`bmp3_defs.h:566-567`). A real `par_T1` is well above 32767 — it is a
 * scaled-up reference temperature — so the Java cast turns it negative and the
 * reported temperature is wrong by hundreds of degrees. This port uses the
 * Bosch types.
 *
 * The clamps are Bosch's too: −40…85 °C and 30…125 kPa
 * (`bmp3_defs.h:318-325`). They are wide enough that hitting one means the
 * input was not a real reading.
 */

import { i16le, s8, u16le } from './bytes.js';
import type { Bmp390Coefficients, CompensatedPressure } from './types.js';

/** Bosch's compensation limits (`bmp3_defs.h:318-325`). */
const MIN_TEMP_C = -40;
const MAX_TEMP_C = 85;
const MIN_PRES_PA = 30000;
const MAX_PRES_PA = 125000;

/**
 * Parse the 21-byte BMP390 trim block into Bosch's quantized form — each
 * register value already divided by its scale factor, which is what
 * {@link compensateBmp390} consumes.
 *
 * Byte order is little-endian per coefficient.
 */
export function parseBmp390Coefficients(bytes: Uint8Array): Bmp390Coefficients | null {
  if (bytes.length < 21) return null;
  return {
    // 1 / 2^8 — dividing by 0.00390625 is multiplying by 256.
    parT1: u16le(bytes, 0) / 0.00390625,
    parT2: u16le(bytes, 2) / 1073741824,
    parT3: s8(bytes[4]) / 281474976710656,
    parP1: (i16le(bytes, 5) - 16384) / 1048576,
    parP2: (i16le(bytes, 7) - 16384) / 536870912,
    parP3: s8(bytes[9]) / 4294967296,
    parP4: s8(bytes[10]) / 137438953472,
    // 1 / 2^3
    parP5: u16le(bytes, 11) / 0.125,
    parP6: u16le(bytes, 13) / 64,
    parP7: s8(bytes[15]) / 256,
    parP8: s8(bytes[16]) / 32768,
    parP9: i16le(bytes, 17) / 281474976710656,
    parP10: s8(bytes[19]) / 281474976710656,
    parP11: s8(bytes[20]) / 36893488147419103232,
  };
}

/**
 * Compensate one BMP390 sample.
 *
 * Both raw values are the 24-bit channel values as streamed; the BMP390 needs
 * no pre-shift, unlike the BMP180 and BMP280.
 */
export function compensateBmp390(
  rawPressure: number,
  rawTemperature: number,
  c: Bmp390Coefficients,
): CompensatedPressure {
  // Temperature, and `tLin` which the pressure maths needs.
  const partialDataT1 = rawTemperature - c.parT1;
  const partialDataT2 = partialDataT1 * c.parT2;
  let tLin = partialDataT2 + partialDataT1 * partialDataT1 * c.parT3;
  if (tLin < MIN_TEMP_C) tLin = MIN_TEMP_C;
  if (tLin > MAX_TEMP_C) tLin = MAX_TEMP_C;

  // Pressure.
  let partialData1 = c.parP6 * tLin;
  let partialData2 = c.parP7 * tLin ** 2;
  let partialData3 = c.parP8 * tLin ** 3;
  const partialOut1 = c.parP5 + partialData1 + partialData2 + partialData3;

  partialData1 = c.parP2 * tLin;
  partialData2 = c.parP3 * tLin ** 2;
  partialData3 = c.parP4 * tLin ** 3;
  const partialOut2 = rawPressure * (c.parP1 + partialData1 + partialData2 + partialData3);

  partialData1 = rawPressure ** 2;
  partialData2 = c.parP9 + c.parP10 * tLin;
  partialData3 = partialData1 * partialData2;
  const partialData4 = partialData3 + rawPressure ** 3 * c.parP11;

  let pressurePa = partialOut1 + partialOut2 + partialData4;
  if (pressurePa < MIN_PRES_PA) pressurePa = MIN_PRES_PA;
  if (pressurePa > MAX_PRES_PA) pressurePa = MAX_PRES_PA;

  return { pressureKPa: pressurePa / 1000, temperatureC: tLin };
}
