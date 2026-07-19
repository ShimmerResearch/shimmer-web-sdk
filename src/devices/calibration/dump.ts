/**
 * Calibration-dump (0x9A GET_CALIB_DUMP) wire-format codec and the
 * calibration source-priority ladder.
 *
 * Ported from the Shimmer Java driver:
 *   ShimmerDevice.calibByteDumpParse (:4319-4406) / calibByteDumpGenerate (:4255-4310)
 *   CalibDetails.CALIB_READ_SOURCE (:20-28) — source priority ordering
 *
 * Dump layout (all multi-byte little-endian unless noted):
 *   0   u16  packet length (= dump.length − 2)
 *   2   8B   version object: HwID u16, FwID u16, FwMajor u16, FwMinor u8, FwInternal u8
 *   10+ records, each:
 *          u16  sensorId
 *          u8   range
 *          u8   calibLen
 *          8B   timestamp ticks (LSB first)
 *          calibLen bytes calibration payload (a 21-byte kinematic block for IMU)
 */

/** One record parsed from a calibration dump. */
export interface CalibDumpRecord {
  sensorId: number;
  range: number;
  /** Calibration payload length (21 for a kinematic block). */
  calibLen: number;
  /** 8-byte calibration timestamp (LSB first). All-zero = default/seeded. */
  timestampTicks: Uint8Array;
  /** Raw calibration payload bytes. */
  calibBytes: Uint8Array;
  /** True when the timestamp is all-zero (a default/seeded calibration). */
  isDefault: boolean;
}

/** Version identity from a calibration dump header. */
export interface CalibDumpVersion {
  hardwareId: number;
  firmwareId: number;
  firmwareMajor: number;
  firmwareMinor: number;
  firmwareInternal: number;
}

/** Parsed calibration dump. */
export interface CalibDump {
  packetLength: number;
  version: CalibDumpVersion;
  records: CalibDumpRecord[];
}

/**
 * Parse a 0x9A calibration dump. Tolerant of a trailing partial record (the
 * Java loop `while(remainingBytes.length>12)` stops before an incomplete one).
 * An all-zero buffer yields an empty record list (Java early-returns).
 */
export function parseCalibDump(bytes: Uint8Array): CalibDump {
  const packetLength = bytes.length >= 2 ? bytes[0] | (bytes[1] << 8) : 0;
  const version: CalibDumpVersion =
    bytes.length >= 10
      ? {
          hardwareId: bytes[2] | (bytes[3] << 8),
          firmwareId: bytes[4] | (bytes[5] << 8),
          firmwareMajor: bytes[6] | (bytes[7] << 8),
          firmwareMinor: bytes[8],
          firmwareInternal: bytes[9],
        }
      : {
          hardwareId: 0,
          firmwareId: 0,
          firmwareMajor: 0,
          firmwareMinor: 0,
          firmwareInternal: 0,
        };

  const records: CalibDumpRecord[] = [];
  const allZero = bytes.every((b) => b === 0);
  if (!allZero && bytes.length > 10) {
    let off = 10;
    // Header of a record is 12 bytes (id 2 + range 1 + len 1 + ts 8); the Java
    // guard `remainingBytes.length>12` requires strictly more than 12 remaining.
    while (bytes.length - off > 12) {
      const sensorId = bytes[off] | (bytes[off + 1] << 8);
      const range = bytes[off + 2];
      const calibLen = bytes[off + 3];
      const timestampTicks = bytes.slice(off + 4, off + 12);
      const start = off + 12;
      const end = start + calibLen;
      if (bytes.length < end) break; // trailing partial record dropped
      const calibBytes = bytes.slice(start, end);
      records.push({
        sensorId,
        range,
        calibLen,
        timestampTicks,
        calibBytes,
        isDefault: timestampTicks.every((b) => b === 0),
      });
      off = end;
    }
  }

  return { packetLength, version, records };
}

/**
 * Serialize a calibration dump (inverse of {@link parseCalibDump}) — used by
 * tests to build round-trippable fixtures.
 */
export function generateCalibDump(
  version: CalibDumpVersion,
  records: CalibDumpRecord[],
): Uint8Array {
  let bodyLen = 8; // version object
  for (const r of records) bodyLen += 12 + r.calibBytes.length;
  const total = 2 + bodyLen;
  const out = new Uint8Array(total);
  const len = total - 2;
  out[0] = len & 0xff;
  out[1] = (len >> 8) & 0xff;
  out[2] = version.hardwareId & 0xff;
  out[3] = (version.hardwareId >> 8) & 0xff;
  out[4] = version.firmwareId & 0xff;
  out[5] = (version.firmwareId >> 8) & 0xff;
  out[6] = version.firmwareMajor & 0xff;
  out[7] = (version.firmwareMajor >> 8) & 0xff;
  out[8] = version.firmwareMinor & 0xff;
  out[9] = version.firmwareInternal & 0xff;
  let off = 10;
  for (const r of records) {
    out[off] = r.sensorId & 0xff;
    out[off + 1] = (r.sensorId >> 8) & 0xff;
    out[off + 2] = r.range & 0xff;
    out[off + 3] = r.calibBytes.length & 0xff;
    out.set(r.timestampTicks.subarray(0, 8), off + 4);
    out.set(r.calibBytes, off + 12);
    off += 12 + r.calibBytes.length;
  }
  return out;
}

/**
 * Calibration read-source priority ladder (CalibDetails.CALIB_READ_SOURCE
 * :20-28). A calibration from a higher-priority source overrides one from a
 * lower-priority source; equal priority also overrides (Java uses `>=`).
 */
export const CALIB_READ_SOURCE = Object.freeze({
  UNKNOWN: 0,
  SD_HEADER: 1,
  LEGACY_BT_COMMAND: 2,
  INFOMEM: 3,
  RADIO_DUMP: 4,
  FILE_DUMP: 5,
  USER_MODIFIED: 6,
} as const);

export type CalibReadSource = (typeof CALIB_READ_SOURCE)[keyof typeof CALIB_READ_SOURCE];

/**
 * Whether a new calibration from `incoming` should replace one currently held
 * from `current`. Mirrors the Java guard in CalibDetails.parseCalibDump:
 *   `if (calibTimeMs > getCalibTimeMs()
 *        || calibReadSource.ordinal() >= getCalibReadSource().ordinal())`
 *
 * The timestamp arguments are optional and additive: when both are supplied a
 * strictly-newer incoming calibration timestamp wins regardless of source
 * priority (a fresher on-device calibration overrides a stale higher-priority
 * one). Omitting them falls back to the source-ordinal comparison alone, which
 * preserves the previous behaviour.
 */
export function shouldOverrideCalibration(
  current: CalibReadSource,
  incoming: CalibReadSource,
  currentTimeMs?: number,
  incomingTimeMs?: number,
): boolean {
  if (
    currentTimeMs !== undefined &&
    incomingTimeMs !== undefined &&
    incomingTimeMs > currentTimeMs
  ) {
    return true;
  }
  return incoming >= current;
}
