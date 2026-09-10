/**
 * Byte readers for the coefficient blocks.
 *
 * Local to this module rather than shared with `devices/shimmer3r/protocol.ts`
 * because the three parts disagree about byte order within the block — BMP180
 * sends each 16-bit coefficient MSB first, BMP280 and BMP390 send them LSB
 * first — and a reader named for the part it serves is harder to point at the
 * wrong block.
 */

/** Unsigned 16-bit, most-significant byte first (BMP180). */
export const u16be = (b: Uint8Array, o: number): number => (b[o] << 8) | b[o + 1];

/** Unsigned 16-bit, least-significant byte first (BMP280, BMP390). */
export const u16le = (b: Uint8Array, o: number): number => b[o] | (b[o + 1] << 8);

/** Sign-extend an unsigned 16-bit value to a signed one. */
export const s16 = (v: number): number => (v & 0x8000 ? v - 0x10000 : v);

/** Sign-extend an unsigned 8-bit value to a signed one. */
export const s8 = (v: number): number => (v & 0x80 ? v - 0x100 : v);

/** Signed 16-bit, most-significant byte first (BMP180). */
export const i16be = (b: Uint8Array, o: number): number => s16(u16be(b, o));

/** Signed 16-bit, least-significant byte first (BMP280, BMP390). */
export const i16le = (b: Uint8Array, o: number): number => s16(u16le(b, o));

/**
 * Sign-extend an unsigned 24-bit value to a signed one.
 *
 * The BMP581 streams its temperature as 24-bit two's complement — the Bosch
 * driver does this same extension before scaling
 * (`Shimmer_Driver/BMP5/BMP5_SensorAPI/bmp5.c:684-693`).
 */
export const s24 = (v: number): number => (v & 0x800000 ? v - 0x1000000 : v);
