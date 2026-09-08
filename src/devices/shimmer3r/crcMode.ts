/**
 * Bluetooth CRC mode for the Shimmer3 / Shimmer3R LiteProtocol.
 *
 * The firmware can append a CRC to everything it sends, in one of three modes,
 * selected by the host with `SET_CRC_COMMAND` (0x8b). With it on, a host can
 * *prove* a streaming frame is intact rather than inferring it from where the
 * preamble bytes fall, which is what keeps a stream from drifting out of sync
 * after a dropped byte.
 *
 * Three properties of the firmware's implementation shape this module, all read
 * from `log-and-stream-common`:
 *
 *  - **It is device-to-host only.** `checkCrc` is called from the EEPROM brand
 *    record and SD sync and from nowhere else — never on the Bluetooth command
 *    receive path — so a host never appends a CRC to a command, in any mode.
 *    Only inbound framing changes.
 *  - **The algorithm is the dock UART's.** `CRC/shimmer_crc.c:24` calls
 *    `platform_crcData`, which `Platform/platform_api.c:56-61` defines as
 *    `ShimSwCrc_calc` and neither platform overrides, and the dock protocol
 *    calls the same function (`Comms/shimmer_dock_usart.c:676,708`). So this
 *    module reuses {@link shimmerUartCrcCalc} rather than growing a third copy
 *    of a CRC that already exists twice in this SDK. Reimplementing its loop
 *    would be a mistake: the odd-length zero-pad means folding the bytes
 *    naively gives a different answer.
 *  - **One byte is the same CRC truncated.** `calculateCrcAndInsert`
 *    (`CRC/shimmer_crc.c:19-32`) computes over the whole message *including its
 *    header or opcode byte*, appends the low byte, and appends the high byte as
 *    well only in two-byte mode. So one-byte mode is not a weaker algorithm,
 *    just fewer bits of it on the wire.
 *
 * Note the firmware's CRC helper takes a `uint8_t` length, so at most 255 bytes
 * are covered. A worst-case Shimmer3R data packet is well inside that, but it
 * is a real bound rather than an oversight.
 */

import { shimmerUartCrcCalc } from '../dock/crc.js';

/** CRC modes the firmware accepts as `SET_CRC_COMMAND`'s only argument. */
export const CRC_MODE = Object.freeze({
  /** No CRC on anything the device sends. The state after every connect. */
  OFF: 0,
  /** Low byte of the CRC-16 appended to everything the device sends. */
  ONE_BYTE: 1,
  /** Both bytes appended, low first. */
  TWO_BYTE: 2,
} as const);

/** A valid `SET_CRC_COMMAND` argument: 0, 1 or 2. */
export type CrcMode = (typeof CRC_MODE)[keyof typeof CRC_MODE];

/**
 * True when `mode` is one the firmware understands.
 *
 * Worth checking, because the firmware does not: `SET_CRC_COMMAND` casts
 * `args[0]` straight into its enum (`shimmer_bt_uart.c:933-937`), so a bad
 * value from a host becomes an out-of-range mode on the device with no
 * complaint. Rejecting it here is the only thing standing in the way.
 */
export function isCrcMode(mode: unknown): mode is CrcMode {
  return mode === CRC_MODE.OFF || mode === CRC_MODE.ONE_BYTE || mode === CRC_MODE.TWO_BYTE;
}

/**
 * How many bytes `mode` adds to the end of every message the device sends.
 * Numerically the mode itself, which is why the firmware writes
 * `packet_length += crcMode`; named so callers read as intent, not arithmetic.
 */
export function crcTrailerBytes(mode: CrcMode): 0 | 1 | 2 {
  return mode;
}

/**
 * Append `mode`'s CRC to `msg`, returning a new array.
 *
 * A host has no reason to call this — the firmware does not check commands —
 * but a test double pretending to *be* the firmware does, and building its
 * frames with the same function the verifier uses is what stops the two
 * drifting apart.
 */
export function appendCrc(msg: Uint8Array, mode: CrcMode): Uint8Array {
  if (mode === CRC_MODE.OFF) return msg;
  const [lsb, msb] = shimmerUartCrcCalc(msg, msg.length);
  const out = new Uint8Array(msg.length + mode);
  out.set(msg, 0);
  out[msg.length] = lsb;
  if (mode === CRC_MODE.TWO_BYTE) out[msg.length + 1] = msb;
  return out;
}

/**
 * Check the CRC on a complete inbound message: `msg` is the payload followed by
 * `mode` trailing bytes.
 *
 * Mirrors the firmware's own `checkCrc` (`CRC/shimmer_crc.c:56-77`), including
 * that one-byte mode compares the low byte only and that `CRC_OFF` is vacuously
 * valid — a caller that has no CRC to check has nothing to reject.
 */
export function verifyCrc(msg: Uint8Array, mode: CrcMode): boolean {
  if (mode === CRC_MODE.OFF) return true;
  const payloadLen = msg.length - mode;
  if (payloadLen < 1) return false;
  const [lsb, msb] = shimmerUartCrcCalc(msg, payloadLen);
  if (msg[payloadLen] !== lsb) return false;
  return mode === CRC_MODE.ONE_BYTE || msg[payloadLen + 1] === msb;
}
