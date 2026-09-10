import { describe, expect, it } from 'vitest';
import {
  compensateBmp180,
  compensateBmp280,
  compensateBmp390,
  compensateBmp581,
  compensatePressure,
  parseBmp180Coefficients,
  parseBmp280Coefficients,
  parseBmp390Coefficients,
} from '../../src/devices/pressure/index.js';
import type { PressureCalibration } from '../../src/devices/pressure/index.js';

/**
 * Where each vector comes from, and how far that goes:
 *
 * - **BMP180**: BST-BMP180-DS000 §3.5, coefficients AND answers — 150
 *   (15.0 °C) and 69964 Pa. The port reproduces the temperature exactly and
 *   the pressure to 69961 Pa, 3 Pa low, because the datasheet's worked example
 *   is integer arithmetic throughout while the Java driver this port follows
 *   uses real division (`CalibDetailsBmp180.calibratePressureSensorData`).
 *   The assertions below state the port's value and the datasheet's separately
 *   rather than pretending they agree: 3 Pa exceeds the part's 2 Pa
 *   resolution, so it is a real, if tiny, divergence and a reader should know
 *   which number they are looking at.
 * - **BMP280**: BST-BMP280-DS001 §8.2, coefficients and answers — 25.08 °C and
 *   100653 Pa.
 * - **BMP390**: coefficients from the Java driver's own
 *   `CalibDetailsBmp390.main()` (:294-336), which is the only BMP390 example on
 *   hand. Its `main()` prints its results rather than asserting them, so the
 *   expected values here were computed from Bosch's published algorithm rather
 *   than copied from a publication. Recompute them, do not trust them because
 *   they are written down.
 * - **BMP581**: exact powers of two, because its conversion is two divisions.
 */

// --- BMP180 -----------------------------------------------------------------

/** BST-BMP180-DS000 §3.5, in the block's own byte order (big-endian pairs). */
const BMP180_DATASHEET_BLOCK = (): Uint8Array => {
  const b = new Uint8Array(22);
  const put = (o: number, v: number) => {
    b[o] = (v >> 8) & 0xff;
    b[o + 1] = v & 0xff;
  };
  put(0, 408 & 0xffff); // AC1
  put(2, -72 & 0xffff); // AC2
  put(4, -14383 & 0xffff); // AC3
  put(6, 32741); // AC4 (unsigned)
  put(8, 32757); // AC5 (unsigned)
  put(10, 23153); // AC6 (unsigned)
  put(12, 6190); // B1
  put(14, 4); // B2
  put(16, -32768 & 0xffff); // MB
  put(18, -8711 & 0xffff); // MC
  put(20, 2868); // MD
  return b;
};

describe('BMP180', () => {
  it('parses the datasheet trim block, signed and unsigned fields alike', () => {
    const c = parseBmp180Coefficients(BMP180_DATASHEET_BLOCK())!;
    expect(c).toEqual({
      ac1: 408,
      ac2: -72,
      ac3: -14383,
      ac4: 32741,
      ac5: 32757,
      ac6: 23153,
      b1: 6190,
      b2: 4,
      mb: -32768,
      mc: -8711,
      md: 2868,
    });
  });

  it('reproduces the datasheet worked example', () => {
    const c = parseBmp180Coefficients(BMP180_DATASHEET_BLOCK())!;
    // The datasheet's UP is the right-aligned value; the channel carries it
    // left-aligned by 8 - oss bits, which compensateBmp180 undoes.
    const out = compensateBmp180(23843 * 256, 27898, c, 0);
    expect(out.temperatureC).toBeCloseTo(15.0471242, 6);
    expect(out.pressureKPa).toBeCloseTo(69.9606585, 6);
    // Temperature matches the datasheet's 150 (15.0 °C) exactly.
    expect(Math.round(out.temperatureC * 10)).toBe(150);
    /* Pressure is 69961 Pa where the datasheet's integer walk-through gives
       69964. The 3 Pa is the real-division port, inherited deliberately from
       the Java driver so a host and Consensys agree; see the file docblock.
       Pinned both ways so neither number can drift unnoticed. */
    expect(Math.round(out.pressureKPa * 1000)).toBe(69961);
    expect(Math.abs(out.pressureKPa * 1000 - 69964)).toBeLessThan(4);
  });

  it('reads the same pressure at every oversampling setting', () => {
    // The chip left-aligns its result in the 24-bit register, so the raw
    // channel value for a given pressure does NOT depend on the oversampling
    // setting — the setting appears twice inside the maths (as `1 << oss` and
    // `50000 >> oss`) and cancels the `2^(8-oss)` right-shift. Getting this
    // wrong scales the reported pressure by a power of two, so it is worth a
    // test: all four settings must agree to within a couple of pascals (they
    // differ only in where the algorithm's fixed-point rounding lands).
    const c = parseBmp180Coefficients(BMP180_DATASHEET_BLOCK())!;
    const results = [0, 1, 2, 3].map((oss) => compensateBmp180(23843 * 256, 27898, c, oss));
    for (const r of results) {
      expect(r.pressureKPa).toBeCloseTo(69.9606585, 2);
      expect(r.temperatureC).toBeCloseTo(15.0471242, 6);
    }
  });

  it('rejects a short block', () => {
    expect(parseBmp180Coefficients(new Uint8Array(21))).toBeNull();
  });
});

// --- BMP280 -----------------------------------------------------------------

/** BST-BMP280-DS001 §8.2, in the block's own byte order (little-endian pairs). */
const BMP280_DATASHEET_BLOCK = (): Uint8Array => {
  const b = new Uint8Array(24);
  const put = (o: number, v: number) => {
    b[o] = v & 0xff;
    b[o + 1] = (v >> 8) & 0xff;
  };
  put(0, 27504); // dig_T1 (unsigned)
  put(2, 26435); // dig_T2
  put(4, -1000 & 0xffff); // dig_T3
  put(6, 36477); // dig_P1 (unsigned)
  put(8, -10685 & 0xffff);
  put(10, 3024);
  put(12, 2855);
  put(14, 140);
  put(16, -7 & 0xffff);
  put(18, 15500);
  put(20, -14600 & 0xffff);
  put(22, 6000);
  return b;
};

describe('BMP280', () => {
  it('parses the datasheet trim block with little-endian pairs', () => {
    const c = parseBmp280Coefficients(BMP280_DATASHEET_BLOCK())!;
    expect(c).toEqual({
      digT1: 27504,
      digT2: 26435,
      digT3: -1000,
      digP1: 36477,
      digP2: -10685,
      digP3: 3024,
      digP4: 2855,
      digP5: 140,
      digP6: -7,
      digP7: 15500,
      digP8: -14600,
      digP9: 6000,
    });
  });

  it('reproduces the datasheet worked example, recovering the 20-bit values', () => {
    const c = parseBmp280Coefficients(BMP280_DATASHEET_BLOCK())!;
    // adc_T 519888 arrives as 2 bytes (÷16); adc_P 415148 as 3 bytes (×16).
    const out = compensateBmp280(415148 * 16, 519888 / 16, c);
    expect(out.temperatureC).toBeCloseTo(25.0824779, 6);
    expect(out.pressureKPa).toBeCloseTo(100.6532668, 6);
    // The datasheet states 25.08 °C and 100653 Pa.
    expect(Math.round(out.temperatureC * 100)).toBe(2508);
    expect(Math.round(out.pressureKPa * 1000)).toBe(100653);
  });

  it('is not compensated without the temperature shift', () => {
    // Feeding the 16-bit temperature straight in — the shape of an easy
    // mistake — is not merely inaccurate, it is unphysical. This pins that the
    // port shifts, by showing what the unshifted answer would be.
    const c = parseBmp280Coefficients(BMP280_DATASHEET_BLOCK())!;
    const wrong = compensateBmp280(415148 * 16, 519888 / 16 / 16, c);
    expect(wrong.temperatureC).toBeLessThan(-100);
  });

  it('reports an unusable calibration as NaN rather than Infinity', () => {
    const c = parseBmp280Coefficients(BMP280_DATASHEET_BLOCK())!;
    const out = compensateBmp280(415148 * 16, 519888 / 16, { ...c, digP1: 0 });
    expect(Number.isNaN(out.pressureKPa)).toBe(true);
    expect(out.temperatureC).toBeCloseTo(25.0824779, 6);
  });
});

// --- BMP390 -----------------------------------------------------------------

/** The Java driver's own vector (`CalibDetailsBmp390.main()` :301-306). */
const BMP390_BLOCK = (): Uint8Array =>
  Uint8Array.from([
    0xe7, 0x6b, 0xf0, 0x4a, 0xf9, 0xab, 0x1c, 0x9b, 0x15, 0x06, 0x01, 0xd2, 0x49, 0x18, 0x5f, 0x03,
    0xfa, 0x3a, 0x0f, 0x07, 0xf5,
  ]);

describe('BMP390', () => {
  it('reproduces the Java driver vector, both samples', () => {
    const c = parseBmp390Coefficients(BMP390_BLOCK())!;
    const a = compensateBmp390(0x640d00, 0x7fba00, c);
    expect(a.pressureKPa).toBeCloseTo(100.9118245, 6);
    expect(a.temperatureC).toBeCloseTo(23.1701699, 6);

    const b = compensateBmp390(0x641700, 0x7fcf00, c);
    expect(b.pressureKPa).toBeCloseTo(100.9128176, 6);
    expect(b.temperatureC).toBeCloseTo(23.265872, 6);
  });

  it('reads par_T1 and par_T2 as UNSIGNED, as Bosch does and Java does not', () => {
    // Java casts both through `(short)` (CalibDetailsBmp390.java:210,214) while
    // Bosch declares them uint16_t (bmp3_defs.h:566-567). A real par_T1 is a
    // scaled reference temperature well above 32767, so the difference is not
    // academic: the signed reading makes the sensor report roughly -140 °C.
    const b = BMP390_BLOCK();
    b[0] = 0x00;
    b[1] = 0x80; // par_T1 register = 0x8000 = 32768, negative as a short
    const c = parseBmp390Coefficients(b)!;
    expect(c.parT1).toBe(32768 * 256);
    expect(c.parT1).toBeGreaterThan(0);

    /* And the value it produces, which is the point. Reading par_T1 as a short
       here would put the reference temperature 65536 counts out and drag the
       compensated temperature to about -140 °C — the Java bug's actual
       symptom. The reference vector cannot show this: its own par_T1 is 0x6BE7
       = 27623, below 32768, where signed and unsigned agree. */
    const out = compensateBmp390(0x640d00, 0x7fba00, c);
    expect(out.temperatureC).toBeGreaterThan(-40);
    expect(out.temperatureC).toBeLessThan(85);
  });

  it('clamps to the compensation limits Bosch states', () => {
    const c = parseBmp390Coefficients(BMP390_BLOCK())!;
    // Raw values far outside anything the chip can produce. Both clamp; which
    // end each lands on follows the sign of this unit's coefficients (par_P1 is
    // negative here), so the assertion is on the limits, not on a direction.
    const low = compensateBmp390(0, 0, c);
    expect(low.temperatureC).toBe(-40);
    expect(low.pressureKPa).toBe(125);

    const high = compensateBmp390(0xffffff, 0xffffff, c);
    expect(high.temperatureC).toBe(85);
    expect(high.pressureKPa).toBe(30);
  });

  it('rejects a short block', () => {
    expect(parseBmp390Coefficients(new Uint8Array(20))).toBeNull();
  });
});

// --- BMP581 -----------------------------------------------------------------

describe('BMP581', () => {
  it('scales pressure by 64 and temperature by 65536', () => {
    expect(compensateBmp581(6400000, 1638400)).toEqual({
      pressureKPa: 100,
      temperatureC: 25,
    });
  });

  it('treats temperature as signed 24-bit, and pressure as unsigned', () => {
    // The Bosch driver sign-extends temperature only (bmp5.c:684-700).
    expect(compensateBmp581(0, 0xffffff).temperatureC).toBeCloseTo(-1 / 65536, 12);
    expect(compensateBmp581(0xffffff, 0).pressureKPa).toBeCloseTo(0xffffff / 64000, 9);
  });
});

// --- dispatch ---------------------------------------------------------------

describe('compensatePressure', () => {
  const cal = (over: Partial<PressureCalibration>): PressureCalibration =>
    ({
      sensor: 'bmp390',
      coefficients: parseBmp390Coefficients(BMP390_BLOCK()),
      calibrated: true,
      raw: BMP390_BLOCK(),
      ...over,
    }) as PressureCalibration;

  it('returns null when there is nothing to compensate with', () => {
    expect(compensatePressure(null, 0x640d00, 0x7fba00)).toBeNull();
    expect(compensatePressure(cal({ calibrated: false }), 0x640d00, 0x7fba00)).toBeNull();
    expect(
      compensatePressure(cal({ coefficients: null, calibrated: true }), 0x640d00, 0x7fba00),
    ).toBeNull();
  });

  it('dispatches on the part, and a BMP581 needs no coefficients', () => {
    const bmp390 = compensatePressure(cal({}), 0x640d00, 0x7fba00)!;
    expect(bmp390.pressureKPa).toBeCloseTo(100.9118245, 6);

    const bmp581 = compensatePressure(
      cal({ sensor: 'bmp581', coefficients: null, raw: new Uint8Array(0) }),
      6400000,
      1638400,
    )!;
    expect(bmp581).toEqual({ pressureKPa: 100, temperatureC: 25 });
  });

  it('passes the oversampling through to the BMP180 only', () => {
    const c180 = cal({
      sensor: 'bmp180',
      coefficients: parseBmp180Coefficients(BMP180_DATASHEET_BLOCK()),
      raw: BMP180_DATASHEET_BLOCK(),
    });
    const a = compensatePressure(c180, 23843 * 256, 27898, 0)!;
    const b = compensatePressure(c180, 23843 * 256, 27898, 3)!;
    expect(a.pressureKPa).not.toBeCloseTo(b.pressureKPa, 3);
  });
});
