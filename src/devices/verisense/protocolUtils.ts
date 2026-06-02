import { ASM_PROPERTY } from './constants.js';

/** Read a 16-bit unsigned integer, little-endian. */
export function u16le(b0: number, b1: number): number {
  return (b1 << 8) | b0;
}

/** Format a single byte as an uppercase `0xNN` string. */
export function formatByteAsHex(v: number): string {
  return `0x${(v & 0xff).toString(16).toUpperCase().padStart(2, '0')}`;
}

/** Format bytes as `[0xAA, 0xBB, ...]`. */
export function formatByteArrayAsHex(
  bytes: ArrayLike<number> | ArrayBuffer | null | undefined,
): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  return `[${Array.from(u8, (b) => formatByteAsHex(Number(b))).join(', ')}]`;
}

/** Parse text containing hex bytes like `0x5A, 00 12` into a Uint8Array. */
export function parseHexByteString(text: string): Uint8Array {
  const matches = String(text ?? '').match(/[0-9a-fA-F]{2}/g) ?? [];
  if (!matches.length) {
    throw new Error('No hex bytes found. Example: 0x5A, 0x00, 0x12');
  }
  return new Uint8Array(matches.map((h) => Number.parseInt(h, 16)));
}

export interface PendingEventPropertyLabel {
  value: number;
  hex: string;
  property: string;
}

const ASM_PROPERTY_BY_VALUE = new Map(
  Object.entries(ASM_PROPERTY).map(([name, value]) => [Number(value), name]),
);

/** Label pending-event property values with both enum name and hex representation. */
export function formatPendingEventProperties(
  pendingProps: ArrayLike<number> | null | undefined,
): PendingEventPropertyLabel[] {
  const list = Array.isArray(pendingProps)
    ? pendingProps
    : pendingProps == null
      ? []
      : Array.from(pendingProps);
  return list.map((prop) => {
    const value = Number(prop) & 0xff;
    return {
      value,
      hex: formatByteAsHex(value),
      property: ASM_PROPERTY_BY_VALUE.get(value) ?? 'UNKNOWN_PROPERTY',
    };
  });
}

/** Read a signed 16-bit integer at byte offset `off`, little-endian. */
export function i16le(bytes: Uint8Array, off: number): number {
  const v = bytes[off] | (bytes[off + 1] << 8);
  return v & 0x8000 ? v - 0x10000 : v;
}

/** Read a 24-bit unsigned integer at byte offset `off`, little-endian. */
export function u24le(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8) | (bytes[off + 2] << 16)) >>> 0;
}

/** Read a 16-bit unsigned integer at byte offset `off`, little-endian (full-array form). */
export function u16le_at(bytes: Uint8Array, off: number): number {
  return (bytes[off] | (bytes[off + 1] << 8)) >>> 0;
}

/** Return current time in milliseconds. */
export function nowMillis(): number {
  return Date.now();
}

/**
 * Compute CRC-16/CCITT-FALSE over `bytes`.
 *
 * Parameters: poly=0x1021, init=0xFFFF, xorOut=0x0000.
 * Matches the C# `ComputeCRC` implementation used by Verisense firmware.
 */
export function crc16_ccitt_false(bytes: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] << 8;
    for (let b = 0; b < 8; b++) {
      crc = crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1;
      crc &= 0xffff;
    }
  }
  return crc & 0xffff;
}

/**
 * Extract the CRC that was appended to a logged payload (last 2 bytes, LE).
 */
export function getOriginalCrcLE(payload: Uint8Array): number {
  const n = payload.length;
  return (payload[n - 2] | (payload[n - 1] << 8)) >>> 0;
}

/**
 * Compute the CRC of a logged payload, excluding the trailing 2 CRC bytes,
 * matching the C# `ComputeCRC(payload, 0, payload.Length - 2)` call.
 */
export function computeCrcLikeCSharp(payload: Uint8Array): number {
  return crc16_ccitt_false(payload.subarray(0, payload.length - 2));
}

/**
 * Convert any reasonable representation of an operational config to a
 * `Uint8Array`. Throws if the input type is unrecognised.
 */
export function normalizeOperationalConfig(
  payload:
    | Uint8Array
    | ArrayBuffer
    | number[]
    | { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number }
    | null
    | undefined,
): Uint8Array | null {
  if (!payload) return null;
  if (payload instanceof Uint8Array) return payload;
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (Array.isArray(payload)) return new Uint8Array(payload);
  if ((payload as { buffer: ArrayBuffer }).buffer instanceof ArrayBuffer) {
    const p = payload as { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number };
    return new Uint8Array(p.buffer, p.byteOffset ?? 0, p.byteLength ?? p.buffer.byteLength);
  }
  throw new Error('normalizeOperationalConfig: unsupported payload type');
}

/** Alias for arbitrary protocol byte payload normalization. */
export function normalizeBytePayload(
  payload:
    | Uint8Array
    | ArrayBuffer
    | number[]
    | { buffer: ArrayBuffer; byteOffset?: number; byteLength?: number }
    | null
    | undefined,
): Uint8Array | null {
  return normalizeOperationalConfig(payload);
}

/**
 * Derive the 6-digit pairing PIN from a Verisense unique identifier.
 *
 * The PIN is built from digits 2, 4 and 6 (1-based) of the identifier,
 * followed by the decimal value of the final byte padded to 3 digits.
 */
export function computeVerisensePairingPin(uniqueId: string): string {
  const normalized = String(uniqueId ?? '')
    .trim()
    .replace(/^Verisense-/i, '');
  if (!/^[0-9a-fA-F]{8,}$/.test(normalized)) {
    throw new Error('computeVerisensePairingPin: uniqueId must be a hex identifier string');
  }

  if (normalized.length < 6) {
    throw new Error('computeVerisensePairingPin: uniqueId must be at least 6 hex characters');
  }

  const prefix = `${normalized[1]}${normalized[3]}${normalized[5]}`;
  const suffixHex = normalized.slice(-2);
  const suffixDec = Number.parseInt(suffixHex, 16);
  return `${prefix}${suffixDec.toString().padStart(3, '0')}`;
}

export interface ProductionConfig {
  hardware: string;
  firmware: string;
  asmid: string;
  configHeader: number;
  revHwMajor?: number;
  revHwMinor?: number;
  revHwInternal?: number;
  revFwMajor?: number;
  revFwMinor?: number;
  revFwInternal?: number;
}

export interface ProductionConfigBuildOptions {
  manufacturingOrderNumberHex: string;
  macIdHex: string;
  revHwMajor: number;
  revHwMinor: number;
  revFwMajor: number;
  revFwMinor: number;
  revFwInternal?: number;
  revHwInternal?: number;
  passkeyId?: string;
  passkey?: string;
  advertisingNamePrefix?: string;
  dfuEnabled?: boolean;
}

export interface ProductionConfigFull extends ProductionConfig {
  manufacturingOrderNumber: string;
  macId: string;
  uniqueIdentifier: string;
  revHwMajor: number;
  revHwMinor: number;
  revHwInternal: number;
  revFwMajor: number;
  revFwMinor: number;
  revFwInternal: number;
  passkeyId: string;
  passkey: string;
  advertisingNamePrefix: string;
  dfuEnabled: boolean;
}

export interface VerisenseStatusFlags {
  usbPluggedIn: boolean;
  recordingPaused: boolean;
  flashIsFull: boolean;
  powerIsGood: boolean;
  adaptiveSchedulerOn: boolean;
  dfuServiceOn: boolean;
  firstBoot: boolean;
  repeatedBatteryMeasurement: boolean;
}

export interface VerisenseStatusPayload {
  uniqueIdentifier: string;
  sourceStatusProperty: 'status1' | 'status2';
  statusTimestampSeconds: number;
  batteryMilliVolts: number;
  batteryPercent: number;
  lastOkTransferSeconds: number;
  lastFailTransferSeconds: number;
  memoryFreeKb: number;
  memoryCapacityKb: number | null;
  memoryUsedKb: number | null;
  /** kB of FULL (ready-to-sync) flash banks. Only populated for payloads >= 57 bytes. */
  memoryFullBanksKb: number | null;
  /** kB of 2DEL (partially-deleted) flash banks. Only populated for payloads >= 57 bytes. */
  memoryTwoDelBanksKb: number | null;
  /** kB of BAD flash banks. Only populated for payloads >= 57 bytes. */
  memoryBadBanksKb: number | null;
  statusFlags: VerisenseStatusFlags | null;
  batteryFallCounter: number | null;
}

export interface VerisenseUnixAndHumanTimestamp {
  unix: number;
  human: string;
}

export interface VerisenseStatusPayloadForLog extends VerisenseStatusPayload {
  statusTimestamp: VerisenseUnixAndHumanTimestamp;
  lastOkTransfer: VerisenseUnixAndHumanTimestamp;
  lastFailTransfer: VerisenseUnixAndHumanTimestamp;
}

export interface VerisenseSchedulerDebugPayload {
  currentTimeUnixSeconds: number;
  bleControlCounter: 'data-transfer' | 'status1' | 'rtc-sync' | 'status2' | 'never' | 'unknown';
  pendingDataTransferUnixSeconds: number;
  pendingStatus1UnixSeconds: number;
  pendingRtcSyncUnixSeconds: number;
  pendingRetryUnixSeconds: number;
  retryCount: number;
  retryOperation: 'ble-off' | 'ble-on' | 'unknown';
  adaptiveScheduler?: {
    nextUnixSeconds: number;
    enabled: boolean;
    syncFailCounter: number;
  };
  ltfRetry?: {
    nextUnixSeconds: number;
    currentOperation:
      | 'flash-write-retry-inactive'
      | 'short-flash-write-retry'
      | 'attempt-flash-write'
      | 'long-flash-write-retry'
      | 'sensor-paused-until-usb-plug-in'
      | 'unknown';
    failCounterShort: number;
    failCounterLong: number;
  };
  pendingStatus2UnixSeconds?: number;
  ppgMeasurementUnixSeconds?: number;
  stepCounterResetUnixSeconds?: number;
  sensorInactivityUnixSeconds?: number;
}

export interface VerisenseSchedulerDebugPayloadForLog extends VerisenseSchedulerDebugPayload {
  currentTime: VerisenseUnixAndHumanTimestamp;
  pendingDataTransfer: VerisenseUnixAndHumanTimestamp;
  pendingStatus1: VerisenseUnixAndHumanTimestamp;
  pendingRtcSync: VerisenseUnixAndHumanTimestamp;
  pendingRetry: VerisenseUnixAndHumanTimestamp;
  pendingStatus2?: VerisenseUnixAndHumanTimestamp;
  ppgMeasurement?: VerisenseUnixAndHumanTimestamp;
  stepCounterReset?: VerisenseUnixAndHumanTimestamp;
  sensorInactivity?: VerisenseUnixAndHumanTimestamp;
  adaptiveScheduler?: VerisenseSchedulerDebugPayload['adaptiveScheduler'] & {
    nextTime: VerisenseUnixAndHumanTimestamp;
  };
  ltfRetry?: VerisenseSchedulerDebugPayload['ltfRetry'] & {
    nextTime: VerisenseUnixAndHumanTimestamp;
  };
}

export interface VerisenseBleLinkDebugPayload {
  attMtu: number;
  maxDataLength: number;
  connectionIntervalUnits: number;
  connectionIntervalMs: number;
  txPhy: number;
  rxPhy: number;
  optimizationResult: number;
  isConnected: boolean;
}

export interface VerisenseEventLogEntry {
  index: number;
  eventId: number;
  eventName: string;
  timestampUnixSeconds: number | null;
  batteryMilliVolts: number | null;
}

/** Format unix seconds as raw + human-readable local datetime for logging. */
export function formatVerisenseUnixAndHuman(unixSeconds: number): VerisenseUnixAndHumanTimestamp {
  const unix = Number(unixSeconds);
  if (!Number.isFinite(unix)) {
    return { unix, human: 'invalid' };
  }
  if (unix <= 0) {
    return { unix, human: '1970-01-01 00:00:00 (epoch)' };
  }
  if (unix > 4102444800) {
    return { unix, human: 'not-valid' };
  }
  const d = new Date(unix * 1000);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const MM = String(d.getMinutes()).padStart(2, '0');
  const SS = String(d.getSeconds()).padStart(2, '0');
  return {
    unix,
    human: `${yyyy}-${mm}-${dd} ${HH}:${MM}:${SS}`,
  };
}

/** Convert parsed status payload into an object with human-readable timestamps for logs. */
export function formatStatusPayloadForLog(
  status: VerisenseStatusPayload,
): VerisenseStatusPayloadForLog {
  return {
    ...status,
    statusTimestamp: formatVerisenseUnixAndHuman(status.statusTimestampSeconds),
    lastOkTransfer: formatVerisenseUnixAndHuman(status.lastOkTransferSeconds),
    lastFailTransfer: formatVerisenseUnixAndHuman(status.lastFailTransferSeconds),
  };
}

/** Convert parsed scheduler payload into an object with human-readable timestamps for logs. */
export function formatSchedulerPayloadForLog(
  parsed: VerisenseSchedulerDebugPayload,
): VerisenseSchedulerDebugPayloadForLog {
  const out: VerisenseSchedulerDebugPayloadForLog = {
    ...parsed,
    adaptiveScheduler: undefined,
    ltfRetry: undefined,
    currentTime: formatVerisenseUnixAndHuman(parsed.currentTimeUnixSeconds),
    pendingDataTransfer: formatVerisenseUnixAndHuman(parsed.pendingDataTransferUnixSeconds),
    pendingStatus1: formatVerisenseUnixAndHuman(parsed.pendingStatus1UnixSeconds),
    pendingRtcSync: formatVerisenseUnixAndHuman(parsed.pendingRtcSyncUnixSeconds),
    pendingRetry: formatVerisenseUnixAndHuman(parsed.pendingRetryUnixSeconds),
  };

  if (typeof parsed.pendingStatus2UnixSeconds === 'number') {
    out.pendingStatus2 = formatVerisenseUnixAndHuman(parsed.pendingStatus2UnixSeconds);
  }
  if (typeof parsed.ppgMeasurementUnixSeconds === 'number') {
    out.ppgMeasurement = formatVerisenseUnixAndHuman(parsed.ppgMeasurementUnixSeconds);
  }
  if (typeof parsed.stepCounterResetUnixSeconds === 'number') {
    out.stepCounterReset = formatVerisenseUnixAndHuman(parsed.stepCounterResetUnixSeconds);
  }
  if (typeof parsed.sensorInactivityUnixSeconds === 'number') {
    out.sensorInactivity = formatVerisenseUnixAndHuman(parsed.sensorInactivityUnixSeconds);
  }
  if (parsed.adaptiveScheduler) {
    out.adaptiveScheduler = {
      ...parsed.adaptiveScheduler,
      nextTime: formatVerisenseUnixAndHuman(parsed.adaptiveScheduler.nextUnixSeconds),
    };
  }
  if (parsed.ltfRetry) {
    out.ltfRetry = {
      ...parsed.ltfRetry,
      nextTime: formatVerisenseUnixAndHuman(parsed.ltfRetry.nextUnixSeconds),
    };
  }

  return out;
}

export interface VerisenseRecordBufferDetails {
  bufferIndex: number;
  bufferState: number;
  packagedPayloadIndex: number;
  currentByteIndexForSensorData: number;
  usedBufferLength: number;
  fifoTicks: number;
  dataTimestampRwcMinutes: number;
  dataTimestampRwcTicks: number;
  temperatureData: number;
  dataTimestampUcClockMinutes: number | null;
  dataTimestampUcClockTicks: number | null;
}

export interface VerisenseLookupTableEntry {
  bankIndex: number;
  statusCode: number;
  statusName: 'Full' | '2Del' | 'Emty' | 'Bad' | 'NUse' | 'Zero' | 'Unknown';
  pendingEepromWrite: boolean;
  payloadIndex: number;
}

export interface VerisenseLookupTablePayload {
  head: number | null;
  tail: number | null;
  entries: VerisenseLookupTableEntry[];
}

const PROD_CONFIG_FLAG_DFU_ENABLED = 1 << 0;

const LOG_EVENT_NAMES: Record<number, string> = {
  0: 'NONE',
  1: 'BATTERY_FALL',
  2: 'BATTERY_RECOVER',
  3: 'WRITE_TO_FLASH_SUCCESS',
  4: 'WRITE_TO_FLASH_FAIL_GENERAL',
  5: 'WRITE_TO_FLASH_FULL',
  6: 'WRITE_TO_FLASH_FAIL_CHECK_ADDR_FREE',
  7: 'WRITE_TO_FLASH_FAIL_LOW_BATT_CHECK_ADDR_FREE',
  8: 'WRITE_TO_FLASH_FAIL_LOW_BATT_FLASH_ON',
  9: 'WRITE_TO_FLASH_FAIL_LOW_BATT_FLASH_WRITE',
  10: 'WRITE_TO_FLASH_FAIL_LOW_BATT_BEFORE_START',
  11: 'USB_PLUGGED_IN_SOFT_DEVICE',
  12: 'USB_PLUGGED_OUT_SOFT_DEVICE',
  13: 'RECORDING_PAUSED',
  14: 'RECORDING_RESUMED',
  15: 'BATTERY_RECOVER_IN_BATT_CHECK_TIMER',
  16: 'TSK_FREE_UP_FLASH',
  17: 'FREE_UP_FLASH_FAIL_LOW_BATT',
  18: 'PAYLOAD_PACKAGING_TASK_SET',
  19: 'PAYLOAD_PACKAGING_FUNCTION_CALL',
  20: 'BATTERY_VOLTAGE',
  21: 'TSK_WRITE_LOOKUP_TBL_CHANGES_TO_EEPROM',
  22: 'LPCOMP_ON',
  23: 'LPCOMP_ON_ALREADY',
  24: 'LPCOMP_OFF',
  25: 'LPCOMP_TRIED_BUT_BATT_LOW',
  26: 'BLE_CONNECTED',
  27: 'BLE_DISCONNECTED',
  28: 'TSK_WRITE_FLASH',
  29: 'PPG_TIMER_START',
  30: 'PAYLOAD_OVERSHOT',
  31: 'ADVERTISING_START',
  32: 'ADVERTISING_STOP',
  33: 'NIMH_BATT_PPG_BLOCKED_BLE_RETRY',
  34: 'NIMH_BATT_PPG_BLOCKED_BLE_ADAPT_SCH',
  35: 'NIMH_BATT_PPG_BLOCKED_BLE_PENDING_EVENTS',
  36: 'NIMH_BATT_BLE_BLOCKED_PPG',
  37: 'USB_PORT_OPEN',
  38: 'USB_PORT_CLOSED',
  39: 'FIFO_INT_SAFETY_CHECK_EVENT_ACCEL1',
  40: 'FIFO_INT_SAFETY_CHECK_EVENT_ACCEL2GYRO',
  41: 'FIFO_INT_SAFETY_CHECK_EVENT_MAX86XXX',
  42: 'FIFO_INT_SAFETY_CHECK_EVENT_MAX3000X',
  43: 'FIFO_INT_SAFETY_CHECK_EVENT_ADC',
  44: 'USB_PLUGGED_IN_PIN_HANDLER',
  45: 'USB_PLUGGED_OUT_PIN_HANDLER',
  46: 'BATTERY_CHARGER_STATUS_BAD_BATTERY',
  47: 'BATTERY_CHARGER_STATUS_CHARGING',
  48: 'BATTERY_CHARGER_STATUS_CHARGING_COMPLETE',
  49: 'BATTERY_CHARGER_STATUS_POWER_DOWN',
  50: 'LTC4123_RECOVERY_ATTEMPT',
  51: 'LTC4123_RECOVERY_GAVE_UP',
  52: 'LTC4123_CHRG_COMPLETE_OVERRIDDEN_BAD_BATT',
};

const LOOKUP_STATUS_NAMES: Record<number, VerisenseLookupTableEntry['statusName']> = {
  0: 'Zero',
  1: 'Full',
  2: '2Del',
  3: 'Emty',
  4: 'Bad',
  5: 'NUse',
};

function u32le_at(bytes: Uint8Array, off: number): number {
  return (
    ((bytes[off] ?? 0) |
      ((bytes[off + 1] ?? 0) << 8) |
      ((bytes[off + 2] ?? 0) << 16) |
      ((bytes[off + 3] ?? 0) << 24)) >>>
    0
  );
}

function decodeAsciiTrimFF(bytes: Uint8Array): string {
  let end = bytes.length;
  while (end > 0 && bytes[end - 1] === 0xff) end--;
  if (end === 0) return '';
  return new TextDecoder().decode(bytes.slice(0, end));
}

/** Convert unix seconds into Verisense 7-byte RTC payload (4-byte minutes + 3-byte ticks). */
export function unixSecondsToAsmRtcBytes(unixSeconds: number): Uint8Array {
  if (!Number.isFinite(unixSeconds) || unixSeconds < 0) {
    throw new Error('unixSecondsToAsmRtcBytes: unixSeconds must be a finite positive number');
  }

  const minutes = Math.floor(unixSeconds / 60);
  const secondsInMinute = unixSeconds - minutes * 60;
  const ticks = Math.floor(secondsInMinute * 32768);

  return new Uint8Array([
    minutes & 0xff,
    (minutes >> 8) & 0xff,
    (minutes >> 16) & 0xff,
    (minutes >> 24) & 0xff,
    ticks & 0xff,
    (ticks >> 8) & 0xff,
    (ticks >> 16) & 0xff,
  ]);
}

/** Convert Verisense 7-byte RTC payload into unix seconds. */
export function asmRtcBytesToUnixSeconds(rtc7: Uint8Array): number {
  if (rtc7.length !== 7) {
    throw new Error('asmRtcBytesToUnixSeconds: payload must be exactly 7 bytes');
  }

  const minutes = u32le_at(rtc7, 0);
  const ticks = u24le(rtc7, 4);
  return minutes * 60 + ticks / 32768.0;
}

/** Convert Verisense 8-byte minute counter payload into unix seconds. */
export function asmRtcMinutesBytesToUnixSeconds(minutes8: Uint8Array): number {
  if (minutes8.length !== 8) {
    throw new Error('asmRtcMinutesBytesToUnixSeconds: payload must be exactly 8 bytes');
  }

  let minutes = 0n;
  for (let i = 0; i < 8; i++) {
    minutes |= BigInt(minutes8[i]) << BigInt(i * 8);
  }
  return Number(minutes) * 60;
}

/**
 * Build a production configuration payload (56 bytes) from structured options.
 * This matches the Python tooling layout used by ASM_BLE.py / ASM_Device.py.
 */
export function buildProductionConfigPayload(opts: ProductionConfigBuildOptions): Uint8Array {
  const mo = String(opts.manufacturingOrderNumberHex ?? '').trim();
  const mac = String(opts.macIdHex ?? '').trim();
  if (!/^[0-9a-fA-F]{8}$/.test(mo)) {
    throw new Error(
      'buildProductionConfigPayload: manufacturingOrderNumberHex must be 8 hex chars',
    );
  }
  if (!/^[0-9a-fA-F]{4}$/.test(mac)) {
    throw new Error('buildProductionConfigPayload: macIdHex must be 4 hex chars');
  }

  const uniqueBytes = new Uint8Array(6);
  uniqueBytes.set(new Uint8Array(mo.match(/../g)!.map((h) => Number.parseInt(h, 16))), 0);
  uniqueBytes.set(new Uint8Array(mac.match(/../g)!.map((h) => Number.parseInt(h, 16))), 4);
  uniqueBytes.reverse();

  const revHwInternal = (opts.revHwInternal ?? 0) & 0xffff;
  const revFwInternal = (opts.revFwInternal ?? 0) & 0xffff;

  const out = new Uint8Array(56);
  out[0] = 0x5a;
  out.set(uniqueBytes, 1);
  out[7] = opts.revHwMajor & 0xff;
  out[8] = opts.revHwMinor & 0xff;
  out[9] = opts.revFwMajor & 0xff;
  out[10] = opts.revFwMinor & 0xff;
  out[11] = revFwInternal & 0xff;
  out[12] = (revFwInternal >> 8) & 0xff;
  out[13] = revHwInternal & 0xff;
  out[14] = (revHwInternal >> 8) & 0xff;

  out.fill(0xff, 15, 56);

  const passkeyId = opts.passkeyId ?? '';
  if (passkeyId.length > 0) {
    if (passkeyId.length !== 2) {
      throw new Error('buildProductionConfigPayload: passkeyId must be 2 chars when provided');
    }
    out.set(new TextEncoder().encode(passkeyId), 15);
  }

  const passkey = opts.passkey ?? '';
  if (passkey.length > 0) {
    if (passkey.length !== 6) {
      throw new Error('buildProductionConfigPayload: passkey must be 6 chars when provided');
    }
    out.set(new TextEncoder().encode(passkey), 17);
  }

  const advPrefix = opts.advertisingNamePrefix ?? '';
  if (advPrefix.length > 32) {
    throw new Error('buildProductionConfigPayload: advertisingNamePrefix must be <= 32 chars');
  }
  if (advPrefix.length > 0) {
    out.set(new TextEncoder().encode(advPrefix), 23);
  }

  if (opts.dfuEnabled ?? true) {
    out[55] = PROD_CONFIG_FLAG_DFU_ENABLED;
  }

  return out;
}

/** Parse production configuration with optional passkey/name/flag fields. */
export function parseProductionConfigPayloadFull(response: Uint8Array): ProductionConfigFull {
  if (response.length < 11) {
    throw new Error('parseProductionConfigPayloadFull: payload must be at least 11 bytes');
  }

  const base = parseProductionConfigPayload(response);
  const uniqueIdentifier = [...response.slice(1, 7)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

  const revHwMajor = response[7] ?? 0;
  const revHwMinor = response[8] ?? 0;
  const revFwMajor = response[9] ?? 0;
  const revFwMinor = response[10] ?? 0;
  const revFwInternal = response.length >= 13 ? u16le_at(response, 11) : 0;
  const revHwInternal = response.length >= 15 ? u16le_at(response, 13) : 0;

  const passkeyId = response.length >= 17 ? decodeAsciiTrimFF(response.slice(15, 17)) : '';
  const passkey = response.length >= 23 ? decodeAsciiTrimFF(response.slice(17, 23)) : '';
  const advertisingNamePrefix =
    response.length >= 55 ? decodeAsciiTrimFF(response.slice(23, 55)) : '';
  const dfuEnabled = response.length >= 56 ? !!(response[55] & PROD_CONFIG_FLAG_DFU_ENABLED) : true;

  return {
    ...base,
    manufacturingOrderNumber: uniqueIdentifier.slice(0, 8),
    macId: uniqueIdentifier.slice(8, 12),
    uniqueIdentifier,
    revHwMajor,
    revHwMinor,
    revHwInternal,
    revFwMajor,
    revFwMinor,
    revFwInternal,
    passkeyId,
    passkey,
    advertisingNamePrefix,
    dfuEnabled,
  };
}

/**
 * Parse STATUS1/STATUS2 payload into a typed object.
 *
 * This ports the core byte parsing from ASM_Device.parse_status while keeping
 * the output concise and UI-friendly.
 */
export function parseStatusPayload(
  response: Uint8Array,
  sourceStatusProperty: 'status1' | 'status2' = 'status1',
): VerisenseStatusPayload {
  if (response.length < 24) {
    throw new Error('parseStatusPayload: payload must be at least 24 bytes');
  }

  const uniqueIdentifier = [...response.slice(0, 6)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();

  const hasTickFields = response.length >= 56;
  const hasExtendedCapacity = response.length >= 65;

  const statusTimestampSeconds = hasTickFields
    ? asmRtcBytesToUnixSeconds(
        new Uint8Array([...response.slice(6, 10), ...response.slice(34, 37)]),
      )
    : u32le_at(response, 6) * 60;

  const batteryMilliVolts = u16le_at(response, 10);
  const batteryPercent = response[12] ?? 0;

  const lastOkTransferSeconds = hasTickFields
    ? asmRtcBytesToUnixSeconds(
        new Uint8Array([...response.slice(13, 17), ...response.slice(37, 40)]),
      )
    : u32le_at(response, 13) * 60;

  const lastFailTransferSeconds = hasTickFields
    ? asmRtcBytesToUnixSeconds(
        new Uint8Array([...response.slice(17, 21), ...response.slice(40, 43)]),
      )
    : u32le_at(response, 17) * 60;

  const memoryFreeKb = hasExtendedCapacity
    ? (response[21] | (response[22] << 8) | (response[23] << 16) | (response[57] << 24)) >>> 0
    : (response[21] | (response[22] << 8) | (response[23] << 16)) >>> 0;

  const memoryCapacityKb = hasExtendedCapacity ? u32le_at(response, 60) : null;
  const memoryUsedKb =
    memoryCapacityKb == null ? null : Math.max(0, memoryCapacityKb - memoryFreeKb);

  // Bank breakdown: FULL=syncable data, 2DEL=partially-deleted, BAD=unusable flash.
  // Present in payloads >= 57 bytes (tick-capable extended format).
  const hasBankData = response.length >= 57;
  const memoryFullBanksKb = hasBankData ? u32le_at(response, 45) : null;
  const memoryTwoDelBanksKb = hasBankData ? u32le_at(response, 49) : null;
  const memoryBadBanksKb = hasBankData ? u32le_at(response, 53) : null;

  const batteryFallCounter = response.length >= 26 ? u16le_at(response, 24) : null;

  let statusFlags: VerisenseStatusFlags | null = null;
  if (response.length >= 34) {
    const f = response[26];
    statusFlags = {
      usbPluggedIn: (f & 0x01) !== 0,
      recordingPaused: (f & 0x02) !== 0,
      flashIsFull: (f & 0x04) !== 0,
      powerIsGood: (f & 0x08) !== 0,
      adaptiveSchedulerOn: (f & 0x10) !== 0,
      dfuServiceOn: (f & 0x20) !== 0,
      firstBoot: (f & 0x40) !== 0,
      repeatedBatteryMeasurement: (f & 0x80) !== 0,
    };
  }

  return {
    uniqueIdentifier,
    sourceStatusProperty,
    statusTimestampSeconds,
    batteryMilliVolts,
    batteryPercent,
    lastOkTransferSeconds,
    lastFailTransferSeconds,
    memoryFreeKb,
    memoryCapacityKb,
    memoryUsedKb,
    memoryFullBanksKb,
    memoryTwoDelBanksKb,
    memoryBadBanksKb,
    statusFlags,
    batteryFallCounter,
  };
}

/** Parse scheduler debug response payload from DEBUG_COMMAND_ID.RWC_SCHEDULER_READ. */
export function parseSchedulerDebugPayload(payload: Uint8Array): VerisenseSchedulerDebugPayload {
  if (payload.length < 42) {
    throw new Error('parseSchedulerDebugPayload: payload is too short');
  }

  let idx = 0;
  const currentTimeUnixSeconds = asmRtcBytesToUnixSeconds(payload.slice(idx, idx + 7));
  idx += 7;

  const bleControlByte = payload[idx++] ?? 0xff;
  const bleControlCounter =
    bleControlByte === 0x00
      ? 'data-transfer'
      : bleControlByte === 0x01
        ? 'status1'
        : bleControlByte === 0x02
          ? 'rtc-sync'
          : bleControlByte === 0x03
            ? 'status2'
            : bleControlByte === 0xff
              ? 'never'
              : 'unknown';

  const next8 = (): number => {
    const v = asmRtcMinutesBytesToUnixSeconds(payload.slice(idx, idx + 8));
    idx += 8;
    return v;
  };

  const out: VerisenseSchedulerDebugPayload = {
    currentTimeUnixSeconds,
    bleControlCounter,
    pendingDataTransferUnixSeconds: next8(),
    pendingStatus1UnixSeconds: next8(),
    pendingRtcSyncUnixSeconds: next8(),
    pendingRetryUnixSeconds: next8(),
    retryCount: payload[idx++] ?? 0,
    retryOperation: (payload[idx++] ?? 0) === 1 ? 'ble-on' : 'ble-off',
  };

  if (payload.length >= idx + 10) {
    out.adaptiveScheduler = {
      nextUnixSeconds: next8(),
      enabled: (payload[idx++] ?? 0) === 1,
      syncFailCounter: payload[idx++] ?? 0,
    };
  }

  if (payload.length >= idx + 11) {
    const nextUnixSeconds = next8();
    const op = payload[idx++] ?? 0;
    out.ltfRetry = {
      nextUnixSeconds,
      currentOperation:
        op === 0
          ? 'flash-write-retry-inactive'
          : op === 1
            ? 'short-flash-write-retry'
            : op === 2
              ? 'attempt-flash-write'
              : op === 3
                ? 'long-flash-write-retry'
                : op === 4
                  ? 'sensor-paused-until-usb-plug-in'
                  : 'unknown',
      failCounterShort: payload[idx++] ?? 0,
      failCounterLong: payload[idx++] ?? 0,
    };
  }

  if (payload.length >= idx + 8) {
    out.pendingStatus2UnixSeconds = next8();
  }
  if (payload.length >= idx + 8) {
    out.ppgMeasurementUnixSeconds = next8();
  }
  if (payload.length >= idx + 8) {
    out.stepCounterResetUnixSeconds = next8();
  }
  if (payload.length >= idx + 8) {
    out.sensorInactivityUnixSeconds = next8();
  }

  return out;
}

/** Parse debug payload from BLE link read/optimize commands. */
export function parseBleLinkDebugPayload(payload: Uint8Array): VerisenseBleLinkDebugPayload {
  if (payload.length < 10) {
    throw new Error('parseBleLinkDebugPayload: payload is too short');
  }

  const connectionIntervalUnits = u16le_at(payload, 4);
  return {
    attMtu: u16le_at(payload, 0),
    maxDataLength: u16le_at(payload, 2),
    connectionIntervalUnits,
    connectionIntervalMs: connectionIntervalUnits * 1.25,
    txPhy: payload[6] ?? 0,
    rxPhy: payload[7] ?? 0,
    optimizationResult: payload[8] ?? 0,
    isConnected: (payload[9] ?? 0) !== 0,
  };
}

/** Parse debug payload listing bank indexes with bad CRC (2-byte LE entries). */
export function parsePayloadCrcErrorBankIndexes(payload: Uint8Array): number[] {
  if (payload.length % 2 !== 0) {
    throw new Error('parsePayloadCrcErrorBankIndexes: payload length must be even');
  }
  const out: number[] = [];
  for (let i = 0; i < payload.length; i += 2) out.push(u16le_at(payload, i));
  return out;
}

/** Parse 8-byte debug event-log entries. */
export function parseEventLogPayload(payload: Uint8Array): VerisenseEventLogEntry[] {
  if (payload.length % 8 !== 0) {
    throw new Error('parseEventLogPayload: payload length must be a multiple of 8');
  }

  const out: VerisenseEventLogEntry[] = [];
  for (let i = 0; i < payload.length; i += 8) {
    const entry = payload.slice(i, i + 8);
    const eventId = entry[7];
    if (eventId === 0) continue;

    out.push({
      index: i / 8,
      eventId,
      eventName: LOG_EVENT_NAMES[eventId] ?? `EVENT_${eventId}`,
      timestampUnixSeconds: eventId === 20 ? null : asmRtcBytesToUnixSeconds(entry.slice(0, 7)),
      batteryMilliVolts: eventId === 20 ? u24le(entry, 0) : null,
    });
  }
  return out;
}

/** Parse record-buffer details payload (26-byte current layout, 19-byte legacy layout). */
export function parseRecordBufferDetailsPayload(
  payload: Uint8Array,
): VerisenseRecordBufferDetails[] {
  const bytesPerBuffer = payload.length % 26 === 0 ? 26 : payload.length % 19 === 0 ? 19 : 0;
  if (!bytesPerBuffer) {
    throw new Error('parseRecordBufferDetailsPayload: unsupported payload length');
  }

  const out: VerisenseRecordBufferDetails[] = [];
  for (let i = 0; i < payload.length; i += bytesPerBuffer) {
    const row = payload.slice(i, i + bytesPerBuffer);
    out.push({
      bufferIndex: row[0],
      bufferState: row[1],
      packagedPayloadIndex: u16le_at(row, 2),
      currentByteIndexForSensorData: u16le_at(row, 4),
      usedBufferLength: u16le_at(row, 6),
      fifoTicks: u16le_at(row, 8),
      dataTimestampRwcMinutes: u32le_at(row, 10),
      dataTimestampRwcTicks: u24le(row, 14),
      temperatureData: u16le_at(row, 17),
      dataTimestampUcClockMinutes: bytesPerBuffer >= 23 ? u32le_at(row, 19) : null,
      dataTimestampUcClockTicks: bytesPerBuffer >= 26 ? u24le(row, 23) : null,
    });
  }

  return out;
}

/**
 * Parse lookup-table debug payload entries (3 bytes per bank), with optional
 * 4-byte tail/head prefix present in older firmware debug responses.
 */
export function parseLookupTablePayload(
  payload: Uint8Array,
  totalBanks: number,
): VerisenseLookupTablePayload {
  const bytesPerBank = 3;
  const expectedNoHeadTail = totalBanks * bytesPerBank;
  const expectedWithHeadTail = expectedNoHeadTail + 4;

  let data = payload;
  let head: number | null = null;
  let tail: number | null = null;

  if (payload.length === expectedWithHeadTail) {
    tail = u16le_at(payload, 0);
    head = u16le_at(payload, 2);
    data = payload.slice(4);
  } else if (payload.length !== expectedNoHeadTail) {
    throw new Error(
      `parseLookupTablePayload: payload length ${payload.length} does not match expected ${expectedNoHeadTail} or ${expectedWithHeadTail}`,
    );
  }

  const entries: VerisenseLookupTableEntry[] = [];
  for (let bankIndex = 0; bankIndex < totalBanks; bankIndex++) {
    const off = bankIndex * bytesPerBank;
    const statusByte = data[off];
    const pendingEepromWrite = (statusByte & 0x80) !== 0;
    const statusCode = statusByte & 0x7f;
    entries.push({
      bankIndex,
      statusCode,
      statusName: LOOKUP_STATUS_NAMES[statusCode] ?? 'Unknown',
      pendingEepromWrite,
      payloadIndex: u16le_at(data, off + 1),
    });
  }

  return { head, tail, entries };
}

/**
 * Parse the production config response payload into a structured object.
 */
export function parseProductionConfigPayload(response: Uint8Array): ProductionConfig {
  const isAllFFs = (arr: Uint8Array) => arr.every((b) => b === 255);

  const configHeader = response[0];
  const asmid = [...response.slice(1, 7)]
    .reverse()
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  const revHwMajor = response[7];
  const revHwMinor = response[8];
  const revFwMajor = response[9];
  const revFwMinor = response[10];

  const fwInternalArray = response.slice(11, 13);
  const revFwInternal = fwInternalArray[0] | (fwInternalArray[1] << 8);

  let revHwInternal = 0;
  if (response.length >= 15) {
    const hwInternalArray = response.slice(13, 15);
    if (!isAllFFs(hwInternalArray)) {
      revHwInternal = hwInternalArray[0] | (hwInternalArray[1] << 8);
    }
  }

  return {
    hardware: `${revHwMajor}.${revHwMinor}.${revHwInternal}`,
    firmware: `${revFwMajor}.${revFwMinor}.${revFwInternal}`,
    asmid: asmid.toUpperCase(),
    configHeader,
    revHwMajor,
    revHwMinor,
    revHwInternal,
    revFwMajor,
    revFwMinor,
    revFwInternal,
  };
}
