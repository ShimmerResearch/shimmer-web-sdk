/**
 * SD-log packet decoding — single file and multi-file session.
 *
 * Ported from the Shimmer Java driver:
 *   ShimmerSDLog#readPacketMsg / #isEndOfFile — read loop and sync-block
 *     accounting (the 9-byte timestamp-offset field before the first packet
 *     of each 512-byte block is consumed and DISCARDED; porting the sync
 *     algorithm itself is out of scope)
 *   ShimmerObject#unwrapTimeStamp / #parseTimestampShimmer3 — rollover
 *     unwrapping and tick→ms conversion
 *   ParserLoggedDataToDatabase#createMapOfFiles / #parseDataToDB /
 *   #compareSDHeader — numeric file ordering + cross-file consistency
 *     (modern files are self-contained: each restarts its own unwrap state
 *     and carries its own initial timestamp; only legacy 0.5.x — out of
 *     scope — carried rollover state across files)
 */

import { SDLOG_CLOCK_FREQ, SDLOG_SYNC_OFFSET_LENGTH } from './constants.js';
import { decodeSdLogValue } from './channels.js';
import { parseSdLog, type ParsedSdLog } from './header.js';
import { SdLogFormatError, type SdLogHeader, type SdLogRecord } from './types.js';
import {
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
} from '../shimmer3r/calibration.js';
import { GSR_UNCAL_LIMIT_RANGE3 } from '../shimmer3r/constants.js';
import { buildSdLogCalibPlan, applyCalibPlan } from './calibrate.js';

/** Options accepted by {@link decodeSdLogFile} and {@link decodeSdSession}. */
export interface SdLogDecodeOptions {
  /** Stop after this many records (the result is flagged `truncated`). */
  maxRecords?: number;
}

/** Result of decoding one SD-log file or a whole session. */
export interface SdLogDecodeResult {
  header: SdLogHeader;
  records: SdLogRecord[];
  /** True when decoding stopped early because `maxRecords` was reached. */
  truncated: boolean;
}

/**
 * Convert a raw GSR sample to conductance in µS, reusing the streaming
 * clients' amplifier-equation path (Shimmer3Client/Shimmer3RClient
 * #_calibrateData) seeded with the header's GSR range setting.
 */
// HARDWARE-VERIFY: GSR amplifier-equation calibration is shared by the SDK's
// Shimmer3 and Shimmer3R streaming clients; confirm it holds for SD-logged
// GSR data on older (pre-GSR+) Shimmer3 expansion boards.
function calibrateGsr(raw: number, gsrRangeSetting: number): number {
  let adc12 = raw & 0x0fff;
  let range = gsrRangeSetting;
  if (range === 4) {
    range = (raw >> 14) & 0x03; // auto-range: range travels in bits 14-15
  }
  if (range === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3) {
    adc12 = GSR_UNCAL_LIMIT_RANGE3;
  }
  let gsrkOhm = calibrateGsrDataToResistanceFromAmplifierEq(adc12, range);
  gsrkOhm = nudgeGsrResistance(gsrkOhm, gsrRangeSetting);
  return (1.0 / gsrkOhm) * 1000;
}

interface DecodeBudget {
  remaining: number;
  truncated: boolean;
}

function decodeRecordsFromFile(
  bytes: Uint8Array,
  parsed: ParsedSdLog,
  out: SdLogRecord[],
  budget: DecodeBudget,
): void {
  const { header, channels, syncFraming, samplesPerBlock, wallClockFreqHz } = parsed;
  // Build the inertial calibration plan once per file. This also flips the
  // affected channel specs to calibrated:true / unit and records per-group
  // metadata on the header (header.calibration), mirroring how GSR is emitted
  // calibrated. LN accel, WR accel, gyro, mag (+ Shimmer3R alt accel/mag).
  const calibPlan = buildSdLogCalibPlan(header, channels);
  header.calibration = calibPlan.info;
  const packetSize = header.packetSizeBytes;
  const tsBytes = header.timestampBytes;
  const maxTicks = 2 ** (8 * tsBytes);
  const initialTicks = header.initialTimestampTicks;
  const rtcTicks = Number(header.rtcDifferenceTicks);
  const hasRtc = header.rtcDifferenceTicks !== 0n;

  // Per-file rollover state (ShimmerObject#unwrapTimeStamp): modern files
  // restart from cycle 0 with their own header initial timestamp.
  let cycle = 0;
  let lastUnwrapped = 0;
  // ShimmerObject#parseTimestampShimmer3 subtracts the FIRST packet's raw
  // timestamp before adding the header's initial timestamp: on modern
  // firmware the 5-byte initial timestamp is the full clock at the first
  // packet, whose low bytes are that packet's raw timestamp — without the
  // subtraction those low bytes would be double-counted
  // (mFirstTsOffsetFromInitialTsTicks in the Java driver).
  let firstRawTicks: number | null = null;

  let pos = header.headerLengthBytes;
  let samplesInBlock = 0;

  while (budget.remaining > 0) {
    // ShimmerSDLog#readPacketMsg: the first packet of the file and the first
    // packet after every `samplesPerBlock` packets is prefixed by the 9-byte
    // sync timestamp-offset field, which is read and discarded here.
    const withOffset = syncFraming && (samplesInBlock === 0 || samplesInBlock === samplesPerBlock);
    const need = withOffset ? SDLOG_SYNC_OFFSET_LENGTH + packetSize : packetSize;
    if (pos + need > bytes.length) break; // trailing partial packet is dropped (Java EOF)

    let p = pos;
    if (withOffset) {
      p += SDLOG_SYNC_OFFSET_LENGTH; // discard the offset value
      samplesInBlock = 0;
    }

    // Timestamp: u16/u24 little-endian, unwrapped against rollovers.
    let rawTs = bytes[p] | (bytes[p + 1] << 8);
    if (tsBytes === 3) rawTs |= bytes[p + 2] << 16;
    p += tsBytes;
    let unwrapped = rawTs + maxTicks * cycle;
    if (unwrapped < lastUnwrapped) {
      cycle += 1;
      unwrapped = rawTs + maxTicks * cycle;
    }
    lastUnwrapped = unwrapped;
    if (firstRawTicks === null) firstRawTicks = rawTs;

    const values = new Array<number>(channels.length);
    for (let c = 0; c < channels.length; c++) {
      const spec = channels[c];
      const raw = decodeSdLogValue(bytes, p, spec.dataType);
      // GSR is calibrated inline (amplifier equation). Inertial channels are
      // marked calibrated by the plan but keep their raw value here and are
      // calibrated together (per triple) by applyCalibPlan below.
      values[c] = spec.name === 'GSR' && spec.calibrated ? calibrateGsr(raw, header.gsrRange) : raw;
      p += spec.sizeBytes;
    }
    if (calibPlan.entries.length) applyCalibPlan(values, calibPlan.entries);

    const absoluteTicks = initialTicks + unwrapped - firstRawTicks;
    out.push({
      // Device-clock timestamp always divides by the 32768 Hz RTC clock
      // (ShimmerObject#getRtcClockFreq); only the wall-clock (RTC) conversion
      // below honours the TCXO sampling clock (ShimmerObject#getSamplingClockFreq).
      timestampMs: (absoluteTicks / SDLOG_CLOCK_FREQ) * 1000,
      wallClockMs: hasRtc ? ((absoluteTicks + rtcTicks) / wallClockFreqHz) * 1000 : null,
      values,
    });

    samplesInBlock += 1;
    pos += need;
    budget.remaining -= 1;
  }

  if (budget.remaining === 0) {
    const nextWithOffset =
      syncFraming && (samplesInBlock === 0 || samplesInBlock === samplesPerBlock);
    const nextNeed = nextWithOffset ? SDLOG_SYNC_OFFSET_LENGTH + packetSize : packetSize;
    if (pos + nextNeed <= bytes.length) {
      budget.truncated = true;
    }
  }
}

/**
 * Decode a single SD-log binary file (e.g. `000`) into typed records.
 *
 * @throws SdLogFormatError `NO_DATA` when the file contains only a header.
 */
export function decodeSdLogFile(bytes: Uint8Array, opts?: SdLogDecodeOptions): SdLogDecodeResult {
  const parsed = parseSdLog(bytes);
  if (bytes.length <= parsed.header.headerLengthBytes) {
    throw new SdLogFormatError(
      'NO_DATA',
      `File contains only the ${parsed.header.headerLengthBytes}-byte header — no sample data.`,
    );
  }
  const records: SdLogRecord[] = [];
  const budget: DecodeBudget = {
    remaining: opts?.maxRecords ?? Number.POSITIVE_INFINITY,
    truncated: false,
  };
  decodeRecordsFromFile(bytes, parsed, records, budget);
  return { header: parsed.header, records, truncated: budget.truncated };
}

const isDataFileName = (name: string): boolean => !name.includes('.');

/**
 * Decode a multi-file SD session (files `000`, `001`, … within one
 * `<ShimmerName>-<SessionNumber>` folder).
 *
 * - Files whose names contain a `.` are ignored (UtilDock's "a log file is a
 *   name containing no dot" rule); remaining names must be numeric.
 * - Files are concatenated in ascending numeric order.
 * - Headers must agree on MAC address, sampling rate, enabled sensors and
 *   trial id (ParserLoggedDataToDatabase#compareSDHeader), otherwise
 *   `INCONSISTENT_SESSION` is thrown.
 * - Each file restarts its own timestamp-unwrap state and uses its own
 *   header's initial timestamp, so absolute times remain continuous across
 *   file boundaries on modern firmware.
 */
export function decodeSdSession(
  files: { name: string; bytes: Uint8Array }[],
  opts?: SdLogDecodeOptions,
): SdLogDecodeResult {
  const dataFiles = files.filter((f) => isDataFileName(f.name));
  if (dataFiles.length === 0) {
    throw new SdLogFormatError('NO_DATA', 'No SD-log data files (dot-free numeric names) given.');
  }

  const numbered = dataFiles.map((f) => {
    if (!/^\d+$/.test(f.name)) {
      throw new SdLogFormatError(
        'BAD_HEADER',
        `"${f.name}" is not a valid SD-log data file name (expected digits only, e.g. "000").`,
      );
    }
    return { num: parseInt(f.name, 10), file: f };
  });
  numbered.sort((a, b) => a.num - b.num);
  for (let i = 1; i < numbered.length; i++) {
    if (numbered[i].num === numbered[i - 1].num) {
      throw new SdLogFormatError(
        'INCONSISTENT_SESSION',
        `Duplicate log file number ${numbered[i].num} in session.`,
      );
    }
  }

  const parsedFiles = numbered.map(({ file }) => ({
    name: file.name,
    bytes: file.bytes,
    parsed: parseSdLog(file.bytes),
  }));

  const first = parsedFiles[0].parsed.header;
  // Populate the returned header's calibration metadata (and calibrated channel
  // flags) even if the first file turns out to be header-only.
  first.calibration = buildSdLogCalibPlan(first, parsedFiles[0].parsed.channels).info;
  for (const { name, parsed } of parsedFiles) {
    const h = parsed.header;
    if (
      h.macAddress !== first.macAddress ||
      h.samplingRateHz !== first.samplingRateHz ||
      h.enabledSensors !== first.enabledSensors ||
      h.trial.id !== first.trial.id
    ) {
      throw new SdLogFormatError(
        'INCONSISTENT_SESSION',
        `Header of file "${name}" does not match the session's first file (MAC/rate/sensors/trial id).`,
      );
    }
  }

  const withData = parsedFiles.filter((f) => f.bytes.length > f.parsed.header.headerLengthBytes);
  if (withData.length === 0) {
    throw new SdLogFormatError('NO_DATA', 'No file in the session contains sample data.');
  }

  const records: SdLogRecord[] = [];
  const budget: DecodeBudget = {
    remaining: opts?.maxRecords ?? Number.POSITIVE_INFINITY,
    truncated: false,
  };
  for (const f of withData) {
    if (budget.remaining <= 0) {
      budget.truncated = true;
      break;
    }
    decodeRecordsFromFile(f.bytes, f.parsed, records, budget);
  }
  return { header: first, records, truncated: budget.truncated };
}
