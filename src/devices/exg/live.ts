/**
 * ADS1292R (EXG) LIVE Bluetooth/BLE framing — the GET/SET register commands and
 * the read-back response decode used by the over-the-air (not docked) path.
 *
 * Pure, transport-free port of the Java oracle's EXG BT command flow
 * (com.shimmerresearch.bluetooth.ShimmerBluetooth). Where EX1 (`registers.ts`)
 * and EX2 (`apply.ts`) build the 10-byte-per-chip register banks, this module
 * turns a bank into the exact LiteProtocol instruction bytes and decodes the
 * response — so both `Shimmer3RClient` and `Shimmer3Client` share one framing
 * definition rather than each hand-rolling the byte layout.
 *
 * LiteProtocol opcodes (ShimmerLiteProtocolInstructionSet.java):
 *   SET_EXG_REGS_COMMAND = 97 (0x61) @:479, EXG_REGS_RESPONSE = 98 (0x62) @:1604,
 *   GET_EXG_REGS_COMMAND = 99 (0x63) @:1058.
 *
 * @packageDocumentation
 */

import { EXG_BANK_LENGTH } from './registers.js';

/** SET_EXG_REGS_COMMAND opcode (ShimmerLiteProtocolInstructionSet.java:479, value 97). */
export const SET_EXG_REGS_COMMAND = 0x61;
/** EXG_REGS_RESPONSE opcode (ShimmerLiteProtocolInstructionSet.java:1604, value 98). */
export const EXG_REGS_RESPONSE = 0x62;
/** GET_EXG_REGS_COMMAND opcode (ShimmerLiteProtocolInstructionSet.java:1058, value 99). */
export const GET_EXG_REGS_COMMAND = 0x63;

/**
 * Number of payload bytes AFTER the {@link EXG_REGS_RESPONSE} opcode. The Java
 * driver declares this response length as 11 (ShimmerBluetooth.java:468) and
 * reads exactly 11 bytes (`readBytes(11, …)`, ShimmerBluetooth.java:1641). The
 * 11 bytes are `[echo][reg0..reg9]`: the driver copies the 10 register bytes
 * from offset 1 (`System.arraycopy(bufferAns, 1, …, 0, 10)`,
 * ShimmerBluetooth.java:1645-1652), so payload byte 0 (the count/chip echo the
 * firmware prepends) is ignored — the chip identity is tracked host-side from
 * the preceding GET instruction, not read from the response
 * (`mTempChipID = insBytes[1]`, ShimmerBluetooth.java:1087-1089).
 */
export const EXG_REGS_RESPONSE_PAYLOAD_LENGTH = 11;

/** EXG chip index — the `EXG_CHIP_INDEX` ordinal used in the instruction header. */
export const EXG_CHIP1 = 0;
/** EXG chip index — chip 2. */
export const EXG_CHIP2 = 1;

/** Chip index accepted by the framing builders. */
export type ExgChipIndex = typeof EXG_CHIP1 | typeof EXG_CHIP2;

/**
 * Build the GET_EXG_REGS instruction for one chip:
 * `{0x63, chipID, 0, 10}` — read 10 registers starting at offset 0.
 * Byte-for-byte port of ShimmerBluetooth.readEXGConfigurations
 * (`writeInstruction(new byte[]{GET_EXG_REGS_COMMAND,(byte)(chipID.ordinal()),0,10})`,
 * ShimmerBluetooth.java:4023).
 */
export function buildGetExgRegsCommand(chip: ExgChipIndex): Uint8Array {
  return new Uint8Array([GET_EXG_REGS_COMMAND, chip, 0, EXG_BANK_LENGTH]);
}

/**
 * Build the SET_EXG_REGS instruction for one chip:
 * `{0x61, chipID, 0, 10, reg0..reg9}` — a single 14-byte write (the 10 register
 * bytes fit one instruction, never chunked). Byte-for-byte port of
 * ShimmerBluetooth.writeEXGConfiguration
 * (`writeInstruction(new byte[]{SET_EXG_REGS_COMMAND,(byte)(chipID.ordinal()),0,10,reg[0]..reg[9]})`,
 * ShimmerBluetooth.java:4220).
 *
 * @throws RangeError when `bank` is not exactly 10 bytes.
 */
export function buildSetExgRegsCommand(chip: ExgChipIndex, bank: Uint8Array): Uint8Array {
  if (bank.length !== EXG_BANK_LENGTH) {
    throw new RangeError(
      `EXG register bank must be exactly ${EXG_BANK_LENGTH} bytes, got ${bank.length}.`,
    );
  }
  const out = new Uint8Array(4 + EXG_BANK_LENGTH);
  out[0] = SET_EXG_REGS_COMMAND;
  out[1] = chip;
  out[2] = 0;
  out[3] = EXG_BANK_LENGTH;
  out.set(bank, 4);
  return out;
}

/**
 * Extract the 10-byte register bank from an EXG_REGS_RESPONSE frame.
 *
 * The frame is `[0x62][echo][reg0..reg9]` (opcode + {@link EXG_REGS_RESPONSE_PAYLOAD_LENGTH}
 * payload bytes). Mirrors the Java `System.arraycopy(bufferAns, 1, …, 0, 10)`
 * (ShimmerBluetooth.java:1645): the byte immediately after the opcode is a
 * count/chip echo that the driver ignores, and the 10 register bytes follow.
 *
 * @param frame the complete response including the leading 0x62 opcode.
 * @throws RangeError when the frame is too short or does not start with 0x62.
 */
export function decodeExgRegsResponse(frame: Uint8Array): Uint8Array {
  if (frame.length < 1 + EXG_REGS_RESPONSE_PAYLOAD_LENGTH) {
    throw new RangeError(
      `EXG_REGS_RESPONSE must be ${1 + EXG_REGS_RESPONSE_PAYLOAD_LENGTH} bytes (opcode + ${EXG_REGS_RESPONSE_PAYLOAD_LENGTH} payload), got ${frame.length}.`,
    );
  }
  if (frame[0] !== EXG_REGS_RESPONSE) {
    throw new RangeError(
      `EXG_REGS_RESPONSE must start with 0x${EXG_REGS_RESPONSE.toString(16)}, got 0x${frame[0].toString(16)}.`,
    );
  }
  // opcode at [0], echo byte at [1], 10 register bytes at [2..11].
  return frame.slice(2, 2 + EXG_BANK_LENGTH);
}

/**
 * Register index of REG8 (LOFF_STAT) within the 10-byte bank — the read-only
 * lead-off status register (ExGConfigBytesDetails REG8). Its bits reflect the
 * chip's live lead-off state, so the device never echoes back what was written;
 * {@link exgBanksEqualIgnoringStatus} excludes it from read-back comparison.
 */
export const EXG_REG8_STATUS_INDEX = 7;

/**
 * Compare two 10-byte register banks for read-back verification, ignoring the
 * read-only REG8 (LOFF_STAT) status byte at index {@link EXG_REG8_STATUS_INDEX}.
 * Every other register is host-writable and must echo back exactly.
 */
export function exgBanksEqualIgnoringStatus(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== EXG_BANK_LENGTH || b.length !== EXG_BANK_LENGTH) return false;
  for (let i = 0; i < EXG_BANK_LENGTH; i++) {
    if (i === EXG_REG8_STATUS_INDEX) continue;
    if (a[i] !== b[i]) return false;
  }
  return true;
}
