/**
 * The Shimmer3R sound-level channel (DEV-1413): channel 0x38, a signed 16-bit
 * little-endian count of 0.01 dB(A), 0x8000 for no level; and configuration
 * byte 233 bit 4, which turns it on.
 *
 * The conversion vectors and the byte-233 cases are shared with the other
 * host implementations of the channel, so they agree on every value here.
 */
import { describe, it, expect } from 'vitest';
import {
  SOUND_LEVEL_CHANNEL_ID,
  SOUND_LEVEL_NAME,
  SOUND_LEVEL_NO_LEVEL,
  SOUND_LEVEL_UNIT,
  soundLevelDbA,
} from '../../src/devices/audio/soundLevel.js';
import {
  AUDIO_MODE,
  AUDIO_MODE_BYTE,
  audioModeOf,
  audioModeRecordsSpeech,
  correctAudioMode,
  encodeAudioMode,
  joinAudioMode,
  soundLevelEnabled,
  soundLevelSupportedByReadback,
  splitAudioMode,
  withSoundLevel,
} from '../../src/devices/audio/mode.js';
import {
  channelLayoutDiffersByGeneration,
  resolveChannelFormat,
} from '../../src/devices/shimmer3r/channelFormats.js';
import { buildStreamSchema } from '../../src/devices/shimmer3r/streamSchema.js';
import { buildShimmer3Schema } from '../../src/devices/shimmer3/protocol.js';
import { SCALAR_CALIBRATORS } from '../../src/devices/calibration/streamChannels.js';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { decodeSdLogFile } from '../../src/devices/sdlog/index.js';
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
import * as sdk from '../../src/index.js';
import { buildFile, buildPacket, buildSdLogHeader, encodeValue } from '../sdlog/fixtures.js';

const i16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];

/** Raw counts and the level each should give: the shared vectors. */
const VECTORS: ReadonlyArray<readonly [raw: number, dbA: number]> = [
  [0, 0],
  [6543, 65.43],
  [3000, 30],
  [12000, 120],
  [-1234, -12.34],
  [-32767, -327.67],
  [32767, 327.67],
];

describe('soundLevelDbA', () => {
  it('converts 0.01 dB(A) counts', () => {
    for (const [raw, db] of VECTORS) expect(soundLevelDbA(raw), String(raw)).toBeCloseTo(db, 10);
  });

  it('gives NaN for 0x8000, never -327.68 dB', () => {
    expect(SOUND_LEVEL_NO_LEVEL).toBe(-32768);
    expect(soundLevelDbA(-32768)).toBeNaN();
    expect(soundLevelDbA(SOUND_LEVEL_NO_LEVEL)).toBeNaN();
  });

  it('gives NaN for anything that is not a signed 16-bit count', () => {
    for (const raw of [NaN, Infinity, 1.5, 32768, -32769]) {
      expect(soundLevelDbA(raw), String(raw)).toBeNaN();
    }
  });

  it('is in nominal dB(A), and exported', () => {
    expect(SOUND_LEVEL_UNIT).toBe('dB(A)');
    expect(sdk.SOUND_LEVEL_CHANNEL_ID).toBe(0x38);
    expect(sdk.soundLevelDbA(100)).toBe(1);
    expect(typeof sdk.withSoundLevel).toBe('function');
    expect(typeof sdk.soundLevelSupportedByReadback).toBe('function');
  });
});

describe('channel 0x38 in the stream', () => {
  it('is a Shimmer3R channel, two bytes little-endian, and nothing on a Shimmer3', () => {
    expect(SOUND_LEVEL_CHANNEL_ID).toBe(0x38);
    expect(resolveChannelFormat(0x38, 'shimmer3r')).toEqual({
      name: SOUND_LEVEL_NAME,
      fmt: 'i16',
      endian: 'le',
      sizeBytes: 2,
    });
    expect(resolveChannelFormat(0x38, 'shimmer3')).toBeUndefined();
    expect(channelLayoutDiffersByGeneration(0x38)).toBe(true);
  });

  it('keeps a Shimmer3R schema trusted, with battery still last', () => {
    // As the firmware orders it: just before the ADS7028 block.
    const s = buildStreamSchema([0x00, 0x01, 0x02, 0x38, 0x1c, 0x03], 'u24', {
      generation: 'shimmer3r',
    });
    expect(s.trusted).toBe(true);
    expect(s.unknownChannelIds).toEqual([]);
    expect(s.fields.map((f) => f.name)).toEqual([
      'LN_ACCEL_X',
      'LN_ACCEL_Y',
      'LN_ACCEL_Z',
      'SOUND_LEVEL',
      'GSR',
      'BATTERY',
    ]);
    // preamble + 3-byte timestamp + 6 channels x 2 bytes
    expect(s.frameBytes).toBe(1 + 3 + 12);
    // No sensor-bitmap bit: byte 233 turns it on, not the bitmap.
    expect(s.enabledSensors).toBe(
      buildStreamSchema([0x00, 0x01, 0x02, 0x1c, 0x03], 'u24', { generation: 'shimmer3r' })
        .enabledSensors,
    );
  });

  it('is an unknown channel on a Shimmer3, which never sends it', () => {
    const s = buildShimmer3Schema([0x00, 0x38], 'u24', () => {});
    expect(s.trusted).toBe(false);
    expect(s.unknownChannelIds).toEqual([0x38]);
  });

  it('calibrates to nominal dB(A) through the shared registry', () => {
    const c = SCALAR_CALIBRATORS[SOUND_LEVEL_NAME];
    expect(c.unit).toBe('dB(A)');
    expect(c.calibrate(6543, {} as never)).toBeCloseTo(65.43, 10);
    expect(c.calibrate(-32768, {} as never)).toBeNaN();
  });
});

describe('Shimmer3RClient streaming the sound level', () => {
  const ACK = OPCODES.ACK_COMMAND_PROCESSED;
  const CHANNELS = [0x00, 0x38, 0x1c, 0x03];
  const INQUIRY = [OPCODES.INQUIRY_RESPONSE, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0];

  async function session(): Promise<{
    t: LoopbackTransport;
    frames: Array<{
      raw: Record<string, number>;
      cal: Record<string, number>;
      units: Record<string, string>;
    }>;
  }> {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify([ACK, ...INQUIRY, CHANNELS.length, 1, ...CHANNELS]), 0);
      } else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.inquiry();
    const frames: Array<{
      raw: Record<string, number>;
      cal: Record<string, number>;
      units: Record<string, string>;
    }> = [];
    client.onStreamFrame = (oc) => {
      const raw: Record<string, number> = {};
      const cal: Record<string, number> = {};
      const units: Record<string, string> = {};
      for (const f of oc.fields) {
        if (f.kind === 'raw') raw[f.name] = f.value;
        else if (f.kind === 'cal') {
          cal[f.name] = f.value;
          units[f.name] = f.unit as string;
        }
      }
      frames.push({ raw, cal, units });
    };
    await client.startStreaming();
    return { t, frames };
  }

  const frame = (ts: number, level: number, battery: number): number[] => [
    0x00,
    ts & 0xff,
    (ts >> 8) & 0xff,
    (ts >> 16) & 0xff,
    ...i16(100), // LN_ACCEL_X
    ...i16(level), // SOUND_LEVEL
    ...i16(1500), // GSR
    ...i16(battery), // BATTERY, last
  ];

  it('decodes the level, gives no level as NaN, and keeps every frame the same width', async () => {
    const { t, frames } = await session();
    const levels = [-32768, -32768, 6543, -1234, 32767, -32768];
    for (const [i, level] of levels.entries()) t.notify(frame(1000 + i * 640, level, 2600 + i));
    // A frame is delivered once the next one confirms its boundary.
    t.notify(frame(1000 + levels.length * 640, 0, 0));

    expect(frames).toHaveLength(levels.length);
    for (const [i, f] of frames.entries()) {
      expect(f.raw.SOUND_LEVEL).toBe(levels[i]);
      expect(f.units.SOUND_LEVEL).toBe('dB(A)');
      expect(f.raw.BATTERY).toBe(2600 + i);
      expect(f.raw.GSR).toBe(1500);
    }
    expect(frames.map((f) => f.cal.SOUND_LEVEL)).toEqual([NaN, NaN, 65.43, -12.34, 327.67, NaN]);
    // The cal field is there for the no-level frames too, so a CSV keeps its columns.
    const widths = new Set(frames.map((f) => Object.keys(f.cal).length));
    expect(widths.size).toBe(1);
  });
});

describe('channel 0x38 in a Shimmer3R SD file', () => {
  const file = (levels: number[]): Uint8Array =>
    buildFile(
      buildSdLogHeader({
        hw: 10,
        fwId: 3,
        fwVersion: [1, 1, 25],
        signalIds: [0x00, 0x38, 0x03],
        calibFill: () => 0xff,
      }),
      ...levels.map((level, i) =>
        buildPacket(100 + i * 512, 3, [
          ...encodeValue('i16', 7),
          ...encodeValue('i16', level),
          ...encodeValue('i16', 2600 + i),
        ]),
      ),
    );

  it('decodes it calibrated, in nominal dB(A), with no level as NaN', () => {
    const { header, records } = decodeSdLogFile(file([-32768, 6543, -1234, 32767]));
    const at = header.channels.findIndex((c) => c.name === SOUND_LEVEL_NAME);
    expect(at).toBe(1);
    expect(header.channels[at]).toMatchObject({
      name: 'SOUND_LEVEL',
      unit: 'dB(A)',
      calibrated: true,
    });
    expect(records.map((r) => r.values[at])).toEqual([NaN, 65.43, -12.34, 327.67]);
    // Battery after it decodes from the right offset.
    expect(records.map((r) => r.values[2])).toEqual([2600, 2601, 2602, 2603]);
  });
});

const S3R: InfoMemContext = {
  hardwareVersion: HW_ID.SHIMMER_3R,
  firmwareId: FW_ID.LOGANDSTREAM,
  firmwareVersion: { major: 1, minor: 1, internal: 25 },
  audio: true,
};

describe('byte 233 bit 4', () => {
  it('survives the firmware correction, and bits 5-6 do not', () => {
    expect(AUDIO_MODE_BYTE.SOUND_LEVEL).toBe(0x10);
    expect(correctAudioMode(0x10)).toBe(0x10);
    expect(correctAudioMode(0x12)).toBe(0x12);
    expect(correctAudioMode(0x73)).toBe(0x13);
    expect(correctAudioMode(0x60)).toBe(0x00);
    // Bit 7 or a reserved gain preset still turns the whole byte off, bit 4 too.
    expect(correctAudioMode(0x90)).toBe(0);
    expect(correctAudioMode(0x14)).toBe(0);
    expect(correctAudioMode(0xff)).toBe(0);
  });

  it('is independent of the mode', () => {
    for (let mode = 0; mode < 4; mode++) {
      const byte = withSoundLevel(encodeAudioMode(mode), true);
      expect(byte).toBe(0x10 | mode);
      expect(audioModeOf(byte)).toBe(mode);
      expect(soundLevelEnabled(byte)).toBe(true);
      expect(withSoundLevel(byte, false)).toBe(mode);
      expect(soundLevelEnabled(encodeAudioMode(mode))).toBe(false);
    }
    // A mode that records speech is still one with the sound level on.
    expect(audioModeRecordsSpeech(0x12)).toBe(true);
    expect(audioModeRecordsSpeech(0x13)).toBe(true);
    expect(audioModeRecordsSpeech(0x11)).toBe(false);
    expect(audioModeRecordsSpeech(0x10)).toBe(false);
  });

  it('joins and splits with the fingerprint and raw audio, on every byte', () => {
    expect(joinAudioMode({ fingerprint: false, raw: false, soundLevel: true })).toBe(0x10);
    expect(joinAudioMode({ fingerprint: true, raw: true, soundLevel: true })).toBe(
      0x10 | AUDIO_MODE.FINGERPRINT_RAW,
    );
    expect(joinAudioMode({ fingerprint: true, raw: false })).toBe(AUDIO_MODE.FINGERPRINT);
    for (let raw = 0; raw < 256; raw++) {
      expect(joinAudioMode(splitAudioMode(raw)), `0x${raw.toString(16)}`).toBe(
        correctAudioMode(raw),
      );
    }
  });

  it('tells a unit with the channel from one without, by the byte read back', () => {
    const written = withSoundLevel(encodeAudioMode(AUDIO_MODE.FINGERPRINT), true); // 0x11
    // Firmware with the channel keeps bit 4; firmware before it clears it.
    expect(soundLevelSupportedByReadback(written, 0x11)).toBe(true);
    expect(soundLevelSupportedByReadback(written, 0x01)).toBe(false);
    // Bit 4 not written: the readback says nothing about the channel.
    expect(soundLevelSupportedByReadback(0x01, 0x01)).toBeNull();
    // A byte the firmware reads as off is no question either.
    expect(soundLevelSupportedByReadback(0x90, 0x00)).toBeNull();
  });

  it('is a Shimmer3R field in Sensor Enables, offered with byte 233', () => {
    const field = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((f) => f.key === 'soundLevel');
    expect(field).toBeDefined();
    expect(field?.appliesTo).toEqual(['shimmer3r']);
    expect(field?.group).toBe('sensors');
    expect(field?.desc).toMatch(/[Nn]ominal/);
    const keys = (fs: { key: string }[]): string[] => fs.map((f) => f.key);
    expect(keys(infoMemFieldsFor('shimmer3r', resolveInfoMemLayout(S3R)))).toContain('soundLevel');
    expect(
      keys(infoMemFieldsFor('shimmer3r', resolveInfoMemLayout({ ...S3R, audio: false }))),
    ).not.toContain('soundLevel');
  });

  it('round-trips through the field, leaving the mode alone', () => {
    const field = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((f) => f.key === 'soundLevel');
    const modeField = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((f) => f.key === 'audioMode');
    if (!field || !modeField) throw new Error('no byte-233 fields');
    const layout = resolveInfoMemLayout(S3R);
    const bytes = new Uint8Array(384);
    bytes[233] = 0x02;
    expect(readInfoMemFieldValue(bytes, field, layout)).toBe(0);
    writeInfoMemFieldValue(bytes, field, layout, 1);
    expect(bytes[233]).toBe(0x12);
    expect(readInfoMemFieldValue(bytes, field, layout)).toBe(1);
    expect(readInfoMemFieldValue(bytes, modeField, layout)).toBe(2);
    writeInfoMemFieldValue(bytes, modeField, layout, 1);
    expect(bytes[233]).toBe(0x11);
    writeInfoMemFieldValue(bytes, field, layout, 0);
    expect(bytes[233]).toBe(0x01);
    // Erased flash reads off, and the bit is written over it from 0.
    bytes[233] = 0xff;
    expect(readInfoMemFieldValue(bytes, field, layout)).toBe(0);
    writeInfoMemFieldValue(bytes, field, layout, 1);
    expect(bytes[233]).toBe(0x10);
  });

  it('round-trips through parseInfoMem and generateInfoMem', () => {
    const image = new Uint8Array(384);
    image[233] = 0x13;
    const cfg = parseInfoMem(image, S3R);
    expect(cfg.audioMode).toBe(0x13);
    expect(soundLevelEnabled(cfg.audioMode)).toBe(true);
    expect(generateInfoMem(cfg, S3R)[233]).toBe(0x13);
    expect(
      generateInfoMem({ ...cfg, audioMode: withSoundLevel(cfg.audioMode, false) }, S3R)[233],
    ).toBe(0x03);
  });
});
