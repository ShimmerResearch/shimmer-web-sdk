import { describe, it, expect } from 'vitest';
import {
  applyDuplicateSuffix,
  buildParsedCsvFileName,
  buildUploadBinaryFileName,
  evaluateParsedFileSplit,
  getFirstPayloadIndex,
  nextAvailableDuplicateFileName,
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

  it('applies duplicate suffix and finds next available duplicate name', () => {
    expect(applyDuplicateSuffix('a.csv', 2)).toBe('a (2).csv');

    const existing = new Set(['a.csv', 'a (2).csv', 'a (3).csv']);
    expect(nextAvailableDuplicateFileName('a.csv', existing)).toBe('a (4).csv');
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
