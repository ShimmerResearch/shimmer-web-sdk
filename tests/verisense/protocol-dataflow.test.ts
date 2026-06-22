import { describe, it, expect } from 'vitest';
import {
  applyDuplicateSuffix,
  buildCalibrationFileName,
  buildParsedCsvFileName,
  buildSensorFolderSegments,
  buildUploadBinaryFileName,
  evaluateParsedFileSplit,
  getFirstPayloadIndex,
  nextAvailableDuplicateFileName,
  SENSOR_DATA_SUBFOLDERS,
} from '../../src/devices/verisense/protocol.js';

describe('Verisense data-flow helpers', () => {
  it('builds upload binary filename format yyMMdd_HHmmss_00000.bin', () => {
    const d = new Date(Date.UTC(2018, 5, 25, 23, 45, 16));
    expect(buildUploadBinaryFileName(d, 1)).toBe('180625_234516_00001.bin');
  });

  it('builds parsed csv filename format yyMMdd_HHmmss_DataSource_00000.csv', () => {
    const d = new Date(Date.UTC(2019, 6, 18, 15, 34, 55));
    expect(buildParsedCsvFileName(d, 'Payload_Metadata', 0)).toBe(
      '190718_153455_Payload_Metadata_00000.csv',
    );
  });

  it('builds calibration filename format yyMMdd_HHmmss_<crc16hex>.calib', () => {
    const d = new Date(Date.UTC(2018, 5, 27, 0, 1, 10));
    expect(buildCalibrationFileName(d, 0x1a2b)).toBe('180627_000110_1A2B.calib');
    expect(buildCalibrationFileName(d, 0)).toBe('180627_000110_0000.calib');
    expect(() => buildCalibrationFileName(d, 0x10000)).toThrow(/range/);
  });

  it('applies duplicate suffix and finds next available duplicate name', () => {
    expect(applyDuplicateSuffix('a.csv', 2)).toBe('a (2).csv');

    const existing = new Set(['a.csv', 'a (2).csv', 'a (3).csv']);
    expect(nextAvailableDuplicateFileName('a.csv', existing)).toBe('a (4).csv');
  });

  it('builds the sensor folder tree segments and rejects unsafe input', () => {
    expect(buildSensorFolderSegments('TRIAL1', 'P001', '1809260136F8')).toEqual([
      'TRIAL1',
      'P001',
      '1809260136F8',
    ]);
    expect(SENSOR_DATA_SUBFOLDERS.binaryFiles).toBe('BinaryFiles');
    expect(SENSOR_DATA_SUBFOLDERS.sensorCalibration).toBe('SensorCalibration');
    expect(() => buildSensorFolderSegments('', 'P001', 'S')).toThrow(/trialId/);
    expect(() => buildSensorFolderSegments('T', 'a/b', 'S')).toThrow(/separator/);
  });

  it('extracts first payload index from payload bytes', () => {
    expect(getFirstPayloadIndex(new Uint8Array([0x34, 0x12]))).toBe(0x1234);
  });

  it('evaluates split reasons from document rules', () => {
    const split = evaluateParsedFileSplit({
      prevTimestampSec: 12 * 60 * 60 - 1,
      currTimestampSec: 12 * 60 * 60 + 1,
      expectedDeltaSec: 2,
      timestampToleranceSec: 0,
      prevConfigSignature: 'A',
      currConfigSignature: 'B',
      powerResetDetected: true,
    });

    expect(split.shouldSplit).toBe(true);
    expect(split.reasons).toContain('midday-midnight-boundary');
    expect(split.reasons).toContain('config-change');
    expect(split.reasons).toContain('power-reset');
  });
});
