import { describe, it, expect } from 'vitest';
import {
  SHIMMER3_INFOMEM_FIELD_SCHEMA,
  SHIMMER3_INFOMEM_FIELD_GROUPS,
  NEW_IMU_EXP_REV,
  resolveFieldIndex,
  readInfoMemFieldValue,
  writeInfoMemFieldValue,
  infoMemFieldsFor,
  inferShimmer3Generation,
  resolveInfoMemLayout,
  parseInfoMem,
  generateInfoMem,
  INFOMEM_SIZE,
  type InfoMemFieldDefinition,
  type Shimmer3Generation,
} from '../../src/devices/infomem/index.js';
import { CTX, fullFieldInfoMem } from './fixtures.js';

const field = (key: string): InfoMemFieldDefinition => {
  const f = SHIMMER3_INFOMEM_FIELD_SCHEMA.find((d) => d.key === key);
  if (!f) throw new Error(`no schema field '${key}'`);
  return f;
};

describe('SHIMMER3_INFOMEM_FIELD_SCHEMA — structural invariants', () => {
  it('has unique keys', () => {
    const keys = SHIMMER3_INFOMEM_FIELD_SCHEMA.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every field names a group that exists', () => {
    const ids = new Set(SHIMMER3_INFOMEM_FIELD_GROUPS.map((g) => g.id));
    for (const f of SHIMMER3_INFOMEM_FIELD_SCHEMA) {
      expect(ids.has(f.group), `${f.key} → ${f.group}`).toBe(true);
    }
  });

  it('every field resolves to a real byte index in both contexts', () => {
    for (const ctx of [CTX.modernShimmer3, CTX.shimmer3R]) {
      const layout = resolveInfoMemLayout(ctx);
      for (const f of SHIMMER3_INFOMEM_FIELD_SCHEMA) {
        const idx = resolveFieldIndex(f, layout);
        expect(Number.isInteger(idx), f.key).toBe(true);
        expect(idx, f.key).toBeGreaterThanOrEqual(0);
        expect(idx, f.key).toBeLessThan(INFOMEM_SIZE);
      }
    }
  });

  it('every bit field declares a shift and width that fit in one byte', () => {
    for (const f of SHIMMER3_INFOMEM_FIELD_SCHEMA) {
      if (f.kind !== 'bit') continue;
      expect(f.shift, f.key).toBeTypeOf('number');
      expect(f.width, f.key).toBeTypeOf('number');
      expect((f.shift ?? 0) + (f.width ?? 1), f.key).toBeLessThanOrEqual(8);
    }
  });

  it('every option value fits the field it belongs to (composite fields get their MSB bits)', () => {
    for (const f of SHIMMER3_INFOMEM_FIELD_SCHEMA) {
      if (!f.options) continue;
      const bits = f.kind === 'bit' ? (f.width ?? 1) + (f.msbLayoutKey ? (f.msbWidth ?? 1) : 0) : 8;
      const max = (1 << bits) - 1;
      for (const [value] of f.options) {
        expect(value, `${f.key} option ${value}`).toBeLessThanOrEqual(max);
        expect(value, `${f.key} option ${value}`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the two composite fields declare their MSB byte, and only they do', () => {
    const composite = SHIMMER3_INFOMEM_FIELD_SCHEMA.filter((f) => f.msbLayoutKey !== undefined);
    expect(composite.map((f) => f.key)).toEqual([
      'gyroRange.lsm6dsv',
      'pressureOversampling.bmp390_581',
    ]);
    for (const f of composite) {
      // Both live in ConfigSetupByte4 and are Shimmer3R-only (on Shimmer3 that
      // byte holds MPL settings).
      expect(f.msbLayoutKey, f.key).toBe('idxConfigSetupByte4');
      expect(f.appliesTo, f.key).toEqual(['shimmer3r']);
    }
  });

  it('surfaces no MPL / DMP field (product decision — never in host UI)', () => {
    // Word-boundary match: "sampling" legitimately contains the substring.
    const mplOrDmp = /\b(mpl|dmp)\b/i;
    for (const f of SHIMMER3_INFOMEM_FIELD_SCHEMA) {
      expect(mplOrDmp.test(`${f.key} ${f.label} ${f.configKey}`), f.key).toBe(false);
    }
    // ConfigSetupByte6 is the MPL-only byte and must not be referenced at all.
    expect(SHIMMER3_INFOMEM_FIELD_SCHEMA.some((f) => f.layoutKey === 'idxConfigSetupByte6')).toBe(
      false,
    );
    expect(
      SHIMMER3_INFOMEM_FIELD_SCHEMA.some((f) => f.msbLayoutKey === 'idxConfigSetupByte6'),
    ).toBe(false);
  });

  it('contains no SDLog-only showErrorLeds fields', () => {
    const keys = SHIMMER3_INFOMEM_FIELD_SCHEMA.map((f) => f.key.toLowerCase());
    expect(keys.some((k) => k.includes('errorled'))).toBe(false);
  });
});

describe('infoMemFieldsFor — generation gating', () => {
  const keysFor = (g: Shimmer3Generation): string[] => infoMemFieldsFor(g).map((f) => f.key);

  it('hides Shimmer3R-only fields on Shimmer3 contexts', () => {
    for (const g of ['shimmer3-old-imu', 'shimmer3-new-imu'] as const) {
      const keys = keysFor(g);
      expect(keys).not.toContain('altAccelRate.adxl371');
      expect(keys).not.toContain('altMagRate.lis3mdl');
      expect(keys).not.toContain('altMagRange.lis3mdl');
      expect(keys).not.toContain('lnAccelRange');
      expect(keys).not.toContain('calib.altAccel');
      expect(keys).not.toContain('calib.altMag');
      expect(keys).not.toContain('gyroRange.lsm6dsv');
      expect(keys).not.toContain('imuRate.lsm6dsv');
      expect(keys).not.toContain('pressureOversampling.bmp390_581');
      expect(keys).not.toContain('wrAccelRate.lis2dw12');
    }
  });

  it('hides LSM303/MPU-specific fields on Shimmer3R', () => {
    const keys = keysFor('shimmer3r');
    expect(keys).not.toContain('gyroRange.mpu9x50');
    expect(keys).not.toContain('imuRate.mpu9x50');
    expect(keys).not.toContain('altAccelRange.mpu9x50');
    expect(keys).not.toContain('magRange.lsm303dlhc');
    expect(keys).not.toContain('magRate.lsm303dlhc');
    expect(keys).not.toContain('wrAccelRate.lsm303dlhc');
    expect(keys).not.toContain('wrAccelRate.lsm303ah');
    expect(keys).not.toContain('pressureOversampling.bmpX80');
  });

  it('shows exactly one WR-accel-rate variant per generation', () => {
    for (const g of ['shimmer3-old-imu', 'shimmer3-new-imu', 'shimmer3r'] as const) {
      const rates = keysFor(g).filter((k) => k.startsWith('wrAccelRate.'));
      expect(rates, g).toHaveLength(1);
    }
  });

  it('shows exactly one gyro-range and one IMU-rate variant per generation', () => {
    for (const g of ['shimmer3-old-imu', 'shimmer3-new-imu', 'shimmer3r'] as const) {
      expect(
        keysFor(g).filter((k) => k.startsWith('gyroRange.')),
        g,
      ).toHaveLength(1);
      expect(
        keysFor(g).filter((k) => k.startsWith('imuRate.')),
        g,
      ).toHaveLength(1);
    }
  });

  it('keeps the shared fields on every generation', () => {
    for (const g of ['shimmer3-old-imu', 'shimmer3-new-imu', 'shimmer3r'] as const) {
      const keys = keysFor(g);
      for (const shared of ['samplingRate', 'gsrRange', 'btBaudRate', 'syncNodes', 'deviceName']) {
        expect(keys, `${g} / ${shared}`).toContain(shared);
      }
    }
  });

  it('old-IMU Shimmer3 keeps the LSM303DLHC mag range (Shimmer3R reuses those bits for the alt mag)', () => {
    expect(keysFor('shimmer3-old-imu')).toContain('magRange.lsm303dlhc');
    expect(keysFor('shimmer3r')).toContain('altMagRange.lis3mdl');
    // Same bits, different meaning.
    expect(field('magRange.lsm303dlhc').shift).toBe(field('altMagRange.lis3mdl').shift);
    expect(field('magRange.lsm303dlhc').layoutKey).toBe(field('altMagRange.lis3mdl').layoutKey);
  });
});

describe('inferShimmer3Generation', () => {
  const s3 = {
    hardwareVersion: 3,
    firmwareId: 3,
    firmwareVersion: { major: 0, minor: 16, internal: 11 },
  };

  it('hardware id 10 → shimmer3r', () => {
    expect(inferShimmer3Generation(CTX.shimmer3R)).toBe('shimmer3r');
  });

  it('hardware id 3 with no board info → shimmer3-old-imu (safe default)', () => {
    expect(inferShimmer3Generation(s3)).toBe('shimmer3-old-imu');
  });

  it('base board SR31 rev >= NEW_IMU_EXP_REV.IMU (6) → new IMU', () => {
    expect(inferShimmer3Generation(s3, { boardId: 31, boardRev: 6 })).toBe('shimmer3-new-imu');
    expect(inferShimmer3Generation(s3, { boardId: 31, boardRev: 5 })).toBe('shimmer3-old-imu');
  });

  it('unified expansion board rev >= 3 → new IMU', () => {
    // SR47 ExG-unified, SR48 GSR-unified, SR49 bridge-amp-unified.
    for (const boardId of [47, 48, 49]) {
      expect(inferShimmer3Generation(s3, { boardId, boardRev: 3 })).toBe('shimmer3-new-imu');
      expect(inferShimmer3Generation(s3, { boardId, boardRev: 2 })).toBe('shimmer3-old-imu');
    }
  });

  it('the SRx-x-171 sentinel always means new IMU', () => {
    expect(NEW_IMU_EXP_REV.ANY_EXP_BRD_WITH_SPECIAL_REV).toBe(171);
    expect(inferShimmer3Generation(s3, { boardId: 14, boardRev: 171 })).toBe('shimmer3-new-imu');
  });

  it('an unknown hardware id falls back to shimmer3-old-imu', () => {
    expect(
      inferShimmer3Generation({ ...s3, hardwareVersion: 99 }, { boardId: 31, boardRev: 9 }),
    ).toBe('shimmer3-old-imu');
  });
});

describe('readInfoMemFieldValue / writeInfoMemFieldValue', () => {
  const ctx = CTX.shimmer3R;
  const layout = resolveInfoMemLayout(ctx);

  it('reads every kind out of the full-field fixture', () => {
    const img = fullFieldInfoMem();
    expect(readInfoMemFieldValue(img, field('samplingRate'), layout)).toBe(32); // u16le divider
    expect(readInfoMemFieldValue(img, field('wrAccelRate.lis2dw12'), layout)).toBe(9); // bit
    expect(readInfoMemFieldValue(img, field('imuRate.lsm6dsv'), layout)).toBe(7); // u8
    expect(readInfoMemFieldValue(img, field('estimatedExpLength'), layout)).toBe(0x0102); // u16be
    expect(readInfoMemFieldValue(img, field('configTime'), layout)).toBe(0x5f0a0b0c); // u32be
    expect(readInfoMemFieldValue(img, field('deviceName'), layout)).toBe('SHIM3R'); // ascii12
    expect(readInfoMemFieldValue(img, field('calib.gyro'), layout)).toEqual(img.subarray(55, 76));
    expect(readInfoMemFieldValue(img, field('syncNodes'), layout)).toEqual([
      'A1A2A3A4A5A6',
      'B1B2B3B4B5B6',
      'C1C2C3C4C5C6',
    ]);
  });

  it('round-trips every field kind through write → read', () => {
    const cases: ReadonlyArray<[string, number | string | Uint8Array | string[]]> = [
      ['samplingRate', 64],
      ['wrAccelRange', 3],
      ['wrAccelHrm', 1],
      ['imuRate.lsm6dsv', 12],
      ['altMagRate.lis3mdl', 0x3a],
      ['estimatedExpLength', 0xbeef],
      ['configTime', 0x7fabcdef],
      ['deviceName', 'NODE-07'],
      ['calib.wrAccel', new Uint8Array(21).fill(0x2b)],
      ['syncNodes', ['0011223344FF', 'AABBCCDDEEFF']],
    ];
    for (const [key, value] of cases) {
      const bytes = new Uint8Array(INFOMEM_SIZE);
      const f = field(key);
      writeInfoMemFieldValue(bytes, f, layout, value);
      expect(readInfoMemFieldValue(bytes, f, layout), key).toEqual(value);
    }
  });

  it('a bit write preserves the other bits of its byte', () => {
    const bytes = new Uint8Array(INFOMEM_SIZE);
    bytes[layout.idxConfigSetupByte0] = 0xff;
    writeInfoMemFieldValue(bytes, field('wrAccelRange'), layout, 0);
    // Only bits 2-3 cleared.
    expect(bytes[layout.idxConfigSetupByte0]).toBe(0xff & ~0b0000_1100);
  });

  it('a mac6[] write pads unused slots with 0xFF', () => {
    const bytes = new Uint8Array(INFOMEM_SIZE);
    writeInfoMemFieldValue(bytes, field('syncNodes'), layout, ['0123456789AB']);
    for (let i = 6; i < 21 * 6; i++) expect(bytes[layout.idxNode0 + i]).toBe(0xff);
  });

  it('schema writes agree with generateInfoMem for the same field', () => {
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, ctx);
    const viaCodec = generateInfoMem({ ...cfg, imu: { ...cfg.imu, wrAccelRange: 1 } }, ctx, {
      base: img,
    });
    const viaSchema = new Uint8Array(img);
    writeInfoMemFieldValue(viaSchema, field('wrAccelRange'), layout, 1);
    expect(Array.from(viaSchema)).toEqual(Array.from(viaCodec));
  });

  it('a schema edit of an unrelated field leaves the calibration blocks byte-identical', () => {
    const img = fullFieldInfoMem();
    const bytes = new Uint8Array(img);
    writeInfoMemFieldValue(bytes, field('trialName'), layout, 'RENAMED');
    expect(Array.from(bytes.subarray(34, 118))).toEqual(Array.from(img.subarray(34, 118)));
    expect(Array.from(bytes.subarray(133, 175))).toEqual(Array.from(img.subarray(133, 175)));
  });

  it('resolveFieldIndex reflects the firmware-conditional layout', () => {
    const legacy = resolveInfoMemLayout(CTX.relocatedSdlog);
    // Branch 1 not taken below LogAndStream 0.3.4 / SDLog 0.8.42 — but SDLog
    // 0.8.68 DOES take it, so ConfigSetupByte5 is 131 here.
    expect(resolveFieldIndex(field('altMagRate.lis3mdl'), legacy)).toBe(131);
    const btstream = resolveInfoMemLayout({
      hardwareVersion: 3,
      firmwareId: 1,
      firmwareVersion: { major: 0, minor: 5, internal: 0 },
    });
    expect(resolveFieldIndex(field('altMagRate.lis3mdl'), btstream)).toBe(129);
  });
});

describe('schema composite fields agree with the codec', () => {
  const ctx = CTX.shimmer3R;
  const layout = resolveInfoMemLayout(ctx);

  it('reads the FULL gyro range (LSB pair + ConfigSetupByte4 bit 2)', () => {
    const img = fullFieldInfoMem();
    expect(readInfoMemFieldValue(img, field('gyroRange.lsm6dsv'), layout)).toBe(5);
    expect(parseInfoMem(img, ctx).imu.gyroRange).toBe(5);
  });

  it('reads the FULL pressure oversampling (LSB pair + ConfigSetupByte4 bit 0)', () => {
    const img = fullFieldInfoMem();
    expect(readInfoMemFieldValue(img, field('pressureOversampling.bmp390_581'), layout)).toBe(5);
    expect(parseInfoMem(img, ctx).imu.pressureOversampling).toBe(5);
  });

  it('a composite write produces the same bytes as generateInfoMem', () => {
    for (const [key, configPatch] of [
      ['gyroRange.lsm6dsv', 'gyroRange'],
      ['pressureOversampling.bmp390_581', 'pressureOversampling'],
    ] as const) {
      for (const value of [0, 3, 5, 7]) {
        const img = fullFieldInfoMem();
        const cfg = parseInfoMem(img, ctx);
        const viaCodec = generateInfoMem(
          { ...cfg, imu: { ...cfg.imu, [configPatch]: value } },
          ctx,
          { base: img },
        );
        const viaSchema = new Uint8Array(img);
        writeInfoMemFieldValue(viaSchema, field(key), layout, value);
        expect(Array.from(viaSchema), `${key} = ${value}`).toEqual(Array.from(viaCodec));
        expect(readInfoMemFieldValue(viaSchema, field(key), layout)).toBe(value);
      }
    }
  });
});

describe('every schema field writes ONLY into its own declared bytes', () => {
  /** Bytes a field owns: its own span plus, for composites, the MSB byte. */
  function ownedBytes(f: InfoMemFieldDefinition, layout: ReturnType<typeof resolveInfoMemLayout>) {
    const idx = resolveFieldIndex(f, layout);
    const spans: number[] = [];
    const width =
      f.kind === 'u16le' || f.kind === 'u16be'
        ? 2
        : f.kind === 'u32be'
          ? 4
          : f.kind === 'ascii12'
            ? 12
            : f.kind === 'bytes21'
              ? 21
              : f.kind === 'mac6[]'
                ? 21 * 6
                : 1;
    for (let i = 0; i < width; i++) spans.push(idx + i);
    if (f.msbLayoutKey !== undefined)
      spans.push(resolveFieldIndex({ ...f, layoutKey: f.msbLayoutKey }, layout));
    return new Set(spans);
  }

  /** A non-default value for each kind, guaranteed to change a zeroed image. */
  function probeValue(f: InfoMemFieldDefinition): number | string | Uint8Array | string[] {
    switch (f.kind) {
      case 'bit': {
        const bits = (f.width ?? 1) + (f.msbLayoutKey ? (f.msbWidth ?? 1) : 0);
        return (1 << bits) - 1;
      }
      case 'u8':
        return 0xa5;
      case 'u16le':
      case 'u16be':
        return 0xbeef;
      case 'u32be':
        return 0x12345678;
      case 'ascii12':
        return 'PROBE';
      case 'bytes21':
        return new Uint8Array(21).fill(0x3c);
      case 'mac6[]':
        return ['00112233445A'];
    }
  }

  for (const ctx of [CTX.modernShimmer3, CTX.shimmer3R] as const) {
    const layout = resolveInfoMemLayout(ctx);
    const generation: Shimmer3Generation = layout.isShimmer3R ? 'shimmer3r' : 'shimmer3-old-imu';

    it(`${generation}: no field touches a byte it does not declare, and the value reads back`, () => {
      for (const f of infoMemFieldsFor(generation)) {
        const bytes = new Uint8Array(INFOMEM_SIZE);
        const value = probeValue(f);
        writeInfoMemFieldValue(bytes, f, layout, value);
        const owned = ownedBytes(f, layout);
        for (let i = 0; i < INFOMEM_SIZE; i++) {
          if (bytes[i] !== 0 && !owned.has(i)) {
            throw new Error(
              `${f.key} wrote byte ${i} (0x${bytes[i].toString(16)}) it does not own`,
            );
          }
        }
        expect(readInfoMemFieldValue(bytes, f, layout), f.key).toEqual(value);
      }
    });
  }
});
