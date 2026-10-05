/**
 * Firmware/hardware-conditional InfoMem byte-layout resolution for Shimmer3
 * and Shimmer3R.
 *
 * Ported verbatim from the Java driver:
 *   com.shimmerresearch.driver.shimmer2r3.ConfigByteLayoutShimmer3
 *     (field initialisers + the constructor @324-412 that mutates offsets and
 *      the InfoMem address base by firmware version / hardware id)
 *   com.shimmerresearch.driver.ConfigByteLayout (address defaults @36-40,
 *     checkConfigBytesValid @90)
 *   com.shimmerresearch.driverUtilities.UtilShimmer#compareVersions (@580-629)
 *   com.shimmerresearch.driverUtilities.ShimmerVerObject
 *     (#isSupportedMpl @390, #isSupportedEightByteDerivedSensors @472)
 *   com.shimmerresearch.driver.ShimmerDevice#isSupportedSdLogSync (@2091)
 *
 * Everything here is pure so it can be unit-tested with byte fixtures.
 */

import type { InfoMemContext } from './types.js';

// ---------------------------------------------------------------------------
// HW / FW id constants (ShimmerVerDetails.java)
// ---------------------------------------------------------------------------

/** Hardware version codes (`ShimmerVerDetails.HW_ID`). */
export const HW_ID = Object.freeze({
  SHIMMER_3: 3,
  SHIMMER_3R: 10,
} as const);

/** Firmware identifier codes (`ShimmerVerDetails.FW_ID`). */
export const FW_ID = Object.freeze({
  BTSTREAM: 1,
  SDLOG: 2,
  LOGANDSTREAM: 3,
  GQ_802154: 9,
  SHIMMER4_SDK_STOCK: 12,
  STROKARE: 15,
} as const);

/** `ShimmerVerDetails.ANY_VERSION` — wildcard for a version-field comparison. */
export const ANY_VERSION = -1;

// ---------------------------------------------------------------------------
// InfoMem geometry
// ---------------------------------------------------------------------------

/** Total InfoMem config length used by Shimmer3/3R (D+C+B pages). */
export const INFOMEM_SIZE = 384;
/** One InfoMem page (D/C/B) = 128 bytes; also the UART transfer chunk size. */
export const INFOMEM_PAGE_SIZE = 128;
/** Number of validity sentinel bytes checked at the start of the InfoMem. */
export const INFOMEM_VALIDITY_BYTES = 6;

/** Legacy MSP430 absolute page addresses (`ConfigByteLayout` defaults). */
export const INFOMEM_ADDR_LEGACY = Object.freeze({ D: 0x1800, C: 0x1880, B: 0x1900 } as const);
/** 0-based flat page addresses used by newer firmware / all Shimmer3R. */
export const INFOMEM_ADDR_FLAT = Object.freeze({ D: 0, C: 128, B: 256 } as const);

// ---------------------------------------------------------------------------
// Version comparison (UtilShimmer#compareVersions)
// ---------------------------------------------------------------------------

/**
 * True when the context firmware matches `fwId` (or `fwId` is
 * {@link ANY_VERSION}) AND the context version is >= the given threshold.
 * Major/minor use strict `>`, internal uses `>=`, exactly as
 * `UtilShimmer.compareVersions` (UtilShimmer.java:582-629). Passing
 * {@link ANY_VERSION} for the version fields makes the version test always pass
 * (any real version is `> -1`), matching the Java `ANY_VERSION` idiom.
 */
export function fwCompare(
  ctx: InfoMemContext,
  fwId: number,
  major: number,
  minor: number,
  internal: number,
): boolean {
  if (fwId !== ANY_VERSION && ctx.firmwareId !== fwId) return false;
  const { major: a, minor: b, internal: c } = ctx.firmwareVersion;
  return a > major || (a === major && b > minor) || (a === major && b === minor && c >= internal);
}

const isShimmer3R = (ctx: InfoMemContext): boolean => ctx.hardwareVersion === HW_ID.SHIMMER_3R;

// ---------------------------------------------------------------------------
// Feature predicates that gate which InfoMem fields are meaningful
// ---------------------------------------------------------------------------

/**
 * `ShimmerVerObject#isSupportedMpl` (@390): Shimmer3 + SDLog in the half-open
 * window [0.7.0, 0.8.0). No supported/target device runs this, so enabled-
 * sensor bytes 3-4 (bits 24-39) are effectively never populated.
 */
export function isSupportedMpl(ctx: InfoMemContext): boolean {
  return (
    ctx.hardwareVersion === HW_ID.SHIMMER_3 &&
    fwCompare(ctx, FW_ID.SDLOG, 0, 7, 0) &&
    !fwCompare(ctx, FW_ID.SDLOG, 0, 8, 0)
  );
}

/**
 * `ShimmerVerObject#isSupportedEightByteDerivedSensors` (@472): SDLog>=0.13.1,
 * LogAndStream>=0.7.1, GQ_802154>=0.3.2, Shimmer4>=0.0.23, or StroKare (any).
 */
export function isSupportedEightByteDerivedSensors(ctx: InfoMemContext): boolean {
  return (
    fwCompare(ctx, FW_ID.SDLOG, 0, 13, 1) ||
    fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 7, 1) ||
    fwCompare(ctx, FW_ID.GQ_802154, 0, 3, 2) ||
    fwCompare(ctx, FW_ID.SHIMMER4_SDK_STOCK, 0, 0, 23) ||
    fwCompare(ctx, FW_ID.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)
  );
}

/**
 * `ShimmerDevice#isSupportedSdLogSync` (@2091): SDLog (any), Shimmer3R+
 * LogAndStream (any), Shimmer3+LogAndStream>=0.16.11, or StroKare. Gates the
 * trial id / number-of-Shimmers, sync bits, sync-node list.
 */
export function isSupportedSdLogSync(ctx: InfoMemContext): boolean {
  if (ctx.firmwareId === FW_ID.SDLOG) return true;
  if (ctx.firmwareId === FW_ID.STROKARE) return true;
  if (isShimmer3R(ctx) && ctx.firmwareId === FW_ID.LOGANDSTREAM) return true;
  if (
    ctx.hardwareVersion === HW_ID.SHIMMER_3 &&
    ctx.firmwareId === FW_ID.LOGANDSTREAM &&
    fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 16, 11)
  ) {
    return true;
  }
  return false;
}

/**
 * SDLog / LogAndStream / StroKare firmware — the family that stores the
 * experiment-config bytes (button-start, disable-BT, TCXO) and honours the
 * device-write MAC-0xFF + config-file-creation-flag semantics
 * (ShimmerObject.java:5035,5054,5278,5312,5320).
 */
export function isSdLoggingFirmware(ctx: InfoMemContext): boolean {
  return (
    ctx.firmwareId === FW_ID.SDLOG ||
    ctx.firmwareId === FW_ID.LOGANDSTREAM ||
    ctx.firmwareId === FW_ID.STROKARE
  );
}

// ---------------------------------------------------------------------------
// Resolved layout
// ---------------------------------------------------------------------------

/**
 * A fully-resolved InfoMem byte layout: every offset already reflects the
 * firmware/hardware-conditional mutations from the Java constructor, so callers
 * index directly without re-deriving branches.
 */
export interface InfoMemLayout {
  // Page address base (what the firmware expects on the wire).
  addrD: number;
  addrC: number;
  addrB: number;
  /** True when the flat 0-based address base is used (vs. legacy 0x1800). */
  flatAddressing: boolean;

  // InfoMem D
  idxSamplingRate: number;
  idxBufferSize: number;
  idxSensors0: number;
  idxSensors1: number;
  idxSensors2: number;
  idxConfigSetupByte0: number;
  idxConfigSetupByte1: number;
  idxConfigSetupByte2: number;
  idxConfigSetupByte3: number;
  idxExg1: number;
  idxExg2: number;
  idxBtCommBaudRate: number;
  /** LN-accel (KXRB5/KXTC9 on Shimmer3, LSM6DSV accel on Shimmer3R) 21-byte kinematic calib block. */
  idxAnalogAccelCalibration: number;
  /** Gyro (MPU9x50 on Shimmer3, LSM6DSV on Shimmer3R) 21-byte kinematic calib block. */
  idxMPU9150GyroCalibration: number;
  /** Mag (LSM303DLHC/AH on Shimmer3, LIS2MDL on Shimmer3R) 21-byte kinematic calib block. */
  idxLSM303DLHCMagCalibration: number;
  /** WR-accel (LSM303DLHC/AH on Shimmer3, LIS2DW12 on Shimmer3R) 21-byte kinematic calib block. */
  idxLSM303DLHCAccelCalibration: number;
  /** Alt-accel (ADXL371, Shimmer3R only) 21-byte kinematic calib block. */
  idxADXL371AltAccelCalibration: number;
  /** Alt-mag (LIS3MDL, Shimmer3R only) 21-byte kinematic calib block. */
  idxLIS3MDLAltMagCalibration: number;
  idxDerivedSensors0: number;
  idxDerivedSensors1: number;
  idxDerivedSensors2: number;
  idxDerivedSensors3: number;
  idxDerivedSensors4: number;
  idxDerivedSensors5: number;
  idxDerivedSensors6: number;
  idxDerivedSensors7: number;

  // InfoMem C
  idxSensors3: number;
  idxSensors4: number;
  idxConfigSetupByte4: number;
  idxConfigSetupByte5: number;
  idxConfigSetupByte6: number;
  idxSDShimmerName: number;
  idxSDEXPIDName: number;
  idxSDConfigTime0: number;
  idxSDConfigTime1: number;
  idxSDConfigTime2: number;
  idxSDConfigTime3: number;
  idxSDMyTrialID: number;
  idxSDNumOfShimmers: number;
  idxSDExperimentConfig0: number;
  idxSDExperimentConfig1: number;
  idxSDBTInterval: number;
  idxEstimatedExpLengthMsb: number;
  idxEstimatedExpLengthLsb: number;
  idxMaxExpLengthMsb: number;
  idxMaxExpLengthLsb: number;
  idxMacAddress: number;
  idxSDConfigDelayFlag: number;
  idxBtFactoryReset: number;

  // InfoMem B
  idxNode0: number;

  /** `ConfigByteLayoutShimmer3.lengthGeneralCalibrationBytes` (@238) — always 21. */
  lengthGeneralCalibrationBytes: number;

  // Feature gates (cached from ctx).
  supportsMpl: boolean;
  supportsEightByteDerived: boolean;
  supportsSdLogSync: boolean;
  isSdLoggingFirmware: boolean;
  /** True for HW_ID.SHIMMER_3R — gates the Shimmer3R-only composite MSB bits. */
  isShimmer3R: boolean;
}

/*
 * MPL (MPU9150 DMP / sensor-fusion) InfoMem regions and bit fields are
 * DELIBERATELY NOT MODELLED and must never appear in host UI:
 *
 *   `idxMPLAccelCalibration` = 128+5, `idxMPLMagCalibration` = 128+26,
 *   `idxMPLGyroCalibration`  = 128+47, plus every `bitShiftMPL*` /
 *   `bitShiftMPU9150DMP|LPF|MotCalCfg|MPLSamplingRate|MagSamplingRate` field
 *   (ConfigByteLayoutShimmer3.java:226-248) written into ConfigSetupByte4/5/6
 *   by `SensorMPU9X50.configBytesGenerate` (@905-931).
 *
 * They are MPU9150-DMP-only: `ShimmerVerObject#isSupportedMpl` restricts them
 * to Shimmer3 + SDLog in [0.7.0, 0.8.0), which no supported/target device runs.
 * The product decision is that these settings are never surfaced; their bytes
 * must simply SURVIVE round-trip, which the read-modify-write generate path
 * guarantees (anything not explicitly written keeps its base value).
 *
 * Note that on every supported firmware the MPL blocks are physically the same
 * bytes as the Shimmer3R alt-IMU calibration blocks (MPL accel 133 ==
 * ADXL371 alt-accel calib, MPL mag 154 == LIS3MDL alt-mag calib), and the
 * firmware header marks the MPL gyro region as `unusedIdx175To186[12]`
 * (shimmer_config.h) — i.e. the MPL region was reclaimed, further confirming
 * it should not be modelled as MPL.
 */

// Field constant lengths / bit positions shared by parse + generate.
export const EXG_BANK_LENGTH = 10;
export const NAME_LENGTH = 12;
export const CONFIG_TIME_LENGTH = 4;
export const MAC_LENGTH = 6;
export const MAX_SYNC_NODES = 21;

/**
 * MAC values reported by a device whose InfoMem has never been provisioned
 * (erased flash reads back all-FF; a zeroed page reads back all-zero). Neither
 * is a real address, so a client should reject rather than surface them.
 */
export const INVALID_MAC_IDS: readonly string[] = Object.freeze(['FFFFFFFFFFFF', '000000000000']);

/** One 21-byte kinematic calibration block (`lengthGeneralCalibrationBytes`). */
export const GENERAL_CALIBRATION_LENGTH = 21;

/**
 * Bit positions within the InfoMem config-setup bytes. Every entry cites its
 * `ConfigByteLayoutShimmer3` declaration; where the Java DECLARATION comment
 * ("//Config ByteN") disagrees with the byte the Java code actually indexes, or
 * with the firmware `gConfigBytes` struct, the firmware wins and the
 * disagreement is called out inline.
 */
export const BIT_SHIFT = Object.freeze({
  // ---- ConfigSetupByte0 (idx 6) — firmware `gConfigBytes` idx 6 bitfield.
  /** WR-accel sampling rate. `bitShiftLSM303DLHCAccelSamplingRate` (@124); FW `wrAccelRate` bits 4-7. */
  WR_ACCEL_RATE: 4,
  /** WR-accel range. `bitShiftLSM303DLHCAccelRange` (@126); FW `wrAccelRange` bits 2-3. */
  WR_ACCEL_RANGE: 2,
  /** WR-accel low-power mode (LSB). `bitShiftLSM303DLHCAccelLPM` (@129); FW `wrAccelLpModeLsb` bit 1. */
  WR_ACCEL_LPM: 1,
  /** WR-accel high-resolution mode. `bitShiftLSM303DLHCAccelHRM` (@132); FW `wrAccelHrMode` bit 0. */
  WR_ACCEL_HRM: 0,

  // ---- ConfigSetupByte1 (idx 7) — whole byte.
  /** IMU (MPU9x50 / LSM6DSV) accel+gyro rate. `bitShiftMPU9150AccelGyroSamplingRate` (@139); FW `gyroRate`. */
  IMU_RATE: 0,

  // ---- ConfigSetupByte2 (idx 8).
  /** Mag range. `bitShiftLSM303DLHCMagRange` (@143); FW `magRange` (S3) / `altMagRange` (S3R) bits 5-7. */
  MAG_RANGE: 5,
  /** Mag sampling rate. `bitShiftLSM303DLHCMagSamplingRate` (@145); FW `magRate` bits 2-4. */
  MAG_RATE: 2,
  /** Gyro range, LOW 2 bits. `bitShiftMPU9150GyroRange` (@147); FW `gyroRangeLsb` bits 0-1. */
  GYRO_RANGE_LSB: 0,

  // ---- ConfigSetupByte3 (idx 9).
  /** Alt-accel range (S3 MPU9x50) / LN-accel range (S3R LSM6DSV). `bitShiftMPU9150AccelRange` (@150); FW bits 6-7. */
  ALT_ACCEL_RANGE: 6,
  /** Pressure oversampling, LOW 2 bits. `bitShiftBMPX80PressureResolution` (@152); FW `pressureOversamplingRatioLsb` bits 4-5. */
  PRESSURE_OVERSAMPLING_LSB: 4,
  GSR_RANGE: 1,
  EXP_POWER: 0,

  // ---- ConfigSetupByte4 (idx 130 on every supported firmware).
  /**
   * Alt-accel (ADXL371) sampling rate. `bitShiftADXL371AltAccelSamplingRate`
   * (@161) used with `idxConfigSetupByte4` in SensorADXL371.java:356/370;
   * FW `altAccelRate` bits 6-7 of idx 130. Java and firmware AGREE.
   */
  ALT_ACCEL_RATE: 6,
  /**
   * Gyro range MSB (3rd bit). `bitShiftLSM6DSVGyroRangeMSB` (@163) used with
   * `idxConfigSetupByte4` in SensorLSM6DSV.java:980/1015; FW `gyroRangeMsb`
   * bit 2 of idx 130. Java and firmware AGREE.
   */
  GYRO_RANGE_MSB: 2,
  /**
   * Pressure oversampling MSB (3rd bit). Java declares this as
   * `bitShiftBMP390PressureResolution` under a "//Config Byte0" comment
   * (@134-135) — that comment is WRONG: both SensorBMP390.java:499 and
   * SensorBMP581.java:380 index `idxConfigSetupByte4`, and the firmware struct
   * has `pressureOversamplingRatioMsb` as bit 0 of idx 130. FIRMWARE WINS →
   * ConfigSetupByte4 bit 0, not ConfigSetupByte0.
   */
  PRESSURE_OVERSAMPLING_MSB: 0,
  /**
   * WR-accel low-power-mode MSB — FIRMWARE-ONLY (`wrAccelLpModeMsb`, bit 1 of
   * idx 130). The Java driver has no equivalent field and never writes it, so
   * the codec does not model it either; the bit survives round-trip untouched.
   */
  WR_ACCEL_LPM_MSB: 1,

  // ---- ConfigSetupByte5 (idx 131 on every supported firmware).
  /**
   * Alt-mag (LIS3MDL) sampling rate. Java declares
   * `bitShiftLIS3MDLAltMagSamplingRate` (@158) under a "//Config Byte4"
   * comment — that comment is WRONG: SensorLIS3MDL.java:809/831 index
   * `idxConfigSetupByte5`, and the firmware struct has `altMagRate` as bits
   * 0-5 of idx 131. FIRMWARE WINS → ConfigSetupByte5 bits 0-5.
   */
  ALT_MAG_RATE: 0,
  /**
   * `bitShiftLIS2MDLMagRateMSB` (@167). NOT MODELLED: every use in
   * SensorLIS2MDL.java (@581 generate, @602 parse) is COMMENTED OUT, and the
   * firmware struct has idx 131 bits 6-7 as `unusedByte131Bit6/7` with no mag
   * MSB anywhere. LIS2MDL mag rate is the plain 3-bit ConfigSetupByte2 field.
   * Kept here only so the constant table is complete against the Java source;
   * writing it would corrupt `altMagRate` bits 3-5.
   */
  LIS2MDL_MAG_RATE_MSB_UNUSED: 3,

  // ---- SD / trial bits (idx 217/218/230).
  BUTTON_START: 5,
  DISABLE_BLUETOOTH: 3,
  SYNC_WHEN_LOGGING: 2,
  MASTER_SHIMMER: 1,
  SINGLE_TOUCH: 7,
  TCXO: 4,
  SD_CFG_FILE_WRITE_FLAG: 0,
} as const);

export const MASK = Object.freeze({
  // ConfigSetupByte0
  WR_ACCEL_RATE: 0x0f, // maskLSM303DLHCAccelSamplingRate @125
  WR_ACCEL_RANGE: 0x03, // maskLSM303DLHCAccelRange @127
  WR_ACCEL_LPM: 0x01, // maskLSM303DLHCAccelLPM @130
  WR_ACCEL_HRM: 0x01, // maskLSM303DLHCAccelHRM @133
  // ConfigSetupByte1
  IMU_RATE: 0xff, // maskMPU9150AccelGyroSamplingRate @140
  // ConfigSetupByte2
  MAG_RANGE: 0x07, // maskLSM303DLHCMagRange @144
  MAG_RATE: 0x07, // maskLSM303DLHCMagSamplingRate @146
  GYRO_RANGE_LSB: 0x03, // maskMPU9150GyroRange @148
  // ConfigSetupByte3
  ALT_ACCEL_RANGE: 0x03, // maskMPU9150AccelRange @151
  PRESSURE_OVERSAMPLING_LSB: 0x03, // maskBMPX80PressureResolution @153
  GSR_RANGE: 0x07,
  EXP_POWER: 0x01,
  // ConfigSetupByte4
  ALT_ACCEL_RATE: 0x03, // maskADXL371AltAccelSamplingRate @162
  GYRO_RANGE_MSB: 0x01, // maskLSM6DSVGyroRangeMSB @164
  PRESSURE_OVERSAMPLING_MSB: 0x01, // maskBMP390PressureResolution @136
  WR_ACCEL_LPM_MSB: 0x01, // firmware-only, not written
  // ConfigSetupByte5
  ALT_MAG_RATE: 0x3f, // maskLIS3MDLAltMagSamplingRate @159
  LIS2MDL_MAG_RATE_MSB_UNUSED: 0x07, // maskLIS2MDLMagRateMSB @166 (never written)
  // Shared
  ONE_BIT: 0x01,
  DERIVED_BYTE: 0xff,
  SD_CFG_FILE_WRITE_FLAG: 0x01,
} as const);

/**
 * Composite (split across two bytes) field widths. The low part lives in
 * ConfigSetupByte2/3 and the high bit in ConfigSetupByte4; the high bit is only
 * written on Shimmer3R, where the LSM6DSV / BMP390-BMP581 need the extra range.
 */
export const COMPOSITE_MSB_SHIFT = 2;

/** Config-time bytes are big-endian: byte0 = MSB (shift 24) … byte3 = LSB. */
export const CONFIG_TIME_BIT_SHIFTS = [24, 16, 8, 0] as const;

/**
 * Resolve the InfoMem layout for a firmware/hardware context, applying the
 * same ordered constructor branches as `ConfigByteLayoutShimmer3` (oldest →
 * newest). Returns a frozen, fully-derived {@link InfoMemLayout}.
 */
export function resolveInfoMemLayout(ctx: InfoMemContext): InfoMemLayout {
  const r = isShimmer3R(ctx);

  // ---- Base (default) initialiser values (ConfigByteLayoutShimmer3 @34-109).
  const layout: InfoMemLayout = {
    // Page addresses — legacy default; branch 4 may remap to flat 0-based.
    addrD: INFOMEM_ADDR_LEGACY.D,
    addrC: INFOMEM_ADDR_LEGACY.C,
    addrB: INFOMEM_ADDR_LEGACY.B,
    flatAddressing: false,

    idxSamplingRate: 0,
    idxBufferSize: 2,
    idxSensors0: 3,
    idxSensors1: 4,
    idxSensors2: 5,
    idxConfigSetupByte0: 6,
    idxConfigSetupByte1: 7,
    idxConfigSetupByte2: 8,
    idxConfigSetupByte3: 9,
    idxExg1: 10,
    idxExg2: 20,
    idxBtCommBaudRate: 30,
    // Kinematic calibration blocks — defaults (@95-99); branch 2 remaps all six.
    idxAnalogAccelCalibration: 31,
    idxMPU9150GyroCalibration: 52,
    idxLSM303DLHCMagCalibration: 73,
    idxLSM303DLHCAccelCalibration: 94,
    idxADXL371AltAccelCalibration: 256,
    idxLIS3MDLAltMagCalibration: 285,
    // Derived-sensor offsets default to 0 ("not present").
    idxDerivedSensors0: 0,
    idxDerivedSensors1: 0,
    idxDerivedSensors2: 0,
    idxDerivedSensors3: 0,
    idxDerivedSensors4: 0,
    idxDerivedSensors5: 0,
    idxDerivedSensors6: 0,
    idxDerivedSensors7: 0,

    // C page (128 + X).
    idxSensors3: 128 + 2,
    idxSensors4: 128 + 3,
    // Defaults (@113-117): ConfigSetupByte4/5 sit BELOW Sensors3/4; branch 1
    // swaps them so Sensors3/4 land at 128/129 and ConfigSetupByte4/5 at
    // 130/131. ConfigSetupByte6 is 128+4 in both cases.
    idxConfigSetupByte4: 128 + 0,
    idxConfigSetupByte5: 128 + 1,
    idxConfigSetupByte6: 128 + 4, // 132
    idxSDShimmerName: 128 + 59, // 187
    idxSDEXPIDName: 128 + 71, // 199
    idxSDConfigTime0: 128 + 83, // 211
    idxSDConfigTime1: 128 + 84, // 212
    idxSDConfigTime2: 128 + 85, // 213
    idxSDConfigTime3: 128 + 86, // 214
    idxSDMyTrialID: 128 + 87, // 215
    idxSDNumOfShimmers: 128 + 88, // 216
    idxSDExperimentConfig0: 128 + 89, // 217
    idxSDExperimentConfig1: 128 + 90, // 218
    idxSDBTInterval: 128 + 91, // 219
    idxEstimatedExpLengthMsb: 128 + 92, // 220
    idxEstimatedExpLengthLsb: 128 + 93, // 221
    idxMaxExpLengthMsb: 128 + 94, // 222
    idxMaxExpLengthLsb: 128 + 95, // 223
    idxMacAddress: 128 + 96, // 224
    idxSDConfigDelayFlag: 128 + 102, // 230
    idxBtFactoryReset: 0,

    // B page. Java `idxNode0` = 128+128 = 256 with `maxNumOfExperimentNodes`
    // = 21 (→ 256..381). The firmware header's NV_* defines look different
    // (NV_CENTER = 256, NV_NODE0 = 262) but its `gConfigBytes` struct lays out
    // `syncNodeAddr1[6]`…`syncNodeAddr21[6]` starting at 256 with
    // NV_NUM_BYTES_SYNC_CENTER_NODE_ADDRS = 126 = 21*6, so the struct AGREES
    // with Java: slot 0 (the "center") is simply the first of the 21 slots.
    idxNode0: 128 + 128, // 256

    lengthGeneralCalibrationBytes: GENERAL_CALIBRATION_LENGTH,

    supportsMpl: isSupportedMpl(ctx),
    supportsEightByteDerived: isSupportedEightByteDerivedSensors(ctx),
    supportsSdLogSync: isSupportedSdLogSync(ctx),
    isSdLoggingFirmware: isSdLoggingFirmware(ctx),
    isShimmer3R: r,
  };

  // ---- Branch 1 (@330-343): 3R | SDLog>=0.8.42 | LogAndStream>=0.3.4 | Shimmer4 | StroKare
  // Relocates Sensors3/4 to 128/129 (ConfigSetupByte4/5 shift to 130/131) and
  // seeds DerivedSensors0-2 at 115-117 (overridden by branch 2 below).
  if (
    r ||
    fwCompare(ctx, FW_ID.SDLOG, 0, 8, 42) ||
    fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 3, 4) ||
    fwCompare(ctx, FW_ID.SHIMMER4_SDK_STOCK, ANY_VERSION, ANY_VERSION, ANY_VERSION) ||
    fwCompare(ctx, FW_ID.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)
  ) {
    layout.idxSensors3 = 128 + 0;
    layout.idxSensors4 = 128 + 1;
    layout.idxConfigSetupByte4 = 128 + 2; // 130 — matches FW NV_CONFIG_SETUP_BYTE4
    layout.idxConfigSetupByte5 = 128 + 3; // 131 — matches FW NV_CONFIG_SETUP_BYTE5
    layout.idxConfigSetupByte6 = 128 + 4; // 132 — matches FW NV_CONFIG_SETUP_BYTE6
    layout.idxDerivedSensors0 = 115;
    layout.idxDerivedSensors1 = 116;
    layout.idxDerivedSensors2 = 117;
  }

  // ---- Branch 2 (@345-360): 3R | SDLog>=0.8.68 | LogAndStream>=0.3.17 | BtStream>=0.6.0 | Shimmer4 | StroKare
  // Moves DerivedSensors0-2 into InfoMem D at 31-33 (and the calibration blocks,
  // which this codec does not surface).
  if (
    r ||
    fwCompare(ctx, FW_ID.SDLOG, 0, 8, 68) ||
    fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 3, 17) ||
    fwCompare(ctx, FW_ID.BTSTREAM, 0, 6, 0) ||
    fwCompare(ctx, FW_ID.SHIMMER4_SDK_STOCK, ANY_VERSION, ANY_VERSION, ANY_VERSION) ||
    fwCompare(ctx, FW_ID.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)
  ) {
    layout.idxDerivedSensors0 = 31;
    layout.idxDerivedSensors1 = 32;
    layout.idxDerivedSensors2 = 33;
    // Calibration blocks shift up by 3 to make room for DerivedSensors0-2, and
    // the two alt-IMU blocks move from their (bogus, InfoMem-B-colliding)
    // defaults into InfoMem C. All six match the firmware NV_* map exactly:
    // NV_LN_ACCEL_CALIBRATION 34, NV_GYRO_CALIBRATION 55, NV_MAG_CALIBRATION
    // 76, NV_WR_ACCEL_CALIBRATION 97, NV_ALT_ACCEL_CALIBRATION 128+5 = 133,
    // NV_ALT_MAG_CALIBRATION 128+26 = 154.
    layout.idxAnalogAccelCalibration = 34;
    layout.idxMPU9150GyroCalibration = 55;
    layout.idxLSM303DLHCMagCalibration = 76;
    layout.idxLSM303DLHCAccelCalibration = 97;
    layout.idxADXL371AltAccelCalibration = 133;
    layout.idxLIS3MDLAltMagCalibration = 154;
  }

  // ---- Branch 4 — ADDRESS-BASE REMAP (@370-381): 3R | SDLog>=0.11.5 |
  // LogAndStream>=0.5.16 | BtStream>=0.7.4 | Shimmer4 | StroKare.
  // HARDWARE-VERIFY: the page address the device firmware expects on the wire
  // (legacy MSP430 0x1800/0x1880/0x1900 vs. flat 0/128/256) is only confirmable
  // against real hardware of each firmware generation.
  if (
    r ||
    fwCompare(ctx, FW_ID.SDLOG, 0, 11, 5) ||
    fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 5, 16) ||
    fwCompare(ctx, FW_ID.BTSTREAM, 0, 7, 4) ||
    fwCompare(ctx, FW_ID.SHIMMER4_SDK_STOCK, ANY_VERSION, ANY_VERSION, ANY_VERSION) ||
    fwCompare(ctx, FW_ID.STROKARE, ANY_VERSION, ANY_VERSION, ANY_VERSION)
  ) {
    layout.addrD = INFOMEM_ADDR_FLAT.D;
    layout.addrC = INFOMEM_ADDR_FLAT.C;
    layout.addrB = INFOMEM_ADDR_FLAT.B;
    layout.flatAddressing = true;
  }

  // ---- Branch 5 (@383-390): 3R | isSupportedEightByteDerivedSensors.
  if (r || layout.supportsEightByteDerived) {
    layout.idxDerivedSensors3 = 118;
    layout.idxDerivedSensors4 = 119;
    layout.idxDerivedSensors5 = 120;
    layout.idxDerivedSensors6 = 121;
    layout.idxDerivedSensors7 = 122;
  }

  // ---- Branch 7 (@398-401): 3R | LogAndStream>=0.8.1.
  if (r || fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 8, 1)) {
    layout.idxBtFactoryReset = 128 + 103; // 231
  }

  return Object.freeze(layout);
}

/**
 * The "first 6 bytes all 0xFF ⇒ unconfigured/invalid" check
 * (ConfigByteLayout.checkConfigBytesValid @90). Returns true when the InfoMem
 * holds a real configuration.
 */
export function checkConfigBytesValid(bytes: Uint8Array): boolean {
  if (bytes.length < INFOMEM_VALIDITY_BYTES) return false;
  for (let i = 0; i < INFOMEM_VALIDITY_BYTES; i++) {
    if (bytes[i] !== 0xff) return true;
  }
  return false;
}
