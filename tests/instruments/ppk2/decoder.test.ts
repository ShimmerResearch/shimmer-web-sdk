import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Ppk2SampleDecoder,
  DEFAULT_PPK2_MODIFIERS,
  RunningStats,
  MinMaxDownsampler,
  type Ppk2Modifiers,
} from '../../../src/instruments/ppk2/ppk2Codec.js';

interface DecodeVector {
  name: string;
  vddMv: number;
  modifiers: Ppk2Modifiers;
  rawBase64: string;
  expectedMicroAmps: number[];
  expectedLogic: number[];
}

const fixture: { decodeVectors: DecodeVector[] } = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'ppk2-fixtures.json'), 'utf-8'),
);

function rawBytes(v: DecodeVector): Uint8Array {
  return Uint8Array.from(Buffer.from(v.rawBase64, 'base64'));
}

function feedInChunks(decoder: Ppk2SampleDecoder, raw: Uint8Array, chunkSize: number): number[] {
  const out: number[] = [];
  for (let off = 0; off < raw.length; off += chunkSize) {
    const batch = decoder.feed(raw.subarray(off, Math.min(off + chunkSize, raw.length)));
    out.push(...batch.microAmps);
  }
  return out;
}

function expectClose(actual: number[], expected: number[], label: string): void {
  expect(actual.length, label).toBe(expected.length);
  for (let i = 0; i < expected.length; i++) {
    const tol = Math.max(1e-9, Math.abs(expected[i]) * 1e-12);
    expect(Math.abs(actual[i] - expected[i]), `${label}[${i}]`).toBeLessThanOrEqual(tol);
  }
}

describe('Ppk2SampleDecoder vs Python reference fixtures', () => {
  for (const vector of fixture.decodeVectors) {
    it(`decodes "${vector.name}" identically to ppk2_api`, () => {
      const decoder = new Ppk2SampleDecoder(vector.modifiers, vector.vddMv);
      const batch = decoder.feed(rawBytes(vector));
      expectClose(Array.from(batch.microAmps), vector.expectedMicroAmps, vector.name);
      expect(Array.from(batch.logic)).toEqual(vector.expectedLogic);
    });
  }

  it('is invariant to how the stream is split into chunks', () => {
    const vector = fixture.decodeVectors.find((v) => v.name === 'calibrated_range_transitions')!;
    const raw = rawBytes(vector);
    for (const chunkSize of [1, 3, 4, 5, 7, 4096]) {
      const decoder = new Ppk2SampleDecoder(vector.modifiers, vector.vddMv);
      const out = feedInChunks(decoder, raw, chunkSize);
      expectClose(out, vector.expectedMicroAmps, `chunkSize=${chunkSize}`);
    }
  });

  it('reset() clears filter and remainder state (same input twice, same output)', () => {
    const vector = fixture.decodeVectors.find((v) => v.name === 'calibrated_range_transitions')!;
    const raw = rawBytes(vector);
    const decoder = new Ppk2SampleDecoder(vector.modifiers, vector.vddMv);

    // Leave the decoder mid-word and with filter state, then reset.
    decoder.feed(raw.subarray(0, 13));
    decoder.reset();

    const out = Array.from(decoder.feed(raw).microAmps);
    expectClose(out, vector.expectedMicroAmps, 'after reset');
  });

  it('holds back a trailing partial word until completed', () => {
    const decoder = new Ppk2SampleDecoder(DEFAULT_PPK2_MODIFIERS, 3700);
    const word = new Uint8Array([0x10, 0x80, 0x00, 0x00]); // adc, range 2
    expect(decoder.feed(word.subarray(0, 3)).microAmps.length).toBe(0);
    const batch = decoder.feed(word.subarray(3));
    expect(batch.microAmps.length).toBe(1);
  });
});

describe('RunningStats', () => {
  it('tracks count/mean/min/max incrementally', () => {
    const stats = new RunningStats();
    stats.add(Float64Array.from([1, 2, 3]));
    stats.add(Float64Array.from([4]));
    expect(stats.count).toBe(4);
    expect(stats.mean).toBeCloseTo(2.5, 12);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(4);
    stats.reset();
    expect(stats.count).toBe(0);
    expect(Number.isNaN(stats.mean)).toBe(true);
  });
});

describe('MinMaxDownsampler', () => {
  it('bins min/max/mean and excludes the partial bin', () => {
    const ds = new MinMaxDownsampler(4);
    ds.push(Float64Array.from([1, 5, 3, 3, 10, 10, 10]));
    expect(ds.binCount).toBe(1);
    expect(ds.snapshot()).toEqual([{ min: 1, max: 5, mean: 3 }]);
    expect(ds.totalSamples).toBe(7);
    ds.push(Float64Array.from([10]));
    expect(ds.snapshot()).toEqual([
      { min: 1, max: 5, mean: 3 },
      { min: 10, max: 10, mean: 10 },
    ]);
  });

  it('acts as a ring buffer once maxBins is reached', () => {
    const ds = new MinMaxDownsampler(1, 3);
    ds.push(Float64Array.from([1, 2, 3, 4, 5]));
    expect(ds.binCount).toBe(3);
    expect(ds.snapshot().map((b) => b.mean)).toEqual([3, 4, 5]);
  });
});
