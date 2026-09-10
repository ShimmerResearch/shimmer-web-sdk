import { describe, expect, it } from 'vitest';
import {
  CALIB_SENSOR_ID_BY_GROUP,
  SC_SENSOR,
  calibSensorIdForGroup,
  groupForCalibSensorId,
  selectDumpCalibrations,
} from '../../src/devices/calibration/sensorIds.js';
import {
  generateCalibDump,
  parseCalibDump,
  type CalibDumpRecord,
} from '../../src/devices/calibration/dump.js';
import { generateKinematicCalibBlock } from '../../src/devices/calibration/kinematic.js';
import { getDefaultCalibration } from '../../src/devices/calibration/defaults.js';
import type { ImuFamily, InertialGroup } from '../../src/devices/calibration/defaults.js';

const VERSION = {
  hardwareId: 10,
  firmwareId: 3,
  firmwareMajor: 1,
  firmwareMinor: 1,
  firmwareInternal: 12,
};

const stamp = (set: boolean): Uint8Array =>
  set ? Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) : new Uint8Array(8);

/** A record carrying a real 21-byte block for `group` at `range`. */
function record(
  family: ImuFamily,
  group: InertialGroup,
  range: number,
  offset: [number, number, number],
): CalibDumpRecord {
  const defaults = getDefaultCalibration(family, group, range)!;
  const bytes = generateKinematicCalibBlock(
    offset,
    defaults.calibration.sensitivity,
    defaults.calibration.alignment,
    { sensitivityScale: defaults.sensitivityScale },
  );
  return {
    sensorId: calibSensorIdForGroup(family, group)!,
    range,
    calibLen: bytes.length,
    timestampTicks: stamp(true),
    calibBytes: bytes,
    isDefault: false,
  };
}

/** A record whose block holds nothing. */
function blankRecord(sensorId: number, range: number, fill: number): CalibDumpRecord {
  const calibBytes = new Uint8Array(21).fill(fill);
  return {
    sensorId,
    range,
    calibLen: 21,
    timestampTicks: stamp(false),
    calibBytes,
    isDefault: true,
  };
}

describe('SC_SENSOR', () => {
  it('matches the firmware ids', () => {
    // shimmer_calibration.h:99-116
    expect(SC_SENSOR.ANALOG_ACCEL).toBe(2);
    expect(SC_SENSOR.MPU9X50_GYRO).toBe(30);
    expect(SC_SENSOR.LSM303_ACCEL).toBe(31);
    expect(SC_SENSOR.LSM303_MAG).toBe(32);
    expect(SC_SENSOR.LSM6DSV_ACCEL).toBe(37);
    expect(SC_SENSOR.LSM6DSV_GYRO).toBe(38);
    expect(SC_SENSOR.LIS2DW12_ACCEL).toBe(39);
    expect(SC_SENSOR.ADXL371_ACCEL).toBe(40);
    expect(SC_SENSOR.LIS3MDL_MAG).toBe(41);
    expect(SC_SENSOR.LIS2MDL_MAG).toBe(42);
    expect(SC_SENSOR.ALL).toBe(0xff);
  });

  it('disagrees with the Verisense table on 40 and 41, deliberately', () => {
    // In the Verisense domain 40 is an LSM6DS3 accel and 41 its gyro. Here they
    // are the ADXL371 high-g accel and the LIS3MDL alt-mag; a Shimmer3R dump
    // read through the other table mislabels both.
    expect(calibSensorIdForGroup('shimmer3r', 'altAccel')).toBe(40);
    expect(calibSensorIdForGroup('shimmer3r', 'altMag')).toBe(41);
  });
});

describe('group ↔ sensor id', () => {
  it('maps every Shimmer3R group', () => {
    expect(CALIB_SENSOR_ID_BY_GROUP.shimmer3r).toEqual({
      lnAccel: 37,
      wrAccel: 39,
      gyro: 38,
      mag: 42,
      altAccel: 40,
      altMag: 41,
    });
  });

  it('gives a Shimmer3 no high-g accel and no alt mag', () => {
    // The hardware does not have them, so a lookup must fail rather than
    // resolve to some other part's record.
    expect(calibSensorIdForGroup('shimmer3-old', 'altAccel')).toBeUndefined();
    expect(calibSensorIdForGroup('shimmer3-new', 'altMag')).toBeUndefined();
    expect(calibSensorIdForGroup('shimmer3-old', 'lnAccel')).toBe(2);
  });

  it('resolves ids back to groups, per family', () => {
    expect(groupForCalibSensorId('shimmer3r', 38)).toBe('gyro');
    expect(groupForCalibSensorId('shimmer3-old', 30)).toBe('gyro');
    // 38 is a Shimmer3R id; on a Shimmer3 it belongs to nothing.
    expect(groupForCalibSensorId('shimmer3-old', 38)).toBeNull();
    // A pressure coefficient block is not an inertial group.
    expect(groupForCalibSensorId('shimmer3r', SC_SENSOR.BMP390_PRESSURE)).toBeNull();
  });
});

describe('selectDumpCalibrations', () => {
  it('keys usable blocks by group and then by range', () => {
    const dump = parseCalibDump(
      generateCalibDump(VERSION, [
        record('shimmer3r', 'lnAccel', 0, [12, -30, 4]),
        record('shimmer3r', 'gyro', 2, [1, 2, 3]),
        record('shimmer3r', 'gyro', 0, [4, 5, 6]),
        record('shimmer3r', 'altMag', 1, [7, 8, 9]),
      ]),
    );
    const out = selectDumpCalibrations(dump, 'shimmer3r');
    expect(Object.keys(out).sort()).toEqual(['altMag', 'gyro', 'lnAccel']);
    expect(Object.keys(out.gyro!).sort()).toEqual(['0', '2']);
    expect(out.lnAccel![0].offset).toEqual([12, -30, 4]);
    expect(out.gyro![2].offset).toEqual([1, 2, 3]);
    expect(out.gyro![0].offset).toEqual([4, 5, 6]);
    expect(out.altMag![1].offset).toEqual([7, 8, 9]);
  });

  it('drops a block that holds nothing, so the default stays in force', () => {
    const dump = parseCalibDump(
      generateCalibDump(VERSION, [
        blankRecord(SC_SENSOR.LSM6DSV_GYRO, 0, 0xff),
        blankRecord(SC_SENSOR.LIS2DW12_ACCEL, 0, 0x00),
        record('shimmer3r', 'lnAccel', 0, [1, 1, 1]),
      ]),
    );
    const out = selectDumpCalibrations(dump, 'shimmer3r');
    expect(out.gyro).toBeUndefined();
    expect(out.wrAccel).toBeUndefined();
    expect(out.lnAccel).toBeDefined();
  });

  it('drops records that are not an inertial group of this family', () => {
    const dump = parseCalibDump(
      generateCalibDump(VERSION, [
        // A 22-byte pressure coefficient block: present in a real dump, and
        // not a kinematic set.
        {
          sensorId: SC_SENSOR.BMP390_PRESSURE,
          range: 0,
          calibLen: 22,
          timestampTicks: stamp(true),
          calibBytes: Uint8Array.from({ length: 22 }, (_, i) => 0x40 + i),
          isDefault: false,
        },
        record('shimmer3r', 'mag', 0, [2, 2, 2]),
      ]),
    );
    const out = selectDumpCalibrations(dump, 'shimmer3r');
    expect(Object.keys(out)).toEqual(['mag']);
  });

  it('reads a Shimmer3 dump against the Shimmer3 ids', () => {
    const dump = parseCalibDump(
      generateCalibDump({ ...VERSION, hardwareId: 3 }, [
        record('shimmer3-old', 'lnAccel', 0, [2051, 2043, 2049]),
        record('shimmer3-old', 'mag', 1, [1, 2, 3]),
      ]),
    );
    const out = selectDumpCalibrations(dump, 'shimmer3-old');
    expect(out.lnAccel![0].offset).toEqual([2051, 2043, 2049]);
    expect(out.mag![1].offset).toEqual([1, 2, 3]);
    // Reading the same dump as a Shimmer3R finds nothing: the ids differ.
    expect(selectDumpCalibrations(dump, 'shimmer3r')).toEqual({});
  });

  it('returns an empty map for an empty dump', () => {
    expect(selectDumpCalibrations(parseCalibDump(new Uint8Array(64)), 'shimmer3r')).toEqual({});
  });
});
