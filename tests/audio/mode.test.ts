/**
 * Configuration byte 233 (DEV-99): the firmware's correction rule on all 256
 * values (a port of log-and-stream-common `Test/host/test_audio_mode.c`), and
 * the byte in the InfoMem layout, schema, parse, generate and SD header.
 */
import { describe, it, expect } from 'vitest';
import {
  AUDIO_MODE,
  AUDIO_MODE_OPTIONS,
  applyAudioModeRules,
  audioGainPresetOf,
  audioModeOf,
  audioModeRecordsSpeech,
  correctAudioMode,
  describeAudioMode,
  encodeAudioMode,
  joinAudioMode,
  recordsAudioFingerprint,
  recordsRawAudio,
} from '../../src/devices/audio/mode.js';
import { FW_ID, HW_ID, resolveInfoMemLayout } from '../../src/devices/infomem/layout.js';
import {
  SHIMMER3_INFOMEM_FIELD_SCHEMA,
  infoMemFieldsFor,
  readInfoMemFieldValue,
  writeInfoMemFieldValue,
} from '../../src/devices/infomem/schema.js';
import { parseInfoMem } from '../../src/devices/infomem/parse.js';
import { generateInfoMem } from '../../src/devices/infomem/generate.js';
import type { InfoMemContext } from '../../src/devices/infomem/types.js';

const S3R: InfoMemContext = {
  hardwareVersion: HW_ID.SHIMMER_3R,
  firmwareId: FW_ID.LOGANDSTREAM,
  firmwareVersion: { major: 1, minor: 1, internal: 25 },
};
const S3: InfoMemContext = {
  hardwareVersion: HW_ID.SHIMMER_3,
  firmwareId: FW_ID.LOGANDSTREAM,
  firmwareVersion: { major: 1, minor: 1, internal: 6 },
};

describe('correctAudioMode, on every value', () => {
  it('keeps a valid built value with bits 4-6 cleared, and reads anything else as off', () => {
    for (let raw = 0; raw < 256; raw++) {
      const fixed = correctAudioMode(raw);
      const valid = (raw & 0x80) === 0 && (raw & 0x0c) === 0;
      expect(fixed, `0x${raw.toString(16)}`).toBe(valid ? raw & 0x0f : 0);
      expect(fixed & 0xf0).toBe(0);
      expect(correctAudioMode(fixed)).toBe(fixed);
      expect(audioModeOf(raw)).toBe(fixed & 0x03);
      expect(audioGainPresetOf(raw)).toBe(0);
      const mode = audioModeOf(raw);
      expect(recordsAudioFingerprint(raw)).toBe(mode === 1 || mode === 2);
      expect(recordsRawAudio(raw)).toBe(mode === 2 || mode === 3);
    }
  });

  it('reads erased flash, a zeroing host and reserved values as off', () => {
    expect(correctAudioMode(0xff)).toBe(0);
    expect(correctAudioMode(0x00)).toBe(0);
    expect(correctAudioMode(0x83)).toBe(0); // raw audio, bit 7 set
    expect(correctAudioMode(0x05)).toBe(0); // fingerprint, gain preset 1
    expect(correctAudioMode(0x0f)).toBe(0); // raw audio, gain preset 3
    expect(correctAudioMode(0x73)).toBe(0x03); // unused bits cleared, mode kept
  });

  it('encodes a mode at the default gain, and nothing outside 0-3', () => {
    expect([0, 1, 2, 3].map(encodeAudioMode)).toEqual([0, 1, 2, 3]);
    expect(encodeAudioMode(4)).toBe(0);
    expect(encodeAudioMode(-1)).toBe(0);
  });

  it('says which modes record speech: the two that keep raw audio', () => {
    expect([0, 1, 2, 3].map(audioModeRecordsSpeech)).toEqual([false, false, true, true]);
    expect(AUDIO_MODE_OPTIONS.map(([v]) => v)).toEqual([0, 1, 2, 3]);
    expect(AUDIO_MODE_OPTIONS[2][1]).toMatch(/speech/);
    expect(AUDIO_MODE_OPTIONS[3][1]).toMatch(/speech/);
    expect(describeAudioMode(AUDIO_MODE.FINGERPRINT_RAW)).toBe('Fingerprint + raw');
  });
});

describe('byte 233 in the InfoMem', () => {
  const field = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((f) => f.key === 'audioMode');

  it('is in the layout only where the device said it records audio', () => {
    expect(resolveInfoMemLayout(S3R).idxAudioMode).toBeUndefined();
    expect(resolveInfoMemLayout({ ...S3R, audio: false }).idxAudioMode).toBeUndefined();
    expect(resolveInfoMemLayout({ ...S3R, audio: true }).idxAudioMode).toBe(233);
  });

  it('is a Shimmer3R field, offered only with a layout that has the byte', () => {
    expect(field).toBeDefined();
    expect(field?.appliesTo).toEqual(['shimmer3r']);
    const withAudio = resolveInfoMemLayout({ ...S3R, audio: true });
    const without = resolveInfoMemLayout(S3R);
    const keys = (fs: { key: string }[]): string[] => fs.map((f) => f.key);
    expect(keys(infoMemFieldsFor('shimmer3r', withAudio))).toContain('audioMode');
    expect(keys(infoMemFieldsFor('shimmer3r', without))).not.toContain('audioMode');
    expect(keys(infoMemFieldsFor('shimmer3r'))).not.toContain('audioMode');
    expect(
      keys(infoMemFieldsFor('shimmer3-new-imu', resolveInfoMemLayout({ ...S3, audio: true }))),
    ).not.toContain('audioMode');
  });

  it('reads 0xFF and a reserved gain preset as off, and writes a mode over them from 0', () => {
    if (!field) throw new Error('no audioMode field');
    const layout = resolveInfoMemLayout({ ...S3R, audio: true });
    const bytes = new Uint8Array(384);
    bytes[233] = 0xff;
    expect(readInfoMemFieldValue(bytes, field, layout)).toBe(0);
    writeInfoMemFieldValue(bytes, field, layout, 3);
    expect(bytes[233]).toBe(0x03);
    bytes[233] = 0x06; // mode 2, gain preset 1: the firmware reads it as off
    expect(readInfoMemFieldValue(bytes, field, layout)).toBe(0);
    writeInfoMemFieldValue(bytes, field, layout, 1);
    expect(bytes[233]).toBe(0x01);
    bytes[233] = 0x72; // unused bits do not turn the byte off
    expect(readInfoMemFieldValue(bytes, field, layout)).toBe(2);
  });

  it('parses the byte raw, and an unedited config writes it back as it was', () => {
    const ctx = { ...S3R, audio: true };
    const image = new Uint8Array(384);
    image[233] = 0x83;
    const cfg = parseInfoMem(image, ctx);
    expect(cfg.audioMode).toBe(0x83);
    expect(generateInfoMem(cfg, ctx)[233]).toBe(0x83);
    expect(generateInfoMem({ ...cfg, audioMode: encodeAudioMode(2) }, ctx)[233]).toBe(0x02);
    // Without the byte in the layout, parse gives 0 and generate leaves the base alone.
    const plain = parseInfoMem(image, S3R);
    expect(plain.audioMode).toBe(0);
    expect(generateInfoMem({ ...plain, audioMode: 3 }, S3R)[233]).toBe(0x83);
  });

  it('applies the firmware check before a write, and holds a microphone-less unit at 0', () => {
    const layout = resolveInfoMemLayout({ ...S3R, audio: true });
    const image = new Uint8Array(384);
    image[233] = 0x7b; // mode 3, gain preset 2: off
    expect(applyAudioModeRules(image, layout)).toEqual([233]);
    expect(image[233]).toBe(0);
    image[233] = 0x73;
    expect(applyAudioModeRules(image, layout)).toEqual([233]);
    expect(image[233]).toBe(0x03);
    expect(applyAudioModeRules(image, layout)).toEqual([]);
    expect(applyAudioModeRules(image, layout, false)).toEqual([233]);
    expect(image[233]).toBe(0);
    expect(applyAudioModeRules(image, resolveInfoMemLayout(S3R))).toEqual([]);
  });
});

describe('byte 233 as two enables', () => {
  it('has a mode for every combination of the fingerprint and raw audio', () => {
    expect(joinAudioMode({ fingerprint: false, raw: false })).toBe(AUDIO_MODE.OFF);
    expect(joinAudioMode({ fingerprint: true, raw: false })).toBe(AUDIO_MODE.FINGERPRINT);
    expect(joinAudioMode({ fingerprint: true, raw: true })).toBe(AUDIO_MODE.FINGERPRINT_RAW);
    expect(joinAudioMode({ fingerprint: false, raw: true })).toBe(AUDIO_MODE.RAW);
  });

  it('splits every byte back into the same two, as the firmware reads it', () => {
    for (let raw = 0; raw < 256; raw++) {
      const parts = { fingerprint: recordsAudioFingerprint(raw), raw: recordsRawAudio(raw) };
      expect(joinAudioMode(parts), `0x${raw.toString(16)}`).toBe(audioModeOf(raw));
    }
  });

  it('is in Sensor Enables, with what is recorded', () => {
    const field = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((f) => f.key === 'audioMode');
    expect(field?.group).toBe('sensors');
  });
});
