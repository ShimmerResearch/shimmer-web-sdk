import {
  ASM_COMMAND,
  ASM_PROPERTY,
  type AsmCommand,
  type AsmProperty,
  type AsmProperty as PendingEventProperty,
} from './constants.js';
import { u16le, crc16_ccitt_false } from './protocolUtils.js';

export interface VerisenseMessage {
  header: number;
  command: AsmCommand;
  property: AsmProperty;
  payloadLength: number;
  payload: Uint8Array;
}

/** Build a protocol header byte from command/property nibbles. */
export function buildHeader(command: AsmCommand, property: AsmProperty): number {
  return ((command & 0xf0) | (property & 0x0f)) & 0xff;
}

/** Decode a protocol header byte into command/property fields. */
export function parseHeader(header: number): { command: AsmCommand; property: AsmProperty } {
  return {
    command: (header & 0xf0) as AsmCommand,
    property: (header & 0x0f) as AsmProperty,
  };
}

/** Build a complete protocol message (header + 16-bit LE payload length + payload bytes). */
export function buildMessage(
  command: AsmCommand,
  property: AsmProperty,
  payloadBytes: Uint8Array | number[] = [],
): Uint8Array {
  const payload = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
  const out = new Uint8Array(3 + payload.length);
  out[0] = buildHeader(command, property);
  out[1] = payload.length & 0xff;
  out[2] = (payload.length >> 8) & 0xff;
  out.set(payload, 3);
  return out;
}

// ---------------------------------------------------------------------------
// Streaming-frame framing / resynchronisation
// ---------------------------------------------------------------------------

/**
 * Header byte that prefixes every streaming data frame:
 * `RESPONSE (0x30) | STREAM_MODE (0x0a) === 0x3A`.
 */
export const STREAM_FRAME_HEADER = buildHeader(ASM_COMMAND.RESPONSE, ASM_PROPERTY.STREAM_MODE);

/** Smallest valid streaming payload: sensorId(1) + tick(3) + CRC16(2). */
export const STREAM_FRAME_MIN_PAYLOAD = 6;

/**
 * Largest streaming payload we will accept. The firmware emits each streaming
 * frame as a single BLE notification, so it can never exceed the BLE5 MTU
 * (244 bytes) minus the 3-byte frame header. The ceiling is deliberately
 * generous so a genuine frame is never rejected, while still bounding how far a
 * corrupt length field can run before the CRC rejects it during resync.
 */
export const STREAM_FRAME_MAX_PAYLOAD = 512;

/** Result of attempting to read one streaming frame from a byte buffer. */
export type StreamFrameScan =
  | { status: 'need-more' }
  | { status: 'invalid' }
  | { status: 'frame'; payload: Uint8Array; consumed: number };

const STREAM_SCAN_NEED_MORE: StreamFrameScan = { status: 'need-more' };
const STREAM_SCAN_INVALID: StreamFrameScan = { status: 'invalid' };

/**
 * Try to read one CRC-validated streaming frame from the front of `buf`.
 *
 * On the wire a streaming frame is:
 *
 * ```
 * [0x3A][ len LE (2) ][ sensorId(1) | tick(3) | samples… | CRC16(2) ]
 * ```
 *
 * where `len` is the payload length **including** the trailing 2-byte CRC, and
 * the CRC-16/CCITT-FALSE covers the payload up to (but not including) those last
 * 2 bytes — matching the firmware's `crc16_ccitt(buf + 3, len - 2)`.
 *
 * The framing has no start/sync marker, so the CRC is what makes
 * resynchronisation reliable: after a flaky link drops bytes and knocks the
 * stream out of alignment, the caller slides one byte at a time and accepts a
 * boundary only when its CRC checks out, so misaligned/garbage data can no
 * longer masquerade as a valid (but wrong sensor-id) packet.
 *
 * Returns:
 *  - `need-more` — too few bytes buffered to decide; wait for the next chunk.
 *  - `invalid`   — the front of the buffer is not a valid frame start; the
 *                  caller should drop one byte and try again.
 *  - `frame`     — a CRC-valid frame; `payload` is the `len`-byte payload (CRC
 *                  trailer included) and `consumed` is `3 + len` bytes to remove.
 */
export function scanStreamFrame(buf: Uint8Array): StreamFrameScan {
  if (buf.length < 3) return STREAM_SCAN_NEED_MORE;
  if (buf[0] !== STREAM_FRAME_HEADER) return STREAM_SCAN_INVALID;

  const len = (buf[1] | (buf[2] << 8)) >>> 0;
  if (len < STREAM_FRAME_MIN_PAYLOAD || len > STREAM_FRAME_MAX_PAYLOAD) {
    return STREAM_SCAN_INVALID;
  }
  if (buf.length < 3 + len) return STREAM_SCAN_NEED_MORE;

  // CRC trailer is the last 2 payload bytes (LE); it covers the payload before it.
  const crcAt = 3 + len - 2;
  const claimed = (buf[crcAt] | (buf[crcAt + 1] << 8)) >>> 0;
  const calc = crc16_ccitt_false(buf.subarray(3, crcAt));
  if (calc !== claimed) return STREAM_SCAN_INVALID;

  return { status: 'frame', payload: buf.slice(3, 3 + len), consumed: 3 + len };
}

/** Parse a complete protocol message into structured fields. */
export function parseMessage(msg: Uint8Array): VerisenseMessage {
  if (msg.length < 3) throw new Error('Invalid Verisense message: header is incomplete');
  const header = msg[0];
  const payloadLength = u16le(msg[1], msg[2]);
  if (msg.length !== payloadLength + 3) {
    throw new Error(
      `Invalid Verisense message: length=${payloadLength}, actualPayload=${Math.max(0, msg.length - 3)}`,
    );
  }
  const { command, property } = parseHeader(header);
  return {
    header,
    command,
    property,
    payloadLength,
    payload: msg.slice(3),
  };
}

export function isAckCommand(command: AsmCommand): boolean {
  return command === ASM_COMMAND.ACK || command === ASM_COMMAND.ACK_NEXT_STAGE;
}

export function isNackCommand(command: AsmCommand): boolean {
  return (
    command === ASM_COMMAND.NACK_BAD_HEADER_COMMAND ||
    command === ASM_COMMAND.NACK_BAD_HEADER_PROPERTY ||
    command === ASM_COMMAND.NACK_GENERIC
  );
}

/** Convert a pending-events payload (property IDs) into a typed array. */
export function parsePendingEvents(payload: Uint8Array): PendingEventProperty[] {
  const out: PendingEventProperty[] = [];
  for (let i = 0; i < payload.length; i++) out.push((payload[i] & 0x0f) as PendingEventProperty);
  return out;
}
