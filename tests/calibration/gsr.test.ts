import { describe, expect, it } from 'vitest';
import { ObjectCluster } from '../../src/core/ObjectCluster.js';
import {
  GSR_RANGE_NAME,
  GSR_RESISTANCE_NAME,
  calibrateGsrChannel,
  calibrateGsrSample,
  gsrRangeForSample,
} from '../../src/devices/calibration/gsr.js';
import { calibrateGsrDataToResistanceFromAmplifierEq } from '../../src/devices/shimmer3r/calibration.js';
import { GSR_UNCAL_LIMIT_RANGE3 } from '../../src/devices/shimmer3r/constants.js';

/** A raw GSR word: 12-bit ADC value with auto-range's resistor in bits 14-15. */
const word = (adc12: number, rangeBits = 0): number => (adc12 & 0x0fff) | (rangeBits << 14);

describe('gsrRangeForSample', () => {
  it('uses the configured range when it is fixed', () => {
    // The range bits in the sample are ignored on a fixed range: the firmware
    // only populates them when auto-range is on.
    expect(gsrRangeForSample(word(2000, 3), 0)).toBe(0);
    expect(gsrRangeForSample(word(2000, 0), 2)).toBe(2);
  });

  it('reads the resistor out of the sample on auto-range', () => {
    for (const bits of [0, 1, 2, 3]) {
      expect(gsrRangeForSample(word(2000, bits), 4)).toBe(bits);
    }
  });
});

describe('calibrateGsrSample', () => {
  it('converts through the amplifier equation', () => {
    const out = calibrateGsrSample(word(2000), 0);
    expect(out.range).toBe(0);
    expect(out.resistanceKOhms).toBeCloseTo(20.8246679, 6);
    expect(out.conductanceUSiemens).toBeCloseTo(48.0199734, 6);
    // Conductance is the reciprocal, in the two units' scale.
    expect(out.conductanceUSiemens).toBeCloseTo(1000 / out.resistanceKOhms, 9);
  });

  it('floors the ADC value on range 3, where the amplifier is non-linear', () => {
    // Below 683 counts the conversion is floored rather than extrapolated, so
    // every sample under the limit reports the same resistance. Checked on
    // auto-range, because a FIXED range 3 also clamps the result to 4700 kΩ
    // and that would hide whether the ADC floor did anything.
    const atLimit = calibrateGsrSample(word(683, 3), 4);
    const below = calibrateGsrSample(word(100, 3), 4);
    expect(below.resistanceKOhms).toBeCloseTo(atLimit.resistanceKOhms, 9);
    // And a count above the limit really does read differently.
    expect(calibrateGsrSample(word(1000, 3), 4).resistanceKOhms).toBeLessThan(
      atLimit.resistanceKOhms,
    );
  });

  it('clamps both ends of the window on a fixed range', () => {
    // Resistance falls as the count rises: R = Rf / ((V/0.5) - 1). So full scale
    // on range 1 computes 57.4 kΩ and hits that range's 63 kΩ floor, and range
    // 3's floored count computes above its ceiling.
    expect(calibrateGsrSample(word(4095), 1).resistanceKOhms).toBe(63);
    expect(calibrateGsrSample(word(683), 3).resistanceKOhms).toBe(4700);
  });

  it('clamps only the floor on auto-range, using the sample’s own resistor', () => {
    // Range bits say resistor 3 (3.3 MΩ), so the ceiling must not be range 0's
    // 63 kΩ nor range 3's 4700 kΩ — on auto-range the resistor is known per
    // sample and only the circuit's own floor applies.
    const big = calibrateGsrSample(word(2000, 3), 4);
    expect(big.range).toBe(3);
    // Not range 0's 63 kΩ ceiling…
    expect(big.resistanceKOhms).toBeGreaterThan(63);
    // …and not range 3's 4700 kΩ ceiling either, which a fixed range 3 would
    // have applied to this same sample.
    expect(calibrateGsrSample(word(683, 3), 4).resistanceKOhms).toBeGreaterThan(4700);
    expect(calibrateGsrSample(word(683), 3).resistanceKOhms).toBe(4700);
    // Every count now decodes above the 8 kΩ floor, so it no longer shows here:
    // the nudge's own tests cover it.
    expect(calibrateGsrSample(word(4095, 0), 4).resistanceKOhms).toBeCloseTo(8.04, 9);
  });

  // DEV-1070: a count below the 0.5 V reference, which is every count below
  // the range-3 limit, means the electrodes are open, on any range. In
  // auto-range the lower ranges see them as the device climbs after the
  // electrodes come off. They decoded to a negative resistance, which the floor
  // turned into 8 kΩ: 125 µS, the highest conductance there is.
  it('decodes a count below the range-3 limit as open on every range (DEV-1070)', () => {
    const open = calibrateGsrSample(word(GSR_UNCAL_LIMIT_RANGE3, 3), 4).resistanceKOhms;
    expect(open).toBeCloseTo(4504500, 0);
    for (const rangeBits of [0, 1, 2, 3]) {
      for (const count of [0, 1, 500, GSR_UNCAL_LIMIT_RANGE3 - 1]) {
        const out = calibrateGsrSample(word(count, rangeBits), 4);
        const where = `range ${rangeBits}, count ${count}`;
        // The equation alone gives these a negative resistance.
        const equation = calibrateGsrDataToResistanceFromAmplifierEq(count, rangeBits);
        expect(equation, where).toBeLessThan(0);
        expect(out.resistanceKOhms, where).toBe(open);
        expect(out.conductanceUSiemens, where).toBeGreaterThan(0);
        expect(out.conductanceUSiemens, where).toBeLessThan(0.03);
        // Only the resistance changes: the range is still the resistor in circuit.
        expect(out.range, where).toBe(rangeBits);
      }
    }
  });

  it('pins an open circuit on a fixed range to the top of its window (DEV-1070)', () => {
    // It used to pin to the bottom, which on range 0 is 125 µS.
    const top = [63, 220, 680, 4700];
    for (const range of [0, 1, 2, 3]) {
      for (const count of [0, GSR_UNCAL_LIMIT_RANGE3 - 1]) {
        expect(calibrateGsrSample(word(count), range).resistanceKOhms, `range ${range}`).toBe(
          top[range],
        );
      }
    }
  });

  it('decodes every count from the range-3 limit up exactly as before (DEV-1070)', () => {
    for (const rangeBits of [0, 1, 2, 3]) {
      for (let count = GSR_UNCAL_LIMIT_RANGE3; count <= 4095; count++) {
        expect(calibrateGsrSample(word(count, rangeBits), 4).resistanceKOhms).toBe(
          calibrateGsrDataToResistanceFromAmplifierEq(count, rangeBits),
        );
      }
    }
  });

  it('reports a larger resistance on a larger feedback resistor', () => {
    const r0 = calibrateGsrSample(word(2000, 0), 4).resistanceKOhms;
    const r1 = calibrateGsrSample(word(2000, 1), 4).resistanceKOhms;
    const r2 = calibrateGsrSample(word(2000, 2), 4).resistanceKOhms;
    expect(r1).toBeGreaterThan(r0);
    expect(r2).toBeGreaterThan(r1);
  });
});

describe('calibrateGsrChannel', () => {
  it('adds conductance, resistance and the range, with units', () => {
    const oc = new ObjectCluster('test');
    oc.add('GSR', word(2000), 'no_units', 'raw');
    calibrateGsrChannel(oc, 0);

    const cal = oc.get('GSR', 'cal')!;
    expect(cal.unit).toBe('uS');
    expect(cal.value).toBeCloseTo(48.0199734, 6);

    const res = oc.get(GSR_RESISTANCE_NAME, 'cal')!;
    expect(res.unit).toBe('kOhms');
    expect(res.value).toBeCloseTo(20.8246679, 6);

    const range = oc.get(GSR_RANGE_NAME, 'cal')!;
    expect(range.unit).toBe('no_units');
    expect(range.value).toBe(0);

    // The raw field is left exactly as the decoder wrote it.
    expect(oc.get('GSR', 'raw')!.value).toBe(word(2000));
  });

  it('records the per-sample range on auto-range', () => {
    const oc = new ObjectCluster('test');
    oc.add('GSR', word(2000, 2), 'no_units', 'raw');
    calibrateGsrChannel(oc, 4);
    expect(oc.get(GSR_RANGE_NAME, 'cal')!.value).toBe(2);
  });

  it('does nothing when the frame carries no GSR channel', () => {
    const oc = new ObjectCluster('test');
    oc.add('GYRO_X', 100, 'no_units', 'raw');
    calibrateGsrChannel(oc, 0);
    expect(oc.fields).toHaveLength(1);
  });
});
