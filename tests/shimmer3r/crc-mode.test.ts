import { describe, it, expect } from 'vitest';
import {
  CRC_MODE,
  isCrcMode,
  crcTrailerBytes,
  appendCrc,
  verifyCrc,
} from '../../src/devices/shimmer3r/crcMode.js';
import { shimmerUartCrcCalc, shimmerUartCrcCheck } from '../../src/devices/dock/crc.js';

describe('crcMode', () => {
  it('returns an owned array in every mode, off included', () => {
    /* Review finding. OFF used to return `msg` itself, so the return value was
       sometimes owned and sometimes an alias of the input - and a caller that
       wrote through it mutated its own buffer in exactly one mode. */
    const msg = Uint8Array.from([0x42, 0x43]);
    for (const mode of [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const) {
      const out = appendCrc(msg, mode);
      expect(out, `mode ${mode}`).not.toBe(msg);
      out[0] = 0x99;
      expect(msg[0], `mode ${mode} must not write through to the input`).toBe(0x42);
    }
  });

  it('accepts only the three modes the firmware understands', () => {
    expect([0, 1, 2].every(isCrcMode)).toBe(true);
    // The firmware casts args[0] into its enum unchecked, so these are the
    // values that would otherwise reach a device as an out-of-range mode.
    for (const bad of [-1, 3, 255, 1.5, '1', null, undefined, NaN]) {
      expect(isCrcMode(bad)).toBe(false);
    }
  });

  it('reports the trailer width the firmware appends', () => {
    expect(crcTrailerBytes(CRC_MODE.OFF)).toBe(0);
    expect(crcTrailerBytes(CRC_MODE.ONE_BYTE)).toBe(1);
    expect(crcTrailerBytes(CRC_MODE.TWO_BYTE)).toBe(2);
  });

  it('is the dock UART CRC, not a second implementation of it', () => {
    // Both must be the same function, since the firmware reaches both through
    // platform_crcData. A divergence here is the bug this test exists to catch.
    const msg = Uint8Array.from([0x8d, 0x06, 0x26, 0x01, 0x14, 0x01, 0x85, 0xb8]);
    const [lsb, msb] = shimmerUartCrcCalc(msg, msg.length);
    const two = appendCrc(msg, CRC_MODE.TWO_BYTE);
    expect([...two.slice(-2)]).toEqual([lsb, msb]);
    // ...and the dock's own whole-packet check agrees with ours.
    expect(shimmerUartCrcCheck(two)).toBe(true);
    expect(verifyCrc(two, CRC_MODE.TWO_BYTE)).toBe(true);
  });

  it('puts the low byte first, and one-byte mode is that byte alone', () => {
    const msg = Uint8Array.from([0x00, 0x01, 0x02, 0x03, 0x04]);
    const [lsb, msb] = shimmerUartCrcCalc(msg, msg.length);
    expect([...appendCrc(msg, CRC_MODE.ONE_BYTE).slice(-1)]).toEqual([lsb]);
    expect([...appendCrc(msg, CRC_MODE.TWO_BYTE).slice(-2)]).toEqual([lsb, msb]);
    expect(msb).not.toBe(lsb); // else the assertion above proves nothing
  });

  it('covers odd and even lengths, where the zero-pad rule bites', () => {
    // shimmerUartCrcCalc pads an odd-length message with a zero byte. Folding
    // the bytes without that rule gives a different answer, which is why this
    // module shares the function instead of reimplementing the loop.
    for (const len of [1, 2, 3, 4, 5, 20, 21]) {
      const msg = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff);
      for (const mode of [CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const) {
        expect(verifyCrc(appendCrc(msg, mode), mode)).toBe(true);
      }
    }
  });

  it('rejects a corrupted payload, and a corrupted CRC', () => {
    const msg = Uint8Array.from([0x00, 0x11, 0x22, 0x33, 0x44, 0x55]);
    for (const mode of [CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const) {
      const good = appendCrc(msg, mode);
      for (let i = 0; i < good.length; i++) {
        const bad = Uint8Array.from(good);
        bad[i] ^= 0x01;
        expect(verifyCrc(bad, mode)).toBe(false);
      }
    }
  });

  it('notices a two-byte message whose high byte alone is wrong', () => {
    // The case one-byte mode cannot see, and two-byte mode exists for.
    const msg = Uint8Array.from([0x00, 0x11, 0x22, 0x33]);
    const two = appendCrc(msg, CRC_MODE.TWO_BYTE);
    two[two.length - 1] ^= 0xff;
    expect(verifyCrc(two, CRC_MODE.TWO_BYTE)).toBe(false);
    // Read as one-byte mode the same bytes pass, because the high byte is not
    // examined -- which is the trade the mode makes, not a bug.
    expect(verifyCrc(two.subarray(0, two.length - 1), CRC_MODE.ONE_BYTE)).toBe(true);
  });

  it('treats CRC_OFF as nothing to reject, and refuses a trailer with no payload', () => {
    expect(verifyCrc(Uint8Array.from([0x42]), CRC_MODE.OFF)).toBe(true);
    expect(appendCrc(Uint8Array.from([0x42]), CRC_MODE.OFF)).toHaveLength(1);
    expect(verifyCrc(Uint8Array.from([0x00]), CRC_MODE.ONE_BYTE)).toBe(false);
    expect(verifyCrc(new Uint8Array(0), CRC_MODE.TWO_BYTE)).toBe(false);
  });
});
