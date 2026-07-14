/**
 * Orientation estimation (IMU sensor fusion) for streamed accel/gyro/mag data.
 *
 * Device-agnostic: works on any calibrated sample stream in physical units
 * (accel in any consistent unit — it is normalised; gyro in deg/s; mag in µT).
 * For Verisense this is the `cal` triplets of `LSM6DSVSample` / `LSM6DS3Sample`
 * / `LIS2DW12Sample`, which per-device calibration (or the seeded defaults)
 * rotates into the common ASM body frame: +X along the strap, +Y out of the
 * device face, +Z toward the hand.
 *
 * Building blocks:
 * - {@link MadgwickAhrs} — the fusion filter (MARG when mag is supplied,
 *   IMU-only otherwise), quaternion state.
 * - {@link MagHardIronEstimator} — continuous min/max hard-iron offset
 *   estimation so an uncalibrated-environment magnetometer still yields a
 *   stable yaw once the device has been rotated through enough of the field.
 * - {@link OrientationEstimator} — the consumer-facing wrapper: feed it
 *   timestamped samples as they arrive (accel / gyro / mag in any mix), it
 *   picks the fusion mode (MARG / IMU / accel-only tilt), derives `dt` from
 *   sample timestamps, and exposes the orientation quaternion, Euler angles
 *   and a "set level" zeroing reference.
 *
 * Conventions: quaternions are `[w, x, y, z]`, and the filter quaternion maps
 * body-frame vectors into the earth frame ({@link quatRotateVector}); the
 * earth frame is z-up (gravity along −Z, i.e. a static accelerometer measures
 * +1 g along earth +Z). Yaw is relative to magnetic north when a magnetometer
 * is fused, otherwise arbitrary (and drifting, gyro-integration only).
 */

/** Quaternion as `[w, x, y, z]`. */
export type Quaternion = [number, number, number, number];

/** 3-vector as `[x, y, z]`. */
export type Vec3 = [number, number, number];

/** Euler angles in degrees, ZYX (yaw-pitch-roll) intrinsic convention. */
export interface EulerAnglesDeg {
  rollDeg: number;
  pitchDeg: number;
  yawDeg: number;
}

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

/** Hamilton product `a · b`. */
export function quatMultiply(a: Quaternion, b: Quaternion): Quaternion {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
  ];
}

/** Conjugate (inverse for unit quaternions). */
export function quatConjugate(q: Quaternion): Quaternion {
  return [q[0], -q[1], -q[2], -q[3]];
}

/** Normalise to unit length (returns identity for a zero quaternion). */
export function quatNormalize(q: Quaternion): Quaternion {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  if (n === 0) return [1, 0, 0, 0];
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
}

/** Rotate a body-frame vector into the earth frame by unit quaternion `q`. */
export function quatRotateVector(q: Quaternion, v: Vec3): Vec3 {
  const p = quatMultiply(quatMultiply(q, [0, v[0], v[1], v[2]]), quatConjugate(q));
  return [p[1], p[2], p[3]];
}

/** Spherical linear interpolation from `a` to `b` by `t` ∈ [0, 1]. */
export function quatSlerp(a: Quaternion, b: Quaternion, t: number): Quaternion {
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (dot < 0) {
    bb = [-b[0], -b[1], -b[2], -b[3]];
    dot = -dot;
  }
  if (dot > 0.9995) {
    return quatNormalize([
      a[0] + (bb[0] - a[0]) * t,
      a[1] + (bb[1] - a[1]) * t,
      a[2] + (bb[2] - a[2]) * t,
      a[3] + (bb[3] - a[3]) * t,
    ]);
  }
  const th = Math.acos(dot);
  const s = Math.sin(th);
  const ka = Math.sin((1 - t) * th) / s;
  const kb = Math.sin(t * th) / s;
  return [
    a[0] * ka + bb[0] * kb,
    a[1] * ka + bb[1] * kb,
    a[2] * ka + bb[2] * kb,
    a[3] * ka + bb[3] * kb,
  ];
}

/** Quaternion → Euler angles (degrees), ZYX intrinsic yaw/pitch/roll. */
export function quatToEulerDeg(q: Quaternion): EulerAnglesDeg {
  const [w, x, y, z] = q;
  return {
    rollDeg: Math.atan2(2 * (w * x + y * z), 1 - 2 * (x * x + y * y)) * RAD2DEG,
    pitchDeg: Math.asin(Math.max(-1, Math.min(1, 2 * (w * y - z * x)))) * RAD2DEG,
    yawDeg: Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * RAD2DEG,
  };
}

/**
 * Madgwick AHRS fusion filter (gradient-descent orientation from gyro +
 * accel, optionally + mag). Direct port of the reference algorithm.
 *
 * `update()` expects gyro in **rad/s**; accel and mag are normalised
 * internally so any consistent unit works. Pass `mag = null` (or a zero
 * vector) for 6-DoF IMU-only fusion.
 */
export class MadgwickAhrs {
  /** Filter gain: higher converges faster but is noisier. */
  beta: number;

  /** Current orientation quaternion (body → earth, z-up). */
  q: Quaternion = [1, 0, 0, 0];

  constructor(beta = 0.08) {
    this.beta = beta;
  }

  reset(): void {
    this.q = [1, 0, 0, 0];
  }

  /**
   * One fusion step. Gyro in rad/s; accel/mag in any unit (normalised).
   * With `mag` null/zero this falls back to {@link updateImu}; with a zero
   * accel it falls back to pure gyro integration.
   */
  update(gyroRadS: Vec3, accel: Vec3, mag: Vec3 | null, dtSec: number): void {
    if (!mag || (mag[0] === 0 && mag[1] === 0 && mag[2] === 0)) {
      this.updateImu(gyroRadS, accel, dtSec);
      return;
    }
    const [gx, gy, gz] = gyroRadS;
    let [ax, ay, az] = accel;
    let [mx, my, mz] = mag;
    const [q0, q1, q2, q3] = this.q;

    let norm = Math.hypot(ax, ay, az);
    if (norm === 0) {
      this.integrate(gx, gy, gz, 0, 0, 0, 0, dtSec);
      return;
    }
    ax /= norm;
    ay /= norm;
    az /= norm;
    norm = Math.hypot(mx, my, mz);
    if (norm === 0) {
      this.updateImu(gyroRadS, [ax, ay, az], dtSec);
      return;
    }
    mx /= norm;
    my /= norm;
    mz /= norm;

    const _2q0mx = 2 * q0 * mx;
    const _2q0my = 2 * q0 * my;
    const _2q0mz = 2 * q0 * mz;
    const _2q1mx = 2 * q1 * mx;
    const _2q0 = 2 * q0;
    const _2q1 = 2 * q1;
    const _2q2 = 2 * q2;
    const _2q3 = 2 * q3;
    const _2q0q2 = 2 * q0 * q2;
    const _2q2q3 = 2 * q2 * q3;
    const q0q0 = q0 * q0;
    const q0q1 = q0 * q1;
    const q0q2 = q0 * q2;
    const q0q3 = q0 * q3;
    const q1q1 = q1 * q1;
    const q1q2 = q1 * q2;
    const q1q3 = q1 * q3;
    const q2q2 = q2 * q2;
    const q2q3 = q2 * q3;
    const q3q3 = q3 * q3;

    // Reference direction of Earth's magnetic field
    const hx =
      mx * q0q0 -
      _2q0my * q3 +
      _2q0mz * q2 +
      mx * q1q1 +
      _2q1 * my * q2 +
      _2q1 * mz * q3 -
      mx * q2q2 -
      mx * q3q3;
    const hy =
      _2q0mx * q3 +
      my * q0q0 -
      _2q0mz * q1 +
      _2q1mx * q2 -
      my * q1q1 +
      my * q2q2 +
      _2q2 * mz * q3 -
      my * q3q3;
    const _2bx = Math.hypot(hx, hy);
    const _2bz =
      -_2q0mx * q2 +
      _2q0my * q1 +
      mz * q0q0 +
      _2q1mx * q3 -
      mz * q1q1 +
      _2q2 * my * q3 -
      mz * q2q2 +
      mz * q3q3;
    const _4bx = 2 * _2bx;
    const _4bz = 2 * _2bz;

    // Gradient-descent corrective step
    const s0 =
      -_2q2 * (2 * q1q3 - _2q0q2 - ax) +
      _2q1 * (2 * q0q1 + _2q2q3 - ay) -
      _2bz * q2 * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) +
      (-_2bx * q3 + _2bz * q1) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) +
      _2bx * q2 * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    const s1 =
      _2q3 * (2 * q1q3 - _2q0q2 - ax) +
      _2q0 * (2 * q0q1 + _2q2q3 - ay) -
      4 * q1 * (1 - 2 * q1q1 - 2 * q2q2 - az) +
      _2bz * q3 * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) +
      (_2bx * q2 + _2bz * q0) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) +
      (_2bx * q3 - _4bz * q1) * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    const s2 =
      -_2q0 * (2 * q1q3 - _2q0q2 - ax) +
      _2q3 * (2 * q0q1 + _2q2q3 - ay) -
      4 * q2 * (1 - 2 * q1q1 - 2 * q2q2 - az) +
      (-_4bx * q2 - _2bz * q0) * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) +
      (_2bx * q1 + _2bz * q3) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) +
      (_2bx * q0 - _4bz * q2) * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    const s3 =
      _2q1 * (2 * q1q3 - _2q0q2 - ax) +
      _2q2 * (2 * q0q1 + _2q2q3 - ay) +
      (-_4bx * q3 + _2bz * q1) * (_2bx * (0.5 - q2q2 - q3q3) + _2bz * (q1q3 - q0q2) - mx) +
      (-_2bx * q0 + _2bz * q2) * (_2bx * (q1q2 - q0q3) + _2bz * (q0q1 + q2q3) - my) +
      _2bx * q1 * (_2bx * (q0q2 + q1q3) + _2bz * (0.5 - q1q1 - q2q2) - mz);
    norm = Math.hypot(s0, s1, s2, s3) || 1;
    this.integrate(gx, gy, gz, s0 / norm, s1 / norm, s2 / norm, s3 / norm, dtSec);
  }

  /** 6-DoF (gyro + accel) fusion step. Gyro in rad/s. */
  updateImu(gyroRadS: Vec3, accel: Vec3, dtSec: number): void {
    const [gx, gy, gz] = gyroRadS;
    let [ax, ay, az] = accel;
    const [q0, q1, q2, q3] = this.q;

    let norm = Math.hypot(ax, ay, az);
    if (norm === 0) {
      this.integrate(gx, gy, gz, 0, 0, 0, 0, dtSec);
      return;
    }
    ax /= norm;
    ay /= norm;
    az /= norm;

    const _2q0 = 2 * q0;
    const _2q1 = 2 * q1;
    const _2q2 = 2 * q2;
    const _2q3 = 2 * q3;
    const _4q0 = 4 * q0;
    const _4q1 = 4 * q1;
    const _4q2 = 4 * q2;
    const _8q1 = 8 * q1;
    const _8q2 = 8 * q2;
    const q0q0 = q0 * q0;
    const q1q1 = q1 * q1;
    const q2q2 = q2 * q2;
    const q3q3 = q3 * q3;

    const s0 = _4q0 * q2q2 + _2q2 * ax + _4q0 * q1q1 - _2q1 * ay;
    const s1 =
      _4q1 * q3q3 - _2q3 * ax + 4 * q0q0 * q1 - _2q0 * ay - _4q1 + _8q1 * q1q1 + _8q1 * q2q2 + _4q1 * az;
    const s2 =
      4 * q0q0 * q2 + _2q0 * ax + _4q2 * q3q3 - _2q3 * ay - _4q2 + _8q2 * q1q1 + _8q2 * q2q2 + _4q2 * az;
    const s3 = 4 * q1q1 * q3 - _2q1 * ax + 4 * q2q2 * q3 - _2q2 * ay;
    norm = Math.hypot(s0, s1, s2, s3) || 1;
    this.integrate(gx, gy, gz, s0 / norm, s1 / norm, s2 / norm, s3 / norm, dtSec);
  }

  private integrate(
    gx: number,
    gy: number,
    gz: number,
    s0: number,
    s1: number,
    s2: number,
    s3: number,
    dt: number,
  ): void {
    const [q0, q1, q2, q3] = this.q;
    const qDot0 = 0.5 * (-q1 * gx - q2 * gy - q3 * gz) - this.beta * s0;
    const qDot1 = 0.5 * (q0 * gx + q2 * gz - q3 * gy) - this.beta * s1;
    const qDot2 = 0.5 * (q0 * gy - q1 * gz + q3 * gx) - this.beta * s2;
    const qDot3 = 0.5 * (q0 * gz + q1 * gy - q2 * gx) - this.beta * s3;
    this.q = quatNormalize([
      q0 + qDot0 * dt,
      q1 + qDot1 * dt,
      q2 + qDot2 * dt,
      q3 + qDot3 * dt,
    ]);
  }
}

/**
 * Continuous hard-iron (constant offset) magnetometer correction: tracks the
 * per-axis min/max of the field and subtracts the midpoint once enough of the
 * sphere has been observed (`minSpanUt` per axis, default 25 µT). Until then
 * {@link apply} passes values through uncorrected.
 *
 * Complements (does not replace) per-device calibration: it absorbs the local
 * magnetic environment (mounts, desks, enclosure remanence) at runtime.
 */
export class MagHardIronEstimator {
  private min: Vec3 = [Infinity, Infinity, Infinity];
  private max: Vec3 = [-Infinity, -Infinity, -Infinity];

  /** Per-axis field span (µT) required before the correction engages. */
  readonly minSpanUt: number;

  /** True once every axis has seen at least `minSpanUt` of span. */
  ready = false;

  constructor(minSpanUt = 25) {
    this.minSpanUt = minSpanUt;
  }

  feed(m: Vec3): void {
    for (let i = 0; i < 3; i++) {
      if (m[i] < this.min[i]) this.min[i] = m[i];
      if (m[i] > this.max[i]) this.max[i] = m[i];
    }
    this.ready =
      this.max[0] - this.min[0] > this.minSpanUt &&
      this.max[1] - this.min[1] > this.minSpanUt &&
      this.max[2] - this.min[2] > this.minSpanUt;
  }

  /** Offset-corrected copy of `m` when {@link ready}, else `m` unchanged. */
  apply(m: Vec3): Vec3 {
    if (!this.ready) return m;
    return [
      m[0] - (this.max[0] + this.min[0]) / 2,
      m[1] - (this.max[1] + this.min[1]) / 2,
      m[2] - (this.max[2] + this.min[2]) / 2,
    ];
  }

  /** Observed per-axis span so far (µT) — useful for "rotate to calibrate" UI. */
  spanUt(): Vec3 {
    return [
      Math.max(0, this.max[0] - this.min[0]),
      Math.max(0, this.max[1] - this.min[1]),
      Math.max(0, this.max[2] - this.min[2]),
    ];
  }

  reset(): void {
    this.min = [Infinity, Infinity, Infinity];
    this.max = [-Infinity, -Infinity, -Infinity];
    this.ready = false;
  }
}

/**
 * One decoded sample fed to {@link OrientationEstimator.addSample}. Any subset
 * of the three vectors may be present (e.g. the LSM6DSV tagged FIFO delivers
 * exactly one stream per entry; the LSM6DS3 delivers accel+gyro pairs).
 */
export interface OrientationSampleInput {
  /** Accelerometer sample, any consistent unit (normalised internally). */
  accel?: Vec3 | null;
  /** Gyroscope sample in deg/s (the SDK's calibrated unit). */
  gyro?: Vec3 | null;
  /** Magnetometer sample in µT. */
  mag?: Vec3 | null;
  /** Device-clock timestamp in ms (`timestamps.tsMillis`); used to derive dt. */
  tsMillis?: number | null;
}

export interface OrientationEstimatorOptions {
  /** Madgwick filter gain (default 0.08). */
  beta?: number;
  /** Fuse magnetometer samples when available (default true). */
  useMag?: boolean;
  /** Per-axis µT span required to engage hard-iron correction (default 25). */
  magMinSpanUt?: number;
  /** dt used when timestamps are missing or non-increasing (default 1/60 s via 60 Hz). */
  nominalRateHz?: number;
  /** Upper clamp on a single integration step, s (default 0.25 — stream gaps). */
  maxDtSec?: number;
  /** Gyro silence (ms) after which accel-only tilt tracking takes over (default 1500). */
  gyroStaleMs?: number;
}

/** Fusion mode last used by the estimator. */
export type OrientationMode = 'idle' | 'marg' | 'imu' | 'tilt';

/**
 * Streaming orientation estimator: feed decoded, calibrated samples in
 * arrival order and read back the orientation quaternion / Euler angles.
 *
 * - With gyro samples, runs Madgwick fusion — 9-DoF MARG when mag samples are
 *   flowing (and `useMag`), else 6-DoF IMU (yaw drifts).
 * - Accel-only streams (e.g. LIS2DW12, or gyro disabled in the op-config) fall
 *   back to smoothed gravity-tilt tracking (no yaw) once the gyro has been
 *   silent for `gyroStaleMs`.
 * - `dt` comes from consecutive same-stream `tsMillis` deltas, clamped to
 *   `maxDtSec`, falling back to `1/nominalRateHz` when unavailable.
 *
 * {@link setLevel} captures the current pose as the zero reference;
 * {@link levelledQuaternion} / {@link euler} report relative to it.
 */
export class OrientationEstimator {
  readonly filter: MadgwickAhrs;
  readonly magHardIron: MagHardIronEstimator;

  private readonly useMag: boolean;
  private readonly nominalDtSec: number;
  private readonly maxDtSec: number;
  private readonly gyroStaleMs: number;

  private levelRef: Quaternion = [1, 0, 0, 0];
  private latestAccel: Vec3 | null = null;
  private latestMag: Vec3 | null = null;
  private lastGyroTsMs: number | null = null;
  private lastTiltTsMs: number | null = null;
  private smoothedGravity: Vec3 | null = null;

  /** Fusion mode of the most recent step. */
  mode: OrientationMode = 'idle';

  /** Total samples consumed (any stream). */
  sampleCount = 0;

  constructor(options: OrientationEstimatorOptions = {}) {
    this.filter = new MadgwickAhrs(options.beta ?? 0.08);
    this.magHardIron = new MagHardIronEstimator(options.magMinSpanUt ?? 25);
    this.useMag = options.useMag ?? true;
    this.nominalDtSec = 1 / Math.max(1e-3, options.nominalRateHz ?? 60);
    this.maxDtSec = options.maxDtSec ?? 0.25;
    this.gyroStaleMs = options.gyroStaleMs ?? 1500;
  }

  /** Orientation quaternion (body → earth, z-up), without the level reference. */
  get quaternion(): Quaternion {
    return this.filter.q;
  }

  /** Orientation relative to the last {@link setLevel} pose. */
  get levelledQuaternion(): Quaternion {
    return quatMultiply(this.levelRef, this.filter.q);
  }

  /** Euler angles (deg) of {@link levelledQuaternion}. */
  euler(): EulerAnglesDeg {
    return quatToEulerDeg(this.levelledQuaternion);
  }

  /** Capture the current pose as the zero (identity) reference. */
  setLevel(): void {
    this.levelRef = quatConjugate(this.filter.q);
  }

  /** Drop the level reference. */
  clearLevel(): void {
    this.levelRef = [1, 0, 0, 0];
  }

  /** Reset all fusion state (quaternion, hard-iron estimate, caches, level). */
  reset(): void {
    this.filter.reset();
    this.magHardIron.reset();
    this.levelRef = [1, 0, 0, 0];
    this.latestAccel = null;
    this.latestMag = null;
    this.lastGyroTsMs = null;
    this.lastTiltTsMs = null;
    this.smoothedGravity = null;
    this.mode = 'idle';
    this.sampleCount = 0;
  }

  /** Consume one decoded sample (any mix of accel / gyro / mag). */
  addSample(s: OrientationSampleInput): void {
    let counted = false;

    if (s.mag) {
      this.magHardIron.feed(s.mag);
      this.latestMag = this.magHardIron.apply(s.mag);
      counted = true;
    }
    if (s.accel) {
      this.latestAccel = s.accel;
      counted = true;
    }

    if (s.gyro) {
      counted = true;
      const dt = this.dtFrom(s.tsMillis ?? null, this.lastGyroTsMs);
      if (typeof s.tsMillis === 'number') this.lastGyroTsMs = s.tsMillis;
      const accel = s.accel ?? this.latestAccel ?? ([0, 0, 0] as Vec3);
      const mag = this.useMag ? this.latestMag : null;
      const gyroRadS: Vec3 = [s.gyro[0] * DEG2RAD, s.gyro[1] * DEG2RAD, s.gyro[2] * DEG2RAD];
      this.filter.update(gyroRadS, accel, mag, dt);
      this.mode = mag ? 'marg' : 'imu';
    } else if (s.accel && this.gyroIsStale(s.tsMillis ?? null)) {
      // Accel-only stream: track tilt from smoothed gravity (no yaw).
      const dt = this.dtFrom(s.tsMillis ?? null, this.lastTiltTsMs);
      if (typeof s.tsMillis === 'number') this.lastTiltTsMs = s.tsMillis;
      this.tiltFromAccel(s.accel, dt);
      this.mode = 'tilt';
    }

    if (counted) this.sampleCount++;
  }

  private dtFrom(tsMillis: number | null, lastTsMillis: number | null): number {
    if (tsMillis === null || lastTsMillis === null) return this.nominalDtSec;
    const dt = (tsMillis - lastTsMillis) / 1000;
    if (!(dt > 0)) return this.nominalDtSec;
    return Math.min(dt, this.maxDtSec);
  }

  private gyroIsStale(tsMillis: number | null): boolean {
    if (this.lastGyroTsMs === null) return true;
    if (tsMillis === null) return false;
    return tsMillis - this.lastGyroTsMs > this.gyroStaleMs;
  }

  /**
   * Pull the quaternion toward the rotation that maps the measured (smoothed)
   * gravity direction in the body frame onto earth up (+Z).
   */
  private tiltFromAccel(accel: Vec3, dt: number): void {
    this.smoothedGravity = this.smoothedGravity
      ? ([
          this.smoothedGravity[0] * 0.95 + accel[0] * 0.05,
          this.smoothedGravity[1] * 0.95 + accel[1] * 0.05,
          this.smoothedGravity[2] * 0.95 + accel[2] * 0.05,
        ] as Vec3)
      : ([accel[0], accel[1], accel[2]] as Vec3);
    const n = Math.hypot(...this.smoothedGravity) || 1;
    const ux = this.smoothedGravity[0] / n;
    const uy = this.smoothedGravity[1] / n;
    const uz = this.smoothedGravity[2] / n;
    // Quaternion rotating u onto earth up (+Z): axis = u × ẑ, angle = acos(u·ẑ)
    const axis: Vec3 = [uy, -ux, 0];
    const angle = Math.acos(Math.max(-1, Math.min(1, uz)));
    const an = Math.hypot(...axis);
    if (an > 1e-6) {
      const s = Math.sin(angle / 2) / an;
      const target: Quaternion = [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
      this.filter.q = quatSlerp(this.filter.q, target, Math.min(1, dt * 8));
    }
  }
}
