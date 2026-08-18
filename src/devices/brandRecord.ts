/**
 * EEPROM brand (advertising name) record.
 *
 * Shimmer3/Shimmer3R firmware stores the effective BT/BLE/USB name prefixes in
 * a 64-byte record in the daughter-card EEPROM (log-and-stream-common
 * `EEPROM/shimmer_eeprom.h`, `gEepromBrandDetails`). On boot, firmware seeds
 * the record with its compile-time defaults when it is blank or invalid and
 * treats it as the single source of truth from then on — so hosts can always
 * read the current effective names back, and can rebrand a unit by writing a
 * new record (the new names apply at the next Bluetooth init / reboot).
 *
 * The record lives at HOST daughter-card-memory offset 1952 (absolute EEPROM
 * bytes 1968–2031 — host offsets skip the first, HW-details, EEPROM page).
 * Reachable over BLE/BT via GET/SET_DAUGHTER_CARD_MEM and over the dock UART /
 * USB-C via `UART_PROP.DAUGHTER_CARD.CARD_MEM` — both take host offsets.
 *
 * Layout (all multi-byte fields little-endian, name fields NOT NUL-terminated):
 * ```
 * offset  size  field
 *      0     2  magic 0x5342 ("SB": bytes 0x42,0x53 on the wire)
 *      2     1  layoutVer (1)
 *      3     1  flags: bit0 customerBranded, bits1-2 seededPlatform
 *      4     1  btClassicLen        5     1  bleLen        6     1  usbLen
 *      7    16  btClassic (Classic BT name prefix)
 *     23    10  ble       (BLE name prefix)
 *     33    16  usb       (USB product prefix / manufacturer)
 *     49    13  padding (zero)
 *     62     2  CRC over bytes 0..61 — Shimmer UART CRC, LSB first
 * ```
 */

import { shimmerUartCrcCalc } from './dock/crc.js';

/** Host daughter-card-memory offset of the record (absolute EEPROM 1968). */
export const BRAND_RECORD_HOST_OFFSET = 1952;
export const BRAND_RECORD_SIZE = 64;
export const BRAND_RECORD_MAGIC = 0x5342;
export const BRAND_RECORD_LAYOUT_VER = 1;

export const BRAND_BT_CLASSIC_MAX_CHARS = 16;
export const BRAND_BLE_MAX_CHARS = 10;
export const BRAND_USB_MAX_CHARS = 16;
/**
 * Shimmer3 firmware truncates the BLE prefix to 8 chars so "<prefix>-XXXX"
 * fits the RN4678's 31-byte advertisement payload. Shimmer3R allows the full
 * field width.
 */
export const BRAND_BLE_MAX_CHARS_SHIMMER3 = 8;

/** `flags` bits 1-2: which platform seeded a stock (non-customer) record. */
export const BRAND_PLATFORM = Object.freeze({
  UNKNOWN: 0,
  SHIMMER3: 1,
  SHIMMER3R: 2,
  SHIMMER4_SDK: 3,
} as const);

const FLAG_CUSTOMER_BRANDED = 0x01;
const PLATFORM_MASK = 0x06;
const PLATFORM_SHIFT = 1;

const OFF_MAGIC = 0;
const OFF_LAYOUT_VER = 2;
const OFF_FLAGS = 3;
const OFF_BT_CLASSIC_LEN = 4;
const OFF_BLE_LEN = 5;
const OFF_USB_LEN = 6;
const OFF_BT_CLASSIC = 7;
const OFF_BLE = OFF_BT_CLASSIC + BRAND_BT_CLASSIC_MAX_CHARS; // 23
const OFF_USB = OFF_BLE + BRAND_BLE_MAX_CHARS; // 33
const OFF_CRC = BRAND_RECORD_SIZE - 2; // 62

export interface BrandRecord {
  /** True when magic, layout version, lengths, charset and CRC all check out. */
  valid: boolean;
  /** Populated when `valid` is false — first failed check, for display. */
  invalidReason?: string;
  /** Classic BT name prefix (firmware appends the MAC suffix). */
  btClassic: string;
  /** BLE name prefix. */
  ble: string;
  /** USB product prefix / manufacturer string. */
  usb: string;
  /** Customer-branded records are honoured on any platform and never re-seeded. */
  customerBranded: boolean;
  /** BRAND_PLATFORM value stamped by the seeding firmware. */
  seededPlatform: number;
}

export interface BrandRecordFields {
  btClassic: string;
  ble: string;
  usb: string;
  customerBranded: boolean;
  /** Defaults to BRAND_PLATFORM.UNKNOWN — only meaningful for stock records. */
  seededPlatform?: number;
}

/**
 * Firmware-mirrored character rule: 1..max printable ASCII (0x20–0x7E),
 * comma excluded (it would corrupt the RN4X `S-,<name>` command).
 * Returns null when OK, else a human-readable reason.
 */
export function brandNameProblem(name: string, maxChars: number): string | null {
  if (name.length === 0) return 'name is empty';
  if (name.length > maxChars) return `longer than ${maxChars} characters`;
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x20 || c > 0x7e) return `unsupported character "${ch}" (printable ASCII only)`;
    if (c === 0x2c) return 'commas are not allowed';
  }
  return null;
}

function readField(bytes: Uint8Array, off: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[off + i]);
  return s;
}

/** Decode and validate a 64-byte brand record read from the device. */
export function parseBrandRecord(bytes: Uint8Array): BrandRecord {
  const rec: BrandRecord = {
    valid: false,
    btClassic: '',
    ble: '',
    usb: '',
    customerBranded: false,
    seededPlatform: BRAND_PLATFORM.UNKNOWN,
  };
  if (bytes.length < BRAND_RECORD_SIZE) {
    rec.invalidReason = `record is ${bytes.length} bytes, expected ${BRAND_RECORD_SIZE}`;
    return rec;
  }
  const magic = bytes[OFF_MAGIC] | (bytes[OFF_MAGIC + 1] << 8);
  const flags = bytes[OFF_FLAGS];
  rec.customerBranded = (flags & FLAG_CUSTOMER_BRANDED) !== 0;
  rec.seededPlatform = (flags & PLATFORM_MASK) >> PLATFORM_SHIFT;

  const btLen = bytes[OFF_BT_CLASSIC_LEN];
  const bleLen = bytes[OFF_BLE_LEN];
  const usbLen = bytes[OFF_USB_LEN];
  if (btLen >= 1 && btLen <= BRAND_BT_CLASSIC_MAX_CHARS) {
    rec.btClassic = readField(bytes, OFF_BT_CLASSIC, btLen);
  }
  if (bleLen >= 1 && bleLen <= BRAND_BLE_MAX_CHARS) {
    rec.ble = readField(bytes, OFF_BLE, bleLen);
  }
  if (usbLen >= 1 && usbLen <= BRAND_USB_MAX_CHARS) {
    rec.usb = readField(bytes, OFF_USB, usbLen);
  }

  if (magic !== BRAND_RECORD_MAGIC) {
    rec.invalidReason =
      bytes.every((b) => b === 0xff) ? 'blank (erased) record' : 'bad magic';
    return rec;
  }
  if (bytes[OFF_LAYOUT_VER] !== BRAND_RECORD_LAYOUT_VER) {
    rec.invalidReason = `unsupported layout version ${bytes[OFF_LAYOUT_VER]}`;
    return rec;
  }
  const fieldChecks: Array<[string, string, number]> = [
    ['Classic BT name', rec.btClassic, BRAND_BT_CLASSIC_MAX_CHARS],
    ['BLE name', rec.ble, BRAND_BLE_MAX_CHARS],
    ['USB name', rec.usb, BRAND_USB_MAX_CHARS],
  ];
  for (const [label, value, max] of fieldChecks) {
    const problem = brandNameProblem(value, max);
    if (problem) {
      rec.invalidReason = `${label}: ${problem}`;
      return rec;
    }
  }
  const [crcLo, crcHi] = shimmerUartCrcCalc(bytes, OFF_CRC);
  if (bytes[OFF_CRC] !== crcLo || bytes[OFF_CRC + 1] !== crcHi) {
    rec.invalidReason = 'CRC mismatch';
    return rec;
  }
  rec.valid = true;
  return rec;
}

/**
 * Serialise a brand record ready to write to the device. Throws on names that
 * the firmware would reject (so callers surface errors before writing).
 */
export function buildBrandRecord(fields: BrandRecordFields): Uint8Array {
  const checks: Array<[string, string, number]> = [
    ['btClassic', fields.btClassic, BRAND_BT_CLASSIC_MAX_CHARS],
    ['ble', fields.ble, BRAND_BLE_MAX_CHARS],
    ['usb', fields.usb, BRAND_USB_MAX_CHARS],
  ];
  for (const [label, value, max] of checks) {
    const problem = brandNameProblem(value, max);
    if (problem) throw new Error(`${label}: ${problem}`);
  }

  const bytes = new Uint8Array(BRAND_RECORD_SIZE); // zero-filled, incl. padding
  bytes[OFF_MAGIC] = BRAND_RECORD_MAGIC & 0xff;
  bytes[OFF_MAGIC + 1] = (BRAND_RECORD_MAGIC >> 8) & 0xff;
  bytes[OFF_LAYOUT_VER] = BRAND_RECORD_LAYOUT_VER;
  bytes[OFF_FLAGS] =
    (fields.customerBranded ? FLAG_CUSTOMER_BRANDED : 0) |
    (((fields.seededPlatform ?? BRAND_PLATFORM.UNKNOWN) << PLATFORM_SHIFT) & PLATFORM_MASK);
  bytes[OFF_BT_CLASSIC_LEN] = fields.btClassic.length;
  bytes[OFF_BLE_LEN] = fields.ble.length;
  bytes[OFF_USB_LEN] = fields.usb.length;
  for (let i = 0; i < fields.btClassic.length; i++) {
    bytes[OFF_BT_CLASSIC + i] = fields.btClassic.charCodeAt(i);
  }
  for (let i = 0; i < fields.ble.length; i++) bytes[OFF_BLE + i] = fields.ble.charCodeAt(i);
  for (let i = 0; i < fields.usb.length; i++) bytes[OFF_USB + i] = fields.usb.charCodeAt(i);

  const [crcLo, crcHi] = shimmerUartCrcCalc(bytes, OFF_CRC);
  bytes[OFF_CRC] = crcLo;
  bytes[OFF_CRC + 1] = crcHi;
  return bytes;
}

/**
 * An all-0xFF (erased) record. Writing this restores the platform defaults:
 * firmware re-seeds them at the next boot.
 */
export function buildBlankBrandRecord(): Uint8Array {
  return new Uint8Array(BRAND_RECORD_SIZE).fill(0xff);
}
