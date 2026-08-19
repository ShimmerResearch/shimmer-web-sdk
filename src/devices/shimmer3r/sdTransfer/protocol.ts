/**
 * Wire protocol for Shimmer3R SD-card file transfer over BLE.
 *
 * Mirrors the firmware implementation in
 * `log-and-stream-common/Comms/shimmer_sd_file_transfer.{c,h}` (FW >= v1.01.009).
 *
 * Command/response shapes (all multi-byte fields little-endian):
 *
 *   SD_LIST_DIR_COMMAND  0xCC: [startIdx u16][maxEntries u8][pathLen u8][path]
 *   SD_LIST_DIR_RESPONSE 0xC1: [status][startIdx u16][entriesLen u16][nEntries][flags][entries…]
 *       entry: [attr][size u32][fdate u16][ftime u16][nameLen][name…]
 *   SD_FILE_STAT_COMMAND 0xC2: [pathLen u8][path]
 *   SD_FILE_STAT_RESPONSE 0xC3: [status][size u32][fdate u16][ftime u16][attr]
 *   SD_FILE_READ_COMMAND 0xC4: [offset u32][windowLen u32][blockPayloadLen u16][pathLen u8][path]
 *   SD_FREE_SPACE_COMMAND 0xC8 / RESPONSE 0xC9: [status][freeKB u32][totalKB u32]
 *   SD_DELETE_COMMAND 0xCA / RESPONSE 0xCB: [status]
 *   SD_TRANSFER_ABORT_COMMAND 0xC7: no args
 *
 * Streamed frames (always self-CRC'd, independent of the global CRC mode):
 *   data:   [0x8A][0xC5][sessionId][seq u16][len u16][payload…][crc16 u16]
 *   status: [0x8A][0xC6][sessionId][status][nextOffset u32][crc16 u16]
 */

export const SD_TRANSFER_OPCODES = {
  // Command opcodes must avoid the CYW20820 EZ-Serial SOF bytes 0x80/0xC0/
  // 0xD0 (the firmware's UART RX demux would route them to the EZ-Serial
  // parser instead of the Shimmer command parser) — hence LIST sits at 0xCC.
  LIST_DIR_COMMAND: 0xcc,
  LIST_DIR_RESPONSE: 0xc1,
  FILE_STAT_COMMAND: 0xc2,
  FILE_STAT_RESPONSE: 0xc3,
  FILE_READ_COMMAND: 0xc4,
  FILE_DATA_RESPONSE: 0xc5,
  FILE_STATUS_RESPONSE: 0xc6,
  TRANSFER_ABORT_COMMAND: 0xc7,
  FREE_SPACE_COMMAND: 0xc8,
  FREE_SPACE_RESPONSE: 0xc9,
  DELETE_COMMAND: 0xca,
  DELETE_RESPONSE: 0xcb,
} as const;

/** Prefix byte shared with the firmware's other instream responses. */
export const SD_INSTREAM_BYTE = 0x8a;

/** Status byte of the one-shot responses. 0x01–0x13 are raw FatFs FRESULTs. */
export const SD_STATUS = {
  OK: 0x00,
  SD_UNAVAILABLE: 0xf0,
  BUSY: 0xf1,
  BAD_ARGS: 0xf2,
} as const;

/** Codes carried in SD_FILE_STATUS_RESPONSE frames. */
export const SD_XFER = {
  WINDOW_COMPLETE: 0,
  EOF: 1,
  HOST_ABORT: 2,
  SD_LOST: 3,
  FS_ERROR: 4,
  SUPERSEDED: 5,
  DENIED: 6,
  NOT_FOUND: 7,
} as const;

export const SD_ATTR_DIR = 0x01;
export const SD_ATTR_NAME_TRUNCATED = 0x02;

export const SD_MAX_PATH_LEN = 96;
export const SD_LIST_MAX_ENTRIES = 16;
export const SD_BLOCK_PAYLOAD_MIN = 64;
export const SD_BLOCK_PAYLOAD_MAX = 1024;
export const SD_BLOCK_PAYLOAD_DEFAULT = 512;

const DATA_FRAME_HEADER_LEN = 7;
const FRAME_CRC_LEN = 2;
const STATUS_FRAME_LEN = 8 + FRAME_CRC_LEN;
const LIST_RSP_HDR_LEN = 8;

export interface SdDirEntry {
  name: string;
  isDir: boolean;
  /** Truncated by the firmware to 64 bytes; such entries cannot be addressed by path. */
  nameTruncated: boolean;
  size: number;
  fdate: number;
  ftime: number;
  /** Decoded FAT timestamp, or null when the card holds no timestamp (e.g. a file
   * that was still open for logging when it was last written). */
  mtime: Date | null;
}

export interface SdFileStat {
  size: number;
  isDir: boolean;
  fdate: number;
  ftime: number;
  mtime: Date | null;
}

export interface SdCardSpace {
  freeKB: number;
  totalKB: number;
}

export interface SdDataFrame {
  kind: 'data';
  sessionId: number;
  seq: number;
  payload: Uint8Array;
  crcOk: boolean;
}

export interface SdStatusFrame {
  kind: 'status';
  sessionId: number;
  status: number;
  nextOffset: number;
  crcOk: boolean;
}

export interface SdOneShotResponse {
  kind: 'oneshot';
  opcode: number;
  /** Complete response bytes, opcode included. */
  body: Uint8Array;
}

export type SdMessage = SdDataFrame | SdStatusFrame | SdOneShotResponse;

/** Error carrying the in-band status byte of a refused/failed SD command. */
export class SdTransferError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'SdTransferError';
  }
}

export function sdStatusToString(status: number): string {
  switch (status) {
    case SD_STATUS.OK:
      return 'OK';
    case SD_STATUS.SD_UNAVAILABLE:
      return 'SD unavailable (docked, USB-C plugged, no card or bad card)';
    case SD_STATUS.BUSY:
      return 'device busy (sensing/logging/streaming)';
    case SD_STATUS.BAD_ARGS:
      return 'bad arguments';
    default:
      return `FatFs error ${status}`;
  }
}

export function sdXferStatusToString(status: number): string {
  switch (status) {
    case SD_XFER.WINDOW_COMPLETE:
      return 'window complete';
    case SD_XFER.EOF:
      return 'end of file';
    case SD_XFER.HOST_ABORT:
      return 'aborted by host';
    case SD_XFER.SD_LOST:
      return 'SD card lost (docked or USB-C plugged)';
    case SD_XFER.FS_ERROR:
      return 'filesystem error';
    case SD_XFER.SUPERSEDED:
      return 'superseded by a newer read';
    case SD_XFER.DENIED:
      return 'denied (busy or bad arguments)';
    case SD_XFER.NOT_FOUND:
      return 'file not found';
    default:
      return `unknown transfer status ${status}`;
  }
}

// ---------------------------------------------------------------------------
// CRC16 — mirrors the firmware's ShimSwCrc (init 0xB0CA, odd-length zero pad)
// ---------------------------------------------------------------------------

const SD_CRC_INIT = 0xb0ca;

function crcByte(crc: number, b: number): number {
  crc = (((crc >> 8) & 0xff) | (crc << 8)) & 0xffff;
  crc ^= b & 0xff;
  crc ^= (crc & 0xff) >> 4;
  crc = (crc ^ (crc << 12)) & 0xffff;
  crc = (crc ^ ((crc & 0xff) << 5)) & 0xffff;
  return crc;
}

/** Shimmer CRC16 over `len` bytes of `data` (defaults to all of it). */
export function sdCrc16(data: Uint8Array, len = data.length): number {
  let crc = SD_CRC_INIT;
  for (let i = 0; i < len; i++) crc = crcByte(crc, data[i]);
  if (len % 2) crc = crcByte(crc, 0x00);
  return crc;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function u16(buf: Uint8Array, off: number): number {
  return buf[off] | (buf[off + 1] << 8);
}

function u32(buf: Uint8Array, off: number): number {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/** Encode and validate a card path (ASCII, 1..96 bytes). */
export function encodeSdPath(path: string): Uint8Array {
  if (path.length === 0 || path.length > SD_MAX_PATH_LEN) {
    throw new SdTransferError(
      `path must be 1..${SD_MAX_PATH_LEN} characters, got ${path.length}`,
      SD_STATUS.BAD_ARGS,
    );
  }
  const out = new Uint8Array(path.length);
  for (let i = 0; i < path.length; i++) {
    const c = path.charCodeAt(i);
    if (c < 0x20 || c > 0x7e) {
      throw new SdTransferError(
        `path contains non-ASCII character at index ${i}`,
        SD_STATUS.BAD_ARGS,
      );
    }
    out[i] = c;
  }
  return out;
}

/** Decode a FAT date/time pair; null when unset or invalid. */
export function fatDateTimeToDate(fdate: number, ftime: number): Date | null {
  if (!fdate) return null;
  const year = 1980 + ((fdate >> 9) & 0x7f);
  const month = (fdate >> 5) & 0x0f;
  const day = fdate & 0x1f;
  const hours = (ftime >> 11) & 0x1f;
  const minutes = (ftime >> 5) & 0x3f;
  const seconds = (ftime & 0x1f) * 2;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hours > 23 || minutes > 59 || seconds > 59) return null;
  return new Date(year, month - 1, day, hours, minutes, seconds);
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export function buildListDirCmd(
  path: string,
  startIdx = 0,
  maxEntries = SD_LIST_MAX_ENTRIES,
): Uint8Array {
  const p = encodeSdPath(path);
  const cmd = new Uint8Array(5 + p.length);
  cmd[0] = SD_TRANSFER_OPCODES.LIST_DIR_COMMAND;
  cmd[1] = startIdx & 0xff;
  cmd[2] = (startIdx >> 8) & 0xff;
  cmd[3] = maxEntries & 0xff;
  cmd[4] = p.length;
  cmd.set(p, 5);
  return cmd;
}

export function buildStatCmd(path: string): Uint8Array {
  const p = encodeSdPath(path);
  const cmd = new Uint8Array(2 + p.length);
  cmd[0] = SD_TRANSFER_OPCODES.FILE_STAT_COMMAND;
  cmd[1] = p.length;
  cmd.set(p, 2);
  return cmd;
}

export function buildDeleteCmd(path: string): Uint8Array {
  const p = encodeSdPath(path);
  const cmd = new Uint8Array(2 + p.length);
  cmd[0] = SD_TRANSFER_OPCODES.DELETE_COMMAND;
  cmd[1] = p.length;
  cmd.set(p, 2);
  return cmd;
}

export function buildFreeSpaceCmd(): Uint8Array {
  return new Uint8Array([SD_TRANSFER_OPCODES.FREE_SPACE_COMMAND]);
}

export function buildAbortCmd(): Uint8Array {
  return new Uint8Array([SD_TRANSFER_OPCODES.TRANSFER_ABORT_COMMAND]);
}

export function buildReadCmd(
  path: string,
  offset: number,
  windowLen: number,
  blockPayloadLen = SD_BLOCK_PAYLOAD_DEFAULT,
): Uint8Array {
  if (blockPayloadLen < SD_BLOCK_PAYLOAD_MIN || blockPayloadLen > SD_BLOCK_PAYLOAD_MAX) {
    throw new SdTransferError(
      `blockPayloadLen must be ${SD_BLOCK_PAYLOAD_MIN}..${SD_BLOCK_PAYLOAD_MAX}, got ${blockPayloadLen}`,
      SD_STATUS.BAD_ARGS,
    );
  }
  const p = encodeSdPath(path);
  const cmd = new Uint8Array(12 + p.length);
  cmd[0] = SD_TRANSFER_OPCODES.FILE_READ_COMMAND;
  new DataView(cmd.buffer).setUint32(1, offset >>> 0, true);
  new DataView(cmd.buffer).setUint32(5, windowLen >>> 0, true);
  new DataView(cmd.buffer).setUint16(9, blockPayloadLen, true);
  cmd[11] = p.length;
  cmd.set(p, 12);
  return cmd;
}

// ---------------------------------------------------------------------------
// One-shot response parsers (buf starts at the response opcode)
// ---------------------------------------------------------------------------

export interface SdListDirPage {
  status: number;
  startIdx: number;
  entries: SdDirEntry[];
  hasMore: boolean;
}

export function parseListDirRsp(buf: Uint8Array): SdListDirPage {
  if (buf.length < LIST_RSP_HDR_LEN || buf[0] !== SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE) {
    throw new Error('malformed SD_LIST_DIR_RESPONSE');
  }
  const status = buf[1];
  const startIdx = u16(buf, 2);
  const entriesLen = u16(buf, 4);
  const nEntries = buf[6];
  const hasMore = (buf[7] & 0x01) !== 0;
  const entries: SdDirEntry[] = [];
  let off = LIST_RSP_HDR_LEN;
  const end = LIST_RSP_HDR_LEN + entriesLen;
  if (buf.length < end) throw new Error('truncated SD_LIST_DIR_RESPONSE');
  while (off < end && entries.length < nEntries) {
    const attr = buf[off];
    const size = u32(buf, off + 1);
    const fdate = u16(buf, off + 5);
    const ftime = u16(buf, off + 7);
    const nameLen = buf[off + 9];
    const nameBytes = buf.subarray(off + 10, off + 10 + nameLen);
    entries.push({
      name: String.fromCharCode(...nameBytes),
      isDir: (attr & SD_ATTR_DIR) !== 0,
      nameTruncated: (attr & SD_ATTR_NAME_TRUNCATED) !== 0,
      size,
      fdate,
      ftime,
      mtime: fatDateTimeToDate(fdate, ftime),
    });
    off += 10 + nameLen;
  }
  return { status, startIdx, entries, hasMore };
}

export function parseStatRsp(buf: Uint8Array): { status: number; stat: SdFileStat } {
  if (buf.length < 11 || buf[0] !== SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE) {
    throw new Error('malformed SD_FILE_STAT_RESPONSE');
  }
  const fdate = u16(buf, 6);
  const ftime = u16(buf, 8);
  return {
    status: buf[1],
    stat: {
      size: u32(buf, 2),
      fdate,
      ftime,
      mtime: fatDateTimeToDate(fdate, ftime),
      isDir: (buf[10] & SD_ATTR_DIR) !== 0,
    },
  };
}

export function parseFreeSpaceRsp(buf: Uint8Array): { status: number; space: SdCardSpace } {
  if (buf.length < 10 || buf[0] !== SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE) {
    throw new Error('malformed SD_FREE_SPACE_RESPONSE');
  }
  return { status: buf[1], space: { freeKB: u32(buf, 2), totalKB: u32(buf, 6) } };
}

export function parseDeleteRsp(buf: Uint8Array): { status: number } {
  if (buf.length < 2 || buf[0] !== SD_TRANSFER_OPCODES.DELETE_RESPONSE) {
    throw new Error('malformed SD_DELETE_RESPONSE');
  }
  return { status: buf[1] };
}

// ---------------------------------------------------------------------------
// Incremental extractor
// ---------------------------------------------------------------------------

/** Expected total length of a one-shot response, or 0 if `buf` is too short
 * to tell yet, or -1 if buf[0] is not a known one-shot response opcode. */
function oneShotLength(buf: Uint8Array): number {
  switch (buf[0]) {
    case SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE:
      if (buf.length < 6) return 0;
      return LIST_RSP_HDR_LEN + u16(buf, 4);
    case SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE:
      return 11;
    case SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE:
      return 10;
    case SD_TRANSFER_OPCODES.DELETE_RESPONSE:
      return 2;
    default:
      return -1;
  }
}

export interface SdExtractResult {
  /** Bytes to drop from the front of the buffer (0 = need more data). */
  consumed: number;
  msg?: SdMessage;
  /** True when a data/status frame was recognised but failed its CRC; the
   * extractor resynchronises one byte at a time in that case. */
  crcError?: boolean;
}

/**
 * Try to extract one SD-transfer message from the front of `buf`.
 * Unknown bytes are skipped one at a time (resync) so interleaved traffic
 * (e.g. unsolicited instream status responses) cannot jam the stream.
 */
export function tryExtractSdMessage(buf: Uint8Array): SdExtractResult {
  if (buf.length === 0) return { consumed: 0 };

  if (buf[0] === SD_INSTREAM_BYTE) {
    if (buf.length < 2) return { consumed: 0 };

    if (buf[1] === SD_TRANSFER_OPCODES.FILE_DATA_RESPONSE) {
      if (buf.length < DATA_FRAME_HEADER_LEN) return { consumed: 0 };
      const len = u16(buf, 5);
      if (len === 0 || len > SD_BLOCK_PAYLOAD_MAX) return { consumed: 1 };
      const total = DATA_FRAME_HEADER_LEN + len + FRAME_CRC_LEN;
      if (buf.length < total) return { consumed: 0 };
      const crcOk =
        sdCrc16(buf, DATA_FRAME_HEADER_LEN + len) === u16(buf, DATA_FRAME_HEADER_LEN + len);
      if (!crcOk) return { consumed: 1, crcError: true };
      return {
        consumed: total,
        msg: {
          kind: 'data',
          sessionId: buf[2],
          seq: u16(buf, 3),
          payload: buf.slice(DATA_FRAME_HEADER_LEN, DATA_FRAME_HEADER_LEN + len),
          crcOk,
        },
      };
    }

    if (buf[1] === SD_TRANSFER_OPCODES.FILE_STATUS_RESPONSE) {
      if (buf.length < STATUS_FRAME_LEN) return { consumed: 0 };
      const crcOk = sdCrc16(buf, 8) === u16(buf, 8);
      if (!crcOk) return { consumed: 1, crcError: true };
      return {
        consumed: STATUS_FRAME_LEN,
        msg: { kind: 'status', sessionId: buf[2], status: buf[3], nextOffset: u32(buf, 4), crcOk },
      };
    }

    /* An instream response that is not part of the SD-transfer protocol
     * (e.g. an unsolicited status response) — resync past it. */
    return { consumed: 1 };
  }

  const len = oneShotLength(buf);
  if (len === -1) return { consumed: 1 };
  if (len === 0 || buf.length < len) return { consumed: 0 };
  return { consumed: len, msg: { kind: 'oneshot', opcode: buf[0], body: buf.slice(0, len) } };
}
