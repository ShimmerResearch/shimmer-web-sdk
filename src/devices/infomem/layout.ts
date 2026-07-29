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
  idxConfigSetupByte3: number;
  idxExg1: number;
  idxExg2: number;
  idxBtCommBaudRate: number;
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
  idxSDShimmerName: number;
  idxSDEXPIDName: number;
  idxSDConfigTime0: number;
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

  // Feature gates (cached from ctx).
  supportsMpl: boolean;
  supportsEightByteDerived: boolean;
  supportsSdLogSync: boolean;
  isSdLoggingFirmware: boolean;
}

// Field constant lengths / bit positions shared by parse + generate.
export const EXG_BANK_LENGTH = 10;
export const NAME_LENGTH = 12;
export const CONFIG_TIME_LENGTH = 4;
export const MAC_LENGTH = 6;
export const MAX_SYNC_NODES = 21;

export const BIT_SHIFT = Object.freeze({
  GSR_RANGE: 1,
  EXP_POWER: 0,
  BUTTON_START: 5,
  DISABLE_BLUETOOTH: 3,
  SYNC_WHEN_LOGGING: 2,
  MASTER_SHIMMER: 1,
  SINGLE_TOUCH: 7,
  TCXO: 4,
  SD_CFG_FILE_WRITE_FLAG: 0,
} as const);

export const MASK = Object.freeze({
  GSR_RANGE: 0x07,
  EXP_POWER: 0x01,
  ONE_BIT: 0x01,
  DERIVED_BYTE: 0xff,
  SD_CFG_FILE_WRITE_FLAG: 0x01,
} as const);

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
    idxConfigSetupByte3: 9,
    idxExg1: 10,
    idxExg2: 20,
    idxBtCommBaudRate: 30,
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
    idxSDShimmerName: 128 + 59, // 187
    idxSDEXPIDName: 128 + 71, // 199
    idxSDConfigTime0: 128 + 83, // 211
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

    // B page.
    idxNode0: 128 + 128, // 256

    supportsMpl: isSupportedMpl(ctx),
    supportsEightByteDerived: isSupportedEightByteDerivedSensors(ctx),
    supportsSdLogSync: isSupportedSdLogSync(ctx),
    isSdLoggingFirmware: isSdLoggingFirmware(ctx),
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
