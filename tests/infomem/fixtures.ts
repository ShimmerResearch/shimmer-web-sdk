import type { InfoMemContext } from '../../src/devices/infomem/index.js';
import { INFOMEM_SIZE } from '../../src/devices/infomem/index.js';

/**
 * Firmware/hardware contexts exercising each InfoMem layout branch.
 * FW_ID: SDLOG=2, LOGANDSTREAM=3. HW_ID: Shimmer3=3, Shimmer3R=10.
 */
export const CTX = {
  /** Modern Shimmer3 + LogAndStream 0.16.11: flat addressing, derived@31, 8-byte derived. */
  modernShimmer3: {
    hardwareVersion: 3,
    firmwareId: 3,
    firmwareVersion: { major: 0, minor: 16, internal: 11 },
  } as InfoMemContext,

  /** Shimmer3 + SDLog 0.8.68: relocated offsets (derived@31) but LEGACY 0x1800 addressing, no 8-byte derived. */
  relocatedSdlog: {
    hardwareVersion: 3,
    firmwareId: 2,
    firmwareVersion: { major: 0, minor: 8, internal: 68 },
  } as InfoMemContext,

  /** Legacy-ish Shimmer3 + SDLog 0.8.69 (still legacy addressing, sync supported). */
  legacyAddrSdlog: {
    hardwareVersion: 3,
    firmwareId: 2,
    firmwareVersion: { major: 0, minor: 8, internal: 69 },
  } as InfoMemContext,

  /** Shimmer3R + LogAndStream 1.0.40: all newest branches, flat addressing. */
  shimmer3R: {
    hardwareVersion: 10,
    firmwareId: 3,
    firmwareVersion: { major: 1, minor: 0, internal: 40 },
  } as InfoMemContext,
} as const;

/** A blank valid InfoMem (all 0x00 → first 6 bytes not 0xFF once we set fields). */
export function blankInfoMem(): Uint8Array {
  return new Uint8Array(INFOMEM_SIZE);
}

/** Write a little-endian 16-bit divider at bytes 0-1. */
export function setSamplingDivider(buf: Uint8Array, divider: number): void {
  buf[0] = divider & 0xff;
  buf[1] = (divider >> 8) & 0xff;
}

/** Write an ASCII name at `offset`, padded with `pad` up to 12 bytes. */
export function setName(buf: Uint8Array, offset: number, name: string, pad = 0xff): void {
  for (let i = 0; i < 12; i++) {
    buf[offset + i] = i < name.length ? name.charCodeAt(i) : pad;
  }
}

/** Write a 32-bit big-endian value at `offset`. */
export function setBE32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}
