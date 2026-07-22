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

import { OPCODES, TIMESTAMP_FIELD, type TimestampFmt } from '../shimmer3r/constants.js';
import { CHANNEL_FORMATS } from '../shimmer3r/channelFormats.js';
import { SensorBitmapShimmer3 } from '../shimmer3r/SensorBitmap.js';
import { u16le, hex2 } from '../shimmer3r/protocol.js';

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

/** One decoded channel within a streaming data frame. */
export interface Shimmer3ChannelField {
  id: number;
  name: string;
  fmt: string;
  endian: string;
  sizeBytes: number;
}

/** Describes how to slice a streaming data frame, built from an inquiry. */
export interface Shimmer3StreamSchema {
  timestampFmt: TimestampFmt;
  fields: Shimmer3ChannelField[];
  /** Total bytes per frame, including the 0x00 DATA_PACKET preamble byte. */
  frameBytes: number;
  enabledSensors: number;
  dataPreambleByte: number;
}

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
 * Mirrors ShimmerObject#interpretDataPacketFormat (the channel→format mapping is
 * identical for Shimmer3 and Shimmer3R, so `CHANNEL_FORMATS` and
 * `SensorBitmapShimmer3` are reused verbatim). The only Shimmer3-relevant knob is
 * the timestamp width (u24 for firmware code ≥ 6, else u16 — see
 * ShimmerObject#updateTimestampByteLength).
 */
export function buildShimmer3Schema(
  channelIds: number[],
  timestampFmt: TimestampFmt,
): Shimmer3StreamSchema {
  const fields: Shimmer3ChannelField[] = [];
  const ts = timestampFmt === 'u24' ? TIMESTAMP_FIELD.u24 : TIMESTAMP_FIELD.u16;
  let frameBytes = 1 + ts.sizeBytes; // 1 = DATA_PACKET (0x00) preamble
  let enabledSensors = 0;

  for (const id of channelIds) {
    const fmt = CHANNEL_FORMATS[id];
    if (!fmt) {
      fields.push({ id, name: `CH_${hex2(id)}`, fmt: 'i16', endian: 'le', sizeBytes: 2 });
      frameBytes += 2;
      continue;
    }
    fields.push({ id, ...fmt });
    frameBytes += fmt.sizeBytes ?? 2;
    enabledSensors |= channelIdToSensorBit(id);
  }

  return { timestampFmt, fields, frameBytes, enabledSensors, dataPreambleByte: 0x00 };
}

/** Map a channel/signal ID to its SensorBitmapShimmer3 enable bit (0 if none). */
function channelIdToSensorBit(id: number): number {
  switch (id) {
    case 0x00:
    case 0x01:
    case 0x02:
      return SensorBitmapShimmer3.SENSOR_A_ACCEL;
    case 0x04:
    case 0x05:
    case 0x06:
      return SensorBitmapShimmer3.SENSOR_D_ACCEL;
    case 0x14:
    case 0x15:
    case 0x16:
      return SensorBitmapShimmer3.SENSOR_ACCEL_ALT;
    case 0x07:
    case 0x08:
    case 0x09:
      return SensorBitmapShimmer3.SENSOR_MAG;
    case 0x0a:
    case 0x0b:
    case 0x0c:
      return SensorBitmapShimmer3.SENSOR_GYRO;
    case 0x12:
      return SensorBitmapShimmer3.SENSOR_INT_A1;
    case 0x1c:
      return SensorBitmapShimmer3.SENSOR_GSR;
    case 0x23:
    case 0x24:
      return SensorBitmapShimmer3.SENSOR_EXG1_16BIT;
    case 0x25:
    case 0x26:
      return SensorBitmapShimmer3.SENSOR_EXG2_16BIT;
    case 0x1e:
    case 0x1f:
      return SensorBitmapShimmer3.SENSOR_EXG1_24BIT;
    case 0x21:
    case 0x22:
      return SensorBitmapShimmer3.SENSOR_EXG2_24BIT;
    default:
      return 0;
  }
}

/**
 * Decode an INQUIRY_RESPONSE using the Shimmer3 (classic) layout.
 *
 * Accepts the message with or without the leading 0x02 opcode byte (the
 * byte-stream parser always includes it; a caller passing a bare body also
 * works, matching Shimmer3RClient's `base` handling).
 *
 * Ported from ShimmerObject#interpretInqResponse, HW_ID.SHIMMER_3 branch.
 */
export function interpretShimmer3InquiryResponse(
  u8: Uint8Array,
  timestampFmt: TimestampFmt = 'u24',
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

  const schema = buildShimmer3Schema(channelIds, timestampFmt);

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
  // EXG_REGS_RESPONSE (0x62): 11 payload bytes after the opcode = [echo][reg0..reg9]
  // (ShimmerBluetooth.java:468 declares length 11; :1641 reads 11).
  [OPCODES.EXG_REGS_RESPONSE]: 11, // 0x62
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

  const payload = SHIMMER3_RESPONSE_PAYLOAD_LENGTHS[opcode];
  if (payload === undefined) return RESYNC;
  return 1 + payload;
}
