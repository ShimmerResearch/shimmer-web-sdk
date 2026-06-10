export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.buffer instanceof ArrayBuffer) {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out.buffer;
}

/**
 * True if `bytes` is non-empty and every byte equals `value` (0–255). Useful for
 * detecting uniform blobs such as erased flash (all `0xFF`) or zeroed regions.
 * Returns false for empty or nullish input.
 */
export function isUniformByteArray(
  bytes: ArrayLike<number> | ArrayBuffer | null | undefined,
  value: number,
): boolean {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (!u8.length) return false;
  const expected = value & 0xff;
  for (let i = 0; i < u8.length; i++) {
    if (u8[i] !== expected) return false;
  }
  return true;
}
