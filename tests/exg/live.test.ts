import { describe, it, expect } from 'vitest';
import {
  SET_EXG_REGS_COMMAND,
  EXG_REGS_RESPONSE,
  GET_EXG_REGS_COMMAND,
  EXG_REGS_RESPONSE_PAYLOAD_LENGTH,
  EXG_CHIP1,
  EXG_CHIP2,
  EXG_REG8_STATUS_INDEX,
  buildGetExgRegsCommand,
  buildSetExgRegsCommand,
  decodeExgRegsResponse,
  exgBanksEqualIgnoringStatus,
} from '../../src/devices/exg/live.js';

// Pin the exact LiteProtocol byte layouts for the EXG GET/SET commands and the
// EXG_REGS_RESPONSE decode, byte-for-byte against ShimmerBluetooth.

describe('EXG live framing', () => {
  it('opcode values match the LiteProtocol table', () => {
    expect(SET_EXG_REGS_COMMAND).toBe(0x61);
    expect(EXG_REGS_RESPONSE).toBe(0x62);
    expect(GET_EXG_REGS_COMMAND).toBe(0x63);
    expect(EXG_REGS_RESPONSE_PAYLOAD_LENGTH).toBe(11);
  });

  it('buildGetExgRegsCommand → {0x63, chip, 0, 10} (ShimmerBluetooth.java:4023)', () => {
    expect(Array.from(buildGetExgRegsCommand(EXG_CHIP1))).toEqual([0x63, 0, 0, 10]);
    expect(Array.from(buildGetExgRegsCommand(EXG_CHIP2))).toEqual([0x63, 1, 0, 10]);
  });

  it('buildSetExgRegsCommand → {0x61, chip, 0, 10, reg0..reg9} (ShimmerBluetooth.java:4220)', () => {
    const bank = new Uint8Array([2, 160, 16, 64, 64, 45, 0, 0, 2, 3]);
    expect(Array.from(buildSetExgRegsCommand(EXG_CHIP1, bank))).toEqual([
      0x61, 0, 0, 10, 2, 160, 16, 64, 64, 45, 0, 0, 2, 3,
    ]);
    expect(Array.from(buildSetExgRegsCommand(EXG_CHIP2, bank))).toEqual([
      0x61, 1, 0, 10, 2, 160, 16, 64, 64, 45, 0, 0, 2, 3,
    ]);
  });

  it('buildSetExgRegsCommand rejects a non-10-byte bank', () => {
    expect(() => buildSetExgRegsCommand(EXG_CHIP1, new Uint8Array(9))).toThrow(/exactly 10 bytes/);
  });

  it('decodeExgRegsResponse extracts reg0..reg9 from [0x62][echo][10 regs]', () => {
    const regs = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // echo byte (index 1) is the count/chip echo the firmware prepends — ignored.
    const frame = new Uint8Array([EXG_REGS_RESPONSE, 10, ...regs]);
    expect(Array.from(decodeExgRegsResponse(frame))).toEqual(regs);
  });

  it('decodeExgRegsResponse rejects a short frame or wrong opcode', () => {
    expect(() => decodeExgRegsResponse(new Uint8Array([0x62, 10, 1, 2, 3]))).toThrow(/must be 12/);
    expect(() => decodeExgRegsResponse(new Uint8Array(12))).toThrow(/must start with/);
  });

  it('exgBanksEqualIgnoringStatus ignores REG8 (index 7) only', () => {
    const a = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 0xaa, 9, 10]);
    const b = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 0x55, 9, 10]); // differs only at REG8
    expect(EXG_REG8_STATUS_INDEX).toBe(7);
    expect(exgBanksEqualIgnoringStatus(a, b)).toBe(true);

    const c = new Uint8Array(b);
    c[0] = 0xff; // a writable register differs
    expect(exgBanksEqualIgnoringStatus(a, c)).toBe(false);
  });
});
