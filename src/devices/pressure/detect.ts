/**
 * Which pressure part a Shimmer3R carries, when the sensor will not say.
 *
 * The in-band answer is the 0xA7 reply's sensor id (see `./types.ts`), but two
 * places have no such reply to read. An SD-log file carries no sensor id at
 * all — for a BMP581 the firmware simply leaves the header's calibration
 * region unwritten (`SDCard/shimmer_sd_header.c:209-215`) — and a
 * LogAndStream_Shimmer3R v1.01.006 NACKs 0xA7 on a BMP581. Both fall back to
 * the rule the firmware itself uses when the chip id cannot be read: the
 * board's SR number.
 */

import { FW_ID, HW_ID } from '../infomem/layout.js';
import { isShimmerSrBoardAtLeast, type ShimmerSrBoard } from '../identity.js';

/** The first firmware that drives a BMP581: LogAndStream_Shimmer3R v1.01.006. */
export const BMP581_MIN_FIRMWARE = Object.freeze({ major: 1, minor: 1, internal: 6 } as const);

/** One SR-number window that carries the BMP581. */
interface Bmp581BoardRule {
  boardId: number;
  /** First revision with it, `[rev, specialRev]`, inclusive. */
  from: readonly [number, number];
  /** First revision back on the BMP390, exclusive; absent for "and every later one". */
  before?: readonly [number, number];
}

/**
 * `ShimBrd_isBmp581PresentPerSrNumber()` (`Boards/shimmer_boards.c:337-355`),
 * one row per term. SR48 needs two rows: its rev-7 development build carries
 * the BMP581 from 7.2, production went back to the BMP390 at 8.0 and 8.1, and
 * picked it up again at 8.2 — so a single `>= 7.2` would wrongly claim 8.0 and
 * 8.1.
 */
const BMP581_BOARD_RULES: readonly Bmp581BoardRule[] = Object.freeze([
  { boardId: 31, from: [11, 2] }, // SHIMMER3_IMU
  { boardId: 38, from: [4, 2] }, // EXP_BRD_PROTO3_DELUXE
  { boardId: 47, from: [8, 2] }, // EXP_BRD_EXG_UNIFIED
  { boardId: 48, from: [7, 2], before: [8, 0] }, // EXP_BRD_GSR_UNIFIED, rev 7
  { boardId: 48, from: [8, 2] }, // EXP_BRD_GSR_UNIFIED, rev 8 on
  { boardId: 49, from: [4, 2] }, // EXP_BRD_BR_AMP_UNIFIED
]);

/** What {@link isBmp581PresentPerSrNumber} needs to know about the sensor. */
export interface Bmp581DetectionContext {
  /** Hardware id: 10 for a Shimmer3R. */
  hardwareVersion: number;
  /** Firmware id: 3 for LogAndStream. */
  firmwareId: number;
  firmwareVersion: { major: number; minor: number; internal: number };
  /** The daughter-card id page, or null when it was not read or not stored. */
  board: ShimmerSrBoard | null | undefined;
}

/**
 * True when a sensor should be assumed to carry a BMP581 rather than a BMP390.
 *
 * All three must hold:
 * - the hardware is a Shimmer3R — the firmware rule is Shimmer3R-only, and a
 *   daughter card can be moved onto a Shimmer3 host;
 * - the firmware is LogAndStream {@link BMP581_MIN_FIRMWARE} or later — older
 *   firmware has no BMP581 support, so its data is never BMP581 output;
 * - the board's SR number is in one of the windows in the firmware's
 *   `ShimBrd_isBmp581PresentPerSrNumber()`, where `>=` compares the rev first
 *   and then the special rev.
 *
 * The hardware and SR-number checks mirror the firmware exactly; the firmware
 * version check is the host's own addition, as it is in the Java driver
 * (`ShimmerObject.isSupportedBmp581`). Prefer the 0xA7 sensor id whenever the
 * sensor gives one: this is the fallback for when it cannot.
 */
export function isBmp581PresentPerSrNumber(ctx: Bmp581DetectionContext): boolean {
  if (ctx.hardwareVersion !== HW_ID.SHIMMER_3R) return false;
  if (ctx.firmwareId !== FW_ID.LOGANDSTREAM) return false;
  const v = ctx.firmwareVersion;
  const min = BMP581_MIN_FIRMWARE;
  const fwOk =
    v.major > min.major ||
    (v.major === min.major &&
      (v.minor > min.minor || (v.minor === min.minor && v.internal >= min.internal)));
  if (!fwOk) return false;
  return BMP581_BOARD_RULES.some(
    (r) =>
      isShimmerSrBoardAtLeast(ctx.board, r.boardId, r.from[0], r.from[1]) &&
      !(r.before && isShimmerSrBoardAtLeast(ctx.board, r.boardId, r.before[0], r.before[1])),
  );
}
