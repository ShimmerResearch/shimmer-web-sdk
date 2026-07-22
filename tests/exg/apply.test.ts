import { describe, it, expect } from 'vitest';
import {
  applyExgPreset,
  exgConflictingSensors,
  exgRateSettingFromFreq,
  EXG_CONFLICTING_SENSORS,
  detectExgPreset,
  exgResolutionFromSensors,
  EXG_PRESET_ARRAYS,
  type ApplicableExgPreset,
  type ExgResolution,
} from '../../src/devices/exg/index.js';

// Sensor-bitmap resolution masks (ConfigByteLayoutShimmer3.java:300-303).
const EXG1_24BIT = 0x000010;
const EXG2_24BIT = 0x000008;
const EXG1_16BIT = 0x100000;
const EXG2_16BIT = 0x080000;
// Some non-EXG sensor masks for conflict tests (Configuration.java SensorBitmap).
const GSR = 0x000004;
const INT_A1 = 0x000400;
const A_ACCEL = 0x000080;
const BRIDGE_AMP = 0x008000;

const HW3 = 3; // Shimmer3
const HW3R = 10; // Shimmer3R

const zeros = () => new Uint8Array(10);
const u8 = (a: readonly number[]): Uint8Array => new Uint8Array(a);

/** A fresh (unconfigured) apply input at a given rate / hardware version. */
const freshInput = (samplingRateHz: number, hardwareVersion?: number, enabledSensors = 0) => ({
  exg1: zeros(),
  exg2: zeros(),
  enabledSensors,
  samplingRateHz,
  hardwareVersion,
});

describe('exgRateSettingFromFreq (SensorEXG.setExGRateFromFreq, :2784-2806)', () => {
  it('maps the sampling rate to the REG1 data-rate setting with <= thresholds', () => {
    // At / below each boundary the lower index wins (Java uses freq<=boundary).
    expect(exgRateSettingFromFreq(100)).toBe(0);
    expect(exgRateSettingFromFreq(125)).toBe(0);
    expect(exgRateSettingFromFreq(125.1)).toBe(1);
    expect(exgRateSettingFromFreq(250)).toBe(1);
    expect(exgRateSettingFromFreq(500)).toBe(2);
    expect(exgRateSettingFromFreq(512)).toBe(3); // 512 > 500 → 1000 Hz bucket
    expect(exgRateSettingFromFreq(1000)).toBe(3);
    expect(exgRateSettingFromFreq(1024)).toBe(4);
    expect(exgRateSettingFromFreq(2000)).toBe(4);
    expect(exgRateSettingFromFreq(4000)).toBe(5);
    expect(exgRateSettingFromFreq(8000)).toBe(6);
    // > 8 kHz falls back to 500 Hz (index 2), matching the Java else-branch.
    expect(exgRateSettingFromFreq(16000)).toBe(2);
  });
});

describe('applyExgPreset — golden vectors (Java preset arrays + rate/clock coupling)', () => {
  it('ECG @500 Hz on Shimmer3 reproduces the Java reference arrays', () => {
    const r = applyExgPreset(freshInput(500, HW3), 'ecg', '24bit');
    // byte0 rate = 2 (500 Hz) = the reference default; Shimmer3 fresh → osc bit off.
    expect([...r.exg1]).toEqual([...EXG_PRESET_ARRAYS.ecg.exg1]);
    expect([...r.exg2]).toEqual([...EXG_PRESET_ARRAYS.ecg.exg2]);
  });

  it('ECG @500 Hz on Shimmer3R sets the joined oscillator-clock bit on chip 1', () => {
    const r = applyExgPreset(freshInput(500, HW3R), 'ecg', '24bit');
    // Matches the hardcoded 3R ECG arrays (Shimmer3RClient.ts:504-508):
    // chip1 byte1 0xA0 -> 0xA8 (oscillator clock joined), chip2 unchanged.
    expect([...r.exg1]).toEqual([2, 0xa8, 16, 64, 64, 45, 0, 0, 2, 3]);
    expect([...r.exg2]).toEqual([2, 0xa0, 16, 64, 71, 0, 0, 0, 2, 1]);
  });

  it('rewrites REG1 data-rate on BOTH chips from the sampling rate', () => {
    const r = applyExgPreset(freshInput(1024, HW3), 'ecg', '24bit');
    expect(r.exg1[0] & 0x07).toBe(4); // 1024 Hz → 2 kHz bucket (index 4)
    expect(r.exg2[0] & 0x07).toBe(4);
  });

  it('EMG @500 Hz reproduces the Java reference arrays (chip-1-only preset)', () => {
    const r = applyExgPreset(freshInput(500, HW3), 'emg', '16bit');
    expect([...r.exg1]).toEqual([...EXG_PRESET_ARRAYS.emg.exg1]);
    expect([...r.exg2]).toEqual([...EXG_PRESET_ARRAYS.emg.exg2]);
  });

  it('Test signal @500 Hz reproduces the Java reference arrays', () => {
    const r = applyExgPreset(freshInput(500, HW3), 'test-signal', '16bit');
    expect([...r.exg1]).toEqual([...EXG_PRESET_ARRAYS['test-signal'].exg1]);
    expect([...r.exg2]).toEqual([...EXG_PRESET_ARRAYS['test-signal'].exg2]);
  });

  it('Respiration @500 Hz reproduces the Java reference arrays', () => {
    const r = applyExgPreset(freshInput(500, HW3), 'respiration', '24bit');
    expect([...r.exg1]).toEqual([...EXG_PRESET_ARRAYS.respiration.exg1]);
    expect([...r.exg2]).toEqual([...EXG_PRESET_ARRAYS.respiration.exg2]);
  });

  it('produces identical register bytes for 16-bit and 24-bit (resolution is bitmap-only)', () => {
    const a = applyExgPreset(freshInput(500, HW3), 'ecg', '16bit');
    const b = applyExgPreset(freshInput(500, HW3), 'ecg', '24bit');
    expect([...a.exg1]).toEqual([...b.exg1]);
    expect([...a.exg2]).toEqual([...b.exg2]);
    expect(a.enabledSensors).not.toBe(b.enabledSensors); // only the bitmap differs
  });

  it('preserves a Shimmer3 device oscillator-clock bit when the HW cannot be resolved', () => {
    // A Shimmer3 EXG-unified rev>=4 joins clocks (undetectable from HW id) — its
    // existing bit must survive a preset apply rather than being forced off.
    const input = { ...freshInput(500, HW3), exg1: u8([2, 0xa8, 16, 0, 0, 0, 0, 0, 2, 1]) };
    const r = applyExgPreset(input, 'ecg', '24bit');
    expect(r.exg1[1] & 0x08).toBe(0x08);
  });
});

describe('applyExgPreset — sensor-bitmap coherence', () => {
  it('sets the chosen-resolution flags and clears the other resolution', () => {
    const r16 = applyExgPreset(freshInput(500, HW3), 'ecg', '16bit');
    expect(r16.enabledSensors & (EXG1_16BIT | EXG2_16BIT)).toBe(EXG1_16BIT | EXG2_16BIT);
    expect(r16.enabledSensors & (EXG1_24BIT | EXG2_24BIT)).toBe(0);

    const r24 = applyExgPreset(freshInput(500, HW3), 'ecg', '24bit');
    expect(r24.enabledSensors & (EXG1_24BIT | EXG2_24BIT)).toBe(EXG1_24BIT | EXG2_24BIT);
    expect(r24.enabledSensors & (EXG1_16BIT | EXG2_16BIT)).toBe(0);
  });

  it('EMG enables chip 1 only', () => {
    const r = applyExgPreset(freshInput(500, HW3), 'emg', '16bit');
    expect(r.enabledSensors & EXG1_16BIT).toBe(EXG1_16BIT);
    expect(r.enabledSensors & EXG2_16BIT).toBe(0);
  });

  it("'off' zeroes both banks and clears all four resolution flags", () => {
    const input = freshInput(500, HW3, EXG1_24BIT | EXG2_24BIT);
    input.exg1 = u8([...EXG_PRESET_ARRAYS.ecg.exg1]);
    input.exg2 = u8([...EXG_PRESET_ARRAYS.ecg.exg2]);
    const r = applyExgPreset(input, 'off', '24bit');
    expect([...r.exg1]).toEqual(new Array(10).fill(0));
    expect([...r.exg2]).toEqual(new Array(10).fill(0));
    expect(r.enabledSensors & (EXG1_24BIT | EXG2_24BIT | EXG1_16BIT | EXG2_16BIT)).toBe(0);
  });

  it('switching resolution clears the previous resolution flags', () => {
    const first = applyExgPreset(freshInput(500, HW3), 'ecg', '24bit');
    const second = applyExgPreset(
      { ...freshInput(500, HW3), enabledSensors: first.enabledSensors, exg1: first.exg1, exg2: first.exg2 },
      'ecg',
      '16bit',
    );
    expect(second.enabledSensors & (EXG1_24BIT | EXG2_24BIT)).toBe(0);
    expect(second.enabledSensors & (EXG1_16BIT | EXG2_16BIT)).toBe(EXG1_16BIT | EXG2_16BIT);
  });
});

describe('applyExgPreset — sensor conflicts (ShimmerDevice.sensorMapConflictCheckandCorrect)', () => {
  it('clears conflicting sensors from the returned bitmap, keeping non-conflicting ones', () => {
    const enabled = A_ACCEL | GSR | INT_A1 | BRIDGE_AMP;
    const r = applyExgPreset(freshInput(500, HW3, enabled), 'ecg', '24bit');
    expect(r.enabledSensors & GSR).toBe(0);
    expect(r.enabledSensors & INT_A1).toBe(0);
    expect(r.enabledSensors & BRIDGE_AMP).toBe(0);
    expect(r.enabledSensors & A_ACCEL).toBe(A_ACCEL); // accel is not a conflict
    expect(r.enabledSensors & (EXG1_24BIT | EXG2_24BIT)).toBe(EXG1_24BIT | EXG2_24BIT);
  });

  it('exgConflictingSensors reports only the currently-enabled conflicts', () => {
    expect(exgConflictingSensors(A_ACCEL | GSR | INT_A1).map((c) => c.label)).toEqual([
      'GSR',
      'Internal ADC A1',
    ]);
    expect(exgConflictingSensors(A_ACCEL)).toEqual([]);
    expect(exgConflictingSensors(0)).toEqual([]);
  });

  it('the conflict list covers GSR, the internal ADCs and the bridge/resistance amp', () => {
    const masks = EXG_CONFLICTING_SENSORS.map((c) => c.mask);
    expect(masks).toContain(GSR);
    expect(masks).toContain(INT_A1);
    expect(masks).toContain(BRIDGE_AMP);
    expect(masks).toContain(0x800000); // INT_A14
  });
});

describe('applyExgPreset — idempotence + detection round-trip', () => {
  const presets: ApplicableExgPreset[] = ['ecg', 'emg', 'test-signal', 'respiration'];
  const resolutions: ExgResolution[] = ['16bit', '24bit'];

  for (const hw of [HW3, HW3R]) {
    for (const preset of presets) {
      for (const resolution of resolutions) {
        it(`round-trips ${preset}/${resolution} through detectExgPreset (HW ${hw})`, () => {
          const r = applyExgPreset(freshInput(500, hw), preset, resolution);
          expect(detectExgPreset(r.exg1, r.exg2, r.enabledSensors)).toBe(preset);
          expect(exgResolutionFromSensors(r.enabledSensors)).toBe(resolution);
        });

        it(`is idempotent for ${preset}/${resolution} (HW ${hw})`, () => {
          const first = applyExgPreset(freshInput(500, hw), preset, resolution);
          const second = applyExgPreset(
            { exg1: first.exg1, exg2: first.exg2, enabledSensors: first.enabledSensors, samplingRateHz: 500, hardwareVersion: hw },
            preset,
            resolution,
          );
          expect([...second.exg1]).toEqual([...first.exg1]);
          expect([...second.exg2]).toEqual([...first.exg2]);
          expect(second.enabledSensors).toBe(first.enabledSensors);
        });
      }
    }
  }

  it("'off' detects as off", () => {
    const r = applyExgPreset(freshInput(500, HW3, EXG1_24BIT), 'off', '24bit');
    expect(detectExgPreset(r.exg1, r.exg2, r.enabledSensors)).toBe('off');
  });
});

describe('applyExgPreset — input validation', () => {
  it('rejects malformed bank lengths', () => {
    expect(() =>
      applyExgPreset({ exg1: new Uint8Array(9), exg2: zeros(), enabledSensors: 0, samplingRateHz: 500 }, 'ecg', '24bit'),
    ).toThrow(RangeError);
  });
});
