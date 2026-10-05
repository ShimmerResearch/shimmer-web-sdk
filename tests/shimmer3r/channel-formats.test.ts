import { describe, it, expect } from 'vitest';
import {
  CHANNEL_FORMATS,
  CHANNEL_FORMAT_OVERRIDES,
  UNKNOWN_CHANNEL_ASSUMED_BYTES,
  channelFormatsFor,
  resolveChannelFormat,
  generationFromHardwareVersion,
  type ChannelFormat,
} from '../../src/devices/shimmer3r/channelFormats.js';

// The 41 channel IDs the LogAndStream firmware can put in an inquiry response
// (shimmer_sensing.h:93-144 for the two SHIMMER3/SHIMMER3R arms — the
// SHIMMER4_SDK-only block 0x29.. is out of scope).
const ALL_IDS_BOTH = [
  0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f,
  0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26,
];
/** Bridge amp: Shimmer3 expansion board only, no Shimmer3R equivalent. */
const SHIMMER3_ONLY_IDS = [0x27, 0x28];

describe('generationFromHardwareVersion', () => {
  it('maps the two DEVICE_VERSION hardware ids, and nothing else', () => {
    expect(generationFromHardwareVersion(3)).toBe('shimmer3');
    expect(generationFromHardwareVersion(10)).toBe('shimmer3r');
    expect(generationFromHardwareVersion(0)).toBeNull();
    expect(generationFromHardwareVersion(9)).toBeNull();
    expect(generationFromHardwareVersion(null)).toBeNull();
    expect(generationFromHardwareVersion(undefined)).toBeNull();
  });
});

describe('channel coverage', () => {
  it('describes every channel ID a Shimmer3 can report', () => {
    const table = channelFormatsFor('shimmer3');
    const missing = [...ALL_IDS_BOTH, ...SHIMMER3_ONLY_IDS].filter((id) => !table[id]);
    expect(missing).toEqual([]);
  });

  it('describes every channel ID a Shimmer3R can report', () => {
    const table = channelFormatsFor('shimmer3r');
    const missing = ALL_IDS_BOTH.filter((id) => !table[id]);
    expect(missing).toEqual([]);
  });

  it('leaves the bridge-amp channels undescribed on a Shimmer3R (no such hardware)', () => {
    for (const id of SHIMMER3_ONLY_IDS) {
      expect(resolveChannelFormat(id, 'shimmer3')).toBeDefined();
      expect(resolveChannelFormat(id, 'shimmer3r')).toBeUndefined();
    }
  });

  it('gives every entry a name, a positive width and a known encoding', () => {
    for (const generation of ['shimmer3', 'shimmer3r'] as const) {
      for (const [id, f] of Object.entries(channelFormatsFor(generation))) {
        expect(f.name, `0x${Number(id).toString(16)} name`).toMatch(/^\S+$/);
        expect(f.sizeBytes, `0x${Number(id).toString(16)} size`).toBeGreaterThan(0);
        expect(['i16', 'u16', 'i24', 'u24', 'i12*', 'u8']).toContain(f.fmt);
        expect(['le', 'be']).toContain(f.endian);
        // Width and encoding have to agree, or the parser reads past the field.
        const width = { u8: 1, i16: 2, u16: 2, 'i12*': 2, i24: 3, u24: 3 }[f.fmt];
        expect(f.sizeBytes, `0x${Number(id).toString(16)} ${f.fmt} width`).toBe(width);
      }
    }
  });
});

describe('the newly described channels', () => {
  const expected: Array<[number, ChannelFormat, ChannelFormat]> = [
    // id, shimmer3, shimmer3r
    [
      0x03,
      { name: 'BATTERY', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'BATTERY', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x0d,
      { name: 'EXT_EXP_ADC_A7', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'EXT_ADC_0', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x0e,
      { name: 'EXT_EXP_ADC_A6', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'EXT_ADC_1', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x0f,
      { name: 'EXT_EXP_ADC_A15', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'EXT_ADC_2', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x10,
      { name: 'INT_EXP_ADC_A1', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'INT_ADC_3', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x11,
      { name: 'INT_EXP_ADC_A12', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'INT_ADC_0', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x13,
      { name: 'INT_EXP_ADC_A14', fmt: 'u16', endian: 'le', sizeBytes: 2 },
      { name: 'INT_ADC_2', fmt: 'u16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x17,
      { name: 'ALT_MAG_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
      { name: 'ALT_MAG_X', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x18,
      { name: 'ALT_MAG_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
      { name: 'ALT_MAG_Y', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    ],
    [
      0x19,
      { name: 'ALT_MAG_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
      { name: 'ALT_MAG_Z', fmt: 'i16', endian: 'le', sizeBytes: 2 },
    ],
    // The two that were corrupting packets: BMPX80 over I2C on a Shimmer3
    // (2-byte big-endian temperature, 3-byte big-endian pressure) vs
    // BMP390/BMP581 over SPI on a Shimmer3R (3 little-endian bytes each).
    [
      0x1a,
      { name: 'TEMPERATURE', fmt: 'u16', endian: 'be', sizeBytes: 2 },
      { name: 'TEMPERATURE', fmt: 'u24', endian: 'le', sizeBytes: 3 },
    ],
    [
      0x1b,
      { name: 'PRESSURE', fmt: 'u24', endian: 'be', sizeBytes: 3 },
      { name: 'PRESSURE', fmt: 'u24', endian: 'le', sizeBytes: 3 },
    ],
  ];

  it.each(expected)('0x%s resolves per generation', (id, s3, s3r) => {
    expect(resolveChannelFormat(id, 'shimmer3')).toEqual(s3);
    expect(resolveChannelFormat(id, 'shimmer3r')).toEqual(s3r);
  });

  it('describes the Shimmer3-only bridge-amp pair', () => {
    expect(resolveChannelFormat(0x27, 'shimmer3')).toEqual({
      name: 'BRIDGE_AMP_HIGH',
      fmt: 'u16',
      endian: 'le',
      sizeBytes: 2,
    });
    expect(resolveChannelFormat(0x28, 'shimmer3')).toEqual({
      name: 'BRIDGE_AMP_LOW',
      fmt: 'u16',
      endian: 'le',
      sizeBytes: 2,
    });
  });

  it('is the pressure pair, and only it, that differs in width between generations', () => {
    const differing = Object.keys(CHANNEL_FORMAT_OVERRIDES.shimmer3)
      .map(Number)
      .filter((id) => {
        const a = resolveChannelFormat(id, 'shimmer3')!;
        const b = resolveChannelFormat(id, 'shimmer3r');
        return b !== undefined && a.sizeBytes !== b.sizeBytes;
      });
    expect(differing).toEqual([0x1a]);
  });
});

describe('CHANNEL_FORMATS (public base table)', () => {
  it('keeps the entries earlier releases exported meaning what they meant', () => {
    // Spot-check the load-bearing ones: any change here is a breaking change
    // for a consumer reading the map directly (e.g. a demo's mock device).
    expect(CHANNEL_FORMATS[0x00]).toEqual({
      name: 'LN_ACCEL_X',
      fmt: 'i16',
      endian: 'le',
      sizeBytes: 2,
    });
    expect(CHANNEL_FORMATS[0x12]).toEqual({ name: 'PPG', fmt: 'i16', endian: 'le', sizeBytes: 2 });
    expect(CHANNEL_FORMATS[0x1c]).toEqual({ name: 'GSR', fmt: 'u16', endian: 'le', sizeBytes: 2 });
    expect(CHANNEL_FORMATS[0x14]).toEqual({
      name: 'HG_ACCEL_X',
      fmt: 'i12*',
      endian: 'le',
      sizeBytes: 2,
    });
    expect(CHANNEL_FORMATS[0x1e]).toEqual({
      name: 'Exg1_CH1_24Bit',
      fmt: 'i24',
      endian: 'be',
      sizeBytes: 3,
    });
  });

  it('holds no channel whose meaning depends on the generation', () => {
    for (const id of Object.keys(CHANNEL_FORMATS).map(Number)) {
      const overridden =
        CHANNEL_FORMAT_OVERRIDES.shimmer3[id] ?? CHANNEL_FORMAT_OVERRIDES.shimmer3r[id];
      // 0x12 is the documented exception: the firmware names it differently on
      // each platform but the width and encoding are identical, and `PPG` is
      // the name this SDK has always emitted.
      if (id === 0x12) continue;
      expect(overridden, `0x${id.toString(16)} is in both layers`).toBeUndefined();
    }
  });

  it('is frozen, as are the per-generation layers', () => {
    expect(Object.isFrozen(CHANNEL_FORMATS)).toBe(true);
    expect(Object.isFrozen(CHANNEL_FORMAT_OVERRIDES)).toBe(true);
    expect(Object.isFrozen(CHANNEL_FORMAT_OVERRIDES.shimmer3)).toBe(true);
    expect(Object.isFrozen(CHANNEL_FORMAT_OVERRIDES.shimmer3r)).toBe(true);
    expect(Object.isFrozen(channelFormatsFor('shimmer3'))).toBe(true);
    expect(Object.isFrozen(channelFormatsFor('shimmer3r'))).toBe(true);
  });

  it('still exposes the assumed width as a named constant, not a magic 2', () => {
    expect(UNKNOWN_CHANNEL_ASSUMED_BYTES).toBe(2);
  });
});
