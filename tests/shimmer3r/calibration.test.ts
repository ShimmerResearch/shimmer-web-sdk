import { describe, it, expect } from 'vitest';
import {
  calibrateU12AdcValue,
  calibrateShimmer3RAdcChannel,
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
  getOversamplingRatioADS1292R,
} from '../../src/devices/shimmer3r/calibration.js';

describe('calibrateU12AdcValue', () => {
  it('returns 0 for a zero input', () => {
    expect(calibrateU12AdcValue(0, 0, 3, 1)).toBe(0);
  });

  it('full-scale 12-bit → ~3000 mV for Vref=3 V, gain=1', () => {
    const mV = calibrateU12AdcValue(4095, 0, 3, 1);
    expect(mV).toBeCloseTo(3000, 0);
  });

  it('mid-scale input → ~1500 mV', () => {
    const mV = calibrateU12AdcValue(2047.5, 0, 3, 1);
    expect(mV).toBeCloseTo(1500, 0);
  });
});

describe('calibrateShimmer3RAdcChannel', () => {
  it('wraps calibrateU12AdcValue with Shimmer3R defaults', () => {
    const v = calibrateShimmer3RAdcChannel(2000);
    expect(v).toBeCloseTo((2000 / 4095) * 3000, 1);
  });
});

describe('calibrateGsrDataToResistanceFromAmplifierEq', () => {
  it('returns a positive resistance for a valid GSR ADC value (range 0)', () => {
    const kOhm = calibrateGsrDataToResistanceFromAmplifierEq(2000, 0);
    expect(kOhm).toBeGreaterThan(0);
  });

  it('uses the correct reference resistor per range', () => {
    // range 0 = 40.2 kΩ, range 1 = 287 kΩ; higher range → higher resistance for same ADC
    const r0 = calibrateGsrDataToResistanceFromAmplifierEq(2000, 0);
    const r1 = calibrateGsrDataToResistanceFromAmplifierEq(2000, 1);
    expect(r1).toBeGreaterThan(r0);
  });
});

describe('nudgeGsrResistance', () => {
  it('clamps values below the range minimum', () => {
    expect(nudgeGsrResistance(1, 0)).toBe(8.0);
  });

  it('clamps values above the range maximum', () => {
    expect(nudgeGsrResistance(99999, 0)).toBe(63.0);
  });

  it('leaves values within range unchanged', () => {
    expect(nudgeGsrResistance(30, 0)).toBe(30);
  });

  it('does not clamp for auto-range (setting=4)', () => {
    expect(nudgeGsrResistance(1, 4)).toBe(1);
    expect(nudgeGsrResistance(99999, 4)).toBe(99999);
  });
});

describe('getOversamplingRatioADS1292R', () => {
  it('throws on non-finite input', () => {
    expect(() => getOversamplingRatioADS1292R(NaN)).toThrow(TypeError);
    expect(() => getOversamplingRatioADS1292R(Infinity)).toThrow(TypeError);
  });

  it('throws on negative sampling rate', () => {
    expect(() => getOversamplingRatioADS1292R(-1)).toThrow(RangeError);
  });

  const cases: [number, number][] = [
    [0, 0],
    [100, 0],
    [124, 0],
    [125, 1],
    [200, 1],
    [249, 1],
    [250, 2],
    [499, 2],
    [500, 3],
    [999, 3],
    [1000, 4],
    [1999, 4],
    [2000, 5],
    [3999, 5],
    [4000, 6],
    [8000, 6],
  ];

  it.each(cases)('rate=%i → oversampling=%i', (rate, expected) => {
    expect(getOversamplingRatioADS1292R(rate)).toBe(expected);
  });
});
