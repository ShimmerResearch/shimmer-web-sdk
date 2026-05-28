import { u16le_at } from './protocolUtils.js';

export type ParsedSplitReason =
  | 'midday-midnight-boundary'
  | 'config-change'
  | 'timestamp-discontinuity'
  | 'power-reset';

export interface EvaluateParsedSplitInput {
  prevTimestampSec: number;
  currTimestampSec: number;
  expectedDeltaSec?: number;
  timestampToleranceSec?: number;
  prevConfigSignature?: string | null;
  currConfigSignature?: string | null;
  powerResetDetected?: boolean;
}

function pad2(n: number): string {
  return Math.trunc(n).toString().padStart(2, '0');
}

function pad5(n: number): string {
  return Math.trunc(n).toString().padStart(5, '0');
}

function dateToYyMMddHHmmss(date: Date): string {
  const yy = pad2(date.getUTCFullYear() % 100);
  const mm = pad2(date.getUTCMonth() + 1);
  const dd = pad2(date.getUTCDate());
  const hh = pad2(date.getUTCHours());
  const min = pad2(date.getUTCMinutes());
  const ss = pad2(date.getUTCSeconds());
  return `${yy}${mm}${dd}_${hh}${min}${ss}`;
}

/** Build a binary upload file name: yyMMdd_HHmmss_00000.bin */
export function buildUploadBinaryFileName(uploadDate: Date, firstPayloadIndex: number): string {
  if (!Number.isFinite(firstPayloadIndex) || firstPayloadIndex < 0 || firstPayloadIndex > 0xffff) {
    throw new Error('buildUploadBinaryFileName: firstPayloadIndex must be in range 0..65535');
  }
  return `${dateToYyMMddHHmmss(uploadDate)}_${pad5(firstPayloadIndex)}.bin`;
}

/** Build parsed CSV file name: yyMMdd_HHmmss_DataSource_00000.csv */
export function buildParsedCsvFileName(
  startDate: Date,
  dataSource: string,
  firstPayloadIndex: number,
): string {
  if (!dataSource || !String(dataSource).trim()) {
    throw new Error('buildParsedCsvFileName: dataSource must be a non-empty string');
  }
  if (!Number.isFinite(firstPayloadIndex) || firstPayloadIndex < 0 || firstPayloadIndex > 0xffff) {
    throw new Error('buildParsedCsvFileName: firstPayloadIndex must be in range 0..65535');
  }
  return `${dateToYyMMddHHmmss(startDate)}_${String(dataSource).trim()}_${pad5(firstPayloadIndex)}.csv`;
}

/** Add duplicate suffix like " (2)" before extension. */
export function applyDuplicateSuffix(fileName: string, duplicateIndex: number): string {
  if (duplicateIndex < 2) {
    throw new Error('applyDuplicateSuffix: duplicateIndex must be >= 2');
  }

  const idx = fileName.lastIndexOf('.');
  if (idx <= 0) return `${fileName} (${duplicateIndex})`;

  const stem = fileName.slice(0, idx);
  const ext = fileName.slice(idx);
  return `${stem} (${duplicateIndex})${ext}`;
}

/** Return first non-colliding duplicate name for a target file name. */
export function nextAvailableDuplicateFileName(
  fileName: string,
  existingNames: Iterable<string>,
): string {
  const existing = new Set(existingNames);
  if (!existing.has(fileName)) return fileName;

  let i = 2;
  while (true) {
    const candidate = applyDuplicateSuffix(fileName, i);
    if (!existing.has(candidate)) return candidate;
    i++;
  }
}

/** Parse first payload index (uint16 LE) from a payload byte array. */
export function getFirstPayloadIndex(payload: Uint8Array): number {
  if (payload.length < 2) {
    throw new Error('getFirstPayloadIndex: payload must contain at least 2 bytes');
  }
  return u16le_at(payload, 0);
}

/**
 * Evaluate whether parsed CSV output should roll to a new file.
 * Rules mirror ASM-DES08 split conditions.
 */
export function evaluateParsedFileSplit(input: EvaluateParsedSplitInput): {
  shouldSplit: boolean;
  reasons: ParsedSplitReason[];
} {
  const reasons: ParsedSplitReason[] = [];

  const prev = input.prevTimestampSec;
  const curr = input.currTimestampSec;

  // Split when crossing 12:00am or 12:00pm boundaries.
  const prevHalfDay = Math.floor(prev / (12 * 60 * 60));
  const currHalfDay = Math.floor(curr / (12 * 60 * 60));
  if (currHalfDay !== prevHalfDay) reasons.push('midday-midnight-boundary');

  if ((input.prevConfigSignature ?? null) !== (input.currConfigSignature ?? null)) {
    reasons.push('config-change');
  }

  if (input.expectedDeltaSec != null) {
    const tol = Math.max(0, input.timestampToleranceSec ?? 0);
    const delta = curr - prev;
    if (Math.abs(delta - input.expectedDeltaSec) > tol) {
      reasons.push('timestamp-discontinuity');
    }
  }

  if (input.powerResetDetected) {
    reasons.push('power-reset');
  }

  return { shouldSplit: reasons.length > 0, reasons };
}
