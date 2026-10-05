import { describe, it, expect } from 'vitest';
import { decodeSdLogFile, SDLogHeaderBitmask as BM } from '../../src/devices/sdlog/index.js';
import { generateKinematicCalibBlock } from '../../src/devices/calibration/index.js';
import { buildFile, buildPacket, buildSdLogHeader, encodeValue } from './fixtures.js';

// A real per-device LN accel calibration block written into the SD header at
// offset 139-159: offset [2000,2000,2000], sens [80,80,80], identity alignment.
const LN_BLOCK = generateKinematicCalibBlock(
  [2000, 2000, 2000],
  [80, 80, 80],
  [1, 0, 0, 0, 1, 0, 0, 0, 1],
);

describe('SD-log inertial calibration', () => {
  it('applies a valid per-device LN accel block from the header (hand-computed)', () => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: BM.ACCEL_LN | BM.ACCEL_WR,
      // LN accel block (139-159) = the real device block; everything else 0xFF
      // (→ WR accel uses the range-0 default).
      calibFill: (off) => (off >= 139 && off < 160 ? LN_BLOCK[off - 139] : 0xff),
    });
    // LN raw [2000,2080,2160]; WR raw [1631,1631,1631].
    const pkt = buildPacket(100, 3, [
      ...encodeValue('u12', 2000),
      ...encodeValue('u12', 2080),
      ...encodeValue('u12', 2160),
      ...encodeValue('i16', 1631),
      ...encodeValue('i16', 1631),
      ...encodeValue('i16', 1631),
    ]);
    const { header: h, records } = decodeSdLogFile(buildFile(header, pkt));

    // Channels flipped to calibrated with the accel unit.
    expect(h.channels.map((c) => c.name)).toEqual([
      'LN_ACCEL_X',
      'LN_ACCEL_Y',
      'LN_ACCEL_Z',
      'WR_ACCEL_X',
      'WR_ACCEL_Y',
      'WR_ACCEL_Z',
    ]);
    expect(h.channels.every((c) => c.calibrated && c.unit === 'm/(s^2)')).toBe(true);

    // LN accel: identity align, offset 2000, sens 80 → (raw-2000)/80.
    //   [2000,2080,2160] → [0, 80/80, 160/80] = [0, 1, 2].
    expect(records[0].values[0]).toBeCloseTo(0, 10);
    expect(records[0].values[1]).toBeCloseTo(1, 10);
    expect(records[0].values[2]).toBeCloseTo(2, 10);

    // WR accel: default LSM303DLHC 2g (sens 1631, align [[-1,0,0],[0,1,0],[0,0,-1]]).
    //   raw [1631,1631,1631] → [-1, 1, -1].
    expect(records[0].values[3]).toBeCloseTo(-1, 10);
    expect(records[0].values[4]).toBeCloseTo(1, 10);
    expect(records[0].values[5]).toBeCloseTo(-1, 10);
  });

  it('reports per-group usingDefaultCalibration / source metadata', () => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: BM.ACCEL_LN | BM.ACCEL_WR,
      calibFill: (off) => (off >= 139 && off < 160 ? LN_BLOCK[off - 139] : 0xff),
    });
    const pkt = buildPacket(100, 3, [
      ...encodeValue('u12', 2000),
      ...encodeValue('u12', 2000),
      ...encodeValue('u12', 2000),
      ...encodeValue('i16', 0),
      ...encodeValue('i16', 0),
      ...encodeValue('i16', 0),
    ]);
    const { header: h } = decodeSdLogFile(buildFile(header, pkt));

    const ln = h.calibration.find((c) => c.group === 'lnAccel')!;
    expect(ln.usingDefaultCalibration).toBe(false);
    expect(ln.source).toBe('sd-header');
    expect(ln.unit).toBe('m/(s^2)');

    const wr = h.calibration.find((c) => c.group === 'wrAccel')!;
    expect(wr.usingDefaultCalibration).toBe(true);
    expect(wr.source).toBe('default');
  });

  it('uses defaults for every group when all calibration blocks are 0xFF', () => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: BM.ACCEL_LN,
      calibFill: () => 0xff,
    });
    const pkt = buildPacket(100, 3, [
      ...encodeValue('u12', 2047),
      ...encodeValue('u12', 2047),
      ...encodeValue('u12', 2047),
    ]);
    const { header: h, records } = decodeSdLogFile(buildFile(header, pkt));
    expect(h.calibration.find((c) => c.group === 'lnAccel')!.usingDefaultCalibration).toBe(true);
    // Kionix default: raw = offset (2047) → 0.
    expect(records[0].values.map((v) => v + 0)).toEqual([0, 0, 0]);
  });
});
