/**
 * Message framing for a Shimmer3R reached over an **unframed** byte stream.
 *
 * Over BLE the module hands the client one notification per firmware message,
 * so {@link Shimmer3RClient} can assume `chunk[0]` is an opcode and the rest of
 * the chunk is that message. A byte stream — Web Serial over USB, or over the
 * virtual COM port Windows/macOS create for a Shimmer paired via classic
 * Bluetooth (RFCOMM/SPP) — offers no such guarantee: messages arrive split
 * across reads and coalesced with their neighbours.
 *
 * {@link shimmer3rControlMessageLength} restores those boundaries the way
 * `shimmer3ControlMessageLength` does for the classic Shimmer3: as a pure
 * length function the client's drain loop can consult, expressing the same
 * length knowledge the Java driver encodes in its blocking `readBytes(n)`
 * calls.
 *
 * SD-transfer traffic is delegated to {@link sdMessageSpan} so the frame layout
 * has exactly one definition.
 */

import { NEED_MORE, RESYNC } from '../../core/framing.js';
import { OPCODES } from './constants.js';
import { sdMessageSpan, SD_TRANSFER_OPCODES, SD_INSTREAM_BYTE } from './sdTransfer/protocol.js';

/**
 * Offset of the `numChannels` byte within an opcode-prefixed
 * INQUIRY_RESPONSE. Shimmer3R's config word is 7 bytes at [3..9] (Shimmer3's is
 * 4 at [3..6]) which pushes numChannels to [10] and bufferSize to [11].
 */
export const SHIMMER3R_INQ_NUM_CHANNELS_OFFSET = 10;
/** Offset of the first channel-ID byte within an INQUIRY_RESPONSE. */
export const SHIMMER3R_INQ_CHANNELS_OFFSET = SHIMMER3R_INQ_NUM_CHANNELS_OFFSET + 2; // 12

/**
 * Fixed payload lengths (bytes AFTER the opcode) for the fixed-width control
 * responses. Variable-length responses (INQUIRY_RESPONSE, DAUGHTER_CARD_MEM_
 * RESPONSE, everything SD) are handled explicitly in
 * {@link shimmer3rControlMessageLength}.
 *
 * **Extension point.** An opcode absent from here — and from the special cases
 * below — cannot be framed, so the drain loop resynchronises past it one byte at
 * a time and whatever command was awaiting it times out. Add an entry when
 * teaching the client a new GET over an unframed transport; the value is the
 * response's `response_size` in the LiteProtocol instruction set, minus the
 * opcode byte.
 */
export const SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS: Readonly<Record<number, number>> = Object.freeze({
  [OPCODES.SAMPLING_RATE_RESPONSE]: 2, // 0x04
  [OPCODES.WR_ACCEL_RANGE_RESPONSE]: 1, // 0x0A
  [OPCODES.GSR_RANGE_RESPONSE]: 1, // 0x22
  [OPCODES.GYRO_RANGE_RESPONSE]: 1, // 0x4A
  [OPCODES.DEVICE_VERSION_RESPONSE]: 1, // 0x25
  [OPCODES.FW_VERSION_RESPONSE]: 6, // 0x2F fwId u16, major u16, minor u8, patch u8
  [OPCODES.INTERNAL_EXP_POWER_ENABLE_RESPONSE]: 1, // 0x5F
  [OPCODES.RWC_RESPONSE]: 8, // 0x90 64-bit ticks, LSB first
  // 0xA5 — DATA_RATE_TEST_PACKET_SIZE is 5 in the firmware: header + u32 counter
  [OPCODES.DATA_RATE_TEST_RESPONSE]: 4,
});

/** SD-transfer response opcodes, which {@link sdMessageSpan} owns. */
const SD_RESPONSE_OPCODES: ReadonlySet<number> = new Set<number>([
  SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE,
  SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE,
  SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE,
  SD_TRANSFER_OPCODES.DELETE_RESPONSE,
]);

/**
 * How many status bytes a STATUS_RESPONSE carries — the one length in this
 * protocol that depends on which platform answered rather than on the bytes
 * themselves.
 */
export interface Shimmer3RFramingOptions {
  /**
   * 2 on a Shimmer3R, 1 on a Shimmer3 (`STATUS_BYTE_COUNT`,
   * log-and-stream-common `Comms/shimmer_bt_uart.h:259-263`). Defaults to 2:
   * this framer belongs to the Shimmer3R client, and a client that has not yet
   * asked for the hardware version is talking to a Shimmer3R until told
   * otherwise. Get it wrong on a Shimmer3 and the framer eats the byte after
   * the status — an ACK, usually — so the client should pass 1 as soon as
   * `readDeviceVersion` reports hardware 3.
   */
  statusPayloadBytes?: 1 | 2;
}

/**
 * Total length (INCLUDING the leading opcode) of the control message at the
 * head of `buf`, or {@link NEED_MORE} when more bytes are required to tell, or
 * {@link RESYNC} when the leading byte starts nothing we recognise.
 *
 * Deliberately does NOT frame DATA_PACKET (0x00): stream data is length-defined
 * by the negotiated schema rather than by the protocol, so the client routes it
 * to its schema parser instead of through this function.
 */
export function shimmer3rControlMessageLength(
  buf: Uint8Array,
  opts: Shimmer3RFramingOptions = {},
): number {
  if (buf.length === 0) return NEED_MORE;
  const opcode = buf[0];

  if (opcode === OPCODES.ACK_COMMAND_PROCESSED || opcode === OPCODES.NACK_COMMAND_PROCESSED) {
    return 1;
  }

  /*
   * 0x8A (INSTREAM_CMD_RESPONSE) is a shared prefix, not an opcode: the byte
   * after it selects the message. SD transfer owns most of that space, but the
   * firmware also answers GET_STATUS and GET_VBATT through it, and those two
   * predate the SD frames — so they are decided here before the rest is handed
   * to sdMessageSpan.
   */
  if (opcode === SD_INSTREAM_BYTE) {
    if (buf.length < 2) return NEED_MORE;
    if (buf[1] === OPCODES.STATUS_RESPONSE) {
      // [0x8A][0x71][status0]{[status1]} — ShimBt_assembleStatusBytes,
      // `Comms/shimmer_bt_uart.c:2920-2932`.
      const total = 2 + (opts.statusPayloadBytes ?? 2);
      return buf.length < total ? NEED_MORE : total;
    }
    if (buf[1] === OPCODES.VBATT_RESPONSE) {
      // [0x8A][0x94][BattStatusRaw x3] — `Comms/shimmer_bt_uart.c:1848-1859`.
      return buf.length < 5 ? NEED_MORE : 5;
    }
    return sdMessageSpan(buf);
  }

  // SD-transfer one-shot responses: one definition, in sdMessageSpan.
  if (SD_RESPONSE_OPCODES.has(opcode)) {
    return sdMessageSpan(buf);
  }

  if (opcode === OPCODES.RSP_CALIB_DUMP_COMMAND) {
    // [0x99][length][offsetLo][offsetHi][data…] — the length byte counts the
    // data only, and the firmware reads at most 128 bytes of calibration RAM
    // per request (`Comms/shimmer_bt_uart.c:2241-2249`), so a larger one is a
    // stray byte rather than a giant response.
    if (buf.length < 2) return NEED_MORE;
    const dataLen = buf[1];
    if (dataLen > 128) return RESYNC;
    const total = 4 + dataLen;
    return buf.length < total ? NEED_MORE : total;
  }

  if (opcode === OPCODES.INQUIRY_RESPONSE) {
    if (buf.length <= SHIMMER3R_INQ_NUM_CHANNELS_OFFSET) return NEED_MORE;
    const numChannels = buf[SHIMMER3R_INQ_NUM_CHANNELS_OFFSET];
    // A stray stream byte 0x02 can masquerade as an INQUIRY_RESPONSE whose
    // "numChannels" is garbage, swallowing real control traffic (ACK included).
    // No Shimmer3R comes close to 32 channels — treat the rest as garbage.
    if (numChannels > 32) return RESYNC;
    const total = SHIMMER3R_INQ_CHANNELS_OFFSET + numChannels;
    return buf.length < total ? NEED_MORE : total;
  }

  if (opcode === OPCODES.DAUGHTER_CARD_MEM_RESPONSE || opcode === OPCODES.INFOMEM_RESPONSE) {
    // [opcode][length][data…]; the firmware caps both a daughter-card and an
    // InfoMem read at 128 bytes, so a larger "length" is garbage rather than a
    // giant response.
    //
    // Framing these means the whole response arrives as ONE message, so
    // `_readLengthPrefixedResponse`'s continuation path — which treats later
    // chunks as raw opcode-less payload — never engages on a byte stream. That
    // matters: those continuation bytes have no opcode, so the drain could not
    // frame them and would resync straight past the tail of the record.
    if (buf.length < 2) return NEED_MORE;
    const memLen = buf[1];
    if (memLen > 128) return RESYNC;
    const total = 2 + memLen;
    return buf.length < total ? NEED_MORE : total;
  }

  const payload = SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS[opcode];
  if (payload === undefined) return RESYNC;
  const total = 1 + payload;
  return buf.length < total ? NEED_MORE : total;
}
