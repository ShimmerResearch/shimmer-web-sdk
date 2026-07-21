import { describe, it, expect } from 'vitest';
import {
  decodeExgRegisters,
  encodeExgRegisters,
  applyExgMustBeBits,
  detectExgPreset,
  exgResolutionFromSensors,
  exgPresetLabel,
  EXG_PRESET_ARRAYS,
  GAIN_VALUES,
} from '../../src/devices/exg/index.js';

// Sensor-bitmap masks (ConfigByteLayoutShimmer3.java:300-303).
const EXG1_24BIT = 0x000010;
const EXG2_24BIT = 0x000008;
const EXG1_16BIT = 0x100000;
const EXG2_16BIT = 0x080000;

const u8 = (a: readonly number[]): Uint8Array => new Uint8Array(a);

describe('decodeExgRegisters', () => {
  it('decodes the ECG chip-1 reference bank (SensorEXG.java:1782)', () => {
    const d = decodeExgRegisters(u8(EXG_PRESET_ARRAYS.ecg.exg1));
    expect(d.dataRate).toEqual({ value: 2, label: '500 Hz' });
    expect(d.conversionMode.value).toBe(0);
    expect(d.referenceBuffer.value).toBe(1); // ON
    expect(d.voltageReference).toEqual({ value: 0, label: '2.42 V' });
    // byte3 = 64 = 0x40 → CH1 gain setting 4 (=gain 4), input NORMAL(0)
    expect(d.ch1.gain).toEqual({ value: 4, label: '4', gain: 4 });
    expect(d.ch1.inputSelection.value).toBe(0);
    expect(d.ch2.gain.gain).toBe(4);
    // byte5 = 45 = 0x2D → RLD buffer enabled + IN2N/IN2P/IN1P connected
    expect(d.rld.bufferPower.value).toBe(1);
    expect(d.rld.ch2.negInput.value).toBe(1);
    expect(d.rld.ch2.posInput.value).toBe(1);
    expect(d.rld.ch1.posInput.value).toBe(1);
    // byte9 = 3 → RLD reference = half of supply
    expect(d.rld.referenceSignal).toEqual({ value: 1, label: '(AVDD - AVSS) / 2' });
    expect(d.leadOff.detectionEnabled).toBe(false);
    expect(d.respiration.enabled).toBe(false);
    expect(d.raw).toEqual([...EXG_PRESET_ARRAYS.ecg.exg1]);
  });

  it('decodes the ECG chip-2 reference bank (CH2 input = RLDIN-to-neg)', () => {
    const d = decodeExgRegisters(u8(EXG_PRESET_ARRAYS.ecg.exg2));
    // byte4 = 71 = 0x47 → CH2 gain 4, input 7 (RLDIN connected to neg input)
    expect(d.ch2.inputSelection.value).toBe(7);
    expect(d.ch2.gain.gain).toBe(4);
  });

  it('decodes the EMG reference banks (gain 12, ROUTE_CH3, power-down/shorted)', () => {
    const c1 = decodeExgRegisters(u8(EXG_PRESET_ARRAYS.emg.exg1));
    expect(c1.ch1.gain.gain).toBe(12);
    expect(c1.ch1.inputSelection.value).toBe(9); // ROUTE_CH3_TO_CH1
    expect(c1.ch2.gain.gain).toBe(12);
    const c2 = decodeExgRegisters(u8(EXG_PRESET_ARRAYS.emg.exg2));
    expect(c2.ch1.powerDown.value).toBe(1); // power-down
    expect(c2.ch1.inputSelection.value).toBe(1); // shorted
    expect(c2.ch2.powerDown.value).toBe(1);
    expect(c2.ch2.inputSelection.value).toBe(1);
  });

  it('decodes the test-signal reference bank (both channels = test signal)', () => {
    const d = decodeExgRegisters(u8(EXG_PRESET_ARRAYS['test-signal'].exg1));
    expect(d.testSignal.enabled.value).toBe(1);
    expect(d.testSignal.frequency).toEqual({ value: 1, label: '1 kHz Square Wave' });
    expect(d.ch1.inputSelection.value).toBe(5);
    expect(d.ch2.inputSelection.value).toBe(5);
  });

  it('decodes the respiration chip-2 reference bank (mod+demod on, phase 112.5°@32kHz)', () => {
    const d = decodeExgRegisters(u8(EXG_PRESET_ARRAYS.respiration.exg2));
    expect(d.respiration.enabled).toBe(true);
    expect(d.respiration.demod.value).toBe(1);
    expect(d.respiration.mod.value).toBe(1);
    expect(d.respiration.frequency).toEqual({ value: 0, label: '32 kHz' });
    expect(d.respiration.phase).toEqual({ value: 10, label: '112.5°' });
  });

  it('selects the 64 kHz phase label list when the control frequency is 64 kHz', () => {
    // byte8 = phase 5 (bits2-5) + must-be bit1; byte9 bit2 = control freq 64 kHz.
    const bank = [2, 160, 16, 64, 71, 0, 0, 0, (5 << 2) | 0x02, 0x05];
    const d = decodeExgRegisters(u8(bank));
    expect(d.respiration.frequency.value).toBe(1); // 64 kHz
    expect(d.respiration.phase).toEqual({ value: 5, label: '112.5°' }); // 64 kHz index 5
  });

  it('reports gain values matching convertEXGGainSettingToValue', () => {
    expect([...GAIN_VALUES]).toEqual([6, 1, 2, 3, 4, 8, 12]);
  });

  it('rejects malformed bank lengths', () => {
    expect(() => decodeExgRegisters(u8([1, 2, 3]))).toThrow(RangeError);
    expect(() => decodeExgRegisters(new Uint8Array(11))).toThrow(RangeError);
  });
});

describe('encodeExgRegisters (round-trip against Java golden vectors)', () => {
  const cases = [
    ['ecg', 'exg1'],
    ['ecg', 'exg2'],
    ['emg', 'exg1'],
    ['emg', 'exg2'],
    ['test-signal', 'exg1'],
    ['test-signal', 'exg2'],
    ['respiration', 'exg1'],
    ['respiration', 'exg2'],
    ['custom', 'exg1'],
    ['custom', 'exg2'],
  ] as const;

  it.each(cases)('round-trips decode→encode for %s.%s', (preset, chip) => {
    const golden = EXG_PRESET_ARRAYS[preset][chip];
    const bank = u8(golden);
    const encoded = encodeExgRegisters(decodeExgRegisters(bank));
    expect([...encoded]).toEqual([...golden]);
  });
});

describe('applyExgMustBeBits (ExGConfigBytesDetails.java:507-525)', () => {
  it('forces every mandated constant bit from an all-zero bank', () => {
    const out = applyExgMustBeBits(new Uint8Array(10));
    expect(out[1] & 0x80).toBe(0x80); // CONFIG2 bit7 = 1
    expect(out[2] & 0x10).toBe(0x10); // LOFF bit4 = 1
    expect(out[8] & 0x02).toBe(0x02); // RESP1 bit1 = 1
    expect(out[9] & 0x01).toBe(0x01); // RESP2 bit0 = 1
  });

  it('clears the reserved / read-only bits it is required to clear', () => {
    const dirty = new Uint8Array(10).fill(0xff);
    const out = applyExgMustBeBits(dirty);
    expect(out[0] & 0x78).toBe(0); // CONFIG1 bits 3-6 cleared
    expect(out[1] & 0x04).toBe(0); // CONFIG2 bit2 cleared
    expect(out[2] & 0x02).toBe(0); // LOFF bit1 cleared
    expect(out[6] & 0xc0).toBe(0); // LOFF_SENS bits 6-7 cleared
    expect(out[7]).toBe(0x40); // LOFF_STAT: only bit6 (clock divider) survives
    expect(out[9] & 0x78).toBe(0); // RESP2 bits 3-6 cleared
  });

  it('encode always applies the must-be bits even when settings omit them', () => {
    // Decode an all-zero bank (no must-be bits), then re-encode: must-be reappears.
    const encoded = encodeExgRegisters(decodeExgRegisters(new Uint8Array(10)));
    expect(encoded[1] & 0x80).toBe(0x80);
    expect(encoded[2] & 0x10).toBe(0x10);
    expect(encoded[8] & 0x02).toBe(0x02);
    expect(encoded[9] & 0x01).toBe(0x01);
  });
});

describe('detectExgPreset (tolerant, SensorEXG.java:2680-2763)', () => {
  const es = {
    both24: EXG1_24BIT | EXG2_24BIT,
    both16: EXG1_16BIT | EXG2_16BIT,
    chip1_24: EXG1_24BIT,
    chip1_16: EXG1_16BIT,
    none: 0,
  };

  it('detects each preset from its Java reference arrays (no bitmap → tolerant)', () => {
    expect(detectExgPreset(u8(EXG_PRESET_ARRAYS.ecg.exg1), u8(EXG_PRESET_ARRAYS.ecg.exg2))).toBe(
      'ecg',
    );
    expect(detectExgPreset(u8(EXG_PRESET_ARRAYS.emg.exg1), u8(EXG_PRESET_ARRAYS.emg.exg2))).toBe(
      'emg',
    );
    expect(
      detectExgPreset(
        u8(EXG_PRESET_ARRAYS['test-signal'].exg1),
        u8(EXG_PRESET_ARRAYS['test-signal'].exg2),
      ),
    ).toBe('test-signal');
    expect(
      detectExgPreset(
        u8(EXG_PRESET_ARRAYS.respiration.exg1),
        u8(EXG_PRESET_ARRAYS.respiration.exg2),
      ),
    ).toBe('respiration');
    expect(
      detectExgPreset(u8(EXG_PRESET_ARRAYS.custom.exg1), u8(EXG_PRESET_ARRAYS.custom.exg2)),
    ).toBe('custom');
  });

  it('respects the resolution gate when enabledSensors is supplied', () => {
    // ECG requires both chips at the same resolution.
    expect(
      detectExgPreset(u8(EXG_PRESET_ARRAYS.ecg.exg1), u8(EXG_PRESET_ARRAYS.ecg.exg2), es.both24),
    ).toBe('ecg');
    // Same banks but only chip-1 enabled → ECG gate fails → falls through to custom.
    expect(
      detectExgPreset(u8(EXG_PRESET_ARRAYS.ecg.exg1), u8(EXG_PRESET_ARRAYS.ecg.exg2), es.chip1_24),
    ).toBe('custom');
    // EMG requires chip-1 only.
    expect(
      detectExgPreset(u8(EXG_PRESET_ARRAYS.emg.exg1), u8(EXG_PRESET_ARRAYS.emg.exg2), es.chip1_16),
    ).toBe('emg');
  });

  it('detects respiration before ECG (shares the same input selections)', () => {
    // Respiration banks have ECG input selections + resp mod/demod on.
    expect(
      detectExgPreset(
        u8(EXG_PRESET_ARRAYS.respiration.exg1),
        u8(EXG_PRESET_ARRAYS.respiration.exg2),
        es.both16,
      ),
    ).toBe('respiration');
  });

  it('tolerates the 16-bit hardcoded 3R preset arrays (differ in byte1/rate bits)', () => {
    // 3R ECG-16 arrays from Shimmer3RClient.enableECG16Bit (payload only).
    const ecg3rC1 = [0x02, 0xa8, 0x10, 0x40, 0x40, 0x2d, 0x00, 0x00, 0x02, 0x03];
    const ecg3rC2 = [0x02, 0xa0, 0x10, 0x40, 0x47, 0x00, 0x00, 0x00, 0x02, 0x01];
    expect(detectExgPreset(u8(ecg3rC1), u8(ecg3rC2), es.both16)).toBe('ecg');
    // 3R EMG-16
    const emg3rC1 = [0x02, 0xa8, 0x10, 0x69, 0x60, 0x20, 0x00, 0x00, 0x02, 0x03];
    const emg3rC2 = [0x02, 0xa0, 0x10, 0xe1, 0xe1, 0x00, 0x00, 0x00, 0x02, 0x01];
    expect(detectExgPreset(u8(emg3rC1), u8(emg3rC2), es.chip1_16)).toBe('emg');
    // 3R Test-16
    const t3rC1 = [0x02, 0xab, 0x10, 0x15, 0x15, 0x00, 0x00, 0x00, 0x02, 0x01];
    const t3rC2 = [0x02, 0xa3, 0x10, 0x15, 0x15, 0x00, 0x00, 0x00, 0x02, 0x01];
    expect(detectExgPreset(u8(t3rC1), u8(t3rC2), es.both16)).toBe('test-signal');
  });

  it('reports off for empty banks / no enabled EXG bits', () => {
    expect(detectExgPreset(new Uint8Array(10), new Uint8Array(10))).toBe('off');
    expect(
      detectExgPreset(u8(EXG_PRESET_ARRAYS.ecg.exg1), u8(EXG_PRESET_ARRAYS.ecg.exg2), es.none),
    ).toBe('off');
  });

  it('rejects malformed bank lengths', () => {
    expect(() => detectExgPreset(new Uint8Array(9), new Uint8Array(10))).toThrow(RangeError);
  });
});

describe('exgResolutionFromSensors (ShimmerObject.java:7255-7279)', () => {
  it('derives 16-bit / 24-bit / null from the bitmap flags', () => {
    expect(exgResolutionFromSensors(EXG1_16BIT | EXG2_16BIT)).toBe('16bit');
    expect(exgResolutionFromSensors(EXG1_24BIT | EXG2_24BIT)).toBe('24bit');
    expect(exgResolutionFromSensors(EXG1_16BIT)).toBe('16bit');
    expect(exgResolutionFromSensors(EXG1_24BIT)).toBe('24bit');
    expect(exgResolutionFromSensors(0)).toBeNull();
    // Non-EXG sensor bit set → still null.
    expect(exgResolutionFromSensors(0x000080)).toBeNull();
  });

  it('gives 16-bit precedence when both flag families are set (Java checks 16 first)', () => {
    expect(exgResolutionFromSensors(EXG1_16BIT | EXG1_24BIT)).toBe('16bit');
  });
});

describe('exgPresetLabel', () => {
  it('maps each preset to a display label', () => {
    expect(exgPresetLabel('ecg')).toBe('ECG');
    expect(exgPresetLabel('test-signal')).toBe('ExG Test Signal');
    expect(exgPresetLabel('off')).toBe('Off');
  });
});
