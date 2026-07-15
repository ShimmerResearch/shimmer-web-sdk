import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  convertSourceVoltage,
  clampSourceVoltageMv,
  parsePpk2Metadata,
  DEFAULT_PPK2_MODIFIERS,
} from '../../../src/instruments/ppk2/ppk2Codec.js';

interface Fixture {
  voltageVectors: { mv: number; bytes: [number, number] }[];
  metadata: {
    text: string;
    expected: {
      calibrated: string | null;
      hw: string | null;
      ia: string | null;
      r: number[];
      gs: number[];
      gi: number[];
      o: number[];
      s: number[];
      i: number[];
      ug: number[];
    };
  };
}

// ESM-safe fixture path (no __dirname under "type": "module").
const fixture: Fixture = JSON.parse(
  readFileSync(new URL('fixtures/ppk2-fixtures.json', import.meta.url), 'utf-8'),
);

describe('convertSourceVoltage', () => {
  it('matches the Python reference for every fixture vector (incl. clamps)', () => {
    for (const { mv, bytes } of fixture.voltageVectors) {
      expect(convertSourceVoltage(mv), `mV=${mv}`).toEqual(bytes);
    }
  });

  it('encodes the 800 mV baseline as [3, 32]', () => {
    expect(convertSourceVoltage(800)).toEqual([3, 32]);
  });

  it('clamps out-of-range requests', () => {
    expect(clampSourceVoltageMv(500)).toBe(800);
    expect(clampSourceVoltageMv(6000)).toBe(5000);
    expect(convertSourceVoltage(500)).toEqual(convertSourceVoltage(800));
    expect(convertSourceVoltage(6000)).toEqual(convertSourceVoltage(5000));
  });
});

describe('parsePpk2Metadata', () => {
  it('matches the Python reference parse of a realistic metadata blob', () => {
    const parsed = parsePpk2Metadata(fixture.metadata.text);
    const expected = fixture.metadata.expected;
    expect(parsed.calibrated).toBe(expected.calibrated);
    expect(parsed.hw).toBe(expected.hw);
    expect(parsed.ia).toBe(expected.ia);
    expect(parsed.r).toEqual(expected.r);
    expect(parsed.gs).toEqual(expected.gs);
    expect(parsed.gi).toEqual(expected.gi);
    expect(parsed.o).toEqual(expected.o);
    expect(parsed.s).toEqual(expected.s);
    expect(parsed.i).toEqual(expected.i);
    expect(parsed.ug).toEqual(expected.ug);
  });

  it('ignores an R value of exactly 0 (broken calibration), keeping the default', () => {
    const parsed = parsePpk2Metadata('R2: 0\nEND\n');
    expect(parsed.r[2]).toBe(DEFAULT_PPK2_MODIFIERS.r[2]);
  });

  it('keeps defaults for keys missing from the blob', () => {
    const parsed = parsePpk2Metadata('R0: 999.5\nEND\n');
    expect(parsed.r[0]).toBe(999.5);
    expect(parsed.r[1]).toBe(DEFAULT_PPK2_MODIFIERS.r[1]);
    expect(parsed.gs).toEqual([...DEFAULT_PPK2_MODIFIERS.gs]);
    expect(parsed.calibrated).toBeNull();
  });

  it('ignores unknown keys, malformed lines, and out-of-range indexes', () => {
    const parsed = parsePpk2Metadata(
      'mode: 2\nVDD: 3700\nnoseparator\nR7: 5\nR12: 5\nGSX: 5\nUG1: not-a-number\nEND\n',
    );
    expect(parsed.r).toEqual([...DEFAULT_PPK2_MODIFIERS.r]);
    expect(parsed.ug).toEqual([...DEFAULT_PPK2_MODIFIERS.ug]);
  });
});
