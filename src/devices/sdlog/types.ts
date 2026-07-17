/**
 * Public types for the Shimmer3 / Shimmer3R binary SD-log decoder.
 */

/** One decoded channel within an SD-log data packet. */
export interface SdLogChannel {
  /** Signal name, following the SDK's streaming channel naming where a streaming equivalent exists. */
  name: string;
  /** Unit of the emitted value, or null when the value is uncalibrated/raw. */
  unit: string | null;
  /** True when the SDK applies calibration to this channel's values. */
  calibrated: boolean;
}

/** Raw calibration parameter blocks copied verbatim from the SD-log header. */
export interface SdLogCalibrationBytes {
  /** Wide-range (digital) accelerometer block — header offset 76, 21 bytes. */
  wrAccel: Uint8Array;
  /** Gyroscope block — header offset 97, 21 bytes. */
  gyro: Uint8Array;
  /** Magnetometer block — header offset 118, 21 bytes. */
  mag: Uint8Array;
  /** Low-noise (analog) accelerometer block — header offset 139, 21 bytes. */
  lnAccel: Uint8Array;
  /**
   * Pressure/temperature block — header offset 160, 22 bytes, plus header
   * bytes 222-223 appended (24 bytes total) when the device carries a
   * BMP280/BMP390 (new-IMU boards and every Shimmer3R).
   */
  pressure: Uint8Array;
  /** Shimmer3R alternative (high-g) accel block — header offset 256, 21 bytes. */
  altAccel?: Uint8Array;
  /** Shimmer3R alternative magnetometer block — header offset 285, 21 bytes. */
  altMag?: Uint8Array;
}

/** Expansion-board identity from SD-log header bytes 214-216 (when present). */
export interface SdLogExpansionBoard {
  id: number;
  rev: number;
  revSpecial: number;
}

/** Parsed SD-log file header. */
export interface SdLogHeader {
  hardwareVersion: number;
  firmwareId: number;
  firmwareVersion: { major: number; minor: number; internal: number };
  samplingRateHz: number;
  macAddress: string;
  /** 40-bit enabled-sensors value (header bytes 3-7, after firmware-specific masking). */
  enabledSensors: number;
  /**
   * Derived-sensors value (header bytes 40-42, plus 217-221 on newer
   * firmware). Exact only through byte 219 / bit 47 — bytes 220-221 reach
   * bit 56, beyond a JS number's 2^53 exact-integer range. For full fidelity
   * above bit 52 use {@link derivedSensorsBig}.
   */
  derivedSensors: number;
  /**
   * Full-fidelity derived-sensors value as a BigInt (Java uses a `long`),
   * carrying all 8 bytes exactly. Prefer this when testing bits at or above
   * byte 220 (bit 56).
   */
  derivedSensorsBig: bigint;
  /**
   * TCXO (temperature-compensated crystal oscillator) flag — SD header
   * byte 17 bit 4. Affects only the wall-clock (RTC) tick→ms conversion.
   */
  tcxo: boolean;
  /** Config time — Unix seconds, header bytes 52-55 MSB-first. */
  configTime: number;
  /** RTC difference in 32.768 kHz ticks — header bytes 44-51, signed 64-bit MSB-first. */
  rtcDifferenceTicks: bigint;
  /** Initial timestamp in ticks — header bytes 251-255 (non-sequential packing). */
  initialTimestampTicks: number;
  trial: {
    id: number;
    numShimmers: number;
    syncWhenLogging: boolean;
    masterShimmer: boolean;
    buttonStart: boolean;
  };
  headerLengthBytes: number;
  timestampBytes: 2 | 3;
  /**
   * Bytes per data packet: timestamp + all enabled channels. The 9-byte sync
   * timestamp-offset field prefixed to the first packet of each 512-byte
   * block (when trial.syncWhenLogging is set) is NOT included — the decoder
   * strips it transparently.
   */
  packetSizeBytes: number;
  /** Decoded channel list, in on-disk packet order (timestamp excluded). */
  channels: SdLogChannel[];
  // ------- Additions beyond the frozen core API (documented extras) -------
  /** Raw calibration blocks from the header, kept for future calibrated decoding. */
  calibrationBytes: SdLogCalibrationBytes;
  /** GSR hardware range setting from the header (0-3 fixed, 4 = auto). */
  gsrRange: number;
  /** Expansion-board identity, when the firmware stores it in the header. */
  expansionBoard: SdLogExpansionBoard | null;
}

/** Machine-readable reasons for rejecting an SD-log input. */
export type SdLogFormatErrorCode =
  | 'LEGACY_UNSUPPORTED'
  | 'UNSUPPORTED_DEVICE'
  | 'NO_DATA'
  | 'TOO_SMALL'
  | 'BAD_HEADER'
  | 'INCONSISTENT_SESSION';

/** Typed error thrown by the SD-log parsing/decoding entry points. */
export class SdLogFormatError extends Error {
  code: SdLogFormatErrorCode;

  constructor(code: SdLogFormatErrorCode, message: string) {
    super(message);
    this.name = 'SdLogFormatError';
    this.code = code;
  }
}

/** One decoded sample. `values` aligns 1:1 with `SdLogHeader.channels`. */
export interface SdLogRecord {
  /**
   * Device-clock time in milliseconds:
   * (initialTimestampTicks + unwrapped ticks - first packet's raw ticks)
   * / 32768 * 1000, exactly as the Java driver computes the SD calibrated
   * timestamp (parseTimestampShimmer3 with mFirstTsOffsetFromInitialTsTicks).
   * On modern firmware this equals the device's full 40-bit clock in ms.
   */
  timestampMs: number;
  /**
   * Wall-clock (RTC) time in Unix milliseconds — timestampMs shifted by the
   * header's rtcDifferenceTicks — or null when the RTC difference is unset (0).
   */
  wallClockMs: number | null;
  values: number[];
}
