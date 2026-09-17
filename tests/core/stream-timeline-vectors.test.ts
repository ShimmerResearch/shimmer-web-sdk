import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  INVALID_ZERO_WINDOW_TICKS,
  MAX_WINDOW_DIVISOR,
  REORDER_PERIODS,
  StreamTimeline,
  TICKS_PER_SECOND,
  reorderWindowTicks,
  type TimestampBits,
} from '../../src/core/StreamTimeline.js';

/**
 * The timestamp-unwrap rule, run against the vectors every Shimmer host API is
 * checked against.
 *
 * The file is specified and generated in the firmware repository —
 * `log-and-stream-common`, `Test/conformance/timestamp_unwrap.json`, beside the
 * prose it encodes and a reference implementation that regenerates and
 * re-checks it in CI. The copy here is byte-identical: git blob
 * `de91de25accc7c74c0422f7e279a535da92579d9` in both repositories, which is
 * what `git hash-object` on either file prints. Every other Shimmer host API
 * runs the same file.
 *
 * Why go to that trouble for what looks like arithmetic: five implementations
 * of one wire format drifted apart once already, and the same unwrap defect sat
 * in all five for years — each reviewed on its own, against prose, by people
 * who had no way to run the others. A shared file turns "these should agree"
 * into something a suite fails on.
 */

interface Vector {
  id: string;
  description: string;
  timestampBits: number;
  modulo: number;
  reorderWindowTicks: number;
  raw: number[];
  expectedUnwrapped: number[];
  expectedRejected: boolean[];
  expectedFinalCycle: number;
}

interface DerivationCase {
  samplingRateHz: number | null;
  timestampBits: number;
  expectedReorderWindowTicks: number;
  tolerance: number;
}

interface VectorFile {
  schemaVersion: number;
  revision: number;
  spec: string;
  ticksPerSecond: number;
  invalidZeroWindowTicks: number;
  reorderPeriods: number;
  maxWindowDivisor: number;
  windowDerivation: { rule: string; cases: DerivationCase[] };
  vectors: Vector[];
}

const vectorPath = fileURLToPath(new URL('../fixtures/timestamp_unwrap.json', import.meta.url));
const doc = JSON.parse(readFileSync(vectorPath, 'utf8')) as VectorFile;

/**
 * Every vector id, written out.
 *
 * A vector that stops being run is a vector that stops protecting anything, and
 * nothing else here would notice: a loop over whatever the file happens to
 * contain passes just as happily over a shorter file. Updating this list is the
 * moment to ask what changed upstream.
 */
const EXPECTED_IDS = [
  'monotonic-24bit',
  'wrap-24bit',
  'wrap-lands-on-zero-24bit',
  'invalid-zero-signature-24bit',
  'invalid-zero-no-cascade-24bit',
  'first-sample-zero-24bit',
  'wrap-16bit',
  'zero-on-16bit-is-a-wrap',
  'backward-step-outside-window-is-a-wrap-24bit',
  'duplicate-24bit',
  'reorder-one-period-24bit',
  'reorder-one-period-16bit',
  'reorder-across-wrap-boundary-24bit',
  'wrap-after-heavy-loss-24bit',
  'wrap-after-heavy-loss-16bit',
  'wrap-spanning-dropout-1p8s-16bit',
  'wrap-spanning-dropout-152s-24bit',
  'rate-unknown-backward-step-is-a-wrap-24bit',
  'rate-unknown-zero-still-rejected-24bit',
  'zero-within-window-of-origin-24bit',
  'zero-within-window-after-wrap-24bit',
  'reorder-window-boundary-inclusive-24bit',
  'reorder-window-boundary-exclusive-24bit',
  'low-rate-clamp-16bit',
  'high-rate-reorder-24bit',
  'reorder-beyond-eight-periods-is-a-wrap-24bit',
  'reorder-onto-origin-then-earlier-packet-24bit',
];

describe('shared timestamp-unwrap vectors', () => {
  it('is the revision this suite was written against', () => {
    // A bumped revision means the rule moved. Read the upstream change before
    // touching anything here.
    expect(doc.schemaVersion).toBe(1);
    expect(doc.revision).toBe(1);
  });

  it('agrees with this SDK on the constants the rule is built from', () => {
    expect(doc.ticksPerSecond).toBe(TICKS_PER_SECOND);
    expect(doc.invalidZeroWindowTicks).toBe(INVALID_ZERO_WINDOW_TICKS);
    expect(doc.reorderPeriods).toBe(REORDER_PERIODS);
    expect(doc.maxWindowDivisor).toBe(MAX_WINDOW_DIVISOR);
  });

  it('runs every vector in the file', () => {
    expect(doc.vectors.map((v) => v.id)).toEqual(EXPECTED_IDS);
  });

  it.each(doc.vectors.map((v) => [v.id, v] as const))('%s', (_id, vector) => {
    /* The window comes from the vector, not from a rate: a rate is a floating
       divide away from a window, and the point of the file is that four
       implementations classify the same sequence identically. The derivation
       is checked separately below. */
    const t = new StreamTimeline({
      timestampBits: vector.timestampBits as TimestampBits,
      reorderWindowTicks: vector.reorderWindowTicks,
    });
    expect(t.reorderWindowTicks).toBe(vector.reorderWindowTicks);

    // No host clock: the missed-wrap recovery is a live-link extra this SDK has
    // and the shared rule does not, and the vectors are the shared rule.
    const stamps = vector.raw.map((raw) => t.stamp(raw));

    expect(
      stamps.map((s) => s.unwrappedTicks),
      `${vector.id}: ${vector.description}`,
    ).toEqual(vector.expectedUnwrapped);
    expect(
      stamps.map((s) => s.invalid),
      `${vector.id}: rejected`,
    ).toEqual(vector.expectedRejected);

    const finalUnwrapped = stamps[stamps.length - 1]!.unwrappedTicks;
    expect(Math.floor(finalUnwrapped / vector.modulo), `${vector.id}: final cycle`).toBe(
      vector.expectedFinalCycle,
    );
  });

  it.each(
    doc.windowDerivation.cases.map(
      (c) => [`${String(c.samplingRateHz)} Hz at ${c.timestampBits} bits`, c] as const,
    ),
  )('derives the window for %s', (_label, c) => {
    const modulo = 2 ** c.timestampBits;
    const got = reorderWindowTicks(c.samplingRateHz, modulo);
    if (c.tolerance === 0) {
      expect(got).toBe(c.expectedReorderWindowTicks);
    } else {
      expect(Math.abs(got - c.expectedReorderWindowTicks)).toBeLessThanOrEqual(c.tolerance);
    }
  });

  it('never turns an unusable rate into an infinite window', () => {
    /* The derivation cases above cover 0, null and a negative rate. This is the
       one the file cannot express in JSON, and it is the one that bites: in a
       language where 32768 / 0 is Infinity rather than an error, a rate that
       happens to read zero produces a window wider than the modulo, every
       backward step becomes a reorder, and the unwrap silently stops counting
       wraps — the original bug, restored, with no symptom until a recording is
       512 s short. */
    expect(reorderWindowTicks(Number.POSITIVE_INFINITY, 2 ** 24)).toBe(0);
    expect(reorderWindowTicks(Number.NaN, 2 ** 24)).toBe(0);
    expect(reorderWindowTicks(undefined, 2 ** 24)).toBe(0);
  });
});
