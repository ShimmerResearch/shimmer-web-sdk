import { describe, it, expect } from 'vitest';
import {
  u16le,
  u16be,
  u24le,
  u24be,
  sign16,
  sign24,
  hex2,
  concatU8,
} from '../../src/devices/shimmer3r/protocol.js';

describe('u16le', () => {
  it('reads unsigned 16-bit little-endian', () => {
    const b = new Uint8Array([0xcd, 0xab]);
    expect(u16le(b, 0)).toBe(0xabcd);
  });
});

describe('u16be', () => {
  it('reads unsigned 16-bit big-endian', () => {
    const b = new Uint8Array([0xab, 0xcd]);
    expect(u16be(b, 0)).toBe(0xabcd);
  });
});

describe('u24le', () => {
  it('reads unsigned 24-bit little-endian', () => {
    const b = new Uint8Array([0x01, 0x02, 0x03]);
    expect(u24le(b, 0)).toBe(0x030201);
  });
});

describe('u24be', () => {
  it('reads unsigned 24-bit big-endian', () => {
    const b = new Uint8Array([0x01, 0x02, 0x03]);
    expect(u24be(b, 0)).toBe(0x010203);
  });
});

describe('sign16', () => {
  it('leaves positive values unchanged', () => {
    expect(sign16(0x7fff)).toBe(0x7fff);
    expect(sign16(0)).toBe(0);
  });

  it('sign-extends negative values', () => {
    expect(sign16(0x8000)).toBe(-32768);
    expect(sign16(0xffff)).toBe(-1);
  });
});

describe('sign24', () => {
  it('leaves positive values unchanged', () => {
    expect(sign24(0x7fffff)).toBe(0x7fffff);
    expect(sign24(0)).toBe(0);
  });

  it('sign-extends negative values', () => {
    expect(sign24(0x800000)).toBe(-8388608);
    expect(sign24(0xffffff)).toBe(-1);
  });
});

describe('hex2', () => {
  it('formats single digit with leading zero', () => {
    expect(hex2(0x0a)).toBe('0A');
  });

  it('formats two-digit values', () => {
    expect(hex2(0xff)).toBe('FF');
  });
});

describe('concatU8', () => {
  it('concatenates two Uint8Arrays', () => {
    const a = new Uint8Array([1, 2]);
    const b = new Uint8Array([3, 4]);
    expect(Array.from(concatU8(a, b))).toEqual([1, 2, 3, 4]);
  });

  it('handles empty arrays', () => {
    const a = new Uint8Array([1, 2]);
    const empty = new Uint8Array(0);
    expect(Array.from(concatU8(a, empty))).toEqual([1, 2]);
    expect(Array.from(concatU8(empty, a))).toEqual([1, 2]);
  });
});
