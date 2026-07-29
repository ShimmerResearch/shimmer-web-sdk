/**
 * Shimmer wired/dock UART CRC.
 *
 * This is the Shimmer-specific 16-bit CRC used by the dock UART protocol — it is
 * **not** CRC-16/CCITT-FALSE (the algorithm the Verisense client uses in
 * `../verisense/protocolUtils.ts#crc16_ccitt_false`), so it cannot be reused:
 * different seed (0xB0CA), a byte-swap step, and an odd-length zero-pad rule.
 * Ported verbatim from the Java driver:
 *   com.shimmerresearch.comms.wiredProtocol.ShimmerCrc (ShimmerCrc.java:12-60).
 *
 * All functions are pure. Every operation mirrors the Java `int` (32-bit,
 * two's-complement) arithmetic exactly — JavaScript bitwise operators are also
 * 32-bit, so the results are byte-for-byte identical (verified against the Java
 * implementation compiled and run directly; e.g. CRC over `[0x24, 0xFF]` = the
 * `TEST_ACK` header+command → `0xD9 0xB2`, matching
 * `AbstractCommsProtocolWired.TEST_ACK`).
 */

/** Seed value for the wired UART CRC (ShimmerCrc.java:29 `CRC_INIT`). */
export const SHIMMER_UART_CRC_INIT = 0xb0ca;

/**
 * Fold a single byte into the running CRC.
 * Ported from `ShimmerCrc.shimmerUartCrcByte` (ShimmerCrc.java:12-21).
 *
 * NB: only the first and last lines mask to 0xFFFF, exactly as in Java — the
 * intermediate byte-swap / shift / XOR steps run on the full 32-bit word. Adding
 * intermediate masks changes the result, so do not "tidy" this.
 */
export function shimmerUartCrcByte(crc: number, b: number): number {
  crc &= 0xffff;
  crc = ((crc & 0xffff) >>> 8) | ((crc & 0xffff) << 8);
  crc ^= b & 0xff;
  crc ^= (crc & 0xff) >>> 4;
  crc ^= crc << 12;
  crc ^= (crc & 0xff) << 5;
  crc &= 0xffff;
  return crc;
}

/**
 * Compute the 2-byte CRC over the first `len` bytes of `msg`.
 * Returns `[LSB, MSB]` — the on-wire order (LSB first), matching
 * `ShimmerCrc.shimmerUartCrcCalc` (ShimmerCrc.java:28-46).
 *
 * If `len` is odd, one `0x00` byte is folded in before finalising
 * (ShimmerCrc.java:37-39) — the padding is part of the algorithm and must be
 * kept.
 *
 * @param msg the input bytes
 * @param len number of bytes to CRC (defaults to `msg.length`)
 */
export function shimmerUartCrcCalc(msg: Uint8Array, len: number = msg.length): [number, number] {
  let crc = shimmerUartCrcByte(SHIMMER_UART_CRC_INIT, msg[0]);
  for (let i = 1; i < len; i++) {
    crc = shimmerUartCrcByte(crc, msg[i]);
  }
  if (len % 2 > 0) {
    crc = shimmerUartCrcByte(crc, 0x00);
  }
  return [crc & 0xff, (crc >> 8) & 0xff];
}

/**
 * Validate a full packet whose last two bytes are the CRC (LSB then MSB).
 * Recomputes over `msg[0 .. length-2)` and compares, matching
 * `ShimmerCrc.shimmerUartCrcCheck` (ShimmerCrc.java:52-60).
 */
export function shimmerUartCrcCheck(msg: Uint8Array): boolean {
  if (msg.length < 3) return false;
  const [lsb, msb] = shimmerUartCrcCalc(msg, msg.length - 2);
  return lsb === msg[msg.length - 2] && msb === msg[msg.length - 1];
}
