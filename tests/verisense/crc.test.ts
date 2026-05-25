import { describe, it, expect } from 'vitest';
import { crc16_ccitt_false, computeCrcLikeCSharp, getOriginalCrcLE } from '../../src/devices/verisense/protocol.js';

describe('crc16_ccitt_false', () => {
  it('produces 0x29B1 for the canonical test vector "123456789"', () => {
    const bytes = new TextEncoder().encode('123456789');
    expect(crc16_ccitt_false(bytes)).toBe(0x29b1);
  });

  it('returns 0xFFFF for an empty input (init value)', () => {
    expect(crc16_ccitt_false(new Uint8Array(0))).toBe(0xffff);
  });

  it('differs between two payloads that differ by one bit', () => {
    const a = new Uint8Array([0x00, 0x01, 0x02]);
    const b = new Uint8Array([0x00, 0x01, 0x03]);
    expect(crc16_ccitt_false(a)).not.toBe(crc16_ccitt_false(b));
  });
});

describe('computeCrcLikeCSharp / getOriginalCrcLE round-trip', () => {
  it('crc of (payload without last 2 bytes) matches the appended CRC', () => {
    // Simulate building a payload with a CRC appended at the end
    const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef, 0x00, 0x01]);
    const crc  = crc16_ccitt_false(data);
    const payload = new Uint8Array(data.length + 2);
    payload.set(data);
    payload[data.length]     = crc & 0xff;
    payload[data.length + 1] = (crc >> 8) & 0xff;

    const computed = computeCrcLikeCSharp(payload);
    const original = getOriginalCrcLE(payload);

    expect(computed).toBe(original);
  });

  it('detects a corrupt payload', () => {
    const data = new Uint8Array([0x01, 0x02, 0x03, 0x04]);
    const crc  = crc16_ccitt_false(data);
    const payload = new Uint8Array(data.length + 2);
    payload.set(data);
    payload[data.length]     = crc & 0xff;
    payload[data.length + 1] = (crc >> 8) & 0xff;

    // Corrupt one byte
    payload[1] ^= 0xff;

    const computed = computeCrcLikeCSharp(payload);
    const original = getOriginalCrcLE(payload);

    expect(computed).not.toBe(original);
  });
});
