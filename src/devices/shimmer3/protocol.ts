/**
 * Pure protocol helpers for the classic Bluetooth (RFCOMM/SPP) Shimmer3.
 *
 * Classic Shimmer3 speaks the same LiteProtocol command set as the Shimmer3R
 * (see `../shimmer3r/constants.ts`), but over an **unframed RFCOMM byte stream**
 * rather than framed BLE notifications, and with a **different inquiry-response
 * layout** (a 4-byte config word instead of Shimmer3R's 7-byte word). Everything
 * in this file is a side-effect-free function so it can be unit-tested without a
 * transport.
 *
 * Ported from the Shimmer Java driver:
 *   com.shimmerresearch.driver.ShimmerObject#interpretInqResponse (HW_ID.SHIMMER_3 branch)
 *   com.shimmerresearch.bluetooth.ShimmerBluetooth (response byte layouts + handshake)
 */

import { OPCODES, type TimestampFmt } from '../shimmer3r/constants.js';
import {
  buildStreamSchema,
  type StreamSchemaBase,
  type StreamSchemaField,
} from '../shimmer3r/streamSchema.js';
import { u16le } from '../shimmer3r/protocol.js';
import { EXG_BANK_LENGTH } from '../exg/registers.js';

// Re-export the byte utilities so Shimmer3 consumers/tests import from one place;
// these are identical for both device families (see ../shimmer3r/protocol.ts).
export {
  concatU8,
  u16le,
  u16be,
  u24le,
  u24be,
  sign16,
  sign24,
  hex2,
} from '../shimmer3r/protocol.js';

/** The Shimmer3 acknowledgement byte (LiteProtocol). Shared with Shimmer3R. */
export const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
/** The Shimmer3 negative-acknowledgement byte (LiteProtocol). */
export const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE

/**
 * Well-known SPP (Serial Port Profile) service UUID used to open an RFCOMM
 * socket to a classic Shimmer3. Documented here for the platform transport
 * (e.g. the React Native Android module calls
 * `createRfcommSocketToServiceRecord(SPP_UUID)`); the SDK client itself is
 * transport-agnostic and never touches it.
 */
export const SHIMMER3_SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

// ---------------------------------------------------------------------------
// Inquiry-response layout — THE key protocol difference vs Shimmer3R
// ---------------------------------------------------------------------------
//
// Byte layout of an INQUIRY_RESPONSE, INCLUDING the 0x02 opcode byte
// (ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch works on the
// opcode-stripped buffer, so every index below is the Java index + 1):
//
//   [0]      = 0x02  INQUIRY_RESPONSE opcode
//   [1..2]   = sampling-rate divisor, 16-bit little-endian
//   [3..6]   = config word (configByte0), 4 bytes little-endian   <-- 4, not 7
//   [7]      = numChannels
//   [8]      = bufferSize
//   [9..]    = numChannels channel/signal-ID bytes
//
// Shimmer3R differs: its config word is 7 bytes (indices [3..9]), numChannels at
// [10], bufferSize at [11], channels from [12]. That single width difference is
// why this cannot reuse Shimmer3RClient's inquiry parser.

/** 0-based offset (within the opcode-prefixed message) of the config word. */
export const SHIMMER3_INQ_CONFIG_OFFSET = 3;
/** Config word width in bytes (Shimmer3 = 4; Shimmer3R = 7). */
export const SHIMMER3_INQ_CONFIG_LENGTH = 4;
/** Offset of the numChannels byte within the opcode-prefixed message. */
export const SHIMMER3_INQ_NUM_CHANNELS_OFFSET =
  SHIMMER3_INQ_CONFIG_OFFSET + SHIMMER3_INQ_CONFIG_LENGTH; // 7
/** Offset of the first channel-ID byte within the opcode-prefixed message. */
export const SHIMMER3_INQ_CHANNELS_OFFSET = SHIMMER3_INQ_NUM_CHANNELS_OFFSET + 2; // 9

/** The sampling clock frequency (Hz) used for divisor↔rate conversion. */
// ShimmerDevice#getSamplingClockFreq() returns 32768.0 for Shimmer3 and Shimmer3R.
export const SHIMMER3_SAMPLING_CLOCK_FREQ = 32768;

// ---------------------------------------------------------------------------
// Stream schema
// ---------------------------------------------------------------------------

/**
 * One decoded channel within a streaming data frame.
 *
 * Structurally identical to the Shimmer3R client's field type — the two
 * families share the channel vocabulary — and kept as its own name because it
 * is exported. See {@link StreamSchemaField} for what `assumed` and
 * `offsetTrusted` mean.
 */
export type Shimmer3ChannelField = StreamSchemaField;

/**
 * Describes how to slice a streaming data frame, built from an inquiry.
 *
 * `dataPreambleByte` is 0x00 (DATA_PACKET) and `frameBytes` includes it.
 * `trusted` is the field to check before believing the numbers — see
 * {@link StreamSchemaBase.trusted}.
 */
export type Shimmer3StreamSchema = StreamSchemaBase;

/** Typed result of decoding an INQUIRY_RESPONSE. */
export interface Shimmer3InquiryResult {
  opcode: number;
  /** Raw 16-bit sampling divisor from the response. */
  adcRaw: number;
  samplingRateHz: number;
  /** 32-bit config word (configByte0). */
  configByte0: number;
  gsrRange: number;
  internalExpPower: number;
  accelRange: number;
  gyroRange: number;
  magRange: number;
  numChannels: number;
  bufferSize: number;
  channelIds: number[];
  schema: Shimmer3StreamSchema;
  /** The exact response bytes decoded (opcode-inclusive slice). */
  bytes: Uint8Array;
}

/**
 * Build a stream schema from the channel-ID list reported by the inquiry.
 *
 * Mirrors ShimmerObject#interpretDataPacketFormat. The generation is fixed at
 * `'shimmer3'`: this file is the classic-Bluetooth Shimmer3 path, so unlike
 * `Shimmer3RClient` — which the same firmware answers on both platforms — there
 * is nothing to determine and nothing to assume. That matters for the BMP
 * channels, which are 2-byte big-endian temperature + 3-byte big-endian
 * pressure here and 3 little-endian bytes each on a Shimmer3R
 * (see `CHANNEL_FORMAT_OVERRIDES`).
 *
 * The only Shimmer3-relevant knob is the timestamp width (u24 for firmware code
 * ≥ 6, else u16 — see ShimmerObject#updateTimestampByteLength).
 *
 * @param onProblem optional sink for the message an unrecognised channel ID
 *   produces; `Shimmer3Client` wires it to `onStatus`. The schema's `trusted`
 *   and `unknownChannelIds` say the same thing to code rather than to a log.
 */
export function buildShimmer3Schema(
  channelIds: number[],
  timestampFmt: TimestampFmt,
  onProblem?: (message: string) => void,
): Shimmer3StreamSchema {
  return buildStreamSchema(channelIds, timestampFmt, {
    generation: 'shimmer3',
    dataPreambleByte: 0x00,
    onProblem,
  });
}

/**
 * Decode an INQUIRY_RESPONSE using the Shimmer3 (classic) layout.
 *
 * Accepts the message with or without the leading 0x02 opcode byte (the
 * byte-stream parser always includes it; a caller passing a bare body also
 * works, matching Shimmer3RClient's `base` handling).
 *
 * Ported from ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch.
 *
 * @param onProblem optional sink for schema problems (an unrecognised channel
 *   ID); see {@link buildShimmer3Schema}.
 */
export function interpretShimmer3InquiryResponse(
  u8: Uint8Array,
  timestampFmt: TimestampFmt = 'u24',
  onProblem?: (message: string) => void,
): Shimmer3InquiryResult {
  let base = 0;
  if (u8[0] === OPCODES.INQUIRY_RESPONSE) base = 1;

  const adcRaw = u16le(u8, base + 0);
  const samplingRateHz = SHIMMER3_SAMPLING_CLOCK_FREQ / adcRaw;

  // 4-byte little-endian config word (Java: bufferInquiry[2..5]).
  const configByte0 =
    ((u8[base + 2] | (u8[base + 3] << 8) | (u8[base + 4] << 16) | (u8[base + 5] << 24)) >>> 0) >>>
    0;

  const accelRange = (configByte0 & 0xc) >>> 2;
  const gyroRange = (configByte0 & 0x30000) >>> 16;
  const magRange = (configByte0 & 0xe00000) >>> 21;
  const gsrRange = (configByte0 >>> 25) & 0x7;
  const internalExpPower = (configByte0 >>> 24) & 0x1;

  const numChannels = u8[base + 6] ?? 0;
  const bufferSize = u8[base + 7] ?? 0;
  const chStart = base + 8;
  const channelIds = [...u8.slice(chStart, chStart + numChannels)];

  const schema = buildShimmer3Schema(channelIds, timestampFmt, onProblem);

  return {
    opcode: u8[0],
    adcRaw,
    samplingRateHz,
    configByte0,
    gsrRange,
    internalExpPower,
    accelRange,
    gyroRange,
    magRange,
    numChannels,
    bufferSize,
    channelIds,
    schema,
    bytes: u8.slice(0),
  };
}

// ---------------------------------------------------------------------------
// Handshake response decoders
// ---------------------------------------------------------------------------

/** Parsed DEVICE_VERSION (a.k.a. Shimmer HW version) response. */
export interface Shimmer3DeviceVersion {
  hardwareVersion: number;
}

/** Decode a DEVICE_VERSION_RESPONSE (0x25) — 1 payload byte = HW version.
 *  Ported from ShimmerBluetooth (GET_SHIMMER_VERSION_RESPONSE handler). */
export function parseShimmer3DeviceVersionResponse(u8: Uint8Array): Shimmer3DeviceVersion {
  const base = u8[0] === OPCODES.DEVICE_VERSION_RESPONSE ? 1 : 0;
  return { hardwareVersion: u8[base] ?? 0 };
}

/**
 * Firmware identifier (type) values, from
 * com.shimmerresearch.driverUtilities.ShimmerVerDetails.FW_ID.
 */
export const FW_ID = Object.freeze({
  BTSTREAM: 1,
  SDLOG: 2,
  LOGANDSTREAM: 3,
} as const);

/** Parsed FW_VERSION_RESPONSE. */
export interface Shimmer3FwVersion {
  /** Firmware type — one of {@link FW_ID} (BtStream / SDLog / LogAndStream). */
  firmwareIdentifier: number;
  major: number;
  minor: number;
  internal: number;
}

/**
 * Decode a FW_VERSION_RESPONSE (0x2F) — 6 payload bytes.
 * Ported from ShimmerBluetooth (FW_VERSION_RESPONSE handler):
 *   id  = b1<<8 | b0   (little-endian)
 *   maj = b3<<8 | b2
 *   min = b4
 *   int = b5
 */
export function parseShimmer3FwVersionResponse(u8: Uint8Array): Shimmer3FwVersion {
  const base = u8[0] === OPCODES.FW_VERSION_RESPONSE ? 1 : 0;
  const b = (i: number): number => u8[base + i] ?? 0;
  return {
    firmwareIdentifier: (b(1) << 8) | b(0),
    major: (b(3) << 8) | b(2),
    minor: b(4),
    internal: b(5),
  };
}

/**
 * Whether streaming data frames use a 3-byte (u24) timestamp for this firmware.
 *
 * The Java driver widens the timestamp to 3 bytes when the derived firmware
 * version code is ≥ 6 (ShimmerObject#updateTimestampByteLength). That code is a
 * per-firmware-type version ladder (ShimmerVerObject); code ≥ 6 corresponds to
 * LogAndStream ≥ 0.5.4, BtStream ≥ 0.7.3, and SDLog ≥ 0.11.5. Anything at or
 * above those (and any firmware type we don't recognise, assumed modern) uses
 * u24; older firmware uses u16.
 */
export function shimmer3UsesThreeByteTimestamp(v: Shimmer3FwVersion): boolean {
  const atLeast = (maj: number, min: number, int: number): boolean =>
    v.major > maj || (v.major === maj && (v.minor > min || (v.minor === min && v.internal >= int)));
  switch (v.firmwareIdentifier) {
    case FW_ID.LOGANDSTREAM:
      return atLeast(0, 5, 4);
    case FW_ID.BTSTREAM:
      return atLeast(0, 7, 3);
    case FW_ID.SDLOG:
      return atLeast(0, 11, 5);
    default:
      return true; // unknown/newer firmware type — default to modern u24
  }
}

/**
 * Hardware-version codes the firmware-version-code ladder below keys off
 * (`ShimmerVerDetails.HW_ID`).
 */
const HW_ID = Object.freeze({
  SHIMMER_2R: 2,
  SHIMMER_3: 3,
  SHIMMER_3R: 10,
} as const);

/**
 * Derive the `ShimmerVerObject` "firmware version code" from a parsed FW version
 * plus a hardware id — a port of the ladder at ShimmerVerObject.java:266-311.
 *
 * The code is a single monotonically-increasing capability number derived from
 * the (HW id, FW id, major.minor.internal) tuple; the Java driver gates several
 * protocol features on it rather than on the raw version. Returns `-1` when no
 * rung matches (firmware older than every known threshold), exactly as Java
 * initialises it.
 *
 * Only the rungs reachable by the hardware this SDK talks to are ported.
 * Java also awards code 7 on a bare hardware-id match for Shimmer4-SDK and
 * Arduino, code 6 for the two ShimmerGQ 802.15.4 boards and code 5 for SWEATCH,
 * none of which these clients connect to; and code 7 on `mFirmwareIdentifier ==
 * FW_ID.STROKARE`, a bespoke firmware build this SDK has no FW_ID for. A device
 * running one of those would land one rung lower here than in Java — still
 * above the ExG gate below in every case, so the difference is inert.
 *
 * `compareVersions` semantics (UtilShimmer.java:620-629, via :536-543): same HW
 * id AND same FW id AND `this` version >= the target, comparing major, then
 * minor, then internal with `>=`.
 */
export function deriveShimmer3FirmwareVersionCode(
  fw: Shimmer3FwVersion,
  hardwareVersion: number,
): number {
  const { firmwareIdentifier: id, major, minor, internal } = fw;
  const ge = (tHw: number, tId: number, tMaj: number, tMin: number, tInt: number): boolean => {
    if (hardwareVersion !== tHw || id !== tId) return false;
    return (
      major > tMaj || (major === tMaj && (minor > tMin || (minor === tMin && internal >= tInt)))
    );
  };
  const L = FW_ID.LOGANDSTREAM;
  const B = FW_ID.BTSTREAM;
  const S = FW_ID.SDLOG;
  if (ge(HW_ID.SHIMMER_3, L, 0, 16, 6)) return 9;
  if (
    ge(HW_ID.SHIMMER_3R, L, 0, 0, 1) ||
    ge(HW_ID.SHIMMER_3, L, 0, 13, 7) ||
    ge(HW_ID.SHIMMER_3, S, 0, 20, 1)
  ) {
    return 8;
  }
  if (ge(HW_ID.SHIMMER_3, L, 0, 6, 5)) return 7;
  if (
    ge(HW_ID.SHIMMER_3, B, 0, 7, 3) ||
    ge(HW_ID.SHIMMER_3, L, 0, 5, 4) ||
    ge(HW_ID.SHIMMER_3, S, 0, 11, 5)
  ) {
    return 6;
  }
  if (ge(HW_ID.SHIMMER_3, B, 0, 5, 0) || ge(HW_ID.SHIMMER_3, L, 0, 3, 0)) return 5;
  if (ge(HW_ID.SHIMMER_3, B, 0, 4, 0) || ge(HW_ID.SHIMMER_3, L, 0, 2, 0)) return 4;
  if (ge(HW_ID.SHIMMER_3, B, 0, 3, 0) || ge(HW_ID.SHIMMER_3, L, 0, 1, 0)) return 3;
  if (ge(HW_ID.SHIMMER_3, B, 0, 2, 0)) return 2;
  if (ge(HW_ID.SHIMMER_2R, B, 1, 2, 0) || ge(HW_ID.SHIMMER_3, B, 0, 1, 0)) return 1;
  return -1;
}

/**
 * Whether this firmware carries the live ExG GET/SET register commands — the
 * gate the Java driver applies before every ExG read and write:
 * `(getFirmwareVersionInternal() >= 8 && getFirmwareVersionCode() == 2) ||
 * getFirmwareVersionCode() > 2` (ShimmerBluetooth.java:4015,4026,4205,4223).
 *
 * `firmwareVersionCode == 2` is exactly classic-Shimmer3 BtStream in
 * [0.2.0, 0.3.0), which only gained the ExG commands at internal 8 — hence the
 * extra `internal >= 8` leg. Everything newer (code > 2: all LogAndStream,
 * BtStream >= 0.3.0, SDLog, and every Shimmer3R) has them unconditionally.
 * BtStream 0.1.x (code 1) and anything below every rung (code -1) are rejected.
 */
export function shimmer3SupportsExg(fw: Shimmer3FwVersion, hardwareVersion: number): boolean {
  const code = deriveShimmer3FirmwareVersionCode(fw, hardwareVersion);
  return (fw.internal >= 8 && code === 2) || code > 2;
}

// ---------------------------------------------------------------------------
// Unframed-stream control-message framing
// ---------------------------------------------------------------------------

/**
 * Fixed payload lengths (bytes AFTER the opcode) for the control responses the
 * v1 client consumes. INQUIRY_RESPONSE is variable and handled specially in
 * {@link shimmer3ControlMessageLength}. Extend this table to teach the
 * byte-stream parser about further GET responses.
 *
 * Lengths taken from the `readBytes(n, ...)` calls in ShimmerBluetooth and the
 * LiteProtocol instruction-set response_size annotations.
 */
export const SHIMMER3_RESPONSE_PAYLOAD_LENGTHS: Readonly<Record<number, number>> = Object.freeze({
  [OPCODES.SAMPLING_RATE_RESPONSE]: 2, // 0x04
  [OPCODES.FW_VERSION_RESPONSE]: 6, // 0x2F
  [OPCODES.DEVICE_VERSION_RESPONSE]: 1, // 0x25
  [OPCODES.GSR_RANGE_RESPONSE]: 1, // 0x22
  [OPCODES.INTERNAL_EXP_POWER_ENABLE_RESPONSE]: 1, // 0x5F
});

/** Sentinel: need more bytes before the message length can be determined. */
export const NEED_MORE = -1;
/** Sentinel: leading byte is not a recognised control opcode — caller resyncs. */
export const RESYNC = 0;

/**
 * Given the head of the accumulated RFCOMM byte buffer, return the total length
 * (INCLUDING the leading opcode) of the complete control message it starts with,
 * or {@link NEED_MORE} if not enough bytes have arrived yet, or {@link RESYNC}
 * if the leading byte is not a control opcode we understand (garbage / a data
 * byte leaked into the control plane — the caller should drop one byte and
 * retry).
 *
 * This is the primitive that makes the unframed RFCOMM stream tractable: unlike
 * BLE (one notification == one message), RFCOMM delivers bytes split or
 * coalesced arbitrarily, so the client cannot assume `chunk[0]` is a whole
 * message. The Java driver solves the same problem with blocking `readBytes(n)`
 * calls that know each response's length up front (ShimmerBluetooth); this
 * expresses that length knowledge as a pure function.
 *
 * ACK (0xFF) and NACK (0xFE) are 1-byte messages. INQUIRY_RESPONSE (0x02) is
 * `9 + numChannels` bytes, and numChannels lives at index 7, so at least 8 bytes
 * are needed to compute the length.
 */
export function shimmer3ControlMessageLength(buf: Uint8Array): number {
  if (buf.length === 0) return NEED_MORE;
  const opcode = buf[0];

  if (opcode === ACK || opcode === NACK) return 1;

  if (opcode === OPCODES.INQUIRY_RESPONSE) {
    if (buf.length <= SHIMMER3_INQ_NUM_CHANNELS_OFFSET) return NEED_MORE; // need index 7 present
    const numChannels = buf[SHIMMER3_INQ_NUM_CHANNELS_OFFSET];
    // Sanity bound: a stray stream-data byte 0x02 can masquerade as an
    // INQUIRY_RESPONSE whose "numChannels" comes from garbage, swallowing up to
    // 264 bytes of real control traffic (including ACK/NACK). No real Shimmer3
    // has anywhere near 32 channels — treat implausible values as garbage and
    // resync instead.
    if (numChannels > 32) return RESYNC;
    return SHIMMER3_INQ_CHANNELS_OFFSET + numChannels; // 9 + numChannels
  }

  if (opcode === OPCODES.EXG_REGS_RESPONSE) {
    // Variable length: [opcode][count][reg0..reg(count-1)]. The count byte is
    // the number of registers the firmware is returning, echoed from the request
    // (`*(resPacket + packet_length++) = exgLength`,
    // `log-and-stream-common/Comms/shimmer_bt_uart.c:2223-2225`). One ADS1292R
    // bank is `EXG_BANK_LENGTH` registers and the SDK never asks for more, so a
    // larger "count" is garbage — resync rather than swallow up to 257 bytes of
    // real control traffic, the same policy as the memory reads below.
    if (buf.length < 2) return NEED_MORE;
    if (buf[1] > EXG_BANK_LENGTH) return RESYNC;
    return 2 + buf[1];
  }

  if (opcode === OPCODES.DAUGHTER_CARD_MEM_RESPONSE || opcode === OPCODES.INFOMEM_RESPONSE) {
    // Variable length: [opcode][length][data...]. Firmware caps both a
    // daughter-card memory read and an InfoMem read at 128 bytes — treat larger
    // "lengths" as garbage and resync.
    if (buf.length < 2) return NEED_MORE;
    const memLen = buf[1];
    if (memLen > 128) return RESYNC;
    return 2 + memLen;
  }

  const payload = SHIMMER3_RESPONSE_PAYLOAD_LENGTHS[opcode];
  if (payload === undefined) return RESYNC;
  return 1 + payload;
}
