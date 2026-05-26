export function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  if (u8.buffer instanceof ArrayBuffer) {
    if (u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength) return u8.buffer;
    return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  }

  const out = new Uint8Array(u8.byteLength);
  out.set(u8);
  return out.buffer;
}
