import { describe, it, expect } from 'vitest';
import {
  SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS,
  SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS,
  SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_ADXL371_ACCEL_RATE_OPTIONS,
  SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LIS2MDL_MAG_RATE_OPTIONS,
  SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS,
  SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS,
  SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS,
  SHIMMER3_BMP390_PRESSURE_OVERSAMPLING_OPTIONS,
  SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS,
  SHIMMER3_BMP581_PRESSURE_OVERSAMPLING_OPTIONS,
  SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS,
  SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS,
  SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS,
  SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS,
  SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS,
  SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS,
  SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS,
  SHIMMER3_LSM303DLHC_MAG_RATE_OPTIONS,
  SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS,
  SHIMMER3_LSM303AH_ACCEL_RATE_HR_OPTIONS,
  SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS,
  SHIMMER3_LSM303AH_MAG_RATE_OPTIONS,
  SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS,
  SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS,
  SHIMMER3_MPU9X50_ACCEL_RANGE_OPTIONS,
  SHIMMER3_MPU9X50_MAG_RATE_OPTIONS,
  SHIMMER3_BT_BAUD_RATE_OPTIONS,
  SHIMMER3_SAMPLING_RATES_HZ,
  samplingRateToDivisor,
  divisorToSamplingRate,
  SHIMMER3_SENSOR_LABELS,
  shimmer3SensorLabel,
  type Shimmer3SensorOption,
} from '../../src/devices/shimmer3/sensorOptions.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// The option tables are ported from the Java driver, so their real test is a
// diff against that source — which a unit test cannot do. What these tests
// CAN pin are the invariants a transcription error breaks: a config value that
// appears twice (so one option is unreachable), a table that no longer covers
// the range the client accepts, and the oddities the port deliberately
// preserved, which a well-meaning tidy-up would "fix".

/** Every table, so the structural checks below cannot silently skip one. */
const ALL_TABLES: readonly [string, readonly Shimmer3SensorOption[]][] = [
  ['LSM6DSV accel range', SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS],
  ['LSM6DSV gyro range', SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS],
  ['LSM6DSV accel/gyro rate', SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS],
  ['LIS2DW12 accel range', SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS],
  ['LIS2DW12 accel rate HPM', SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS],
  ['LIS2DW12 accel rate LPM', SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS],
  ['ADXL371 accel rate', SHIMMER3_ADXL371_ACCEL_RATE_OPTIONS],
  ['ADXL371 accel range', SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS],
  ['LIS2MDL mag rate', SHIMMER3_LIS2MDL_MAG_RATE_OPTIONS],
  ['LIS2MDL mag range', SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS],
  ['LIS3MDL alt mag rate', SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS],
  ['LIS3MDL alt mag range', SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS],
  ['BMP390 oversampling', SHIMMER3_BMP390_PRESSURE_OVERSAMPLING_OPTIONS],
  ['BMP390 rate', SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS],
  ['BMP581 oversampling', SHIMMER3_BMP581_PRESSURE_OVERSAMPLING_OPTIONS],
  ['BMP581 rate', SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS],
  ['BMP180 resolution', SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS],
  ['BMP280 resolution', SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS],
  ['GSR range (resistance)', SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS],
  ['GSR range (conductance)', SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS],
  ['LSM303DLHC accel range', SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS],
  ['LSM303DLHC accel rate HR', SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS],
  ['LSM303DLHC accel rate LPM', SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS],
  ['LSM303DLHC mag range', SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS],
  ['LSM303DLHC mag rate', SHIMMER3_LSM303DLHC_MAG_RATE_OPTIONS],
  ['LSM303AH accel range', SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS],
  ['LSM303AH accel rate HR', SHIMMER3_LSM303AH_ACCEL_RATE_HR_OPTIONS],
  ['LSM303AH accel rate LPM', SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS],
  ['LSM303AH mag rate', SHIMMER3_LSM303AH_MAG_RATE_OPTIONS],
  ['LSM303AH mag range', SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS],
  ['MPU9X50 gyro range', SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS],
  ['MPU9X50 accel range', SHIMMER3_MPU9X50_ACCEL_RANGE_OPTIONS],
  ['MPU9X50 mag rate', SHIMMER3_MPU9X50_MAG_RATE_OPTIONS],
  ['BT baud rate', SHIMMER3_BT_BAUD_RATE_OPTIONS],
];

describe('Shimmer3 option tables: structure', () => {
  it('covers all 34 tables', () => {
    expect(ALL_TABLES).toHaveLength(34);
  });

  it.each(ALL_TABLES)('%s has no duplicate config value', (_name, table) => {
    // A repeated value makes one option unreachable and the other ambiguous —
    // the signature of a mis-paired label/value transcription.
    const values = table.map(([v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });

  it.each(ALL_TABLES)('%s has non-empty labels and byte-sized values', (_name, table) => {
    expect(table.length).toBeGreaterThan(0);
    for (const [value, label] of table) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xff);
      expect(label.trim()).toBe(label);
      expect(label.length).toBeGreaterThan(0);
    }
  });
});

describe('Shimmer3 option tables: coverage of the client setter ranges', () => {
  // The setters validate a numeric range; the tables are what a UI offers for
  // it. If they disagree, either a legal setting is unofferable or an offered
  // one is rejected before it reaches the device.
  const valuesOf = (t: readonly Shimmer3SensorOption[]): number[] =>
    t.map(([v]) => v).sort((a, b) => a - b);

  it('wide-range accel range covers setWrAccelRange 0-3', () => {
    expect(valuesOf(SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS)).toEqual([0, 1, 2, 3]);
    expect(valuesOf(SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS)).toEqual([0, 1, 2, 3]);
    // The LSM303AH covers the same four values in a different ORDER.
    expect(valuesOf(SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS)).toEqual([0, 1, 2, 3]);
  });

  it('gyro range covers setGyroRange 0-5 on the Shimmer3R chip', () => {
    expect(valuesOf(SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS)).toEqual([0, 1, 2, 3, 4, 5]);
    // The classic Shimmer3's MPU9X50 stops at 3, which is why the client's
    // 0-5 validation is a superset rather than the truth for both platforms.
    expect(valuesOf(SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS)).toEqual([0, 1, 2, 3]);
  });

  it('GSR range covers setGSRRange 0-4, including Auto', () => {
    expect(valuesOf(SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS)).toEqual([0, 1, 2, 3, 4]);
    expect(valuesOf(SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS)).toEqual([0, 1, 2, 3, 4]);
    expect(SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS[4][1]).toBe('Auto Range');
    expect(SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS[4][1]).toBe('Auto Range');
  });

  it('the two GSR unit views describe the same config values', () => {
    expect(valuesOf(SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS)).toEqual(
      valuesOf(SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS),
    );
  });

  it('every table value is one the client would accept', async () => {
    // Drive the real setters rather than restating their bounds: this fails if
    // a table grows past what the client validates, in either direction.
    const t = new LoopbackTransport({ deviceName: 'Shimmer3R-TEST' });
    t.setOnWrite((_bytes, tr) => setTimeout(() => tr.notify([0xff]), 0));
    const client = new Shimmer3RClient({ debug: false, transport: t });
    await client.connect();

    for (const [value] of SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS) {
      await expect(client.setWrAccelRange(value)).resolves.toMatchObject({
        wrAccelRange: value,
      });
    }
    for (const [value] of SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS) {
      await expect(client.setGyroRange(value)).resolves.toMatchObject({ gyroRange: value });
    }
    for (const [value] of SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS) {
      await expect(client.setGSRRange(value)).resolves.toMatchObject({ gsrRange: value });
    }
  });
});

describe('Shimmer3 option tables: the oddities the port preserves', () => {
  it('keeps the LSM303AH accel range values non-monotonic', () => {
    // {0, 2, 3, 1}. Pairing labels with their index would swap +/-4g and
    // +/-16g and miscalibrate by a factor of four.
    expect(SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS.map(([v]) => v)).toEqual([0, 2, 3, 1]);
    expect(SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS[1]).toEqual([2, '± 4g']);
    expect(SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS[3]).toEqual([1, '± 16g']);
  });

  it('keeps the LIS3MDL rate values as raw register codes', () => {
    expect(SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS.map(([v]) => v)).toEqual([
      0x01, 0x11, 0x21, 0x31, 0x3e, 0x3a, 0x08,
    ]);
    // 80Hz (0x3E) sits numerically ABOVE 20Hz (0x3A): not sortable by value.
    expect(SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS[4]).toEqual([0x3e, '80Hz']);
    expect(SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS[5]).toEqual([0x3a, '20Hz']);
  });

  it('keeps the gap at 8 in the LSM303DLHC high-resolution rates', () => {
    // Code 8 is the low-power-only 1620Hz setting, so 1344Hz is code 9.
    expect(SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS.map(([v]) => v)).toEqual([
      0, 1, 2, 3, 4, 5, 6, 7, 9,
    ]);
    expect(SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS[8]).toEqual([8, '1620.0Hz']);
  });

  it('keeps the LSM303DLHC mag range starting at 1', () => {
    // The Java comment reads "no '0' option".
    expect(SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS[0]).toEqual([1, '+/- 1.3Ga']);
    expect(SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS.map(([v]) => v)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps the LSM303AH low-power rates in the upper half of the field', () => {
    expect(SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS.map(([v]) => v)).toEqual([
      0, 8, 9, 10, 11, 12, 13, 14, 15,
    ]);
  });

  it('keeps the repeated LIS2DW12 rate labels', () => {
    // Duplicate LABELS are legitimate (two ODR codes, one output rate); only
    // duplicate VALUES would be a bug.
    const hpm = SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS.map(([, l]) => l);
    expect(hpm.filter((l) => l === '12.5Hz')).toHaveLength(2);
    const lpm = SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS.map(([, l]) => l);
    expect(lpm.filter((l) => l === '200.0Hz')).toHaveLength(4);
  });

  it('keeps the LSM6DSV rate table at the 13 labelled values', () => {
    // The Java config-value array runs 0-13 while its labels stop at 12.
    expect(SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS).toHaveLength(13);
    expect(SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS.at(-1)).toEqual([12, '7680.0Hz']);
  });

  it('keeps the BT baud list default-first rather than in rate order', () => {
    expect(SHIMMER3_BT_BAUD_RATE_OPTIONS[0]).toEqual([0, '115200']);
    expect(SHIMMER3_BT_BAUD_RATE_OPTIONS[1]).toEqual([1, '1200']);
  });

  it('shares one rate table between the BMP390 and BMP581, as Java does', () => {
    expect(SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS).toBe(SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS);
    expect(SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS).toHaveLength(18);
  });

  it('keeps the differing top labels of the BMP180 and BMP280 resolutions', () => {
    expect(SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS.at(-1)).toEqual([3, 'Very High']);
    expect(SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS.at(-1)).toEqual([3, 'Ultra High']);
  });

  it('uses the Java unicode signs, not ASCII lookalikes', () => {
    // UtilShimmer: UNICODE_PLUS_MINUS U+00B1, UNICODE_MICRO U+00B5,
    // UNICODE_OHMS U+2126 (the OHM SIGN, not Greek capital omega U+03A9).
    expect(SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS[0][1]).toBe('± 2g');
    expect(SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS[0][1]).toBe('8kΩ to 63kΩ');
    expect(SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS[0][1]).toBe('125µS to 15.9µS');
    // The older lists spell it "+/-" instead; that inconsistency is Java's.
    expect(SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS[0][1]).toBe('+/- 125dps');
  });

  it('offers the fixed single-option ranges so a UI can show them', () => {
    expect(SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS).toEqual([[0, '+/- 200g']]);
    expect(SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS).toEqual([[0, '+/- 49.152Ga']]);
    expect(SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS).toEqual([[0, '+/- 49.152Ga']]);
  });
});

describe('sampling rate <-> divisor', () => {
  it('round-trips every offered rate', () => {
    for (const hz of SHIMMER3_SAMPLING_RATES_HZ) {
      const applied = divisorToSamplingRate(samplingRateToDivisor(hz));
      // The divisor is floored, so the applied rate is at or just above the
      // request — never below it, which would silently undersample a trial.
      expect(applied).toBeGreaterThanOrEqual(hz);
      expect(applied).toBeCloseTo(hz, 1);
    }
  });

  it('is exact for the rates that divide the 32768 Hz clock', () => {
    expect(samplingRateToDivisor(1)).toBe(32768);
    expect(samplingRateToDivisor(51.2)).toBe(640);
    expect(samplingRateToDivisor(102.4)).toBe(320);
    expect(samplingRateToDivisor(204.8)).toBe(160);
    expect(samplingRateToDivisor(256)).toBe(128);
    expect(samplingRateToDivisor(512)).toBe(64);
    expect(samplingRateToDivisor(1024)).toBe(32);
    expect(samplingRateToDivisor(2048)).toBe(16);
    for (const hz of [1, 51.2, 102.4, 204.8, 256, 512, 1024, 2048]) {
      expect(divisorToSamplingRate(samplingRateToDivisor(hz))).toBe(hz);
    }
  });

  it('reports the rate 10.2 Hz actually becomes', () => {
    // The one offered rate the clock cannot hit exactly: 32768/3212.
    expect(samplingRateToDivisor(10.2)).toBe(3212);
    expect(divisorToSamplingRate(3212)).toBeCloseTo(10.2017, 3);
  });

  it('matches what the client applies, rather than a second opinion', async () => {
    const t = new LoopbackTransport({ deviceName: 'Shimmer3R-TEST' });
    t.setOnWrite((_bytes, tr) => setTimeout(() => tr.notify([0xff]), 0));
    const client = new Shimmer3RClient({ debug: false, transport: t });
    await client.connect();
    for (const hz of SHIMMER3_SAMPLING_RATES_HZ) {
      const res = await client.setSamplingRate(hz);
      expect(res.divisor).toBe(samplingRateToDivisor(hz));
      expect(res.appliedHz).toBe(divisorToSamplingRate(res.divisor));
    }
  });

  it('clamps to the 16-bit divisor field', () => {
    // Below 0.5 Hz the divisor would overflow; above 32768 Hz it would be 0.
    expect(samplingRateToDivisor(0.0001)).toBe(0xffff);
    expect(samplingRateToDivisor(1_000_000)).toBe(1);
  });

  it('rejects rates and divisors that cannot mean anything', () => {
    expect(() => samplingRateToDivisor(0)).toThrow(/positive/);
    expect(() => samplingRateToDivisor(-1)).toThrow(/positive/);
    expect(() => samplingRateToDivisor(Number.NaN)).toThrow(/positive/);
    expect(() => divisorToSamplingRate(0)).toThrow(/positive/);
    expect(() => divisorToSamplingRate(Number.POSITIVE_INFINITY)).toThrow(/positive/);
  });
});

describe('SHIMMER3_SENSOR_LABELS', () => {
  it('labels every bit of the sensor-enable bitmap, and only those', () => {
    expect(Object.keys(SHIMMER3_SENSOR_LABELS).sort()).toEqual(
      Object.keys(SensorBitmapShimmer3).sort(),
    );
  });

  it('gives every sensor a distinct label', () => {
    const labels = Object.values(SHIMMER3_SENSOR_LABELS).map((s) => s.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('records that the enable bitmap is identical across the two platforms', () => {
    // Every bit is served by both; what changes is which chip answers it.
    // If a real divergence ever appears, this is the test that has to change.
    expect(Object.values(SHIMMER3_SENSOR_LABELS).every((s) => s.shimmer3r)).toBe(true);
  });

  it('names both ADC vocabularies, since the platforms number them differently', () => {
    expect(SHIMMER3_SENSOR_LABELS.SENSOR_EXT_A0.label).toMatch(/A7/);
    expect(SHIMMER3_SENSOR_LABELS.SENSOR_EXT_A0.label).toMatch(/Shimmer3R/);
  });

  it('looks a label up by its mask', () => {
    expect(shimmer3SensorLabel(SensorBitmapShimmer3.SENSOR_GYRO)).toBe('Gyroscope');
    expect(shimmer3SensorLabel(SensorBitmapShimmer3.SENSOR_GSR)).toBe('GSR');
    expect(shimmer3SensorLabel(0x000000)).toBeNull();
    // A combined mask is not a sensor, and must not resolve to one of its bits.
    expect(
      shimmer3SensorLabel(SensorBitmapShimmer3.SENSOR_GYRO | SensorBitmapShimmer3.SENSOR_MAG),
    ).toBeNull();
  });
});
