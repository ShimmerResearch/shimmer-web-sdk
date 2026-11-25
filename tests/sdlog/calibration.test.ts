import { describe, it, expect } from 'vitest';
import {
  decodeSdLogFile,
  decodeSdSession,
  SDLogHeaderBitmask as BM,
} from '../../src/devices/sdlog/index.js';
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

describe('SD-log gyro on-the-fly offset calibration (derived-sensor bit 29)', () => {
  /*
   * A still sensor at 51.2 Hz (divider 640): the same raw gyro in every
   * record, so once the 51-record window has filled the offset is the sample
   * and the gyro reads exactly 0. 0x0101 is 257 in either byte order.
   */
  const file = (derivedSensors: number, records = 60): Uint8Array => {
    const header = buildSdLogHeader({
      fwId: 3,
      fwVersion: [1, 1, 3], // LogAndStream from v0.7.1 stores derived bytes 3-7 at 217-221
      samplingDivider: 640,
      enabledSensors: BM.GYRO,
      derivedSensors,
      calibFill: () => 0xff,
    });
    const gyro = [0x01, 0x01, 0x01, 0x01, 0x01, 0x01];
    const pkts = Array.from({ length: records }, (_, i) => buildPacket(640 * (i + 1), 3, gyro));
    return buildFile(header, ...pkts);
  };

  it('re-estimates the gyro offset once a still window has filled', () => {
    const { header: h, records } = decodeSdLogFile(file(1 << 29));
    const gx = h.channels.findIndex((c) => c.name === 'GYRO_X');
    expect(gx).toBeGreaterThanOrEqual(0);
    expect(records[50].values[gx]).not.toBe(0);
    for (const r of records.slice(51)) {
      for (let a = 0; a < 3; a++) expect(Object.is(r.values[gx + a], 0)).toBe(true);
    }
    expect(h.calibration.find((c) => c.group === 'gyro')!.gyroOnTheFly).toEqual({
      enabled: true,
      active: true,
      windowSamples: 51,
      thresholdDps: 1.2,
      updates: 10, // records 50-59: each still window re-estimates
      offset: [257, 257, 257],
    });
  });

  it('leaves the gyro alone without the bit', () => {
    const { header: h, records } = decodeSdLogFile(file(0));
    const gx = h.channels.findIndex((c) => c.name === 'GYRO_X');
    expect(records[59].values[gx]).toBe(records[0].values[gx]);
    expect(records[0].values[gx]).not.toBe(0);
    expect(h.calibration.find((c) => c.group === 'gyro')!.gyroOnTheFly).toMatchObject({
      enabled: false,
      active: false,
      updates: 0,
    });
  });

  it('starts afresh in each file of a session, and sums the updates', () => {
    const a = file(1 << 29, 60);
    const b = file(1 << 29, 55);
    const { header: h, records } = decodeSdSession([
      { name: '000', bytes: a },
      { name: '001', bytes: b },
    ]);
    const gx = h.channels.findIndex((c) => c.name === 'GYRO_X');
    // The second file's first 51 records are calibrated against the stored
    // offset again, not the first file's estimate.
    expect(records[60 + 50].values[gx]).not.toBe(0);
    expect(Object.is(records[60 + 51].values[gx], 0)).toBe(true);
    expect(h.calibration.find((c) => c.group === 'gyro')!.gyroOnTheFly).toMatchObject({
      enabled: true,
      active: true,
      updates: 10 + 5,
    });
  });
});
