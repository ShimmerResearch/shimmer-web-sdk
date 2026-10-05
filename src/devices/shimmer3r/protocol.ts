/**
 * Low-level byte-manipulation utilities used by the Shimmer3R protocol decoder.
 * All functions are pure and have no side-effects, making them straightforward
 * to unit-test without a BLE device.
 */

import { FW_ID, HW_ID } from '../infomem/layout.js';

/** Concatenate two Uint8Arrays. */
export function concatU8(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** Read a 16-bit unsigned integer, little-endian. */
export function u16le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8)) >>> 0;
}

/** Read a 16-bit unsigned integer, big-endian. */
export function u16be(b: Uint8Array, o: number): number {
  return ((b[o] << 8) | b[o + 1]) >>> 0;
}

/** Read a 24-bit unsigned integer, little-endian. */
export function u24le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)) >>> 0;
}

/** Read a 24-bit unsigned integer, big-endian. */
export function u24be(b: Uint8Array, o: number): number {
  return ((b[o] << 16) | (b[o + 1] << 8) | b[o + 2]) >>> 0;
}

/** Sign-extend a 16-bit value to a signed integer. */
export function sign16(v: number): number {
  return v & 0x8000 ? v | 0xffff0000 : v;
}

/** Sign-extend a 24-bit value to a signed integer. */
export function sign24(v: number): number {
  return v & 0x800000 ? v | 0xff000000 : v;
}

/** Format a byte as a 2-digit uppercase hex string. */
export function hex2(v: number): string {
  return v.toString(16).padStart(2, '0').toUpperCase();
}

// ---------------------------------------------------------------------------
// Device status (STATUS_RESPONSE payload)
// ---------------------------------------------------------------------------

/**
 * Decoded STATUS_RESPONSE payload: what the sensor is doing right now.
 *
 * The firmware sends this both on request (GET_STATUS_COMMAND) and unprompted
 * whenever one of these conditions changes, so it is the device's own account of
 * its state rather than anything the host has inferred.
 */
export interface Shimmer3DeviceStatus {
  /** Sitting in a dock or base (its charger is connected). */
  docked: boolean;
  /** Sampling sensors — for a stream, an SD recording, or both. */
  sensing: boolean;
  /** The real-world clock has been set since the sensor last lost power. */
  rtcSet: boolean;
  /** Writing samples to the SD card. */
  sdLogging: boolean;
  /** Sending samples over the Bluetooth link. */
  streaming: boolean;
  /** An SD card is inserted. */
  sdPresent: boolean;
  /** The firmware could not open or write its SD file. */
  sdError: boolean;
  /** The red LED is lit (the firmware's own toggle-LED command state). */
  redLedOn: boolean;
  /**
   * USB plugged in — Shimmer3R only, from LogAndStream v1.00.024. `null` on a
   * Shimmer3, and on Shimmer3R firmware before v1.00.024, which omit the second
   * status byte entirely rather than sending a zero, so "unknown" and
   * "unplugged" stay distinguishable. See {@link statusPayloadBytesFor}.
   */
  usbPluggedIn: boolean | null;
  /** The status bytes as received, for logging. */
  raw: Uint8Array;
}

/**
 * Decode the status bytes of a STATUS_RESPONSE.
 *
 * Takes the payload ONLY — the bytes after `[0x8A][0x71]`. It cannot be lenient
 * about a leading header the way `parseShimmer3DeviceVersionResponse` is,
 * because a status byte of 0x8A is a perfectly ordinary reading (red LED + SD
 * logging + sensing), so there is nothing to test a header against.
 *
 * Bit assignment from `ShimBt_assembleStatusBytes`
 * (log-and-stream-common `Comms/shimmer_bt_uart.c:2920-2932`): bit 7
 * toggleLedRedCmd, 6 sdBadFile, 5 sdInserted, 4 btStreaming, 3 sdLogging,
 * 2 RTC set, 1 sensing, 0 docked.
 *
 * The second byte (usbPluggedIn) exists only under `#if defined(SHIMMER3R)`, so
 * `STATUS_BYTE_COUNT` is 2 on a Shimmer3R and 1 on a Shimmer3
 * (`Comms/shimmer_bt_uart.h:259-263`), and only from LogAndStream_Shimmer3R
 * v1.00.024 — hence the nullable field rather than a plain boolean. Which
 * width a given device sends is {@link statusPayloadBytesFor}'s question; this
 * decodes whatever it is handed.
 */
export function parseShimmer3StatusBytes(bytes: Uint8Array): Shimmer3DeviceStatus {
  if (bytes.length < 1) throw new Error('status payload too short (need at least 1 byte)');
  const s0 = bytes[0] & 0xff;
  return {
    docked: (s0 & 0x01) !== 0,
    sensing: (s0 & 0x02) !== 0,
    rtcSet: (s0 & 0x04) !== 0,
    sdLogging: (s0 & 0x08) !== 0,
    streaming: (s0 & 0x10) !== 0,
    sdPresent: (s0 & 0x20) !== 0,
    sdError: (s0 & 0x40) !== 0,
    redLedOn: (s0 & 0x80) !== 0,
    usbPluggedIn: bytes.length >= 2 ? (bytes[1] & 0xff) !== 0 : null,
    raw: new Uint8Array(bytes),
  };
}

/**
 * The first Shimmer3R firmware that sends a second status byte: LogAndStream
 * v1.00.024 (4 June 2025).
 *
 * The byte came with log-and-stream-common 8377afc (DEV-307), which turned
 * `ShimBt_assembleStatusByte` into `ShimBt_assembleStatusBytes` and appended
 * `usbPluggedIn` under `#if defined(SHIMMER3R)`. v1.00.024 is the first tag to
 * pin it. Every release before it sends one byte, both as the GET_STATUS reply
 * and as the push: v0.00.002 to v1.00.017 build it inline in
 * `S3R_Production/Shimmer_Driver/Bluetooth/shimmer_bt_comms.c` (`:1978-1987` at
 * v1.00.017), and v1.00.019 to v1.00.023 in log-and-stream-common's
 * `ShimBt_assembleStatusByte`.
 *
 * `STATUS_BYTE_COUNT` is not the boundary, though the name suggests it. It
 * arrived with DEV-621 in v1.00.050, as a tidy of the count v1.00.024 already
 * returned, in the same change that enlarged the push's buffer: an ACK prefix,
 * two status bytes and a 2-byte CRC had overrun its six bytes.
 */
export const SHIMMER3R_TWO_BYTE_STATUS_MIN_FIRMWARE = Object.freeze({
  major: 1,
  minor: 0,
  internal: 24,
} as const);

/**
 * How many status bytes this device puts in a STATUS_RESPONSE: 2 on a Shimmer3R
 * running LogAndStream {@link SHIMMER3R_TWO_BYTE_STATUS_MIN_FIRMWARE} or later,
 * 1 on anything else, or `null` while that cannot be told yet.
 *
 * The hardware comes first because the version numbers overlap: Shimmer3
 * LogAndStream is at v1.01.x too, and no Shimmer3 release sends a second byte.
 * Its build defines `SHIMMER3`, never `SHIMMER3R`. So hardware 3 settles the
 * width alone, while a Shimmer3R needs its firmware version as well. The
 * v1.00.008 side build for older Consensys reports hardware 3, and it sends
 * one byte like every release before v1.00.024, so it comes out right.
 *
 * Firmware other than LogAndStream gets 1. No Shimmer3R build of anything else
 * is known, so there is nothing to say it sends the second byte.
 *
 * HARDWARE-VERIFY: derived from the firmware source at each tag and scripted
 * devices. No Shimmer3R on v1.00.023 or earlier has been run against this SDK,
 * so the one-byte Shimmer3R path is unexercised on hardware.
 *
 * @param hardwareVersion The DEVICE_VERSION_RESPONSE hardware id: 10 for a
 *   Shimmer3R, 3 for a Shimmer3. `null` or `undefined` when not read.
 * @param fw The FW_VERSION_RESPONSE, as `Shimmer3RClient.readFwVersion()`
 *   returns it, or `null`/`undefined` when not read. `patch` is the firmware's
 *   internal version number.
 */
export function statusPayloadBytesFor(
  hardwareVersion: number | null | undefined,
  fw: Readonly<{ fwId: number; major: number; minor: number; patch: number }> | null | undefined,
): 1 | 2 | null {
  if (hardwareVersion === null || hardwareVersion === undefined) return null;
  if (hardwareVersion !== HW_ID.SHIMMER_3R) return 1;
  if (!fw) return null;
  if (fw.fwId !== FW_ID.LOGANDSTREAM) return 1;
  const min = SHIMMER3R_TWO_BYTE_STATUS_MIN_FIRMWARE;
  const atLeast =
    fw.major > min.major ||
    (fw.major === min.major &&
      (fw.minor > min.minor || (fw.minor === min.minor && fw.patch >= min.internal)));
  return atLeast ? 2 : 1;
}
