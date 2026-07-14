import { describe, it, expect } from 'vitest';
import {
  MadgwickAhrs,
  MagHardIronEstimator,
  OrientationEstimator,
  quatMultiply,
  quatConjugate,
  quatNormalize,
  quatRotateVector,
  quatSlerp,
  quatToEulerDeg,
  type Quaternion,
  type Vec3,
} from '../../src/core/orientation.js';

const D2R = Math.PI / 180;

/** Unit quaternion for a rotation of `deg` about `axis`. */
function quatFromAxisAngle(axis: Vec3, deg: number): Quaternion {
  const half = (deg * D2R) / 2;
  const n = Math.hypot(...axis) || 1;
  const s = Math.sin(half) / n;
  return [Math.cos(half), axis[0] * s, axis[1] * s, axis[2] * s];
}

/** |dot| similarity between two unit quaternions (1 = same rotation). */
function quatSimilarity(a: Quaternion, b: Quaternion): number {
  return Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
}

describe('quaternion helpers', () => {
  it('multiplies with identity', () => {
    const q = quatNormalize([0.7, 0.1, -0.4, 0.2]);
    const r = quatMultiply(q, [1, 0, 0, 0]);
    expect(quatSimilarity(q, r)).toBeCloseTo(1, 10);
  });

  it('rotates a vector by 90° about Z', () => {
    const q = quatFromAxisAngle([0, 0, 1], 90);
    const v = quatRotateVector(q, [1, 0, 0]);
    expect(v[0]).toBeCloseTo(0, 6);
    expect(v[1]).toBeCloseTo(1, 6);
    expect(v[2]).toBeCloseTo(0, 6);
  });

  it('conjugate inverts a rotation', () => {
    const q = quatFromAxisAngle([1, 2, 0.5], 37);
    const v: Vec3 = [0.3, -1.1, 0.7];
    const back = quatRotateVector(quatConjugate(q), quatRotateVector(q, v));
    expect(back[0]).toBeCloseTo(v[0], 6);
    expect(back[1]).toBeCloseTo(v[1], 6);
    expect(back[2]).toBeCloseTo(v[2], 6);
  });

  it('converts a pure yaw quaternion to Euler angles', () => {
    const e = quatToEulerDeg(quatFromAxisAngle([0, 0, 1], 90));
    expect(e.yawDeg).toBeCloseTo(90, 4);
    expect(e.pitchDeg).toBeCloseTo(0, 4);
    expect(e.rollDeg).toBeCloseTo(0, 4);
  });

  it('slerp hits both endpoints and stays unit-length midway', () => {
    const a = quatFromAxisAngle([0, 0, 1], 0);
    const b = quatFromAxisAngle([0, 0, 1], 120);
    expect(quatSimilarity(quatSlerp(a, b, 0), a)).toBeCloseTo(1, 6);
    expect(quatSimilarity(quatSlerp(a, b, 1), b)).toBeCloseTo(1, 6);
    const mid = quatSlerp(a, b, 0.5);
    expect(Math.hypot(...mid)).toBeCloseTo(1, 6);
    expect(quatSimilarity(mid, quatFromAxisAngle([0, 0, 1], 60))).toBeCloseTo(1, 6);
  });
});

describe('MadgwickAhrs', () => {
  it('stays near identity for a level, static device', () => {
    const f = new MadgwickAhrs();
    for (let i = 0; i < 500; i++) f.updateImu([0, 0, 0], [0, 0, 9.81], 1 / 100);
    expect(quatSimilarity(f.q, [1, 0, 0, 0])).toBeGreaterThan(0.9999);
  });

  it('converges tilt so measured gravity maps onto earth up', () => {
    const f = new MadgwickAhrs(0.3);
    // Gravity measured along body +X (device standing on its -X end).
    for (let i = 0; i < 2000; i++) f.updateImu([0, 0, 0], [9.81, 0, 0], 1 / 100);
    const up = quatRotateVector(f.q, [1, 0, 0]);
    expect(up[2]).toBeGreaterThan(0.999);
  });

  it('tracks a scripted MARG motion (synthesised accel/gyro/mag)', () => {
    const f = new MadgwickAhrs();
    let qTrue: Quaternion = [1, 0, 0, 0];
    const dt = 1 / 60;
    for (let i = 0; i < 60 * 12; i++) {
      const t = i * dt;
      const gyroDps: Vec3 = [
        45 * Math.sin(t * 0.9),
        60 * Math.sin(t * 0.53 + 1),
        35 * Math.sin(t * 0.31 + 3),
      ];
      const dq: Quaternion = [
        1,
        (gyroDps[0] * D2R * dt) / 2,
        (gyroDps[1] * D2R * dt) / 2,
        (gyroDps[2] * D2R * dt) / 2,
      ];
      qTrue = quatNormalize(quatMultiply(qTrue, dq));
      const accel = quatRotateVector(quatConjugate(qTrue), [0, 0, 1]);
      const mag = quatRotateVector(quatConjugate(qTrue), [22, 0, -41]);
      f.update(
        [gyroDps[0] * D2R, gyroDps[1] * D2R, gyroDps[2] * D2R],
        accel,
        mag,
        dt,
      );
    }
    expect(quatSimilarity(f.q, qTrue)).toBeGreaterThan(0.995);
  });

  it('integrates gyro-only when accel is zero', () => {
    const f = new MadgwickAhrs();
    for (let i = 0; i < 100; i++) f.update([0, 0, 90 * D2R], [0, 0, 0], null, 1 / 100);
    expect(quatToEulerDeg(f.q).yawDeg).toBeCloseTo(90, 0);
  });
});

describe('MagHardIronEstimator', () => {
  it('engages after enough span and removes the offset', () => {
    const est = new MagHardIronEstimator(25);
    const bias: Vec3 = [30, -20, 10];
    const r = 40;
    for (let i = 0; i < 72; i++) {
      const a = (i / 36) * Math.PI;
      est.feed([bias[0] + r * Math.cos(a), bias[1] + r * Math.sin(a), bias[2]]); // XY circle
      est.feed([bias[0], bias[1] + r * Math.cos(a), bias[2] + r * Math.sin(a)]); // YZ circle
    }
    expect(est.ready).toBe(true);
    const corrected = est.apply([bias[0] + r, bias[1], bias[2]]);
    expect(corrected[0]).toBeCloseTo(r, 4);
    expect(corrected[1]).toBeCloseTo(0, 4);
    expect(corrected[2]).toBeCloseTo(0, 4);
  });

  it('passes through until ready', () => {
    const est = new MagHardIronEstimator(25);
    est.feed([100, 100, 100]);
    expect(est.ready).toBe(false);
    expect(est.apply([100, 100, 100])).toEqual([100, 100, 100]);
  });
});

describe('OrientationEstimator', () => {
  it('integrates deg/s gyro samples using tsMillis deltas', () => {
    const est = new OrientationEstimator({ nominalRateHz: 100 });
    for (let i = 0; i < 100; i++) {
      est.addSample({ gyro: [0, 0, 90], tsMillis: i * 10 });
    }
    expect(est.euler().yawDeg).toBeCloseTo(90, 0);
    expect(est.mode).toBe('imu');
    expect(est.sampleCount).toBe(100);
  });

  it('holds near identity on an interleaved static accel/gyro stream', () => {
    const est = new OrientationEstimator();
    for (let i = 0; i < 300; i++) {
      const t = i * 10;
      // Tagged-FIFO style: accel and gyro arrive as separate entries.
      est.addSample({ accel: [0, 0, 9.81], tsMillis: t });
      est.addSample({ gyro: [0, 0, 0], tsMillis: t });
    }
    expect(quatSimilarity(est.quaternion, [1, 0, 0, 0])).toBeGreaterThan(0.999);
  });

  it('runs MARG once mag samples flow and reports the mode', () => {
    const est = new OrientationEstimator();
    for (let i = 0; i < 10; i++) {
      const t = i * 10;
      est.addSample({ mag: [20, 5, -40], tsMillis: t });
      est.addSample({ accel: [0, 0, 9.81], tsMillis: t });
      est.addSample({ gyro: [0, 0, 0], tsMillis: t });
    }
    expect(est.mode).toBe('marg');
  });

  it('ignores mag when useMag is false', () => {
    const est = new OrientationEstimator({ useMag: false });
    est.addSample({ mag: [20, 5, -40], tsMillis: 0 });
    est.addSample({ accel: [0, 0, 9.81], tsMillis: 0 });
    est.addSample({ gyro: [0, 0, 0], tsMillis: 0 });
    expect(est.mode).toBe('imu');
  });

  it('falls back to tilt tracking on an accel-only stream', () => {
    const est = new OrientationEstimator();
    // Gravity along body +Y (device lying face-up): accel-only, no gyro ever.
    for (let i = 0; i < 300; i++) {
      est.addSample({ accel: [0, 9.81, 0], tsMillis: i * 10 });
    }
    expect(est.mode).toBe('tilt');
    const up = quatRotateVector(est.quaternion, [0, 1, 0]);
    expect(up[2]).toBeGreaterThan(0.99);
  });

  it('setLevel zeroes the reported orientation', () => {
    const est = new OrientationEstimator();
    for (let i = 0; i < 100; i++) est.addSample({ gyro: [0, 0, 90], tsMillis: i * 10 });
    est.setLevel();
    const e = est.euler();
    expect(Math.abs(e.yawDeg)).toBeLessThan(1e-6);
    expect(quatSimilarity(est.levelledQuaternion, [1, 0, 0, 0])).toBeCloseTo(1, 8);
    est.clearLevel();
    expect(Math.abs(est.euler().yawDeg)).toBeGreaterThan(45);
  });

  it('clamps dt across stream gaps and stays unit-norm', () => {
    const est = new OrientationEstimator({ maxDtSec: 0.25 });
    est.addSample({ gyro: [50, -30, 80], tsMillis: 0 });
    est.addSample({ gyro: [50, -30, 80], tsMillis: 60_000 }); // 60 s gap
    expect(Math.hypot(...est.quaternion)).toBeCloseTo(1, 9);
    // 0.25 s at 80 dps yaw ≈ 20° — a 60 s gap must not integrate 4800°.
    expect(Math.abs(est.euler().yawDeg)).toBeLessThan(45);
  });

  it('reset restores idle state', () => {
    const est = new OrientationEstimator();
    for (let i = 0; i < 50; i++) est.addSample({ gyro: [0, 0, 90], tsMillis: i * 10 });
    est.reset();
    expect(est.mode).toBe('idle');
    expect(est.sampleCount).toBe(0);
    expect(quatSimilarity(est.quaternion, [1, 0, 0, 0])).toBe(1);
  });
});
