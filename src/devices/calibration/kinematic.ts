/**
 * Kinematic (accel/gyro/mag) calibration math and the 21-byte calibration
 * parameter block codec.
 *
 * Pure, dependency-free port of the Shimmer Java driver:
 *   com.shimmerresearch.driver.calibration.CalibDetailsKinematic
 *     (parseCalParamByteArray / generateCalParamByteArray / scale factors)
 *   com.shimmerresearch.driver.calibration.UtilCalibration
 *     (calibrateInertialSensorData / matrixInverse3x3 — the efficient method)
 *
 * Calibration equation (Ferraris, Grimaldi & Parvis 1995), UtilCalibration §14-23:
 *
 *     C = R⁻¹ · K⁻¹ · (U − B)
 *
 * where C = calibrated vector, U = uncalibrated (raw) vector, B = offset,
 * R = alignment matrix, K = diagonal sensitivity matrix. The driver's
 * "efficient method" precomputes M = inv(R)·inv(K) once per calibration set and
 * then evaluates C = M · (U − B) per sample — this module does the same.
 */

/** A parsed/instantiated kinematic calibration set with precomputed matrix M. */
export interface KinematicCalibration {
  /** Offset vector B (raw ADC counts), per axis. */
  offset: [number, number, number];
  /** Diagonal sensitivity K (counts per physical unit), per axis. */
  sensitivity: [number, number, number];
  /** Alignment matrix R, row-major 3x3 (length 9). */
  alignment: number[];
  /**
   * Precomputed M = inv(R)·inv(K), row-major 3x3 (length 9). Applied as
   * C = M·(U − B) by {@link calibrateVector3}.
   */
  m: number[];
}

/**
 * Invert a 3x3 matrix (row-major, length 9) via the adjugate/determinant.
 * Ported verbatim from UtilCalibration.matrixInverse3x3 (:133-162). Returns
 * `null` when the matrix is singular (determinant 0).
 */
export function matrixInverse3x3(m: readonly number[]): number[] | null {
  const a = m[0],
    b = m[1],
    c = m[2],
    d = m[3],
    e = m[4],
    f = m[5],
    g = m[6],
    h = m[7],
    i = m[8];
  const det = a * e * i + b * f * g + c * d * h - c * e * g - b * d * i - a * f * h;
  if (det === 0) return null;
  const inv = 1 / det;
  return [
    inv * (e * i - f * h),
    inv * (c * h - b * i),
    inv * (b * f - c * e),
    inv * (f * g - d * i),
    inv * (a * i - c * g),
    inv * (c * d - a * f),
    inv * (d * h - e * g),
    inv * (g * b - a * h),
    inv * (a * e - b * d),
  ];
}

/** Multiply two 3x3 row-major matrices (length 9 each). */
export function matrixMultiply3x3(x: readonly number[], y: readonly number[]): number[] {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let col = 0; col < 3; col++) {
      out[r * 3 + col] =
        x[r * 3 + 0] * y[0 * 3 + col] +
        x[r * 3 + 1] * y[1 * 3 + col] +
        x[r * 3 + 2] * y[2 * 3 + col];
    }
  }
  return out;
}

/**
 * Build a {@link KinematicCalibration} from offset/sensitivity/alignment,
 * precomputing M = inv(alignment)·inv(diag(sensitivity)) exactly as the Java
 * efficient path does (UtilCalibration.calibrateInertialSensorData :78 with
 * CalibArraysKinematic's cached matrixMultiplication(inv(AM), inv(SM))).
 *
 * A singular alignment or a zero sensitivity axis falls back to an identity M
 * component so calibration never throws — matching the driver's tolerance of a
 * degenerate default (it would emit NaN there rather than crash).
 */
export function makeKinematicCalibration(
  offset: readonly [number, number, number],
  sensitivity: readonly [number, number, number],
  alignment: readonly number[],
): KinematicCalibration {
  const sm = [sensitivity[0], 0, 0, 0, sensitivity[1], 0, 0, 0, sensitivity[2]];
  const invA = matrixInverse3x3(alignment) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const invS = matrixInverse3x3(sm) ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const m = matrixMultiply3x3(invA, invS);
  return {
    offset: [offset[0], offset[1], offset[2]],
    sensitivity: [sensitivity[0], sensitivity[1], sensitivity[2]],
    alignment: [...alignment],
    m,
  };
}

/**
 * Apply a calibration set to one raw tri-axial sample:
 *
 *     C = M · (U − B)
 *
 * with M = inv(R)·inv(K) precomputed in {@link KinematicCalibration.m}.
 */
export function calibrateVector3(
  raw: readonly [number, number, number],
  cal: KinematicCalibration,
): [number, number, number] {
  const d0 = raw[0] - cal.offset[0];
  const d1 = raw[1] - cal.offset[1];
  const d2 = raw[2] - cal.offset[2];
  const m = cal.m;
  return [
    m[0] * d0 + m[1] * d1 + m[2] * d2,
    m[3] * d0 + m[4] * d1 + m[5] * d2,
    m[6] * d0 + m[7] * d1 + m[8] * d2,
  ];
}

/** Options for {@link parseKinematicCalibBlock}. */
export interface ParseKinematicOptions {
  /**
   * Sensitivity scale factor (CALIBRATION_SCALE_FACTOR). The stored sensitivity
   * i16s are divided by this. 100 for gyro (CalibDetailsKinematic gyro sets
   * mSensitivityScaleFactor = ONE_HUNDRED), 1 for accel/mag. Alignment is always
   * divided by 100; offset is never scaled.
   */
  sensitivityScale?: number;
}

const i16be = (b: Uint8Array, o: number): number => {
  const v = ((b[o] << 8) | b[o + 1]) & 0xffff;
  return v >= 0x8000 ? v - 0x10000 : v;
};

const i8 = (v: number): number => (v >= 0x80 ? v - 0x100 : v);

const isAll = (b: Uint8Array, byte: number): boolean => {
  for (let i = 0; i < b.length; i++) if (b[i] !== byte) return false;
  return true;
};

/**
 * Parse a 21-byte kinematic calibration parameter block.
 *
 * Layout (CalibDetailsKinematic.parseCalParamByteArray :250-280, decoded with
 * UtilParseData.formatDataPacketReverse which is BIG-ENDIAN):
 *   bytes 0..5   : 3 × i16 big-endian offset  (x, y, z)
 *   bytes 6..11  : 3 × i16 big-endian sensitivity (x, y, z), ÷ sensitivityScale
 *   bytes 12..20 : 9 × i8 alignment, row-major, ÷ 100
 *
 * An all-0xFF or all-0x00 block means "no calibration stored"
 * (UtilShimmer.isAllFF / isAllZeros) and yields `null` so the caller keeps its
 * default.
 */
export function parseKinematicCalibBlock(
  bytes: Uint8Array,
  opts: ParseKinematicOptions = {},
): KinematicCalibration | null {
  if (bytes.length < 21) return null;
  if (isAll(bytes, 0xff) || isAll(bytes, 0x00)) return null;
  const sensScale = opts.sensitivityScale ?? 1;

  const offset: [number, number, number] = [i16be(bytes, 0), i16be(bytes, 2), i16be(bytes, 4)];
  const sensitivity: [number, number, number] = [
    i16be(bytes, 6) / sensScale,
    i16be(bytes, 8) / sensScale,
    i16be(bytes, 10) / sensScale,
  ];
  const alignment = new Array<number>(9);
  for (let k = 0; k < 9; k++) alignment[k] = i8(bytes[12 + k]) / 100;

  return makeKinematicCalibration(offset, sensitivity, alignment);
}

/**
 * Serialize offset/sensitivity/alignment back into a 21-byte block, inverse of
 * {@link parseKinematicCalibBlock}. Ported from
 * CalibDetailsKinematic.generateCalParamByteArray (:292-327): sensitivity is
 * rounded after ×sensitivityScale, alignment rounded after ×100, offset stored
 * as-is; all as big-endian i16 (offset, sensitivity) and i8 (alignment).
 */
export function generateKinematicCalibBlock(
  offset: readonly [number, number, number],
  sensitivity: readonly [number, number, number],
  alignment: readonly number[],
  opts: ParseKinematicOptions = {},
): Uint8Array {
  const sensScale = opts.sensitivityScale ?? 1;
  const out = new Uint8Array(21);
  for (let i = 0; i < 3; i++) {
    const v = Math.round(offset[i]) & 0xffff;
    out[i * 2] = (v >> 8) & 0xff;
    out[i * 2 + 1] = v & 0xff;
  }
  for (let i = 0; i < 3; i++) {
    const v = Math.round(sensitivity[i] * sensScale) & 0xffff;
    out[6 + i * 2] = (v >> 8) & 0xff;
    out[6 + i * 2 + 1] = v & 0xff;
  }
  for (let k = 0; k < 9; k++) {
    out[12 + k] = Math.round(alignment[k] * 100) & 0xff;
  }
  return out;
}
