/**
 * SD-log header parsing for modern Shimmer3 (256-byte) and Shimmer3R
 * (384-byte) binary log files.
 *
 * Ported from the Shimmer Java driver:
 *   ShimmerSDLog#processSDLogHeader / #parseHwFwVerForMaps /
 *   #parseEnabledDerivedSensorsForMaps / #readSdConfigHeader
 *   ShimmerVerObject (firmware version-code ladder → timestamp byte width)
 *   ShimmerObject#isSupportedNewImuSensors / ShimmerVerObject
 *   #isSupportedExpansionBrdIdInSdHeader / #isSupportedEightByteDerivedSensors
 */

import {
  SDLOG_CLOCK_FREQ,
  SDLOG_EXP_BRD_ID,
  SDLOG_FW_ID,
  SDLOG_HEADER_LENGTH,
  SDLOG_HW_ID,
  SDLOG_SYNC_BLOCK_LENGTH,
  SDLOG_SYNC_OFFSET_LENGTH,
} from './constants.js';
import {
  buildShimmer3RSdLogChannels,
  buildShimmer3SdLogChannels,
  type SdLogChannelSpec,
} from './channels.js';
import {
  SdLogFormatError,
  type SdLogCalibrationBytes,
  type SdLogExpansionBoard,
  type SdLogHeader,
} from './types.js';

/** Internal parse result: the public header plus decode-time layout details. */
export interface ParsedSdLog {
  header: SdLogHeader;
  channels: SdLogChannelSpec[];
  /**
   * True when the data area uses the sync-when-logging 512-byte block
   * framing (a 9-byte timestamp-offset field before the first packet of
   * each block).
   */
  syncFraming: boolean;
  /** Packets per 512-byte block when syncFraming (0 otherwise). */
  samplesPerBlock: number;
}

interface FwVersion {
  major: number;
  minor: number;
  internal: number;
}

const atLeast = (v: FwVersion, major: number, minor: number, internal: number): boolean =>
  v.major > major ||
  (v.major === major && (v.minor > minor || (v.minor === minor && v.internal >= internal)));

/**
 * Whether SD packets carry a 3-byte (u24) timestamp for this firmware.
 * Derived from the ShimmerVerObject firmware-version-code ladder: code >= 6
 * selects 3 bytes (ShimmerObject#updateTimestampByteLength).
 */
function sdTimestampBytes(hw: number, fwId: number, v: FwVersion): 2 | 3 {
  if (hw === SDLOG_HW_ID.SHIMMER_3R) {
    // Shimmer3R LogAndStream >= 0.0.1 maps to version code 8 (u24).
    // HARDWARE-VERIFY: the Java ladder has no explicit Shimmer3R+SDLog rule;
    // u24 assumed for any Shimmer3R firmware.
    return 3;
  }
  if (fwId === SDLOG_FW_ID.SDLOG) return atLeast(v, 0, 11, 5) ? 3 : 2;
  if (fwId === SDLOG_FW_ID.LOGANDSTREAM) return atLeast(v, 0, 5, 4) ? 3 : 2;
  return 3;
}

/**
 * "New IMU sensors" detection for Shimmer3 (LSM303AHTR / MPU9250 / BMP280
 * generation) — controls mag channel order/endianness and BMP naming.
 * Port of ShimmerObject.isSupportedNewImuSensors(svo, expansionBoardDetails);
 * a Shimmer3R always qualifies, a Shimmer3 without expansion-board info in
 * the header never does (Java passes a LOG_FILE placeholder board → false).
 */
export function isNewImuSensors(hw: number, expBrd: SdLogExpansionBoard | null): boolean {
  if (hw === SDLOG_HW_ID.SHIMMER_3R) return true;
  if (hw !== SDLOG_HW_ID.SHIMMER_3 || expBrd === null) return false;
  const { id, rev, revSpecial } = expBrd;
  // HARDWARE-VERIFY: new-IMU expansion-board revision thresholds copied from
  // Configuration.Shimmer3.NEW_IMU_EXP_REV; only verifiable against real
  // boards of each revision.
  return (
    (id === SDLOG_EXP_BRD_ID.EXG_UNIFIED && rev >= 3) ||
    (id === SDLOG_EXP_BRD_ID.GSR_UNIFIED && rev >= 3) ||
    (id === SDLOG_EXP_BRD_ID.BR_AMP_UNIFIED && rev >= 3) ||
    (id === SDLOG_EXP_BRD_ID.SHIMMER3 && rev >= 6) ||
    revSpecial === 171 ||
    (id === SDLOG_EXP_BRD_ID.PROTO3_DELUXE && rev >= 3) ||
    (id === SDLOG_EXP_BRD_ID.PROTO3_MINI && rev >= 3)
  );
}

/**
 * Whether the sync-when-logging 512-byte block framing applies. Port of the
 * guard used throughout ShimmerSDLog (interpretdatapacketformat / setup /
 * readPacketMsg): SDLog firmware always frames when the trial-config sync
 * bit is set; LogAndStream only from 0.16.11 on Shimmer3 and from any
 * version on Shimmer3R (Configuration.Shimmer3.CompatibilityInfoForMaps).
 */
function usesSyncBlockFraming(
  syncWhenLogging: boolean,
  hw: number,
  fwId: number,
  v: FwVersion,
): boolean {
  if (!syncWhenLogging) return false;
  if (fwId === SDLOG_FW_ID.SDLOG) return true;
  if (fwId === SDLOG_FW_ID.LOGANDSTREAM) {
    if (hw === SDLOG_HW_ID.SHIMMER_3R) return true;
    return atLeast(v, 0, 16, 11);
  }
  return false;
}

function macFromBytes(b: Uint8Array): string {
  let s = '';
  for (let i = 24; i <= 29; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Parse an SD-log file header, including layout details needed by the packet
 * decoder. Throws {@link SdLogFormatError} for anything outside the supported
 * modern Shimmer3 / Shimmer3R formats.
 */
export function parseSdLog(bytes: Uint8Array): ParsedSdLog {
  if (bytes.length < 40) {
    throw new SdLogFormatError(
      'TOO_SMALL',
      `File is ${bytes.length} bytes — too small to contain SD-log version fields (need 40).`,
    );
  }

  // Version fields live at fixed offsets in every header generation
  // (ShimmerSDLog#readSDVersionFromHeader).
  const hardwareVersion = (bytes[30] << 8) | bytes[31];
  const firmwareId = (bytes[34] << 8) | bytes[35];
  const fwVersion: FwVersion = {
    major: (bytes[36] << 8) | bytes[37],
    minor: bytes[38],
    internal: bytes[39],
  };

  if (firmwareId === SDLOG_FW_ID.SDLOG && fwVersion.major === 0 && fwVersion.minor === 5) {
    throw new SdLogFormatError(
      'LEGACY_UNSUPPORTED',
      `Legacy SDLog v0.5.x file (178-byte header) is not supported.`,
    );
  }
  if (hardwareVersion !== SDLOG_HW_ID.SHIMMER_3 && hardwareVersion !== SDLOG_HW_ID.SHIMMER_3R) {
    throw new SdLogFormatError(
      'UNSUPPORTED_DEVICE',
      `Unsupported hardware version ${hardwareVersion} — only Shimmer3 (3) and Shimmer3R (10) SD logs are supported.`,
    );
  }
  if (firmwareId !== SDLOG_FW_ID.SDLOG && firmwareId !== SDLOG_FW_ID.LOGANDSTREAM) {
    throw new SdLogFormatError(
      'UNSUPPORTED_DEVICE',
      `Unsupported firmware id ${firmwareId} — only SDLog (2) and LogAndStream (3) logs are supported.`,
    );
  }
  // Support floors for the 256-byte-header era on Shimmer3: SDLog >= 0.8.69,
  // LogAndStream >= 0.5.0. Shimmer3R firmware versioning restarted at 0.x and
  // always writes the modern 384-byte header, so no floor applies there.
  if (hardwareVersion === SDLOG_HW_ID.SHIMMER_3) {
    if (firmwareId === SDLOG_FW_ID.SDLOG && !atLeast(fwVersion, 0, 8, 69)) {
      throw new SdLogFormatError(
        'LEGACY_UNSUPPORTED',
        `SDLog v${fwVersion.major}.${fwVersion.minor}.${fwVersion.internal} predates the supported floor (0.8.69).`,
      );
    }
    if (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && !atLeast(fwVersion, 0, 5, 0)) {
      throw new SdLogFormatError(
        'LEGACY_UNSUPPORTED',
        `LogAndStream v${fwVersion.major}.${fwVersion.minor}.${fwVersion.internal} predates the supported floor (0.5.0).`,
      );
    }
  }

  const headerLengthBytes =
    hardwareVersion === SDLOG_HW_ID.SHIMMER_3R
      ? SDLOG_HEADER_LENGTH.SHIMMER3R
      : SDLOG_HEADER_LENGTH.SHIMMER3;
  if (bytes.length < headerLengthBytes) {
    throw new SdLogFormatError(
      'TOO_SMALL',
      `File is ${bytes.length} bytes but the header alone is ${headerLengthBytes} bytes.`,
    );
  }

  // Bytes 0-1: sampling divider, LSB-first. Hz = 32768 / divider.
  const rawSamplingDivider = bytes[0] | (bytes[1] << 8);
  if (rawSamplingDivider === 0) {
    throw new SdLogFormatError('BAD_HEADER', 'Sampling-rate divider is 0.');
  }
  const samplingRateHz = SDLOG_CLOCK_FREQ / rawSamplingDivider;

  // Bytes 3-7: enabled sensors, 40-bit LSB-first, with the firmware-specific
  // masking from ShimmerSDLog#parseEnabledDerivedSensorsForMaps.
  const enabledBytes = [bytes[3], bytes[4], bytes[5], bytes[6], bytes[7]];
  const mpu9150Dmp = ((bytes[12] >> 7) & 0x01) === 1;
  if (mpu9150Dmp || firmwareId === SDLOG_FW_ID.LOGANDSTREAM) {
    enabledBytes[2] &= ~0x02; // disable MPU temperature (MPL_TEMPERATURE bit)
    enabledBytes[3] = 0;
    enabledBytes[4] = 0;
  }
  let enabledSensors =
    enabledBytes[0] +
    enabledBytes[1] * 2 ** 8 +
    enabledBytes[2] * 2 ** 16 +
    enabledBytes[3] * 2 ** 24 +
    enabledBytes[4] * 2 ** 32;
  if (firmwareId !== SDLOG_FW_ID.SDLOG) {
    enabledSensors = enabledSensors % 2 ** 24; // & 0xFFFFFF
  }

  // Bytes 40-42 (+217-221 on newer firmware): derived sensors, LSB-first.
  let derivedSensors = bytes[40] + bytes[41] * 2 ** 8 + bytes[42] * 2 ** 16;
  const eightByteDerived =
    (firmwareId === SDLOG_FW_ID.SDLOG && atLeast(fwVersion, 0, 13, 1)) ||
    (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && atLeast(fwVersion, 0, 7, 1));
  if (eightByteDerived) {
    for (let i = 0; i < 5; i++) {
      derivedSensors += bytes[217 + i] * 2 ** (8 * (3 + i));
    }
  }

  // Byte 16: trial config A.
  const buttonStart = ((bytes[16] >> 5) & 0x01) === 1;
  const syncWhenLogging = ((bytes[16] >> 2) & 0x01) === 1;
  const masterShimmer = ((bytes[16] >> 1) & 0x01) === 1;

  // Byte 11 bits 1-3: GSR range (0-3 fixed, 4 = auto) — same offset on both
  // the Shimmer3 and Shimmer3R header layouts.
  const gsrRange = (bytes[11] >> 1) & 0x07;

  // Bytes 44-51: RTC difference, signed 64-bit MSB-first.
  let rtc = 0n;
  for (let i = 44; i <= 51; i++) rtc = (rtc << 8n) | BigInt(bytes[i]);
  const rtcDifferenceTicks = BigInt.asIntN(64, rtc);

  // Bytes 52-55: config time (Unix seconds), 32-bit MSB-first.
  const configTime = bytes[52] * 2 ** 24 + bytes[53] * 2 ** 16 + bytes[54] * 2 ** 8 + bytes[55];

  // Bytes 251-255: initial timestamp ticks in the firmware's non-sequential
  // order: b[251]<<32 | b[255]<<24 | b[254]<<16 | b[253]<<8 | b[252].
  // HARDWARE-VERIFY: byte order matches ShimmerSDLog.java:419-426; only a
  // real SD card can confirm it end-to-end.
  const initialTimestampTicks =
    bytes[251] * 2 ** 32 +
    bytes[255] * 2 ** 24 +
    bytes[254] * 2 ** 16 +
    bytes[253] * 2 ** 8 +
    bytes[252];

  // Bytes 214-216: expansion board id/rev/special-rev, only stored by
  // SDLog >= 0.12.4 / LogAndStream >= 0.6.13
  // (ShimmerVerObject#isSupportedExpansionBrdIdInSdHeader).
  const expBrdInHeader =
    (firmwareId === SDLOG_FW_ID.SDLOG && atLeast(fwVersion, 0, 12, 4)) ||
    (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && atLeast(fwVersion, 0, 6, 13));
  const expansionBoard: SdLogExpansionBoard | null = expBrdInHeader
    ? { id: bytes[214], rev: bytes[215], revSpecial: bytes[216] }
    : null;

  const newImu = isNewImuSensors(hardwareVersion, expansionBoard);

  // Calibration parameter blocks (kept raw — see SdLogCalibrationBytes).
  const pressureLen = newImu ? 24 : 22;
  const pressure = new Uint8Array(pressureLen);
  pressure.set(bytes.slice(160, 182), 0);
  if (newImu) pressure.set(bytes.slice(222, 224), 22); // BMP280/BMP390 extra bytes
  const calibrationBytes: SdLogCalibrationBytes = {
    wrAccel: bytes.slice(76, 97),
    gyro: bytes.slice(97, 118),
    mag: bytes.slice(118, 139),
    lnAccel: bytes.slice(139, 160),
    pressure,
  };

  // Channel table.
  let channels: SdLogChannelSpec[];
  if (hardwareVersion === SDLOG_HW_ID.SHIMMER_3R) {
    calibrationBytes.altAccel = bytes.slice(256, 277);
    calibrationBytes.altMag = bytes.slice(285, 306);
    const nChannels = bytes[314];
    if (315 + nChannels > headerLengthBytes) {
      throw new SdLogFormatError(
        'BAD_HEADER',
        `Shimmer3R channel table overruns the header (nChannels=${nChannels}).`,
      );
    }
    channels = buildShimmer3RSdLogChannels(bytes.subarray(315, 315 + nChannels));
  } else {
    channels = buildShimmer3SdLogChannels(enabledSensors, newImu);
  }
  if (channels.length === 0) {
    throw new SdLogFormatError('BAD_HEADER', 'Header enables no data channels.');
  }

  const timestampBytes = sdTimestampBytes(hardwareVersion, firmwareId, fwVersion);
  const packetSizeBytes = timestampBytes + channels.reduce((sum, c) => sum + c.sizeBytes, 0);

  const syncFraming = usesSyncBlockFraming(syncWhenLogging, hardwareVersion, firmwareId, fwVersion);
  // ShimmerSDLog#setup(): floor((512 - OFFSET_LENGTH) / sensorPacketSize),
  // where the Java mPacketSize includes the offset field and ours does not.
  const samplesPerBlock = syncFraming
    ? Math.floor((SDLOG_SYNC_BLOCK_LENGTH - SDLOG_SYNC_OFFSET_LENGTH) / packetSizeBytes)
    : 0;
  if (syncFraming && samplesPerBlock < 1) {
    throw new SdLogFormatError(
      'BAD_HEADER',
      `Packet size ${packetSizeBytes} does not fit a 512-byte sync block.`,
    );
  }

  const header: SdLogHeader = {
    hardwareVersion,
    firmwareId,
    firmwareVersion: fwVersion,
    samplingRateHz,
    macAddress: macFromBytes(bytes),
    enabledSensors,
    derivedSensors,
    configTime,
    rtcDifferenceTicks,
    initialTimestampTicks,
    trial: {
      id: bytes[32],
      numShimmers: bytes[33],
      syncWhenLogging,
      masterShimmer,
      buttonStart,
    },
    headerLengthBytes,
    timestampBytes,
    packetSizeBytes,
    channels,
    calibrationBytes,
    gsrRange,
    expansionBoard,
  };

  return { header, channels, syncFraming, samplesPerBlock };
}

/**
 * Parse an SD-log file header (first 256 bytes for Shimmer3, 384 bytes for
 * Shimmer3R). The whole file may be passed — only the header is read.
 */
export function parseSdLogHeader(bytes: Uint8Array): SdLogHeader {
  return parseSdLog(bytes).header;
}
