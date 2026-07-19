import { describe, it, expect } from 'vitest';
import {
  parseCalibDump,
  generateCalibDump,
  CALIB_READ_SOURCE,
  shouldOverrideCalibration,
  parseKinematicCalibBlock,
  generateKinematicCalibBlock,
  type CalibDumpRecord,
} from '../../src/devices/calibration/index.js';

const block = generateKinematicCalibBlock(
  [2047, 2047, 2047],
  [83, 83, 83],
  [0, -1, 0, -1, 0, 0, 0, 0, -1],
);

describe('parseCalibDump / generateCalibDump', () => {
  it('round-trips a two-record dump', () => {
    const version = {
      hardwareId: 10,
      firmwareId: 3,
      firmwareMajor: 1,
      firmwareMinor: 0,
      firmwareInternal: 22,
    };
    const records: CalibDumpRecord[] = [
      {
        sensorId: 0x0100,
        range: 0,
        calibLen: 21,
        timestampTicks: new Uint8Array(8), // all-zero → default
        calibBytes: block,
        isDefault: true,
      },
      {
        sensorId: 0x0200,
        range: 2,
        calibLen: 21,
        timestampTicks: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
        calibBytes: block,
        isDefault: false,
      },
    ];
    const dump = generateCalibDump(version, records);
    const parsed = parseCalibDump(dump);

    expect(parsed.packetLength).toBe(dump.length - 2);
    expect(parsed.version).toEqual(version);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].sensorId).toBe(0x0100);
    expect(parsed.records[0].range).toBe(0);
    expect(parsed.records[0].isDefault).toBe(true);
    expect(parsed.records[1].sensorId).toBe(0x0200);
    expect(parsed.records[1].range).toBe(2);
    expect(parsed.records[1].isDefault).toBe(false);
    // The embedded 21-byte block still parses to the LN accel calibration.
    const cal = parseKinematicCalibBlock(parsed.records[1].calibBytes)!;
    expect(cal.offset).toEqual([2047, 2047, 2047]);
    expect(cal.sensitivity).toEqual([83, 83, 83]);
  });

  it('returns no records for an all-zero buffer', () => {
    expect(parseCalibDump(new Uint8Array(64)).records).toHaveLength(0);
  });

  it('drops a trailing partial record', () => {
    const version = {
      hardwareId: 3,
      firmwareId: 2,
      firmwareMajor: 0,
      firmwareMinor: 11,
      firmwareInternal: 5,
    };
    const rec: CalibDumpRecord = {
      sensorId: 1,
      range: 0,
      calibLen: 21,
      timestampTicks: new Uint8Array(8),
      calibBytes: block,
      isDefault: true,
    };
    const full = generateCalibDump(version, [rec]);
    // Truncate mid-payload: the record header is present but the block is short.
    const truncated = full.subarray(0, full.length - 5);
    expect(parseCalibDump(truncated).records).toHaveLength(0);
  });
});

describe('calibration source-priority ladder', () => {
  it('orders sources UNKNOWN < SD_HEADER < LEGACY_BT < INFOMEM < RADIO_DUMP < FILE_DUMP < USER_MODIFIED', () => {
    expect(CALIB_READ_SOURCE.UNKNOWN).toBeLessThan(CALIB_READ_SOURCE.SD_HEADER);
    expect(CALIB_READ_SOURCE.SD_HEADER).toBeLessThan(CALIB_READ_SOURCE.LEGACY_BT_COMMAND);
    expect(CALIB_READ_SOURCE.LEGACY_BT_COMMAND).toBeLessThan(CALIB_READ_SOURCE.INFOMEM);
    expect(CALIB_READ_SOURCE.INFOMEM).toBeLessThan(CALIB_READ_SOURCE.RADIO_DUMP);
    expect(CALIB_READ_SOURCE.RADIO_DUMP).toBeLessThan(CALIB_READ_SOURCE.FILE_DUMP);
    expect(CALIB_READ_SOURCE.FILE_DUMP).toBeLessThan(CALIB_READ_SOURCE.USER_MODIFIED);
  });

  it('overrides on >= priority (matches the Java ordinal guard)', () => {
    // A radio dump overrides an SD-header calibration.
    expect(
      shouldOverrideCalibration(CALIB_READ_SOURCE.SD_HEADER, CALIB_READ_SOURCE.RADIO_DUMP),
    ).toBe(true);
    // Equal priority also overrides.
    expect(shouldOverrideCalibration(CALIB_READ_SOURCE.INFOMEM, CALIB_READ_SOURCE.INFOMEM)).toBe(
      true,
    );
    // A lower-priority source does not override a higher one.
    expect(
      shouldOverrideCalibration(CALIB_READ_SOURCE.USER_MODIFIED, CALIB_READ_SOURCE.SD_HEADER),
    ).toBe(false);
  });

  it('overrides on a strictly-newer timestamp even when the source priority is lower', () => {
    // Java: `calibTimeMs > getCalibTimeMs() || ordinal >= ordinal`. A fresher
    // incoming timestamp wins on the first disjunct regardless of source.
    expect(
      shouldOverrideCalibration(
        CALIB_READ_SOURCE.USER_MODIFIED, // current (higher priority)
        CALIB_READ_SOURCE.SD_HEADER, // incoming (lower priority)
        1000, // currentTimeMs
        2000, // incomingTimeMs — strictly newer
      ),
    ).toBe(true);
  });

  it('falls back to the ordinal guard when the incoming timestamp is not newer', () => {
    // Not-newer timestamp (equal or older) → decided by source ordinal alone.
    expect(
      shouldOverrideCalibration(
        CALIB_READ_SOURCE.USER_MODIFIED,
        CALIB_READ_SOURCE.SD_HEADER,
        2000, // currentTimeMs
        2000, // incomingTimeMs — not strictly newer
      ),
    ).toBe(false); // lower-priority source, no timestamp advantage
    expect(
      shouldOverrideCalibration(
        CALIB_READ_SOURCE.SD_HEADER,
        CALIB_READ_SOURCE.RADIO_DUMP,
        5000, // currentTimeMs
        1000, // incomingTimeMs — older, but higher-priority source still wins
      ),
    ).toBe(true);
  });
});
