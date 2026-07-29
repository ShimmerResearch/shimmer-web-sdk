/**
 * SD-log inertial calibration planning.
 *
 * For a decoded SD-log file this builds one {@link CalibPlanEntry} per inertial
 * channel group (LN accel, WR accel, gyro, mag, and the Shimmer3R alt-accel /
 * alt-mag), choosing the per-device calibration block from the header when it
 * is valid and falling back to the range-selected default otherwise — exactly
 * the CalibDetailsKinematic behaviour (a stored block overrides the default;
 * an all-0xFF/all-0x00 block keeps the default). It also flips the affected
 * channel specs to `calibrated:true` with the right unit, so the decoder can
 * emit calibrated values.
 */

import {
  parseKinematicCalibBlock,
  getDefaultCalibration,
  type KinematicCalibration,
  type ImuFamily,
  type InertialGroup,
} from '../calibration/index.js';
import { isNewImuSensors } from './header.js';
import type { SdLogChannelSpec } from './channels.js';
import { SDLOG_HW_ID } from './constants.js';
import type { SdLogChannelCalibrationInfo, SdLogHeader } from './types.js';

/** A group's calibration applied to a triple of channel indices. */
export interface CalibPlanEntry {
  /** Indices into the record `values` array for the X, Y, Z axes. */
  indices: [number, number, number];
  /** Calibration set to apply (device block or range-selected default). */
  calibration: KinematicCalibration;
}

export interface SdLogCalibPlan {
  entries: CalibPlanEntry[];
  info: SdLogChannelCalibrationInfo[];
}

interface GroupSpec {
  group: InertialGroup;
  axisNames: [string, string, string];
  /** Raw calibration block from the header, or undefined when absent. */
  block: Uint8Array | undefined;
  range: number;
}

function familyOf(header: SdLogHeader): ImuFamily {
  if (header.hardwareVersion === SDLOG_HW_ID.SHIMMER_3R) return 'shimmer3r';
  return isNewImuSensors(header.hardwareVersion, header.expansionBoard)
    ? 'shimmer3-new'
    : 'shimmer3-old';
}

function groupSpecsFor(header: SdLogHeader): GroupSpec[] {
  const cb = header.calibrationBytes;
  const r = header.imuRanges;
  if (header.hardwareVersion === SDLOG_HW_ID.SHIMMER_3R) {
    return [
      {
        group: 'lnAccel',
        axisNames: ['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z'],
        block: cb.lnAccel,
        range: r.lnAccel,
      },
      {
        group: 'wrAccel',
        axisNames: ['WR_ACCEL_X', 'WR_ACCEL_Y', 'WR_ACCEL_Z'],
        block: cb.wrAccel,
        range: r.wrAccel,
      },
      { group: 'gyro', axisNames: ['GYRO_X', 'GYRO_Y', 'GYRO_Z'], block: cb.gyro, range: r.gyro },
      { group: 'mag', axisNames: ['MAG_X', 'MAG_Y', 'MAG_Z'], block: cb.mag, range: r.mag },
      {
        group: 'altAccel',
        axisNames: ['HG_ACCEL_X', 'HG_ACCEL_Y', 'HG_ACCEL_Z'],
        block: cb.altAccel,
        range: r.altAccel,
      },
      {
        group: 'altMag',
        axisNames: ['ALT_MAG_X', 'ALT_MAG_Y', 'ALT_MAG_Z'],
        block: cb.altMag,
        range: r.altMag,
      },
    ];
  }
  // Shimmer3 (old + new IMU).
  return [
    {
      group: 'lnAccel',
      axisNames: ['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z'],
      block: cb.lnAccel,
      range: r.lnAccel,
    },
    {
      group: 'wrAccel',
      axisNames: ['WR_ACCEL_X', 'WR_ACCEL_Y', 'WR_ACCEL_Z'],
      block: cb.wrAccel,
      range: r.wrAccel,
    },
    { group: 'gyro', axisNames: ['GYRO_X', 'GYRO_Y', 'GYRO_Z'], block: cb.gyro, range: r.gyro },
    { group: 'mag', axisNames: ['MAG_X', 'MAG_Y', 'MAG_Z'], block: cb.mag, range: r.mag },
  ];
}

/**
 * Build the calibration plan for a file and mark the calibrated channel specs.
 * `channels` is the same array referenced by `header.channels`, so the
 * `calibrated`/`unit` flips are visible to consumers of the header.
 */
export function buildSdLogCalibPlan(
  header: SdLogHeader,
  channels: SdLogChannelSpec[],
): SdLogCalibPlan {
  const family = familyOf(header);
  const nameToIndex = new Map<string, number>();
  channels.forEach((c, i) => nameToIndex.set(c.name, i));

  const entries: CalibPlanEntry[] = [];
  const info: SdLogChannelCalibrationInfo[] = [];

  for (const spec of groupSpecsFor(header)) {
    const xi = nameToIndex.get(spec.axisNames[0]);
    const yi = nameToIndex.get(spec.axisNames[1]);
    const zi = nameToIndex.get(spec.axisNames[2]);
    if (xi === undefined || yi === undefined || zi === undefined) continue; // group not present

    const def = getDefaultCalibration(family, spec.group, spec.range);
    if (!def) continue; // family has no such group

    // A valid per-device block overrides the default (CalibDetailsKinematic
    // parseCalParamByteArray: all-FF/all-00 → keep default).
    const parsed = spec.block
      ? parseKinematicCalibBlock(spec.block, { sensitivityScale: def.sensitivityScale })
      : null;
    const usingDefault = parsed === null;
    const calibration = parsed ?? def.calibration;

    entries.push({ indices: [xi, yi, zi], calibration });
    info.push({
      group: spec.group,
      unit: def.unit,
      usingDefaultCalibration: usingDefault,
      source: usingDefault ? 'default' : 'sd-header',
      range: spec.range,
    });

    for (const idx of [xi, yi, zi]) {
      channels[idx].calibrated = true;
      channels[idx].unit = def.unit;
    }
  }

  return { entries, info };
}

/** Apply a calibration plan in place to one record's `values` array. */
export function applyCalibPlan(values: number[], plan: CalibPlanEntry[]): void {
  for (const e of plan) {
    const [xi, yi, zi] = e.indices;
    const [cx, cy, cz] = calibrateTriple(values[xi], values[yi], values[zi], e.calibration);
    values[xi] = cx;
    values[yi] = cy;
    values[zi] = cz;
  }
}

function calibrateTriple(
  x: number,
  y: number,
  z: number,
  cal: KinematicCalibration,
): [number, number, number] {
  const d0 = x - cal.offset[0];
  const d1 = y - cal.offset[1];
  const d2 = z - cal.offset[2];
  const m = cal.m;
  return [
    m[0] * d0 + m[1] * d1 + m[2] * d2,
    m[3] * d0 + m[4] * d1 + m[5] * d2,
    m[6] * d0 + m[7] * d1 + m[8] * d2,
  ];
}
