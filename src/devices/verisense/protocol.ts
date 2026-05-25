/**
 * Pure byte-manipulation utilities for the Verisense protocol.
 * No side-effects; suitable for unit testing without a BLE device.
 */

/** Read a 16-bit unsigned integer, little-endian. */
export function u16le(b0: number, b1: number): number {
  return (b1 << 8) | b0;
}

/** Read a signed 16-bit integer at byte offset `off`, little-endian. */
export function i16le(bytes: Uint8Array, off: number): number {
  const v = bytes[off] | (bytes[off + 1] << 8);
  return v & 0x8000 ? v - 0x10000 : v;
}

/** Read a 24-bit unsigned integer at byte offset `off`, little-endian. */
export function u24le(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16)) >>> 0;
}

/** Read a 16-bit unsigned integer at byte offset `off`, little-endian (full-array form). */
export function u16le_at(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8)) >>> 0;
}

/** Return current time in milliseconds. */
export function nowMillis(): number {
  return Date.now();
}

// ---------------------------------------------------------------------------
// CRC-16/CCITT-FALSE
// ---------------------------------------------------------------------------

/**
 * Compute CRC-16/CCITT-FALSE over `bytes`.
 *
 * Parameters: poly=0x1021, init=0xFFFF, xorOut=0x0000.
 * Matches the C# `ComputeCRC` implementation used by Verisense firmware.
 */
export function crc16_ccitt_false(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Extract the CRC that was appended to a logged payload (last 2 bytes, LE).
 */
export function getOriginalCrcLE(payload: Uint8Array): number {
  const n = payload.length;
  return (payload[n - 2] | (payload[n - 1] << 8)) >>> 0;
}

/**
 * Compute the CRC of a logged payload, excluding the trailing 2 CRC bytes,
 * matching the C# `ComputeCRC(payload, 0, payload.Length - 2)` call.
 */
export function computeCrcLikeCSharp(payload: Uint8Array): number {
  return crc16_ccitt_false(payload.subarray(0, payload.length - 2));
}

// ---------------------------------------------------------------------------
// Operational config normaliser
// ---------------------------------------------------------------------------

/**
 * Convert any reasonable representation of an operational config to a
 * `Uint8Array`.  Throws if the input type is unrecognised.
 */
export function normalizeOperationalConfig(
  payload:
    | Uint8Array
    | ArrayBuffer
    | number[]
    | { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number }
    | null
    | undefined,
): Uint8Array | null {
  if (!payload) return null;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return new Uint8Array(payload);
  if ((payload as { buffer: ArrayBuffer }).buffer instanceof ArrayBuffer) {
    const p = payload as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number };
    return new Uint8Array(p.buffer, p.byteOffset ?? 0, p.byteLength ?? p.buffer.byteLength);
  }
  throw new Error('normalizeOperationalConfig: unsupported payload type');
}

// ---------------------------------------------------------------------------
// Production config parser
// ---------------------------------------------------------------------------

export interface ProductionConfig {
  hardware: string;
  firmware: string;
  asmid: string;
  configHeader: number;
}

/**
 * Parse the production config response payload into a structured object.
 */
export function parseProductionConfigPayload(response: Uint8Array): ProductionConfig {
  const isAllFFs = (arr: Uint8Array) => arr.every((b) => b === 255);

  const configHeader = response[0];
  const asmid = [...response.slice(1, 7)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const revHwMajor = response[7];
  const revHwMinor = response[8];
  const revFwMajor = response[9];
  const revFwMinor = response[10];

  const fwInternalArray = response.slice(11, 13);
  const revFwInternal = fwInternalArray[0] | (fwInternalArray[1] << 8);

  let revHwInternal = 0;
  if (response.length >= 15) {
    const hwInternalArray = response.slice(13, 15);
    if (!isAllFFs(hwInternalArray)) {
      revHwInternal = hwInternalArray[0] | (hwInternalArray[1] << 8);
    }
  }

  return {
    hardware: `${revHwMajor}.${revHwMinor}.${revHwInternal}`,
    firmware: `${revFwMajor}.${revFwMinor}.${revFwInternal}`,
    asmid: asmid.toUpperCase(),
    configHeader,
  };
}
