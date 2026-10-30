/**
 * The Shimmer3 / Shimmer3R event channel's records: the user button's and the
 * TTL input's edges, each with its own RTC time, written to an event file
 * beside every SD data file and, to a Bluetooth host that opts in, streamed as
 * in-stream frames.
 *
 * One record layout serves both. Format: log-and-stream-common
 * `docs/SHIMMER3_EVENT_CHANNEL.md` §4.2 (file) and
 * `docs/SHIMMER3_BT_COMMUNICATION_PROTOCOL.md` §7.15 (frame and status); the
 * encoder is `Events/shimmer_event_record.c`, whose host test pins the bytes of
 * the worked examples this module's tests decode.
 *
 * HARDWARE-VERIFY: decoded from the firmware's own encoder and doc examples
 * only; no event file or frame from a device has been read through this SDK.
 */

import { CRC_MODE, verifyCrc } from '../shimmer3r/crcMode.js';
import { NEED_MORE, RESYNC } from '../../core/framing.js';

/** The RTC the records are timed by: 32768 ticks a second. */
export const EVENT_TICKS_PER_SECOND = 32768;

/** Event file and record sizes, and the file's magic. */
export const EVENT_FILE = Object.freeze({
  MAGIC: 'SEVT',
  /** The only format version this decoder knows. */
  FORMAT_VERSION: 1,
  HEADER_LENGTH: 64,
  RECORD_LENGTH: 16,
} as const);

/** Record type, byte 0. 0x10 and up are reserved. */
export const EVENT_RECORD_TYPE = Object.freeze({
  /** An input changed. */
  EDGE: 0x01,
  /** Each input's state at a file's open, or at a Bluetooth opt-in. */
  INITIAL_STATE: 0x02,
  /** Nothing was recorded for 60 s; with {@link EVENT_RECORD_FLAG.FINAL}, the file's end. */
  HEARTBEAT: 0x03,
  /** Edges were lost just before this point. */
  OVERFLOW: 0x04,
} as const);

/** Record flags, byte 1. Bit 6 is never written. */
export const EVENT_RECORD_FLAG = Object.freeze({
  /** The time was latched by a timer (TTL edges). */
  HW_CAPTURE: 0x01,
  /** An edge the debounce first took as bounce, put back at its own time. */
  SYNTHESIZED: 0x02,
  /** A TTL capture read more than 32.768 ms after it happened (Shimmer3R). */
  LATE: 0x04,
  /** Reserved. */
  STATE_STALE: 0x08,
  /** The last record of a file. */
  FINAL: 0x80,
} as const);

/** Record channel, byte 12. */
export const EVENT_CHANNEL = Object.freeze({
  BUTTON: 0x00,
  TTL: 0x01,
  /** Records that describe no one input: initial state, heartbeat. */
  NONE: 0xff,
} as const);

/** Bits of a record's state byte, and of a file header's or status's input mask. */
export const EVENT_INPUT = Object.freeze({
  BUTTON: 0x01,
  TTL: 0x02,
} as const);

/** One record, decoded. */
export interface EventRecord {
  /** {@link EVENT_RECORD_TYPE}. */
  type: number;
  /** {@link EVENT_RECORD_FLAG} bits. */
  flags: number;
  /**
   * Sequence number. In a file it continues across a split; over Bluetooth it
   * is the link's own, from 0 at the opt-in, so a gap is records the link lost.
   */
  seq: number;
  /** RTC ticks at 32768 Hz, all 64 bits. Its low 24 bits line up with a data packet's timestamp. */
  ticks: bigint;
  /** {@link EVENT_CHANNEL}. */
  channel: number;
  /** Every input's state after this record, {@link EVENT_INPUT} bits. */
  state: number;
  /** Whether the button is held after this record. */
  buttonDown: boolean;
  /** Whether the TTL input is high after this record. */
  ttlHigh: boolean;
  /** Edges lost so far this session (in a file) or since the opt-in (over Bluetooth); stops at 0xFFFF. */
  dropped: number;
}

/**
 * Decode the 16-byte record at `bytes[offset]`.
 *
 * @throws RangeError when fewer than 16 bytes remain
 */
export function parseEventRecord(bytes: Uint8Array, offset = 0): EventRecord {
  if (bytes.length < offset + EVENT_FILE.RECORD_LENGTH) {
    throw new RangeError(`An event record needs 16 bytes; ${bytes.length - offset} remain.`);
  }
  const b = bytes.subarray(offset, offset + EVENT_FILE.RECORD_LENGTH);
  const state = b[13];
  return {
    type: b[0],
    flags: b[1],
    seq: b[2] | (b[3] << 8),
    ticks: u64le(b, 4),
    channel: b[12],
    state,
    buttonDown: (state & EVENT_INPUT.BUTTON) !== 0,
    ttlHigh: (state & EVENT_INPUT.TTL) !== 0,
    dropped: b[14] | (b[15] << 8),
  };
}

/** A short description of a record, such as `Button pressed` or `TTL low`. */
export function describeEventRecord(rec: EventRecord): string {
  switch (rec.type) {
    case EVENT_RECORD_TYPE.EDGE:
      if (rec.channel === EVENT_CHANNEL.BUTTON)
        return rec.buttonDown ? 'Button pressed' : 'Button released';
      if (rec.channel === EVENT_CHANNEL.TTL) return rec.ttlHigh ? 'TTL high' : 'TTL low';
      return `Edge on channel ${rec.channel}`;
    case EVENT_RECORD_TYPE.INITIAL_STATE:
      return 'Initial state';
    case EVENT_RECORD_TYPE.HEARTBEAT:
      return rec.flags & EVENT_RECORD_FLAG.FINAL ? 'End of file' : 'Heartbeat';
    case EVENT_RECORD_TYPE.OVERFLOW:
      return 'Edges lost';
    default:
      return `Record type 0x${rec.type.toString(16).padStart(2, '0')}`;
  }
}

/** Why an event file was opened, header byte 36. */
export const EVENT_FILE_OPEN_REASON = Object.freeze({
  SESSION_START: 1,
  SPLIT: 2,
} as const);

/** An event file's 64-byte header, decoded. */
export interface EventFileHeader {
  version: number;
  headerLength: number;
  recordLength: number;
  /** 3 Shimmer3, 10 Shimmer3R. */
  hardwareId: number;
  /** The data file's initial timestamp, all 64 bits: pair the two files by it. */
  fileOpenTicks: bigint;
  /**
   * Shimmer3: the offset from boot time to real-world time (as SD header bytes
   * 44-51), added to a record's ticks for real-world time. Shimmer3R: 0, its
   * RTC already counts real-world time.
   */
  rtcOffsetTicks: bigint;
  /** Config time, Unix seconds. */
  configTime: number;
  firmwareId: number;
  firmwareVersion: { major: number; minor: number; internal: number };
  /** The first record's sequence number; non-zero after a split. */
  firstSeq: number;
  /** {@link EVENT_FILE_OPEN_REASON}. */
  openReason: number;
  /** Which inputs the file records, {@link EVENT_INPUT} bits. */
  inputs: number;
}

/** Thrown for bytes that are not an event file this decoder can read. */
export class EventFileFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventFileFormatError';
  }
}

/** A decoded event file. */
export interface EventFile {
  header: EventFileHeader;
  records: EventRecord[];
  /** Bytes after the last whole record, from a file cut short mid-write. */
  trailingBytes: number;
  /** Whether the file ends with a final record. Without one it was cut short, by a flat battery say. */
  complete: boolean;
}

/**
 * Decode an event file: `events/<experiment>/<session>/<NNN>` on the card, the
 * partner of `data/<experiment>/<session>/<NNN>`.
 *
 * The header's own lengths are honoured, so a later format with a longer header
 * or longer records still decodes, its extra bytes skipped.
 *
 * @throws EventFileFormatError when the magic, version or lengths are wrong
 */
export function parseEventFile(bytes: Uint8Array): EventFile {
  if (bytes.length < 8) throw new EventFileFormatError('Too short to be an event file.');
  const magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  if (magic !== EVENT_FILE.MAGIC) {
    throw new EventFileFormatError(`Not an event file: starts "${magic}", not "SEVT".`);
  }
  const version = bytes[4];
  if (version !== EVENT_FILE.FORMAT_VERSION) {
    throw new EventFileFormatError(`Event file format version ${version} is not supported.`);
  }
  const headerLength = bytes[5];
  const recordLength = bytes[6];
  if (headerLength < EVENT_FILE.HEADER_LENGTH || recordLength < EVENT_FILE.RECORD_LENGTH) {
    throw new EventFileFormatError(
      `Event file header gives a ${headerLength}-byte header and ${recordLength}-byte records; ` +
        `at least ${EVENT_FILE.HEADER_LENGTH} and ${EVENT_FILE.RECORD_LENGTH} are needed.`,
    );
  }
  if (bytes.length < headerLength)
    throw new EventFileFormatError('Event file header is cut short.');

  const header: EventFileHeader = {
    version,
    headerLength,
    recordLength,
    hardwareId: bytes[7],
    fileOpenTicks: u64le(bytes, 8),
    rtcOffsetTicks: BigInt.asIntN(64, u64le(bytes, 16)),
    configTime: (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + bytes[27] * 2 ** 24,
    firmwareId: bytes[28] | (bytes[29] << 8),
    firmwareVersion: { major: bytes[30] | (bytes[31] << 8), minor: bytes[32], internal: bytes[33] },
    firstSeq: bytes[34] | (bytes[35] << 8),
    openReason: bytes[36],
    inputs: bytes[37],
  };

  const records: EventRecord[] = [];
  let pos = headerLength;
  while (pos + recordLength <= bytes.length) {
    records.push(parseEventRecord(bytes, pos));
    pos += recordLength;
  }
  const last = records[records.length - 1];
  return {
    header,
    records,
    trailingBytes: bytes.length - pos,
    complete: last !== undefined && (last.flags & EVENT_RECORD_FLAG.FINAL) !== 0,
  };
}

/**
 * A record's real-world time in Unix milliseconds: its ticks, plus the file's
 * RTC offset on a Shimmer3, at 32768 a second.
 *
 * HARDWARE-VERIFY: the Shimmer3 offset's sign follows the firmware
 * (`RTC_getRwcTimeDiffPtr`, added to the RTC for real-world time); no Shimmer3
 * event file has been decoded.
 */
export function eventTicksToUnixMs(ticks: bigint, rtcOffsetTicks = 0n): number {
  return (Number(ticks + rtcOffsetTicks) * 1000) / EVENT_TICKS_PER_SECOND;
}

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

/** Opcodes of the event channel's Bluetooth commands and responses. */
export const EVENT_CHANNEL_OPCODES = Object.freeze({
  /** `[0x8A][0xBB][len][record][CRC-16 LE]`, only to a host that opted in. */
  EVENT_RECORD_RESPONSE: 0xbb,
  GET_EVENT_CHANNEL_STATUS_COMMAND: 0xb9,
  /** `[ACK][0xBA][status × 9]`. */
  EVENT_CHANNEL_STATUS_RESPONSE: 0xba,
} as const);

/** `[0x8A]`, the in-stream prefix the record frame shares. */
const INSTREAM_PREFIX = 0x8a;
/** Prefix, subtype and length byte. */
const FRAME_HEAD = 3;
/** The frame's own CRC-16. */
const FRAME_CRC = 2;
/**
 * The longest record length a frame is believed to carry. The firmware sends
 * 16; a later one may send more, which a host skips. Anything larger is taken
 * for a stray 0x8A rather than a giant frame.
 */
const MAX_FRAME_RECORD_LENGTH = 64;

/** The length of a frame with the firmware's 16-byte record: 21. */
export const EVENT_FRAME_LENGTH = FRAME_HEAD + EVENT_FILE.RECORD_LENGTH + FRAME_CRC;

/**
 * The length of the event record frame at `buf[at]`, or `NEED_MORE` when the
 * buffer ends before that can be told, or `RESYNC` when it is not one.
 *
 * The frame carries its own CRC-16 (seed 0xB0CA, as the link CRC) whatever
 * CRC mode the link is in, and never the link CRC on top. A frame is only
 * taken once that CRC checks out, which is what lets a parser find one between
 * stream data packets with confidence.
 */
export function eventFrameLength(buf: Uint8Array, at = 0): number {
  if (buf.length < at + 1) return NEED_MORE;
  if (buf[at] !== INSTREAM_PREFIX) return RESYNC;
  if (buf.length < at + 2) return NEED_MORE;
  if (buf[at + 1] !== EVENT_CHANNEL_OPCODES.EVENT_RECORD_RESPONSE) return RESYNC;
  if (buf.length < at + FRAME_HEAD) return NEED_MORE;
  const recLen = buf[at + 2];
  if (recLen < EVENT_FILE.RECORD_LENGTH || recLen > MAX_FRAME_RECORD_LENGTH) return RESYNC;
  const total = FRAME_HEAD + recLen + FRAME_CRC;
  if (buf.length < at + total) return NEED_MORE;
  return verifyCrc(buf.subarray(at, at + total), CRC_MODE.TWO_BYTE) ? total : RESYNC;
}

/**
 * Decode a whole record frame, `[0x8A][0xBB][len][record][CRC]`.
 *
 * @returns the record, or null when the bytes are not a frame whose CRC checks out
 */
export function parseEventFrame(frame: Uint8Array): EventRecord | null {
  // NEED_MORE is -1 and RESYNC 0; a frame is a positive length.
  if (eventFrameLength(frame, 0) <= 0) return null;
  return parseEventRecord(frame, FRAME_HEAD);
}

/** The answer to `GET_EVENT_CHANNEL_STATUS_COMMAND` (0xB9). */
export interface EventChannelStatus {
  /** Inputs the configuration enables, {@link EVENT_INPUT} bits. */
  inputsEnabled: number;
  /** The stream is on for this connection, as asked; the task applies it moments later. */
  streaming: boolean;
  /** An event file is open. */
  fileOpen: boolean;
  /** The event file was stopped by an error, this session or the last. */
  fileError: boolean;
  /** The TTL input is armed. */
  ttlArmed: boolean;
  /** The TTL input is switched off for a second after a flood. */
  ttlThrottled: boolean;
  /** Each input's state now, {@link EVENT_INPUT} bits. */
  state: number;
  /** The link's next sequence number. */
  nextSeq: number;
  /** Edges lost this session: the event file's dropped count. */
  sessionDropped: number;
  /** Records the link lost since the opt-in, because its queue was full. */
  linkLost: number;
}

/** Length of the status payload after the 0xBA opcode. */
export const EVENT_CHANNEL_STATUS_LENGTH = 9;

/**
 * Decode the 9 status bytes that follow `EVENT_CHANNEL_STATUS_RESPONSE`.
 *
 * @throws RangeError when fewer than 9 bytes are given
 */
export function parseEventChannelStatus(payload: Uint8Array): EventChannelStatus {
  if (payload.length < EVENT_CHANNEL_STATUS_LENGTH) {
    throw new RangeError(`Event channel status needs 9 bytes; got ${payload.length}.`);
  }
  const flags = payload[1];
  return {
    inputsEnabled: payload[0],
    streaming: (flags & 0x01) !== 0,
    fileOpen: (flags & 0x02) !== 0,
    fileError: (flags & 0x04) !== 0,
    ttlArmed: (flags & 0x08) !== 0,
    ttlThrottled: (flags & 0x10) !== 0,
    state: payload[2],
    nextSeq: payload[3] | (payload[4] << 8),
    sessionDropped: payload[5] | (payload[6] << 8),
    linkLost: payload[7] | (payload[8] << 8),
  };
}

function u64le(b: Uint8Array, at: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[at + i]);
  return v;
}
