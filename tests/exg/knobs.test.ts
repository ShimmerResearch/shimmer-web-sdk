import { describe, it, expect } from 'vitest';
import {
  EXG_KNOBS,
  updateExgSetting,
  applyExgKnobEdits,
  exgKnobOptions,
  respirationPhaseOptions,
  isExgRespirationEnabled,
  readExgKnobs,
  decodeExgRegisters,
  applyExgMustBeBits,
  EXG_PRESET_ARRAYS,
  UnknownExgKnobError,
  ExgKnobValueError,
  ExgRespirationLockedError,
  type ExgBanks,
  type ExgKnobField,
} from '../../src/devices/exg/index.js';

const u8 = (a: readonly number[]): Uint8Array => new Uint8Array(a);

/** ECG preset banks (both chips, must-be already satisfied) — a realistic base. */
const ecgBanks = (): ExgBanks => ({
  exg1: applyExgMustBeBits(u8([...EXG_PRESET_ARRAYS.ecg.exg1])),
  exg2: applyExgMustBeBits(u8([...EXG_PRESET_ARRAYS.ecg.exg2])),
});

/** Respiration preset banks (chip-2 respiration on). */
const respBanks = (): ExgBanks => ({
  exg1: applyExgMustBeBits(u8([...EXG_PRESET_ARRAYS.respiration.exg1])),
  exg2: applyExgMustBeBits(u8([...EXG_PRESET_ARRAYS.respiration.exg2])),
});

/** All must-be bits present in a bank (so a knob edit never drops them). */
function expectMustBe(bank: Uint8Array) {
  expect(bank[1] & 0x80).toBe(0x80); // CONFIG2 bit7
  expect(bank[1] & 0x04).toBe(0); // CONFIG2 bit2 clear
  expect(bank[2] & 0x10).toBe(0x10); // LOFF bit4
  expect(bank[8] & 0x02).toBe(0x02); // RESP1 bit1
  expect(bank[9] & 0x01).toBe(0x01); // RESP2 bit0
}

const ALL_FIELDS = Object.keys(EXG_KNOBS) as ExgKnobField[];

describe('EXG knob table', () => {
  it('every knob exposes a label, at least one option, and a bank set', () => {
    for (const field of ALL_FIELDS) {
      const spec = EXG_KNOBS[field];
      expect(spec.label.length).toBeGreaterThan(0);
      expect(spec.banks.length).toBeGreaterThan(0);
      const opts = exgKnobOptions(field, respBanks());
      expect(opts.length).toBeGreaterThan(0);
    }
  });
});

describe('updateExgSetting — every knob round-trips and preserves other bits', () => {
  // Walk ALL knobs programmatically: for each legal value, set it and confirm
  // decode reflects it, must-be bits survive, and untouched banks are untouched.
  for (const field of ALL_FIELDS) {
    it(`${field}: each option applies and reads back`, () => {
      // Respiration freq/phase need respiration ON — use the respiration preset.
      const base = EXG_KNOBS[field].requiresRespiration ? respBanks() : ecgBanks();
      const options = exgKnobOptions(field, base);
      for (const opt of options) {
        const next = updateExgSetting(base, field, opt.value);
        // Input not mutated.
        expect(next.exg1).not.toBe(base.exg1);
        // Must-be bits intact on both banks.
        expectMustBe(next.exg1);
        expectMustBe(next.exg2);
        // The knob's read-back reflects the value (respirationFrequency also
        // remaps phase, so read via readExgKnobs which handles the coupling).
        const knobs = readExgKnobs(next);
        if (field === 'respirationFrequency') {
          expect(knobs.respirationFrequency).toBe(opt.value);
        } else if (field === 'leadOffDetection') {
          expect(knobs.leadOffDetection).toBe(opt.value);
        } else {
          expect(knobs[field]).toBe(opt.value);
        }
      }
    });
  }

  it('a chip-1-only knob (exg1Ch1Gain) never touches the chip-2 bank', () => {
    const base = ecgBanks();
    const next = updateExgSetting(base, 'exg1Ch1Gain', 5); // gain "8"
    expect(Array.from(next.exg2)).toEqual(Array.from(base.exg2));
    expect(decodeExgRegisters(next.exg1).ch1.gain.value).toBe(5);
    // chip-1 CH2 gain unchanged.
    expect(decodeExgRegisters(next.exg1).ch2.gain.value).toBe(
      decodeExgRegisters(base.exg1).ch2.gain.value,
    );
  });

  it('a chip-2-only knob (respirationPhase) never touches the chip-1 bank', () => {
    const base = respBanks();
    const next = updateExgSetting(base, 'respirationPhase', 3);
    expect(Array.from(next.exg1)).toEqual(Array.from(base.exg1));
    expect(decodeExgRegisters(next.exg2).respiration.phase.value).toBe(3);
  });

  it('data-rate writes BOTH chips', () => {
    const base = ecgBanks();
    const next = updateExgSetting(base, 'dataRate', 4); // 2 kHz
    expect(decodeExgRegisters(next.exg1).dataRate.value).toBe(4);
    expect(decodeExgRegisters(next.exg2).dataRate.value).toBe(4);
  });

  it('reference-electrode maps the value onto the CHIP1 REG6 nibble', () => {
    const base = ecgBanks();
    // Inverse Wilson CT = 13 (0b1101): CH2 neg + CH1 neg + CH1 pos, CH2 pos off.
    const next = updateExgSetting(base, 'referenceElectrode', 13);
    expect(next.exg1[5] & 0x0f).toBe(13);
    expect(Array.from(next.exg2)).toEqual(Array.from(base.exg2));
  });
});

describe('phase-by-frequency lists (SensorEXG.java:143-146)', () => {
  it('32 kHz → 16 options (values 0-15)', () => {
    const opts = respirationPhaseOptions(0);
    expect(opts.map((o) => o.value)).toEqual([...Array(16).keys()]);
    expect(opts[0].label).toBe('0°');
    expect(opts[10].label).toBe('112.5°');
    expect(opts[15].label).toBe('168.75°');
  });
  it('64 kHz → 8 options (values 0-7)', () => {
    const opts = respirationPhaseOptions(1);
    expect(opts.map((o) => o.value)).toEqual([...Array(8).keys()]);
    expect(opts[0].label).toBe('0°');
    expect(opts[7].label).toBe('157.5°');
  });
  it('exgKnobOptions(respirationPhase) follows the current frequency', () => {
    const base = respBanks(); // respiration preset defaults to 32 kHz
    expect(exgKnobOptions('respirationPhase', base).length).toBe(16);
    const at64 = updateExgSetting(base, 'respirationFrequency', 1);
    expect(exgKnobOptions('respirationPhase', at64).length).toBe(8);
  });
});

describe('respiration frequency-flip auto-remaps the phase (SensorEXG.java:2618-2628)', () => {
  it('flip to 64 kHz forces phase = 157.5° (reg value 7)', () => {
    const base = respBanks();
    const at64 = updateExgSetting(base, 'respirationFrequency', 1);
    expect(decodeExgRegisters(at64.exg2).respiration.frequency.value).toBe(1);
    expect(decodeExgRegisters(at64.exg2).respiration.phase.value).toBe(7);
  });
  it('flip to 32 kHz forces phase = 112.5° (reg value 10)', () => {
    // Start at 64 kHz, then flip to 32 kHz.
    const at64 = updateExgSetting(respBanks(), 'respirationFrequency', 1);
    const at32 = updateExgSetting(at64, 'respirationFrequency', 0);
    expect(decodeExgRegisters(at32.exg2).respiration.frequency.value).toBe(0);
    expect(decodeExgRegisters(at32.exg2).respiration.phase.value).toBe(10);
  });
  it('a formerly-illegal phase (15 @32 kHz) is legal after the flip forces a default', () => {
    // Set phase 15 at 32 kHz, then flip to 64 kHz where 15 would be illegal.
    const p15 = updateExgSetting(respBanks(), 'respirationPhase', 15);
    const at64 = updateExgSetting(p15, 'respirationFrequency', 1);
    // Phase is now 7 (a legal 64 kHz value), not the stale 15.
    expect(decodeExgRegisters(at64.exg2).respiration.phase.value).toBe(7);
  });
});

describe('illegal phase-for-frequency is rejected', () => {
  it('phase 15 at 64 kHz throws ExgKnobValueError', () => {
    const at64 = updateExgSetting(respBanks(), 'respirationFrequency', 1);
    expect(() => updateExgSetting(at64, 'respirationPhase', 15)).toThrow(ExgKnobValueError);
    expect(() => updateExgSetting(at64, 'respirationPhase', 8)).toThrow(ExgKnobValueError);
  });
  it('phase 15 at 32 kHz is accepted', () => {
    const next = updateExgSetting(respBanks(), 'respirationPhase', 15);
    expect(decodeExgRegisters(next.exg2).respiration.phase.value).toBe(15);
  });
});

describe('respiration gating (locked unless enabled)', () => {
  it('ECG banks report respiration disabled', () => {
    expect(isExgRespirationEnabled(ecgBanks())).toBe(false);
  });
  it('respirationFrequency edit throws when respiration is off', () => {
    expect(() => updateExgSetting(ecgBanks(), 'respirationFrequency', 1)).toThrow(
      ExgRespirationLockedError,
    );
  });
  it('respirationPhase edit throws when respiration is off', () => {
    expect(() => updateExgSetting(ecgBanks(), 'respirationPhase', 2)).toThrow(
      ExgRespirationLockedError,
    );
  });
  it('respirationEnable is NOT gated and unlocks the others in a batch', () => {
    // Enable respiration then set a phase, in one batch, from an ECG base.
    const next = applyExgKnobEdits(ecgBanks(), [
      { field: 'respirationEnable', value: 1 },
      { field: 'respirationPhase', value: 4 },
    ]);
    expect(isExgRespirationEnabled(next)).toBe(true);
    expect(decodeExgRegisters(next.exg2).respiration.phase.value).toBe(4);
  });
  it('respirationEnable = 0 turns both demod + mod off', () => {
    const off = updateExgSetting(respBanks(), 'respirationEnable', 0);
    expect(isExgRespirationEnabled(off)).toBe(false);
  });
});

describe('lead-off detection macro (SensorEXG.setEXGLeadOffCurrentMode)', () => {
  it('DC Current enables comparators + RLD sense on chip 1', () => {
    const dc = updateExgSetting(ecgBanks(), 'leadOffDetection', 1);
    const d1 = decodeExgRegisters(dc.exg1);
    expect(d1.leadOff.detectionEnabled).toBe(true);
    expect(d1.rld.leadOffSenseFunction.value).toBe(1);
    expect(d1.leadOff.current.value).toBe(1); // 22 nA
    expect(d1.leadOff.comparatorThreshold.value).toBe(2); // Pos90/Neg10
  });
  it('Off disables the comparators again', () => {
    const dc = updateExgSetting(ecgBanks(), 'leadOffDetection', 1);
    const off = updateExgSetting(dc, 'leadOffDetection', 0);
    expect(decodeExgRegisters(off.exg1).leadOff.detectionEnabled).toBe(false);
    expect(decodeExgRegisters(off.exg2).leadOff.detectionEnabled).toBe(false);
  });
});

describe('validation errors', () => {
  it('unknown field name throws UnknownExgKnobError', () => {
    expect(() => updateExgSetting(ecgBanks(), 'nope' as ExgKnobField, 0)).toThrow(
      UnknownExgKnobError,
    );
  });
  it('out-of-range value throws ExgKnobValueError', () => {
    expect(() => updateExgSetting(ecgBanks(), 'dataRate', 7)).toThrow(ExgKnobValueError); // 0-6
    expect(() => updateExgSetting(ecgBanks(), 'exg1Ch1Gain', 9)).toThrow(ExgKnobValueError); // 0-6
    expect(() => updateExgSetting(ecgBanks(), 'referenceElectrode', 1)).toThrow(ExgKnobValueError); // {0,3,7,13}
  });
  it('wrong bank length throws RangeError', () => {
    const short: ExgBanks = { exg1: new Uint8Array(9), exg2: new Uint8Array(10) };
    expect(() => updateExgSetting(short, 'dataRate', 0)).toThrow(RangeError);
  });
});

describe('applyExgKnobEdits — batch, later edits win', () => {
  it('applies a mixed batch in order', () => {
    const next = applyExgKnobEdits(ecgBanks(), [
      { field: 'exg1Ch1Gain', value: 6 }, // gain "12"
      { field: 'exg2Ch2Gain', value: 2 }, // gain "2"
      { field: 'dataRate', value: 3 },
      { field: 'leadOffDetection', value: 1 },
    ]);
    const k = readExgKnobs(next);
    expect(k.exg1Ch1Gain).toBe(6);
    expect(k.exg2Ch2Gain).toBe(2);
    expect(k.dataRate).toBe(3);
    expect(k.leadOffDetection).toBe(1);
  });
  it('later edit of the same field wins', () => {
    const next = applyExgKnobEdits(ecgBanks(), [
      { field: 'dataRate', value: 1 },
      { field: 'dataRate', value: 5 },
    ]);
    expect(readExgKnobs(next).dataRate).toBe(5);
  });
  it('empty batch returns an equal copy', () => {
    const base = ecgBanks();
    const next = applyExgKnobEdits(base, []);
    expect(Array.from(next.exg1)).toEqual(Array.from(base.exg1));
    expect(next.exg1).not.toBe(base.exg1);
  });
});

describe('readExgKnobs round-trips through updateExgSetting', () => {
  it('reading then re-setting each knob is idempotent', () => {
    const base = respBanks();
    const k = readExgKnobs(base);
    for (const field of ALL_FIELDS) {
      // Re-apply the current value; banks should be unchanged.
      const next = updateExgSetting(base, field, k[field]);
      expect(Array.from(next.exg1)).toEqual(Array.from(base.exg1));
      expect(Array.from(next.exg2)).toEqual(Array.from(base.exg2));
    }
  });
});
