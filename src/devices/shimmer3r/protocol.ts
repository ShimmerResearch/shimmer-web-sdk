/**
 * Low-level byte-manipulation utilities used by the Shimmer3R protocol decoder.
 * All functions are pure and have no side-effects, making them straightforward
 * to unit-test without a BLE device.
 */

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
   * USB plugged in — Shimmer3R only. `null` on a Shimmer3, whose firmware omits
   * the second status byte entirely rather than sending a zero, so "unknown" and
   * "unplugged" stay distinguishable.
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
 * (`Comms/shimmer_bt_uart.h:259-263`) — hence the nullable field rather than a
 * plain boolean.
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
