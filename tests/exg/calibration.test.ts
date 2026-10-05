import { describe, expect, it } from 'vitest';
import {
  EXG_VREF_VOLTS,
  calibrateExgSample,
  exgChannelMillivoltFactor,
  summariseExgBanks,
  summariseExgCalibration,
} from '../../src/devices/exg/calibration.js';
import { setExgFieldPreserving } from '../../src/devices/exg/registers.js';

/** A zeroed bank, i.e. gain setting 0 (= gain 6) and CONFIG2 bit 4 clear (2.42 V). */
const bank = (): Uint8Array => new Uint8Array(10);

const withGain = (channel: 1 | 2, setting: number): Uint8Array => {
  const b = bank();
  setExgFieldPreserving(b, channel === 1 ? 'ch1Gain' : 'ch2Gain', setting);
  return b;
};

const with4V = (): Uint8Array => {
  const b = bank();
  setExgFieldPreserving(b, 'voltageReference', 1);
  return b;
};

describe('ExG millivolt conversion', () => {
  it('states the two reference voltages the chip offers', () => {
    expect(EXG_VREF_VOLTS).toEqual([2.42, 4.033]);
  });

  it('converts 24-bit samples at the default gain and reference', () => {
    // Full scale is V_REF / gain: 2.42 V / 6 = 403.33 mV.
    expect(calibrateExgSample(8388607, bank(), 1, '24bit')).toBeCloseTo(403.3333333, 6);
    expect(calibrateExgSample(1e6, bank(), 1, '24bit')).toBeCloseTo(48.0810859, 6);
    expect(calibrateExgSample(-1e6, bank(), 1, '24bit')).toBeCloseTo(-48.0810859, 6);
    expect(calibrateExgSample(0, bank(), 1, '24bit')).toBe(0);
  });

  it('halves the 16-bit full scale, because the word is bits 22:7', () => {
    // 201.67 mV, not 403.33: the firmware drops the top bit as well as the
    // bottom seven (exg.h:134). A port that used 2^15-1 alone would double it.
    expect(calibrateExgSample(32767, bank(), 1, '16bit')).toBeCloseTo(201.6666667, 6);
    expect(calibrateExgSample(1000, bank(), 1, '16bit')).toBeCloseTo(6.1545661, 6);
  });

  it('agrees between the two widths for the same physical input', () => {
    // A 16-bit sample is the 24-bit conversion over 128, so the same input has
    // to read the same millivolts either way — to within the 0.003% the two
    // full-scale denominators differ by (2^23-1 vs 128·(2^15-1)).
    const s24 = 1_048_576;
    const mv24 = calibrateExgSample(s24, bank(), 1, '24bit');
    const mv16 = calibrateExgSample(s24 / 128, bank(), 1, '16bit');
    expect(mv16 / mv24).toBeCloseTo(1, 4);
  });

  it('reads the gain per channel out of the bank', () => {
    // Setting 6 is gain 12 (GAIN_VALUES = [6,1,2,3,4,8,12]).
    const b = withGain(1, 6);
    expect(calibrateExgSample(8388607, b, 1, '24bit')).toBeCloseTo(2420 / 12, 6);
    // Channel 2 is untouched in that bank, so it keeps gain 6.
    expect(calibrateExgSample(8388607, b, 2, '24bit')).toBeCloseTo(2420 / 6, 6);
  });

  it('honours the 4.033 V reference selection', () => {
    // Reference alone, gain still 6: full scale doubles from 403.3 to 672.2 mV.
    expect(calibrateExgSample(1e6, with4V(), 1, '24bit')).toBeCloseTo(80.1285203, 6);
    // And with gain 12 as well, the pair the plan's vector used.
    const b = with4V();
    setExgFieldPreserving(b, 'ch1Gain', 6); // setting 6 = gain 12
    expect(calibrateExgSample(1e6, b, 1, '24bit')).toBeCloseTo(40.0642602, 6);
  });

  it('assumes the chip defaults when the bank has not been read', () => {
    expect(exgChannelMillivoltFactor(null, 1, '24bit')).toBe(
      exgChannelMillivoltFactor(bank(), 1, '24bit'),
    );
    expect(exgChannelMillivoltFactor(null, 2, '16bit')).toBe(
      exgChannelMillivoltFactor(bank(), 2, '16bit'),
    );
  });

  it('falls back to gain 6 for the undefined setting 7', () => {
    // Java answers -1 here, which would invert the signal.
    const b = withGain(1, 7);
    expect(calibrateExgSample(8388607, b, 1, '24bit')).toBeCloseTo(2420 / 6, 6);
  });
});

describe('summariseExgCalibration', () => {
  it('reports the reference and both gains', () => {
    expect(summariseExgCalibration(bank())).toEqual({
      vrefVolts: 2.42,
      gainCh1: 6,
      gainCh2: 6,
    });
    const b = withGain(2, 5); // setting 5 = gain 8
    expect(summariseExgCalibration(b)).toEqual({
      vrefVolts: 2.42,
      gainCh1: 6,
      gainCh2: 8,
    });
    expect(summariseExgCalibration(with4V()).vrefVolts).toBe(4.033);
  });

  it('summarises both chips, and defaults for an unread pair', () => {
    const banks = { exg1: withGain(1, 6), exg2: with4V() };
    expect(summariseExgBanks(banks)).toEqual({
      chip1: { vrefVolts: 2.42, gainCh1: 12, gainCh2: 6 },
      chip2: { vrefVolts: 4.033, gainCh1: 6, gainCh2: 6 },
    });
    expect(summariseExgBanks(null)).toEqual({
      chip1: { vrefVolts: 2.42, gainCh1: 6, gainCh2: 6 },
      chip2: { vrefVolts: 2.42, gainCh1: 6, gainCh2: 6 },
    });
  });
});
