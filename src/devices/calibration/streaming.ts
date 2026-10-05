/**
 * Streaming-path inertial calibration.
 *
 * Applies kinematic calibration to the inertial channels of a decoded
 * {@link ObjectCluster}, adding a `'cal'` field per axis (unit m/(s^2) | deg/s |
 * local_flux) alongside the existing `'raw'` field — exactly how the streaming
 * clients already emit GSR (raw + calibrated). Calibration is chosen per group:
 * a device calibration fetched via `readCalibration()` (source-priority ladder)
 * wins, otherwise the range-selected default is used.
 */

import type { ObjectCluster } from '../../core/ObjectCluster.js';
import { calibrateVector3, type KinematicCalibration } from './kinematic.js';
import { getDefaultCalibration, type ImuFamily, type InertialGroup } from './defaults.js';

/** Per-group hardware ranges tracked by a streaming client. */
export interface StreamingImuRanges {
  lnAccel: number;
  wrAccel: number;
  gyro: number;
  mag: number;
  altAccel: number;
  altMag: number;
}

/** Calibration state a streaming client passes to {@link applyStreamingCalibration}. */
export interface StreamingCalibrationState {
  family: ImuFamily;
  ranges: StreamingImuRanges;
  /** Device calibrations fetched over the radio (override the range default). */
  device?: Partial<Record<InertialGroup, KinematicCalibration>>;
}

interface StreamGroup {
  group: InertialGroup;
  axes: [string, string, string];
}

/**
 * Streaming channel triples by group. Names match the SDK's streaming channel
 * naming (CHANNEL_FORMATS / Shimmer3 schema); a group is calibrated only when
 * all three axis channels are present in the frame.
 */
const STREAM_GROUPS: readonly StreamGroup[] = Object.freeze([
  { group: 'lnAccel', axes: ['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z'] },
  { group: 'wrAccel', axes: ['WR_ACCEL_X', 'WR_ACCEL_Y', 'WR_ACCEL_Z'] },
  { group: 'gyro', axes: ['GYRO_X', 'GYRO_Y', 'GYRO_Z'] },
  { group: 'mag', axes: ['MAG_X', 'MAG_Y', 'MAG_Z'] },
  { group: 'altAccel', axes: ['HG_ACCEL_X', 'HG_ACCEL_Y', 'HG_ACCEL_Z'] },
  { group: 'altMag', axes: ['ALT_MAG_X', 'ALT_MAG_Y', 'ALT_MAG_Z'] },
] as StreamGroup[]);

const rangeFor = (ranges: StreamingImuRanges, group: InertialGroup): number => ranges[group];

/**
 * Add calibrated (`'cal'`) fields to the inertial channels present in `oc`.
 * No-op for channels not present. Uses the raw (`'raw'`) fields as input.
 */
export function applyStreamingCalibration(
  oc: ObjectCluster,
  state: StreamingCalibrationState,
): void {
  for (const { group, axes } of STREAM_GROUPS) {
    const fx = oc.get(axes[0], 'raw');
    const fy = oc.get(axes[1], 'raw');
    const fz = oc.get(axes[2], 'raw');
    if (!fx || !fy || !fz) continue;

    const def = getDefaultCalibration(state.family, group, rangeFor(state.ranges, group));
    if (!def) continue;
    const cal = state.device?.[group] ?? def.calibration;

    const [cx, cy, cz] = calibrateVector3([fx.value, fy.value, fz.value], cal);
    oc.add(axes[0], cx, def.unit, 'cal');
    oc.add(axes[1], cy, def.unit, 'cal');
    oc.add(axes[2], cz, def.unit, 'cal');
  }
}
