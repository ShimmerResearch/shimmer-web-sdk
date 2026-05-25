/**
 * Low-level byte-manipulation utilities used by the Shimmer3R protocol decoder.
 * All functions are pure and have no side-effects, making them straightforward
 * to unit-test without a BLE device.
 */

/** Concatenate two Uint8Arrays. */
export function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Read a 16-bit unsigned integer, little-endian. */
export function u16le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

/** Read a 16-bit unsigned integer, big-endian. */
export function u16be(b: Uint8Array, o: number): number {
  return ((b[o] << 8) | b[o + 1]) >>> 0;
}

/** Read a 24-bit unsigned integer, little-endian. */
export function u24le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) >>> 0;
}

/** Read a 24-bit unsigned integer, big-endian. */
export function u24be(b: Uint8Array, o: number): number {
  return ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
}

/** Sign-extend a 16-bit value to a signed integer. */
export function sign16(v: number): number {
  return (v & 0x8000) ? (v | 0xffff0000) : v;
}

/** Sign-extend a 24-bit value to a signed integer. */
export function sign24(v: number): number {
  return (v & 0x800000) ? (v | 0xff000000) : v;
}

/** Format a byte as a 2-digit uppercase hex string. */
export function hex2(v: number): string {
  return v.toString(16).padStart(2, '0').toUpperCase();
}
