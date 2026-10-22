/**
 * Gyro on-the-fly offset calibration (derived-sensor bit 29).
 *
 * The reference is `tests/fixtures/gyro_on_the_fly_java.json`: raw gyro and
 * calibrated gyro, as IEEE-754 bits, for three recordings. Two are Bluetooth
 * sessions, a Shimmer3R and a Shimmer3, as the Java driver decodes them. The
 * third is the first 200 records of a Shimmer3R SD file, as Consensys stored
 * them. Matching them bit for bit is matching Consensys. Each case is long
 * enough for the window to fill and the offset to be re-estimated many times;
 * the Shimmer3 one starts from a stored offset of zero against a real offset
 * of hundreds of counts, which is where the correction is largest.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DERIVED_GYRO_ON_THE_FLY_CAL,
  GYRO_ON_THE_FLY_THRESHOLD_DPS,
  GyroOnTheFlyCal,
  calibrateVector3,
  commonsMean,
  commonsStandardDeviation,
  gyroOnTheFlyInfo,
  gyroOnTheFlyWindow,
  isGyroOnTheFlyEnabled,
  makeKinematicCalibration,
  applyStreamingCalibration,
  type KinematicCalibration,
} from '../../src/devices/calibration/index.js';
import { ObjectCluster } from '../../src/core/ObjectCluster.js';

interface FixtureCase {
  name: string;
  samplingRateHz: number;
  calibration: { offset: number[]; sensitivity: number[]; alignment: number[] };
  raw: [number, number, number][];
  expectedCalBits: [string, string, string][];
}

const fixture: { cases: FixtureCase[] } = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../fixtures/gyro_on_the_fly_java.json', import.meta.url)),
    'utf8',
  ),
);

const bitsOf = (v: number): string => {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v);
  return dv.getBigUint64(0).toString(16).padStart(16, '0');
};

const baseOf = (c: FixtureCase): KinematicCalibration =>
  makeKinematicCalibration(
    c.calibration.offset as [number, number, number],
    c.calibration.sensitivity as [number, number, number],
    c.calibration.alignment,
  );

/** Index of the first sample whose bits differ from the reference's, or -1. */
function firstMismatch(c: FixtureCase, out: [number, number, number][]): number {
  return out.findIndex((v, i) => v.some((x, a) => bitsOf(x) !== c.expectedCalBits[i][a]));
}

describe('gyro on-the-fly: bit-exact with the Java driver and Consensys', () => {
  it.each(fixture.cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const base = baseOf(c);
    const otf = new GyroOnTheFlyCal();
    otf.setSamplingRate(c.samplingRateHz);
    const out = c.raw.map((raw) => {
      const cal = calibrateVector3(raw, otf.calibrationFor(base));
      otf.update(base, cal, raw);
      return cal;
    });
    expect(firstMismatch(c, out)).toBe(-1);
    // The cases are only a test of the estimator if it actually fired.
    expect(otf.updates).toBeGreaterThan(0);
  });

  it.each(fixture.cases.map((c) => [c.name, c] as const))(
    '%s: without it, the output parts from the reference, and never inside the first window',
    (_name, c) => {
      const base = baseOf(c);
      const out = c.raw.map((raw) => calibrateVector3(raw, base));
      // No estimate can exist before the window is full; after that, the first
      // still window moves the offset (sample 51 in the streams, 141 on SD).
      expect(firstMismatch(c, out)).toBeGreaterThanOrEqual(gyroOnTheFlyWindow(c.samplingRateHz));
    },
  );

  it('through applyStreamingCalibration, as both streaming clients run it', () => {
    const c = fixture.cases.find((k) => k.name === 'shimmer3r_stream')!;
    const base = baseOf(c);
    const otf = new GyroOnTheFlyCal();
    otf.setSamplingRate(c.samplingRateHz);
    const ranges = { lnAccel: 0, wrAccel: 0, gyro: 0, mag: 0, altAccel: 0, altMag: 0 };
    const out = c.raw.map((raw) => {
      const oc = new ObjectCluster('test');
      oc.add('GYRO_X', raw[0], 'no_units', 'raw');
      oc.add('GYRO_Y', raw[1], 'no_units', 'raw');
      oc.add('GYRO_Z', raw[2], 'no_units', 'raw');
      applyStreamingCalibration(oc, {
        family: 'shimmer3r',
        ranges,
        device: { gyro: base },
        gyroOnTheFly: otf,
      });
      return ['GYRO_X', 'GYRO_Y', 'GYRO_Z'].map((n) => oc.get(n, 'cal')!.value) as [
        number,
        number,
        number,
      ];
    });
    expect(firstMismatch(c, out)).toBe(-1);
  });

  it('keeps a frame that failed its link CRC out of the window, as Java discards it', () => {
    const c = fixture.cases.find((k) => k.name === 'shimmer3r_stream')!;
    const base = baseOf(c);
    const ranges = { lnAccel: 0, wrAccel: 0, gyro: 0, mag: 0, altAccel: 0, altMag: 0 };
    const run = (corruptAt: number | null) => {
      const otf = new GyroOnTheFlyCal();
      otf.setSamplingRate(c.samplingRateHz);
      return c.raw.map((raw, i) => {
        const oc = new ObjectCluster('test');
        const bad = i === corruptAt;
        // A corrupted frame: wild values, flagged by the CRC check.
        const v = bad ? [12345, -12345, 999] : raw;
        oc.add('GYRO_X', v[0], 'no_units', 'raw');
        oc.add('GYRO_Y', v[1], 'no_units', 'raw');
        oc.add('GYRO_Z', v[2], 'no_units', 'raw');
        if (bad) oc.crcOk = false;
        applyStreamingCalibration(oc, {
          family: 'shimmer3r',
          ranges,
          device: { gyro: base },
          gyroOnTheFly: otf,
        });
        return bad ? null : oc.get('GYRO_Y', 'cal')!.value;
      });
    };
    // Dropping the frame from the window is the same as it never arriving.
    const clean = run(null).map((v, i) => (i === 40 ? null : v));
    const withBad = run(40);
    const removed = (() => {
      const otf = new GyroOnTheFlyCal();
      otf.setSamplingRate(c.samplingRateHz);
      return c.raw.map((raw, i) => {
        if (i === 40) return null;
        const cal = calibrateVector3(raw, otf.calibrationFor(base));
        otf.update(base, cal, raw);
        return cal[1];
      });
    })();
    expect(withBad).toEqual(removed);
    expect(withBad).not.toEqual(clean);
  });
});

describe('gyro on-the-fly: the pieces', () => {
  it('sizes the window with Java Math.round, so halves round up', () => {
    expect(gyroOnTheFlyWindow(51.2)).toBe(51);
    expect(gyroOnTheFlyWindow(50.5)).toBe(51);
    expect(gyroOnTheFlyWindow(1024)).toBe(1024);
    expect(gyroOnTheFlyWindow(0)).toBe(0);
    expect(gyroOnTheFlyWindow(Number.NaN)).toBe(0);
  });

  it('reads derived-sensor bit 29 from a number or a bigint', () => {
    expect(DERIVED_GYRO_ON_THE_FLY_CAL).toBe(1n << 29n);
    expect(isGyroOnTheFlyEnabled(1 << 29)).toBe(true);
    expect(isGyroOnTheFlyEnabled((1n << 29n) | (1n << 40n))).toBe(true);
    expect(isGyroOnTheFlyEnabled(1 << 28)).toBe(false);
    expect(isGyroOnTheFlyEnabled(0n)).toBe(false);
  });

  it('computes Commons Math 2.2 mean and sample standard deviation', () => {
    expect(commonsMean([1, 2, 3, 4])).toBe(2.5);
    expect(commonsStandardDeviation([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138089935, 9);
    expect(commonsStandardDeviation([5])).toBe(0);
  });

  it('waits for a full window, and for every axis to be still', () => {
    const base = makeKinematicCalibration([0, 0, 0], [1, 1, 1], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const otf = new GyroOnTheFlyCal();
    otf.setSamplingRate(4);
    // Three samples: not yet a window.
    for (let i = 0; i < 3; i++) expect(otf.update(base, [10, 10, 10], [10, 20, 30])).toBeNull();
    expect(otf.calibrationFor(base)).toBe(base);
    // The fourth fills it, and the window is perfectly still.
    expect(otf.update(base, [10, 10, 10], [10, 20, 30])).toEqual([10, 20, 30]);
    expect(otf.calibrationFor(base).offset).toEqual([10, 20, 30]);
    // One axis moving by more than the threshold blocks the next estimate.
    expect(
      otf.update(base, [10, 10, 10 + 4 * GYRO_ON_THE_FLY_THRESHOLD_DPS], [99, 99, 99]),
    ).toBeNull();
    expect(otf.calibrationFor(base).offset).toEqual([10, 20, 30]);
    expect(otf.updates).toBe(1);
  });

  it('keeps an estimate with the calibration it was made against', () => {
    const a = makeKinematicCalibration([0, 0, 0], [1, 1, 1], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const b = makeKinematicCalibration([5, 5, 5], [2, 2, 2], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const otf = new GyroOnTheFlyCal();
    otf.setSamplingRate(1);
    otf.update(a, [0, 0, 0], [1, 2, 3]);
    expect(otf.isActiveFor(a)).toBe(true);
    // Another range's calibration has its own offset until estimated itself.
    expect(otf.calibrationFor(b)).toBe(b);
    expect(gyroOnTheFlyInfo(otf, true, b).active).toBe(false);
    expect(gyroOnTheFlyInfo(otf, true, a)).toEqual({
      enabled: true,
      active: true,
      windowSamples: 1,
      thresholdDps: 1.2,
      updates: 1,
      offset: [1, 2, 3],
    });
    otf.reset();
    expect(otf.calibrationFor(a)).toBe(a);
    expect(gyroOnTheFlyInfo(otf, true, a).updates).toBe(0);
  });

  it('keeps what the window holds when it is resized, oldest first to go', () => {
    const base = makeKinematicCalibration([0, 0, 0], [1, 1, 1], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const otf = new GyroOnTheFlyCal();
    otf.setSamplingRate(3);
    otf.update(base, [0, 0, 0], [100, 100, 100]);
    otf.update(base, [0, 0, 0], [2, 2, 2]);
    // Shrinking to 2 drops the first sample, so the window is already full.
    otf.setSamplingRate(2);
    expect(otf.update(base, [0, 0, 0], [4, 4, 4])).toEqual([3, 3, 3]);
  });

  it('does nothing before a sampling rate is known', () => {
    const base = makeKinematicCalibration([0, 0, 0], [1, 1, 1], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    const otf = new GyroOnTheFlyCal();
    for (let i = 0; i < 10; i++) expect(otf.update(base, [0, 0, 0], [1, 1, 1])).toBeNull();
    expect(otf.windowSamples).toBe(0);
  });
});
