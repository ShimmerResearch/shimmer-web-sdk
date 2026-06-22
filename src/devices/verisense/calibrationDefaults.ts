/**
 * Verisense calibration defaults, hardware/firmware gating, and timestamp helpers.
 *
 * The byte-level codec lives in `calibration.ts`; this module is the host-side
 * single source of truth for the *default* calibration (the mirror of the
 * firmware `AsmCalib_seedDefaults`) plus the small amount of domain logic the UI
 * used to carry: which calibration blocks a board has, the minimum firmware that
 * supports `CMD_AR_CFG_CALIB`, and the 8-byte timestamp encode/decode.
 */

import { CalibSensorId, SC_TS_BYTES, type CalibrationSetInput } from './calibration.js';
import { compareVerisenseFirmwareVersion, type VerisenseFirmwareVersion } from './protocolUtils.js';
import {
  isVerisenseSecondGenerationHardware,
  type VerisenseHardwareSensorSupport,
} from './hardwareModels.js';

/** Minimum firmware that implements the `CMD_AR_CFG_CALIB` (0x0D) command. */
export const VERISENSE_CALIBRATION_MIN_FW: VerisenseFirmwareVersion = {
  major: 2,
  minor: 0,
  internal: 4,
};

/** Whether the given firmware version supports the calibration command. */
export function supportsVerisenseCalibration(
  fw: Partial<VerisenseFirmwareVersion> | null | undefined,
): boolean {
  if (!fw) return false;
  return compareVerisenseFirmwareVersion(fw, VERISENSE_CALIBRATION_MIN_FW) >= 0;
}

// ---------------------------------------------------------------------------
// 8-byte little-endian Unix-epoch-seconds timestamp (block header `ts` field).
// ---------------------------------------------------------------------------

/** Encode Unix-epoch seconds into the 8-byte little-endian calibration `ts`. */
export function unixSecondsToCalibTsBytes(unixSeconds: number): Uint8Array {
  const out = new Uint8Array(SC_TS_BYTES);
  let v = Math.max(0, Math.floor(Number(unixSeconds) || 0));
  for (let i = 0; i < SC_TS_BYTES; i++) {
    out[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return out;
}

/** Decode the 8-byte little-endian calibration `ts` back to Unix-epoch seconds
 * (0 = default/seeded). */
export function calibTsBytesToUnixSeconds(ts: ArrayLike<number> | null | undefined): number {
  if (!ts || ts.length < SC_TS_BYTES) return 0;
  let secs = 0;
  for (let i = SC_TS_BYTES - 1; i >= 0; i--) secs = secs * 256 + (ts[i] & 0xff);
  return secs;
}

// ---------------------------------------------------------------------------
// Default calibration catalog (mirror of firmware AsmCalib_seedDefaults).
// ---------------------------------------------------------------------------

export interface VerisenseCalibrationRange {
  /** Full-scale index as stored in the block `range` byte (low 6 bits). */
  code: number;
  /** Display label, e.g. "±2g" / "±250dps". */
  label: string;
  /** Default sensitivity `K` (LSB per physical unit) for this range. */
  sens: number;
}

export interface VerisenseCalibrationSensor {
  /** Calibration-domain sensor id (see {@link CalibSensorId}). */
  id: number;
  /** Display label, e.g. "Accelerometer (LSM6DSV)". */
  label: string;
  /** Physical unit of the calibrated output. */
  unit: string;
  /** Default sensor->ASM alignment `R` (row-major 3x3, applied as
   * physical = align · sensor). See VERISENSE_CALIBRATION.md §4. */
  align: number[];
  ranges: VerisenseCalibrationRange[];
}

const ACCEL_RANGES: VerisenseCalibrationRange[] = [
  { code: 0, label: '±2g', sens: 1671.665922915 },
  { code: 1, label: '±4g', sens: 835.832961457 },
  { code: 2, label: '±8g', sens: 417.916480729 },
  { code: 3, label: '±16g', sens: 208.958240364 },
];

// LSM6DSV gyro full-scale codes 0..4 (125/250/500/1000/2000 dps).
const GYRO_RANGES: VerisenseCalibrationRange[] = [
  { code: 0, label: '±125dps', sens: 228.571428571 },
  { code: 1, label: '±250dps', sens: 114.285714286 },
  { code: 2, label: '±500dps', sens: 57.142857143 },
  { code: 3, label: '±1000dps', sens: 28.571428571 },
  { code: 4, label: '±2000dps', sens: 14.285714286 },
];

// LSM6DS3 gyro full-scale codes 0..3 (250/500/1000/2000 dps) — the gen-1 op-config
// gyro field is 2 bits, so 125 dps is not selectable via the standard range (see
// SensorLSM6DS3). Codes here match that field and the decoder lookup.
const LSM6DS3_GYRO_RANGES: VerisenseCalibrationRange[] = [
  { code: 0, label: '±250dps', sens: 114.285714286 },
  { code: 1, label: '±500dps', sens: 57.142857143 },
  { code: 2, label: '±1000dps', sens: 28.571428571 },
  { code: 3, label: '±2000dps', sens: 14.285714286 },
];

/**
 * 2nd-generation catalog (LSM6DSV accel+gyro, LIS2DW12, LIS2MDL). Alignment
 * matrices derived from the ST datasheet axis figures + the SR68-10 pin-1
 * placement; common frame +X=strap, +Y=out of face, +Z=toward hand. LSM6DSV /
 * LIS2DW12 are proper rotations (det +1); the LIS2MDL frame is left-handed
 * (det −1, a reflection). Kept byte-for-byte in sync with the firmware seed
 * (asm_calibration.c) and VERISENSE_CALIBRATION.md §4.
 */
const CALIBRATION_SENSORS_GEN2: VerisenseCalibrationSensor[] = [
  {
    id: CalibSensorId.LSM6DSV_ACCEL,
    label: 'Accelerometer (LSM6DSV)',
    unit: 'LSB/(m/s²)',
    align: [0, -1, 0, 0, 0, 1, -1, 0, 0],
    ranges: ACCEL_RANGES,
  },
  {
    id: CalibSensorId.LSM6DSV_GYRO,
    label: 'Gyroscope (LSM6DSV)',
    unit: 'LSB/dps',
    align: [0, -1, 0, 0, 0, 1, -1, 0, 0],
    ranges: GYRO_RANGES,
  },
  {
    id: CalibSensorId.LIS2DW12_ACCEL,
    label: 'Accelerometer 2 (LIS2DW12)',
    unit: 'LSB/(m/s²)',
    align: [1, 0, 0, 0, 0, 1, 0, -1, 0],
    ranges: ACCEL_RANGES,
  },
  {
    id: CalibSensorId.LIS2MDL_MAG,
    label: 'Magnetometer (LIS2MDL)',
    unit: 'LSB/Gauss',
    align: [0, 1, 0, 0, 0, 1, -1, 0, 0],
    ranges: [{ code: 0, label: '±49.152Ga', sens: 667 }],
  },
];

/**
 * 1st-generation catalog (LIS2DW12 + LSM6DS3 accel/gyro). Sensitivities and
 * alignment from the gen-1 calibration document (ASM-DES §8). The doc states the
 * forward rotation `R` (output = K·R·physical); the stored `align` is the applied
 * sensor→common map = Rᵀ. Note the LIS2DW12 mounting differs from gen-2, so its
 * alignment (id 39) is generation-specific. All proper rotations (det +1).
 */
const CALIBRATION_SENSORS_GEN1: VerisenseCalibrationSensor[] = [
  {
    id: CalibSensorId.LIS2DW12_ACCEL,
    label: 'Accelerometer 1 (LIS2DW12)',
    unit: 'LSB/(m/s²)',
    align: [0, 1, 0, 0, 0, 1, 1, 0, 0],
    ranges: ACCEL_RANGES,
  },
  {
    id: CalibSensorId.LSM6DS3_ACCEL,
    label: 'Accelerometer 2 (LSM6DS3)',
    unit: 'LSB/(m/s²)',
    align: [0, -1, 0, 0, 0, -1, 1, 0, 0],
    ranges: ACCEL_RANGES,
  },
  {
    id: CalibSensorId.LSM6DS3_GYRO,
    label: 'Gyroscope (LSM6DS3)',
    unit: 'LSB/dps',
    align: [0, -1, 0, 0, 0, -1, 1, 0, 0],
    ranges: LSM6DS3_GYRO_RANGES,
  },
];

/**
 * The calibration sensor catalog for a board: the 1st-generation set
 * (LIS2DW12 + LSM6DS3) for 1st-gen hardware, otherwise the 2nd-generation set
 * (LSM6DSV + LIS2DW12 + LIS2MDL). Unknown/offline (no revision) defaults to
 * 2nd-gen. Note id 39 (LIS2DW12) appears in both with a generation-specific
 * alignment, so the catalog must be resolved per hardware revision.
 */
export function getVerisenseCalibrationSensors(
  revHwMajor?: number,
  revHwMinor?: number,
): VerisenseCalibrationSensor[] {
  if (
    revHwMajor != null &&
    revHwMinor != null &&
    !isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor)
  ) {
    return CALIBRATION_SENSORS_GEN1;
  }
  return CALIBRATION_SENSORS_GEN2;
}

/**
 * Build the default calibration set for a board (bias=0, default sensitivity,
 * default alignment, ts=0). Host-side mirror of `AsmCalib_seedDefaults`; useful
 * for "reset to defaults" and round-trip tests.
 */
export function buildDefaultVerisenseCalibrationSet(opts: {
  hwVerMajor: number;
  hwVerMinor: number;
  fwVerMajor: number;
  fwVerMinor: number;
  fwVerPatch: number;
}): CalibrationSetInput {
  const sensors = getVerisenseCalibrationSensors(opts.hwVerMajor, opts.hwVerMinor);
  const blocks = sensors.flatMap((s) =>
    s.ranges.map((r) => ({
      sensorId: s.id,
      range: r.code,
      imu: {
        bias: [0, 0, 0] as [number, number, number],
        sens: [r.sens, r.sens, r.sens] as [number, number, number],
        align: s.align.slice(),
      },
    })),
  );
  return {
    hwVerMajor: opts.hwVerMajor,
    hwVerMinor: opts.hwVerMinor,
    fwVerMajor: opts.fwVerMajor,
    fwVerMinor: opts.fwVerMinor,
    fwVerPatch: opts.fwVerPatch,
    blocks,
  };
}

// ---------------------------------------------------------------------------
// Per-sensor availability for the connected hardware.
// ---------------------------------------------------------------------------

export type VerisenseCalibrationAvailability = 'enabled' | 'disabled' | 'hidden';

/**
 * Map each calibration-domain sensor id to whether it is present and usable on
 * the connected hardware:
 *  - `enabled`  — present and recorded from; show + allow edit.
 *  - `disabled` — physically present but not recorded from (LIS2DW12 routed to
 *    the algorithm hub on 2nd-gen SR68); show greyed.
 *  - `hidden`   — not fitted on this hardware.
 *
 * `support` is the result of `getVerisenseHardwareSensorSupport`. A null/absent
 * support object (offline / unknown hardware) reports every sensor `enabled`.
 */
export function getVerisenseCalibrationSensorAvailability(
  support: VerisenseHardwareSensorSupport | null | undefined,
): Record<number, VerisenseCalibrationAvailability> {
  const all = (v: VerisenseCalibrationAvailability) => ({
    [CalibSensorId.LSM6DSV_ACCEL]: v,
    [CalibSensorId.LSM6DSV_GYRO]: v,
    [CalibSensorId.LIS2DW12_ACCEL]: v,
    [CalibSensorId.LSM6DS3_ACCEL]: v,
    [CalibSensorId.LSM6DS3_GYRO]: v,
    [CalibSensorId.LIS2MDL_MAG]: v,
  });
  if (!support) return all('enabled');

  const imuGen2: VerisenseCalibrationAvailability = support.imuGen2 ? 'enabled' : 'hidden';
  const gen1Imu: VerisenseCalibrationAvailability = support.gyroAccel2 ? 'enabled' : 'hidden';
  // LIS2DW12: recorded directly on 1st-gen (accel1); present-but-algo-hub-routed
  // on 2nd-gen (imuGen2) so shown disabled; otherwise not fitted.
  const lis2dw12: VerisenseCalibrationAvailability = support.accel1
    ? 'enabled'
    : support.imuGen2
      ? 'disabled'
      : 'hidden';

  return {
    [CalibSensorId.LSM6DSV_ACCEL]: imuGen2,
    [CalibSensorId.LSM6DSV_GYRO]: imuGen2,
    [CalibSensorId.LIS2MDL_MAG]: imuGen2,
    [CalibSensorId.LIS2DW12_ACCEL]: lis2dw12,
    [CalibSensorId.LSM6DS3_ACCEL]: gen1Imu,
    [CalibSensorId.LSM6DS3_GYRO]: gen1Imu,
  };
}
