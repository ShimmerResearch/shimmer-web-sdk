/**
 * Public types for the Shimmer3 / Shimmer3R binary SD-log decoder.
 */

import type { PressureSensorKind } from '../pressure/types.js';

/**
 * The pressure part an SD-log header records (byte 224, DEV-1123): a known
 * part, `'unknown'` for an id this SDK does not recognise, or `'none'` when
 * the firmware found no pressure sensor fitted.
 */
export type SdLogPressureSensor = PressureSensorKind | 'unknown' | 'none';

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
   * BMP280/BMP390 (new-IMU boards and every Shimmer3R). A BMP581 has no trim
   * block and the firmware leaves this region unwritten (0xFF) for one.
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
  /**
   * Raw 10-byte ADS1292R chip-1 (ExG1) register bank, from SD header bytes
   * 56-65 (ShimmerSDLog.java:253 Shimmer3R, :323 Shimmer3). Decode it with
   * `decodeExgRegisters`, or identify the whole-device preset with
   * `detectExgPreset(exg1, exg2)`. All-zero on a non-ExG device.
   */
  exg1: Uint8Array;
  /** Raw 10-byte ADS1292R chip-2 (ExG2) register bank, from header bytes 66-75. */
  exg2: Uint8Array;
  /** Expansion-board identity, when the firmware stores it in the header. */
  expansionBoard: SdLogExpansionBoard | null;
  /**
   * Inertial-sensor hardware ranges decoded from the SD config setup bytes,
   * used to select the correct default calibration when the header carries no
   * per-device calibration block for a channel group. Values are the raw
   * config-value indices (see the per-sensor range tables in the Java driver).
   */
  imuRanges: SdLogImuRanges;
  /**
   * Per-group inertial calibration metadata, one entry per calibrated channel
   * group present in this file. Additive: absent groups (or non-inertial
   * files) yield an empty array.
   */
  calibration: SdLogChannelCalibrationInfo[];
  /**
   * The pressure part header byte 224 records, or null when the header does
   * not record one: SDLog firmware, LogAndStream older than v1.01.006 on a
   * Shimmer3 or v1.01.018 on a Shimmer3R, or the byte left at 0xFF. When null,
   * the part is inferred from the expansion-board revision (Shimmer3) or SR
   * number (Shimmer3R), as before the field existed.
   *
   * When set it decides the pressure channels, even against that inference:
   * a BMP581 pair on a Shimmer3R is emitted calibrated (kPa, °C), every other
   * part's pair raw. `'unknown'`, and `'none'` with pressure channels
   * nonetheless enabled, yield raw, part-neutral `PRESSURE`/`TEMPERATURE`
   * channels and an entry in {@link warnings}.
   */
  pressureSensor: SdLogPressureSensor | null;
  /**
   * The sensor id from byte 224 (its low 7 bits) when the byte names a part,
   * known or not; null when {@link pressureSensor} is null or `'none'`.
   */
  pressureSensorId: number | null;
  /**
   * True when byte 224 has bit 7 set: the firmware could not confirm the part
   * by chip id and inferred it from the board's SR number. Always comes with
   * an entry in {@link warnings}.
   */
  pressureSensorInferred: boolean;
  /**
   * Human-readable notes on anything the decoder had to work around or could
   * not confirm in this header. Empty when there is nothing to report.
   */
  warnings: string[];
}

/** Inertial-sensor hardware ranges from the SD config setup bytes. */
export interface SdLogImuRanges {
  /** Low-noise (analog) accel range. Shimmer3 LN accel (Kionix) is fixed → 0. */
  lnAccel: number;
  /** Wide-range (digital) accel range. */
  wrAccel: number;
  /** Gyroscope range. */
  gyro: number;
  /** Magnetometer range (LSM303DLHC uses 1-7; single-range sensors use 0). */
  mag: number;
  /** Shimmer3R alternative (high-g) accel range. */
  altAccel: number;
  /** Shimmer3R alternative magnetometer range. */
  altMag: number;
}

/** Calibration metadata for one inertial channel group in an SD-log file. */
export interface SdLogChannelCalibrationInfo {
  /** Channel group: lnAccel | wrAccel | gyro | mag | altAccel | altMag. */
  group: string;
  /** Emitted unit for the group's channels ('m/(s^2)' | 'deg/s' | 'local_flux'). */
  unit: string;
  /** True when the range-selected default was used (no valid device block). */
  usingDefaultCalibration: boolean;
  /** Where the applied calibration came from. */
  source: 'sd-header' | 'default';
  /** The hardware range value used to select the calibration. */
  range: number;
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
   * Device-clock time in milliseconds: the record's own 40-bit counter value
   * / 32768 * 1000. The first packet's full value is rebuilt from the header's
   * initial timestamp (the RTC at file creation) and the packet's 24-bit raw
   * timestamp, and later packets advance by their unwrapped ticks — as the
   * Java driver computes the SD calibrated timestamp (parseTimestampShimmer3
   * with mFirstTsOffsetFromInitialTsTicks; DEV-1095).
   */
  timestampMs: number;
  /**
   * Wall-clock (RTC) time in Unix milliseconds — timestampMs shifted by the
   * header's rtcDifferenceTicks — or null when the RTC difference is unset (0).
   */
  wallClockMs: number | null;
  values: number[];
}
