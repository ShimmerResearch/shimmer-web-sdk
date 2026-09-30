import { describe, expect, it } from 'vitest';
import {
  BMP581_MIN_FIRMWARE,
  isBmp581PresentPerSrNumber,
  type Bmp581DetectionContext,
} from '../../src/devices/pressure/index.js';
import { isShimmerSrBoardAtLeast } from '../../src/devices/identity.js';

/** A Shimmer3R on the first BMP581 firmware, carrying `SR<id>-<rev>-<special>`. */
const s3r = (boardId: number, boardRev: number, specialRev: number): Bmp581DetectionContext => ({
  hardwareVersion: 10,
  firmwareId: 3,
  firmwareVersion: { ...BMP581_MIN_FIRMWARE },
  board: { boardId, boardRev, specialRev },
});

describe('isBmp581PresentPerSrNumber — the SR rule', () => {
  /*
   * Copied case for case from the firmware's own gate test
   * (log-and-stream-common `Test/host/test_boards.c:158-222`,
   * `test_bmp581_gate`), so the host and the firmware are pinned to the same
   * boundaries. Board ids: 31 SHIMMER3_IMU, 38 EXP_BRD_PROTO3_DELUXE,
   * 47 EXP_BRD_EXG_UNIFIED, 48 EXP_BRD_GSR_UNIFIED, 49 EXP_BRD_BR_AMP_UNIFIED,
   * 36 EXP_BRD_PROTO3_MINI.
   */
  const cases: Array<[number, number, number, boolean, string]> = [
    // IMU, SR31: from 11.2
    [31, 11, 1, false, 'one minor below the line'],
    [31, 11, 2, true, 'the first board with it'],
    [31, 11, 3, true, 'a later minor keeps it'],
    [31, 12, 0, true, 'a later major keeps it'],
    [31, 10, 9, false, 'an earlier major never has it'],

    // Proto3 Deluxe, SR38: from 4.2
    [38, 4, 1, false, 'one minor below the line'],
    [38, 4, 2, true, 'the first board with it'],
    [38, 5, 0, true, 'a later major keeps it'],

    // ExG, SR47: from 8.2 - note 7.x never has it, unlike SR48
    [47, 7, 2, false, 'SR47 has no 7-2 dev build'],
    [47, 8, 1, false, 'one minor below the line'],
    [47, 8, 2, true, 'the first board with it'],
    [47, 9, 0, true, 'a later major keeps it'],

    // Bridge Amplifier, SR49: from 4.2
    [49, 4, 1, false, 'one minor below the line'],
    [49, 4, 2, true, 'the first board with it'],

    // GSR+, SR48: the two-window case.
    [48, 6, 0, false, 'the earliest proto'],
    [48, 7, 0, false, 'below the dev build'],
    [48, 7, 1, false, 'the BOOT0 ECO rev, still no BMP581'],
    [48, 7, 2, true, 'the dev build that carries it'],
    [48, 7, 3, true, 'above the dev build, same major'],
    [48, 8, 0, false, 'LATER board, but back to the BMP390'],
    [48, 8, 1, false, 'still the BMP390'],
    [48, 8, 2, true, 'production line picks it up again'],
    [48, 8, 3, true, 'and keeps it'],
    [48, 9, 0, true, 'a later major keeps it'],

    // A board ID with no BMP581 rule at all.
    [36, 9, 9, false, 'no rule for this board ID'],
  ];

  it.each(cases)('SR%i-%i-%i → %s: %s', (id, rev, special, expected) => {
    expect(isBmp581PresentPerSrNumber(s3r(id, rev, special))).toBe(expected);
  });

  it('never claims a BMP581 on a Shimmer3 host', () => {
    // A daughter card can be moved between hosts; the rule is Shimmer3R-only.
    expect(isBmp581PresentPerSrNumber({ ...s3r(48, 8, 2), hardwareVersion: 3 })).toBe(false);
  });

  it('does not let an unprogrammed card claim one', () => {
    // 0xFF,0xFF,0xFF would satisfy every ">=" without the id check first.
    expect(isBmp581PresentPerSrNumber(s3r(0xff, 0xff, 0xff))).toBe(false);
    expect(isBmp581PresentPerSrNumber(s3r(0, 0, 0))).toBe(false);
    expect(isBmp581PresentPerSrNumber({ ...s3r(48, 8, 2), board: null })).toBe(false);
    expect(isBmp581PresentPerSrNumber({ ...s3r(48, 8, 2), board: undefined })).toBe(false);
  });
});

describe('isBmp581PresentPerSrNumber — the firmware gate', () => {
  const at = (major: number, minor: number, internal: number, firmwareId = 3): boolean =>
    isBmp581PresentPerSrNumber({
      ...s3r(48, 8, 2),
      firmwareId,
      firmwareVersion: { major, minor, internal },
    });

  it('starts at LogAndStream v1.01.006', () => {
    expect(BMP581_MIN_FIRMWARE).toEqual({ major: 1, minor: 1, internal: 6 });
    expect(at(1, 1, 5)).toBe(false);
    expect(at(1, 1, 6)).toBe(true);
    expect(at(1, 1, 7)).toBe(true);
  });

  it('compares major, then minor, then internal', () => {
    expect(at(1, 0, 99)).toBe(false);
    expect(at(1, 2, 0)).toBe(true);
    expect(at(0, 99, 99)).toBe(false);
    expect(at(2, 0, 0)).toBe(true);
  });

  it('needs LogAndStream firmware', () => {
    expect(at(1, 1, 6, 2)).toBe(false); // SDLog
    expect(at(1, 1, 6, 1)).toBe(false); // BtStream
  });
});

describe('isShimmerSrBoardAtLeast', () => {
  const board = { boardId: 48, boardRev: 8, specialRev: 2 };

  it('compares the rev first, and the special rev only on a tie', () => {
    expect(isShimmerSrBoardAtLeast(board, 48, 8, 2)).toBe(true);
    expect(isShimmerSrBoardAtLeast(board, 48, 8, 3)).toBe(false);
    expect(isShimmerSrBoardAtLeast(board, 48, 7, 9)).toBe(true);
    expect(isShimmerSrBoardAtLeast(board, 48, 9, 0)).toBe(false);
  });

  it('never matches a different board id', () => {
    expect(isShimmerSrBoardAtLeast(board, 47, 0, 0)).toBe(false);
  });
});
