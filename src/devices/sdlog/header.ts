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
  type SdLogImuRanges,
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
  /**
   * Clock frequency (Hz) for the SD wall-clock (RTC) tick→ms conversion —
   * 32768 normally, or a TCXO frequency (312500 / 255765.625) when the
   * TCXO flag is set (ShimmerObject#getSamplingClockFreq). The device-clock
   * timestamp always uses 32768 (getRtcClockFreq).
   */
  wallClockFreqHz: number;
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
 * Derived from the ShimmerVerObject firmware-version-code ladder
 * (ShimmerVerObject.java:263-312) fed into
 * `ShimmerObject#updateTimestampByteLength` (:4725-4736): version code >= 6
 * selects 3 bytes, otherwise 2. Combinations that match no rule in the ladder
 * fall through to code -1 (< 6) → 2 bytes.
 *
 * Relevant rules for the HW/FW combos this decoder supports (Shimmer3 /
 * Shimmer3R × SDLog / LogAndStream):
 *   - Shimmer3R + LogAndStream >= 0.0.1  → code 8 → 3 bytes
 *   - Shimmer3R + SDLog                  → no rule → code -1 → 2 bytes
 *   - Shimmer3  + SDLog        >= 0.11.5 → code 6 (or 8 >= 0.20.1) → 3 bytes; else 2
 *   - Shimmer3  + LogAndStream >= 0.5.4  → code 6 (or higher) → 3 bytes; else 2
 */
function sdTimestampBytes(hw: number, fwId: number, v: FwVersion): 2 | 3 {
  if (hw === SDLOG_HW_ID.SHIMMER_3R) {
    // The Java ladder only maps Shimmer3R+LogAndStream (→ code 8, u24). A
    // Shimmer3R+SDLog file matches no rule → code -1 → 2-byte timestamp.
    // HARDWARE-VERIFY: a Shimmer3R+SDLog SD log likely does not exist in the
    // wild; oracle fidelity (ShimmerVerObject.java:270-273) is the tiebreak.
    if (fwId === SDLOG_FW_ID.LOGANDSTREAM) return atLeast(v, 0, 0, 1) ? 3 : 2;
    return 2;
  }
  if (fwId === SDLOG_FW_ID.SDLOG) return atLeast(v, 0, 11, 5) ? 3 : 2;
  if (fwId === SDLOG_FW_ID.LOGANDSTREAM) return atLeast(v, 0, 5, 4) ? 3 : 2;
  return 3;
}

/**
 * Sampling clock frequency used for the SD wall-clock (RTC) timestamp
 * (`ShimmerObject#getSamplingClockFreq`, ShimmerObject.java:10868-10896):
 *   - TCXO + the 20 MHz EXG-unified rev-1.1 board → 20 MHz / 64 = 312500 Hz
 *   - TCXO otherwise                              → 16.369 MHz / 64 = 255765.625 Hz
 *   - no TCXO                                     → 32768 Hz (crystal)
 * NB: only the RTC (wall-clock) conversion uses this frequency. The
 * device-clock timestamp uses `getRtcClockFreq()` = 32768 Hz always
 * (ShimmerObject.java:2824, ShimmerDevice.java:4723), and the sampling-rate
 * field is likewise divided by 32768 here — matching the Java driver, whose
 * SD-log sampling-rate math also uses the (non-TCXO) crystal for these logs.
 */
function samplingClockFreq(tcxo: boolean, hw: number, expBrd: SdLogExpansionBoard | null): number {
  if (!tcxo) return SDLOG_CLOCK_FREQ;
  // isTcxoClock20MHz (ShimmerObject.java:10882-10896): Shimmer3/3R + EXG
  // unified board id 47, rev 1, revSpecial 1.
  const is20MHz =
    (hw === SDLOG_HW_ID.SHIMMER_3 || hw === SDLOG_HW_ID.SHIMMER_3R) &&
    expBrd !== null &&
    expBrd.id === SDLOG_EXP_BRD_ID.EXG_UNIFIED &&
    expBrd.rev === 1 &&
    expBrd.revSpecial === 1;
  return is20MHz ? 312500.0 : 255765.625;
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

/**
 * Decode the inertial-sensor hardware ranges from the SD config setup bytes.
 *
 * The four config setup bytes live at SD header bytes 8-11 (setup0-3): the
 * existing GSR-range read from byte 11 (setup3) fixes this mapping. Bit
 * positions are ported from ConfigByteLayoutShimmer3
 * (com.shimmerresearch.driver.shimmer2r3):
 *   - WR accel range : setup0 (byte 8) bits 2-3, mask 0x03
 *       (SensorLSM303.configByteArrayParse / SensorLIS2DW12 both use
 *        bitShiftLSM303DLHCAccelRange = 2)
 *   - gyro range LSB : setup2 (byte 10) bits 0-1, mask 0x03
 *       (bitShiftMPU9150GyroRange = 0; SensorLSM6DSV reuses the same LSB field)
 *   - mag range      : setup2 (byte 10) bits 5-7, mask 0x07
 *       (bitShiftLSM303DLHCMagRange = 5)
 *   - LN accel range : setup3 (byte 11) bits 6-7, mask 0x03 — Shimmer3R
 *       (SensorLSM6DSV LN accel, bitShiftMPU9150AccelRange = 6). On Shimmer3 the
 *       LN accel is the fixed-range Kionix KXRB, so this is forced to 0 there.
 *   - gyro range MSB : setup4 (byte 12) bit 2, mask 0x01 — Shimmer3R only.
 *       The LSM6DSV has 6 gyro ranges (0-5); the MSB lives in config setup byte 4
 *       and is combined with the 2-bit LSB as `lsb | (msb << 2)`. Ported from
 *       ShimmerSDLog.processSDLogHeader 3R branch:
 *         int gyroRange    = (byteArrayInfo[10]) & 03;      // LSB (byte 10)
 *         int msbGyroRange = (byteArrayInfo[12] >> 2) & 01; // MSB (byte 12 bit 2)
 *         setGyroRange(gyroRange + (msbGyroRange << 2));
 *       This matches the streaming path (Shimmer3RClient.ts, gyroLsb | gyroMsb<<2,
 *       cfg bit 34 == setup4 bit 2) and ShimmerObject.interpretInqResponse.
 *
 * HARDWARE-VERIFY: no real Shimmer3R SD card has been available to confirm the
 * byte-12 MSB placement; the offset is taken from the Java oracle only. The
 * alt-accel (high-g) and alt-mag ranges are likewise not decoded from the SD
 * header (defaulted to 0); their per-device calibration blocks, when present,
 * override the default anyway.
 */
function parseImuRanges(bytes: Uint8Array, hw: number): SdLogImuRanges {
  const setup0 = bytes[8] ?? 0;
  const setup2 = bytes[10] ?? 0;
  const setup3 = bytes[11] ?? 0;
  const setup4 = bytes[12] ?? 0;
  const wrAccel = (setup0 >> 2) & 0x03;
  const gyroLsb = setup2 & 0x03;
  // Shimmer3R gyro (LSM6DSV) has 6 ranges (0-5); the MSB rides in setup4 bit 2.
  // Shimmer3 gyro (MPU9x50) has only 4 ranges (0-3), so no MSB there.
  const gyro = hw === SDLOG_HW_ID.SHIMMER_3R ? gyroLsb | (((setup4 >> 2) & 0x01) << 2) : gyroLsb;
  const mag = (setup2 >> 5) & 0x07;
  const lnAccel = hw === SDLOG_HW_ID.SHIMMER_3R ? (setup3 >> 6) & 0x03 : 0;
  return { lnAccel, wrAccel, gyro, mag, altAccel: 0, altMag: 0 };
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
  // Computed with BigInt because bytes 220-221 reach bit 56, beyond the 2^53
  // exact-integer range of a JS number (Java uses a `long`). `derivedSensors`
  // (number) stays exact through byte 219 / bit 47; `derivedSensorsBig`
  // (bigint) carries the full 8-byte fidelity.
  let derivedBig = BigInt(bytes[40]) + (BigInt(bytes[41]) << 8n) + (BigInt(bytes[42]) << 16n);
  const eightByteDerived =
    (firmwareId === SDLOG_FW_ID.SDLOG && atLeast(fwVersion, 0, 13, 1)) ||
    (firmwareId === SDLOG_FW_ID.LOGANDSTREAM && atLeast(fwVersion, 0, 7, 1));
  if (eightByteDerived) {
    for (let i = 0; i < 5; i++) {
      derivedBig += BigInt(bytes[217 + i]) << BigInt(8 * (3 + i));
    }
  }
  const derivedSensorsBig = derivedBig;
  const derivedSensors = Number(derivedBig);

  // Byte 16: trial config A.
  const buttonStart = ((bytes[16] >> 5) & 0x01) === 1;
  const syncWhenLogging = ((bytes[16] >> 2) & 0x01) === 1;
  const masterShimmer = ((bytes[16] >> 1) & 0x01) === 1;

  // Byte 17 bit 4: TCXO (temperature-compensated crystal oscillator) flag —
  // ShimmerSDLog#processSDLogHeader sets it identically on both the Shimmer3
  // (:303) and Shimmer3R (:233) branches. It only affects the SD wall-clock
  // (RTC) conversion frequency (see samplingClockFreq).
  const tcxo = ((bytes[17] >> 4) & 0x01) === 1;

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

  const wallClockFreqHz = samplingClockFreq(tcxo, hardwareVersion, expansionBoard);

  const header: SdLogHeader = {
    hardwareVersion,
    firmwareId,
    firmwareVersion: fwVersion,
    samplingRateHz,
    macAddress: macFromBytes(bytes),
    enabledSensors,
    derivedSensors,
    derivedSensorsBig,
    tcxo,
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
    imuRanges: parseImuRanges(bytes, hardwareVersion),
    calibration: [],
  };

  return { header, channels, syncFraming, samplesPerBlock, wallClockFreqHz };
}

/**
 * Parse an SD-log file header (first 256 bytes for Shimmer3, 384 bytes for
 * Shimmer3R). The whole file may be passed — only the header is read.
 */
export function parseSdLogHeader(bytes: Uint8Array): SdLogHeader {
  return parseSdLog(bytes).header;
}
