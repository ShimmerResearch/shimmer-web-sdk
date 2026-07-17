/**
 * Pure codec for the Shimmer wired/dock UART protocol.
 *
 * Everything here is a side-effect-free function so it can be unit-tested with
 * byte fixtures and reused by the {@link WiredShimmerClient} regardless of the
 * byte pipe underneath. Ported from the Java driver:
 *   com.shimmerresearch.comms.wiredProtocol.AbstractCommsProtocolWired
 *     (#assembleTxPacket — TX build, AbstractCommsProtocolWired.java:404-456)
 *     (#processRxBuf     — RX framing, :639-757)
 *   com.shimmerresearch.comms.wiredProtocol.UartRxPacketObject (RX field parse)
 *   com.shimmerresearch.comms.wiredProtocol.CommsProtocolWiredShimmerViaDock
 *     (MAC / VER / battery response parsing)
 *   com.shimmerresearch.driverUtilities.ShimmerVerObject#parseVersionByteArray
 *   com.shimmerresearch.driverUtilities.ShimmerBattStatusDetails
 *   com.shimmerresearch.driverUtilities.ExpansionBoardDetails
 */

import { calibrateU12AdcValue } from '../shimmer3r/calibration.js';
import { shimmerUartCrcCalc, shimmerUartCrcCheck } from './crc.js';
import {
  UART_PACKET_HEADER,
  UART_PACKET_CMD,
  PACKET_OVERHEAD_RESPONSE_DATA,
  PACKET_OVERHEAD_RESPONSE_OTHER,
  CHARGING_STATUS_BYTE,
  type UartComponent,
  type UartComponentProperty,
  type ChargingStatus,
} from './constants.js';

// ---------------------------------------------------------------------------
// Byte utilities (re-exported from the shared helpers so dock consumers import
// from one place; these are identical across device families).
// ---------------------------------------------------------------------------
export { concatU8, u16le, hex2 } from '../shimmer3r/protocol.js';
import { concatU8 } from '../shimmer3r/protocol.js';

// ---------------------------------------------------------------------------
// TX — packet assembly
// ---------------------------------------------------------------------------

/**
 * Assemble a command packet: `$ | cmd | [length] | [comp | prop] | [payload] | crcLSB | crcMSB`.
 *
 * Mirrors `AbstractCommsProtocolWired#assembleTxPacket` (AbstractCommsProtocolWired.java:404-456):
 * - the LENGTH byte = component(1) + property(1) + payload.length, and is
 *   OMITTED entirely when that sum is 0 (i.e. an ACK/bad-response echo with no
 *   arg) — see the `msgLength>0` guard at lines 414/435;
 * - the CRC (2 bytes, LSB then MSB) is computed over the whole preceding buffer
 *   and appended, and is NOT counted in the LENGTH byte.
 *
 * @param command one of `UART_PACKET_CMD`
 * @param arg     the component/property address, or null (ACK / bad responses)
 * @param payload optional value bytes (for WRITE / mem commands), or null
 */
export function buildUartPacket(
  command: number,
  arg: UartComponentProperty | null,
  payload: Uint8Array | null = null,
): Uint8Array {
  const compPropLen = arg ? 2 : 0;
  const valueLen = payload ? payload.length : 0;
  const msgLength = compPropLen + valueLen;

  const pre: number[] = [UART_PACKET_HEADER, command & 0xff];
  if (msgLength > 0) pre.push(msgLength & 0xff);
  if (arg) {
    pre.push(arg.component & 0xff, arg.property & 0xff);
  }
  if (payload) {
    for (const b of payload) pre.push(b & 0xff);
  }

  const preU8 = Uint8Array.from(pre);
  const [crcLsb, crcMsb] = shimmerUartCrcCalc(preU8, preU8.length);
  return concatU8(preU8, Uint8Array.from([crcLsb, crcMsb]));
}

/** Build a READ (get) request for a component/property. */
export function buildReadPacket(arg: UartComponentProperty): Uint8Array {
  return buildUartPacket(UART_PACKET_CMD.READ, arg);
}

/** Build a WRITE (set) request for a component/property with a value payload. */
export function buildWritePacket(arg: UartComponentProperty, value: Uint8Array): Uint8Array {
  return buildUartPacket(UART_PACKET_CMD.WRITE, arg, value);
}

/**
 * Build the memory-read payload used by INFOMEM / daughter-card reads:
 * `[sizeByte] [addressBytes...]`. The address is 2 bytes little-endian, except
 * for `DAUGHTER_CARD.CARD_ID` where it is a single byte
 * (AbstractCommsProtocolWired#shimmerUartGetMemCommand, :293-309).
 */
export function buildMemReadPayload(
  arg: UartComponentProperty,
  address: number,
  size: number,
): Uint8Array {
  const singleByteAddr = isDaughterCardId(arg);
  const addr = singleByteAddr
    ? Uint8Array.from([address & 0xff])
    : Uint8Array.from([address & 0xff, (address >> 8) & 0xff]); // little-endian
  return concatU8(Uint8Array.from([size & 0xff]), addr);
}

/**
 * Build the memory-write payload: `[sizeByte] [addressBytes...] [data...]`
 * (AbstractCommsProtocolWired#shimmerUartSetMemCommand, :341-360). `size` is the
 * data length. Address encoding matches {@link buildMemReadPayload}.
 */
export function buildMemWritePayload(
  arg: UartComponentProperty,
  address: number,
  data: Uint8Array,
): Uint8Array {
  const head = buildMemReadPayload(arg, address, data.length);
  return concatU8(head, data);
}

function isDaughterCardId(arg: UartComponentProperty): boolean {
  return arg.component === 0x03 && arg.property === 0x02;
}

// ---------------------------------------------------------------------------
// RX — framing (reassembly length) + single-packet parse
// ---------------------------------------------------------------------------

/** Sentinel: not enough bytes buffered yet to know the message length. */
export const NEED_MORE = -1;
/** Sentinel: leading byte is not a valid header/command — caller drops 1 byte. */
export const RESYNC = 0;

/**
 * Given the head of the accumulated RX buffer, return the total byte length of
 * the complete UART packet it starts with, or {@link NEED_MORE} / {@link RESYNC}.
 *
 * This is the primitive that makes the unframed serial stream tractable: the
 * dock UART (over FTDI serial) delivers bytes split or coalesced arbitrarily, so
 * the client cannot assume one read == one packet. The Java driver solves the
 * same problem in `processRxBuf` with blocking top-up reads that know each
 * packet's length from `PACKET_OVERHEAD_RESPONSE_* + payloadLength`
 * (AbstractCommsProtocolWired.java:661-680); this expresses that as a pure
 * function.
 *
 * - Header must be `$` (0x24); otherwise RESYNC.
 * - DATA_RESPONSE/READ/WRITE: length = 5 + LENGTH-byte (needs index 2 present).
 * - ACK / BAD_*: length = 4.
 */
export function wiredPacketLength(buf: Uint8Array): number {
  if (buf.length === 0) return NEED_MORE;
  if (buf[0] !== UART_PACKET_HEADER) return RESYNC;
  if (buf.length < 2) return NEED_MORE;

  const cmd = buf[1];
  if (
    cmd === UART_PACKET_CMD.DATA_RESPONSE ||
    cmd === UART_PACKET_CMD.READ ||
    cmd === UART_PACKET_CMD.WRITE
  ) {
    if (buf.length < 3) return NEED_MORE; // need the LENGTH byte at index 2
    return PACKET_OVERHEAD_RESPONSE_DATA + buf[2];
  }
  if (
    cmd === UART_PACKET_CMD.ACK_RESPONSE ||
    cmd === UART_PACKET_CMD.BAD_CMD_RESPONSE ||
    cmd === UART_PACKET_CMD.BAD_ARG_RESPONSE ||
    cmd === UART_PACKET_CMD.BAD_CRC_RESPONSE
  ) {
    return PACKET_OVERHEAD_RESPONSE_OTHER;
  }
  return RESYNC; // unknown command byte
}

/** A parsed inbound UART packet (UartRxPacketObject fields). */
export interface UartRxPacket {
  command: number;
  /** Present only for DATA_RESPONSE / READ / WRITE. */
  component: number | null;
  property: number | null;
  /** The data payload (excludes component/property and CRC). Empty for ACK/bad. */
  payload: Uint8Array;
  /** Whether the trailing CRC validated. */
  crcOk: boolean;
  /** Total packet length consumed. */
  length: number;
}

/**
 * Parse exactly one complete packet from the START of `buf`. The caller is
 * responsible for having ensured a full packet is present (via
 * {@link wiredPacketLength}); the length is recomputed here and used to slice.
 *
 * Field extraction mirrors `UartRxPacketObject` (UartRxPacketObject.java:34-72):
 * for DATA_RESPONSE/READ/WRITE the LENGTH byte at index 2 counts
 * component+property+payload, so the payload is `LENGTH-2` bytes starting at
 * index 5 and the CRC is the final 2 bytes. CRC is validated with
 * `shimmerUartCrcCheck` over the whole packet (AbstractCommsProtocolWired
 * #parseSinglePacket, :760-767).
 *
 * @throws if `buf` does not start with a header or is too short for the packet.
 */
export function parseUartPacket(buf: Uint8Array): UartRxPacket {
  if (buf.length < 2 || buf[0] !== UART_PACKET_HEADER) {
    throw new Error('parseUartPacket: buffer does not start with a UART packet header');
  }
  const command = buf[1];
  const total = wiredPacketLength(buf);
  if (total <= 0 || buf.length < total) {
    throw new Error('parseUartPacket: incomplete packet');
  }
  const packet = buf.subarray(0, total);
  const crcOk = shimmerUartCrcCheck(packet);

  if (
    command === UART_PACKET_CMD.DATA_RESPONSE ||
    command === UART_PACKET_CMD.READ ||
    command === UART_PACKET_CMD.WRITE
  ) {
    const lengthByte = buf[2];
    const component = buf[3];
    const property = buf[4];
    // payload = LENGTH-2 bytes at offset 5 (comp+prop already consumed).
    const payloadLen = Math.max(0, lengthByte - 2);
    const payload = new Uint8Array(packet.subarray(5, 5 + payloadLen));
    return { command, component, property, payload, crcOk, length: total };
  }

  // ACK / BAD_* — no component/property/payload.
  return {
    command,
    component: null,
    property: null,
    payload: new Uint8Array(0),
    crcOk,
    length: total,
  };
}

/** True when a parsed command byte is one of the device error responses. */
export function isBadResponse(command: number): boolean {
  return (
    command === UART_PACKET_CMD.BAD_CMD_RESPONSE ||
    command === UART_PACKET_CMD.BAD_ARG_RESPONSE ||
    command === UART_PACKET_CMD.BAD_CRC_RESPONSE
  );
}

/** Map a bad-response command byte to a human-readable reason. */
export function badResponseReason(command: number): string {
  switch (command) {
    case UART_PACKET_CMD.BAD_CMD_RESPONSE:
      return 'BAD_CMD';
    case UART_PACKET_CMD.BAD_ARG_RESPONSE:
      return 'BAD_ARG';
    case UART_PACKET_CMD.BAD_CRC_RESPONSE:
      return 'BAD_CRC';
    default:
      return `0x${command.toString(16)}`;
  }
}

// ---------------------------------------------------------------------------
// Response payload parsers
// ---------------------------------------------------------------------------

/**
 * Format a MAC-address payload as a 12-char lowercase hex string (no
 * separators), taking the first 6 bytes in the order the device sends them.
 * Mirrors `CommsProtocolWiredShimmerViaDock#readMacId` (:40-53) +
 * `UtilShimmer.bytesToHexString`.
 */
export function parseMacId(payload: Uint8Array): string {
  if (payload.length < 6) throw new Error('MAC payload too short (need 6 bytes)');
  let s = '';
  for (let i = 0; i < 6; i++) s += payload[i].toString(16).padStart(2, '0');
  return s;
}

/** Parsed HW/FW version (ShimmerVerObject). */
export interface WiredVersionInfo {
  hardwareVersion: number;
  firmwareIdentifier: number;
  firmwareVersionMajor: number;
  firmwareVersionMinor: number;
  firmwareVersionInternal: number;
}

/**
 * Parse a VER response payload. Accepts the 7-byte (1-byte HW version) or
 * 8-byte (2-byte HW version) layout, matching
 * `ShimmerVerObject#parseVersionByteArray` (ShimmerVerObject.java:193-217):
 *   7-byte: [hw][fwId LE(2)][major LE(2)][minor][internal]
 *   8-byte: [hw LE(2)][fwId LE(2)][major LE(2)][minor][internal]
 */
export function parseVersionInfo(payload: Uint8Array): WiredVersionInfo {
  if (payload.length !== 7 && payload.length !== 8) {
    throw new Error(`VER payload must be 7 or 8 bytes, got ${payload.length}`);
  }
  let i = 0;
  let hardwareVersion: number;
  if (payload.length === 7) {
    hardwareVersion = payload[i++] & 0xff;
  } else {
    hardwareVersion = (payload[i++] | (payload[i++] << 8)) & 0xffff;
  }
  const firmwareIdentifier = (payload[i++] | (payload[i++] << 8)) & 0xffff;
  const firmwareVersionMajor = (payload[i++] | (payload[i++] << 8)) & 0xffff;
  const firmwareVersionMinor = payload[i++] & 0xff;
  const firmwareVersionInternal = payload[i] & 0xff;
  return {
    hardwareVersion,
    firmwareIdentifier,
    firmwareVersionMajor,
    firmwareVersionMinor,
    firmwareVersionInternal,
  };
}

const BATTERY_ERROR_VOLTAGE = 4.5;

/** Parsed battery status (ShimmerBattStatusDetails). */
export interface WiredBatteryStatus {
  /** Raw 12-bit ADC value. */
  adcValue: number;
  /** Battery voltage in volts. */
  voltage: number;
  /** Estimated charge %, clamped 0–100 (null when voltage is implausible). */
  percentage: number | null;
  /** Raw charging-status byte. */
  chargingStatusRaw: number;
  /** Decoded charging state. */
  chargingStatus: ChargingStatus;
}

/**
 * Convert a raw 12-bit battery ADC value to volts.
 * `adcValToBattVoltage` (ShimmerBattStatusDetails.java:143-147): the U12 ADC is
 * calibrated to millivolts (Vref=3 V, gain=1, offset=0 — reusing the shared
 * {@link calibrateU12AdcValue}), scaled by the on-board divider factor 1.988,
 * then converted mV→V.
 */
export function battAdcToVoltage(adcValue: number): number {
  const mv = calibrateU12AdcValue(adcValue, 0, 3, 1);
  return (mv * 1.988) / 1000;
}

/**
 * 4th-order polynomial charge-% estimate from voltage
 * (ShimmerBattStatusDetails#battVoltageToBattPercentage, :175-181), with the
 * pre-clamp to [3.2, 4.167] V and post-clamp to [0, 100]
 * (#calculateBattPercentage, :155-173).
 */
export function battVoltageToPercentage(voltage: number): number {
  let v = voltage;
  if (v > 4.167 + 0.2) v = 4.167;
  else if (v < 3.2 - 0.2) v = 3.2;
  let pct =
    1109.739792 * v ** 4 -
    17167.12674 * v ** 3 +
    99232.71686 * v ** 2 -
    253825.397 * v +
    242266.0527;
  if (pct > 100) pct = 100;
  else if (pct < 0) pct = 0;
  return pct;
}

function decodeChargingStatus(raw: number, voltage: number): ChargingStatus {
  if (voltage > BATTERY_ERROR_VOLTAGE) return 'CHECKING';
  switch (raw & 0xff) {
    case CHARGING_STATUS_BYTE.SUSPENDED:
      return 'SUSPENDED';
    case CHARGING_STATUS_BYTE.FULLY_CHARGED:
      return 'FULLY_CHARGED';
    case CHARGING_STATUS_BYTE.PRECONDITIONING:
      return 'CHARGING';
    case CHARGING_STATUS_BYTE.BAD_BATTERY:
      return 'BAD_BATTERY';
    case CHARGING_STATUS_BYTE.UNKNOWN:
      return 'UNKNOWN';
    default:
      return 'ERROR';
  }
}

/**
 * Parse a BAT.VALUE response payload (needs ≥3 bytes). ADC is a 12-bit
 * little-endian value in bytes [0..1] (LSB first), charging status byte [2]
 * (ShimmerBattStatusDetails.java:74-82).
 */
export function parseBatteryStatus(payload: Uint8Array): WiredBatteryStatus {
  if (payload.length < 3) throw new Error('battery payload too short (need 3 bytes)');
  const adcValue = ((payload[1] & 0xff) << 8) | (payload[0] & 0xff);
  const voltage = battAdcToVoltage(adcValue);
  const chargingStatusRaw = payload[2] & 0xff;
  const percentage = voltage <= BATTERY_ERROR_VOLTAGE ? battVoltageToPercentage(voltage) : null;
  return {
    adcValue,
    voltage,
    percentage,
    chargingStatusRaw,
    chargingStatus: decodeChargingStatus(chargingStatusRaw, voltage),
  };
}

/** Parsed daughter-card (expansion board) ID (ExpansionBoardDetails.java:57-60). */
export interface ExpansionBoardInfo {
  boardId: number;
  boardRev: number;
  specialRev: number;
}

/**
 * Parse the first 3 bytes of a daughter-card CARD_ID read as
 * `[boardId, boardRev, specialRev]` (ExpansionBoardDetails.java:58-60). Returns
 * null when the board is absent (an unwritten card memory reads back all 0xFF).
 */
export function parseExpansionBoard(payload: Uint8Array): ExpansionBoardInfo | null {
  if (payload.length < 3) return null;
  const boardId = payload[0] & 0xff;
  const boardRev = payload[1] & 0xff;
  const specialRev = payload[2] & 0xff;
  if (boardId === 0xff && boardRev === 0xff && specialRev === 0xff) return null;
  return { boardId, boardRev, specialRev };
}

/** Re-export for consumers building addresses. */
export type { UartComponent, UartComponentProperty };
