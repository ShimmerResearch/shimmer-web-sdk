/**
 * Which IMU a classic Shimmer3's board carries, and which default calibrations
 * follow from that.
 *
 * A Shimmer3 was built with two generations of inertial parts: the old IMU
 * (LSM303DLHC accel and mag) and the new one (LSM303AHTR). Their range codes
 * and default calibrations differ, and the old IMU's mag streams big-endian.
 * Only the daughter-card id says which a board carries.
 *
 * Both `Shimmer3Client` and `Shimmer3RClient` apply these rules. The second
 * also drives a Shimmer3, so the two must not drift apart (DEV-1515).
 */

import type { ImuFamily } from '../calibration/defaults.js';
import type { ShimmerSrBoard } from '../identity.js';
import { isNewImuSensors } from '../sdlog/header.js';

/** A Shimmer3's IMU generation. */
export type Shimmer3ImuGeneration = 'old' | 'new';

/**
 * The IMU generation of a Shimmer3 with this daughter-card id.
 *
 * New when the board's id and revision say so (`isNewImuSensors`, the Java
 * driver's `isSupportedNewImuSensors`), and old otherwise. A blank id page
 * (`null`) is old, as it is for the Java driver.
 */
export function shimmer3ImuGenerationOfBoard(
  hardwareVersion: number,
  board: ShimmerSrBoard | null,
): Shimmer3ImuGeneration {
  return board !== null &&
    isNewImuSensors(hardwareVersion, {
      id: board.boardId,
      rev: board.boardRev,
      revSpecial: board.specialRev,
    })
    ? 'new'
    : 'old';
}

/**
 * The default-calibration family for a Shimmer3 of this IMU generation.
 *
 * An unknown generation (`null`) takes the old IMU's defaults, as the Java
 * driver does for a board it cannot identify.
 */
export function shimmer3ImuFamily(imuGeneration: Shimmer3ImuGeneration | null): ImuFamily {
  return imuGeneration === 'new' ? 'shimmer3-new' : 'shimmer3-old';
}
