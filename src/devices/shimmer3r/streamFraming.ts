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
  [OPCODES.GSR_RANGE_RESPONSE]: 1, // 0x22
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
 * Total length (INCLUDING the leading opcode) of the control message at the
 * head of `buf`, or {@link NEED_MORE} when more bytes are required to tell, or
 * {@link RESYNC} when the leading byte starts nothing we recognise.
 *
 * Deliberately does NOT frame DATA_PACKET (0x00): stream data is length-defined
 * by the negotiated schema rather than by the protocol, so the client routes it
 * to its schema parser instead of through this function.
 */
export function shimmer3rControlMessageLength(buf: Uint8Array): number {
  if (buf.length === 0) return NEED_MORE;
  const opcode = buf[0];

  if (opcode === OPCODES.ACK_COMMAND_PROCESSED || opcode === OPCODES.NACK_COMMAND_PROCESSED) {
    return 1;
  }

  // SD-transfer frames and one-shot responses: one definition, in sdMessageSpan.
  if (opcode === SD_INSTREAM_BYTE || SD_RESPONSE_OPCODES.has(opcode)) {
    return sdMessageSpan(buf);
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

  if (opcode === OPCODES.DAUGHTER_CARD_MEM_RESPONSE) {
    // [0x68][length][data…]; the firmware caps a read at 128 bytes, so a larger
    // "length" is garbage rather than a giant response.
    if (buf.length < 2) return NEED_MORE;
    const dcLen = buf[1];
    if (dcLen > 128) return RESYNC;
    const total = 2 + dcLen;
    return buf.length < total ? NEED_MORE : total;
  }

  const payload = SHIMMER3R_RESPONSE_PAYLOAD_LENGTHS[opcode];
  if (payload === undefined) return RESYNC;
  const total = 1 + payload;
  return buf.length < total ? NEED_MORE : total;
}
