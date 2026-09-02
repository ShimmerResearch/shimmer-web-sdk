/**
 * InfoMem → {@link InfoMemDeviceConfig} decode.
 *
 * Ported from `ShimmerObject#configBytesParse` (ShimmerObject.java:4931-5111)
 * and `#parseEnabledDerivedSensorsForMaps` (:5113-5149). Pure and byte-exact:
 * offsets come from {@link resolveInfoMemLayout}, field semantics from the Java
 * accessors.
 */

import type {
  InfoMemCalibrationBlocks,
  InfoMemContext,
  InfoMemDeviceConfig,
  InfoMemImuConfig,
  InfoMemSdConfig,
} from './types.js';
import {
  BIT_SHIFT,
  COMPOSITE_MSB_SHIFT,
  CONFIG_TIME_BIT_SHIFTS,
  CONFIG_TIME_LENGTH,
  EXG_BANK_LENGTH,
  GENERAL_CALIBRATION_LENGTH,
  INFOMEM_SIZE,
  MAC_LENGTH,
  MASK,
  MAX_SYNC_NODES,
  NAME_LENGTH,
  checkConfigBytesValid,
  resolveInfoMemLayout,
  type InfoMemLayout,
} from './layout.js';

/**
 * Sampling clock frequency for the InfoMem sampling-rate field. The crystal
 * (non-TCXO) 32768 Hz is used, matching the Java SD-log sampling-rate math
 * (`getSamplingClockFreq()` resolves to the crystal for a fresh parse where the
 * TCXO flag is not yet known). See `ShimmerObject#getSamplingClockFreq`.
 */
export const INFOMEM_SAMPLING_CLOCK_FREQ = 32768;

const bit = (byte: number, shift: number, mask: number): number => (byte >> shift) & mask;

/** True for a printable ASCII byte (Apache commons `isAsciiPrintable`: [0x20,0x7E]). */
function isAsciiPrintable(b: number): boolean {
  return b >= 0x20 && b < 0x7f;
}

/** Decode an ASCII name field, stopping at the first non-printable byte. */
function parseName(bytes: Uint8Array, offset: number, length: number): string {
  let s = '';
  for (let i = 0; i < length; i++) {
    const b = bytes[offset + i];
    if (b === undefined || !isAsciiPrintable(b)) break;
    s += String.fromCharCode(b);
  }
  return s;
}

/** 12-char UPPERCASE hex, in device byte order (UtilShimmer.bytesToHexString). */
function macToHex(bytes: Uint8Array, offset: number): string {
  let s = '';
  for (let i = 0; i < MAC_LENGTH; i++) {
    s += (bytes[offset + i] ?? 0).toString(16).toUpperCase().padStart(2, '0');
  }
  return s;
}

/**
 * Decode the IMU rate/range fields from ConfigSetupByte0-5.
 *
 * `gyroRange` and `pressureOversampling` are composite: the low bits sit in
 * ConfigSetupByte2/3 and, on Shimmer3R ONLY, a 3rd bit in ConfigSetupByte4.
 * See SensorLSM6DSV.java:1014-1017 and SensorBMP390.java:482-490.
 */
function parseImu(bytes: Uint8Array, layout: InfoMemLayout): InfoMemImuConfig {
  const cfg0 = bytes[layout.idxConfigSetupByte0] & 0xff;
  const cfg1 = bytes[layout.idxConfigSetupByte1] & 0xff;
  const cfg2 = bytes[layout.idxConfigSetupByte2] & 0xff;
  const cfg3 = bytes[layout.idxConfigSetupByte3] & 0xff;
  const cfg4 = bytes[layout.idxConfigSetupByte4] & 0xff;
  const cfg5 = bytes[layout.idxConfigSetupByte5] & 0xff;

  const gyroRangeLsb = bit(cfg2, BIT_SHIFT.GYRO_RANGE_LSB, MASK.GYRO_RANGE_LSB);
  const pressureLsb = bit(
    cfg3,
    BIT_SHIFT.PRESSURE_OVERSAMPLING_LSB,
    MASK.PRESSURE_OVERSAMPLING_LSB,
  );
  const gyroRangeMsb = layout.isShimmer3R
    ? bit(cfg4, BIT_SHIFT.GYRO_RANGE_MSB, MASK.GYRO_RANGE_MSB)
    : 0;
  const pressureMsb = layout.isShimmer3R
    ? bit(cfg4, BIT_SHIFT.PRESSURE_OVERSAMPLING_MSB, MASK.PRESSURE_OVERSAMPLING_MSB)
    : 0;

  return {
    wrAccelRange: bit(cfg0, BIT_SHIFT.WR_ACCEL_RANGE, MASK.WR_ACCEL_RANGE),
    wrAccelRate: bit(cfg0, BIT_SHIFT.WR_ACCEL_RATE, MASK.WR_ACCEL_RATE),
    wrAccelLpm: bit(cfg0, BIT_SHIFT.WR_ACCEL_LPM, MASK.WR_ACCEL_LPM) === 1,
    wrAccelHrm: bit(cfg0, BIT_SHIFT.WR_ACCEL_HRM, MASK.WR_ACCEL_HRM) === 1,
    gyroRange: (gyroRangeMsb << COMPOSITE_MSB_SHIFT) | gyroRangeLsb,
    imuRate: bit(cfg1, BIT_SHIFT.IMU_RATE, MASK.IMU_RATE),
    magRange: bit(cfg2, BIT_SHIFT.MAG_RANGE, MASK.MAG_RANGE),
    magRate: bit(cfg2, BIT_SHIFT.MAG_RATE, MASK.MAG_RATE),
    altAccelRange: bit(cfg3, BIT_SHIFT.ALT_ACCEL_RANGE, MASK.ALT_ACCEL_RANGE),
    pressureOversampling: (pressureMsb << COMPOSITE_MSB_SHIFT) | pressureLsb,
    altMagRate: bit(cfg5, BIT_SHIFT.ALT_MAG_RATE, MASK.ALT_MAG_RATE),
    altAccelRate: bit(cfg4, BIT_SHIFT.ALT_ACCEL_RATE, MASK.ALT_ACCEL_RATE),
  };
}

/** Big-endian u16 read (MSB byte first), used for the experiment lengths. */
function u16be(bytes: Uint8Array, msbIdx: number, lsbIdx: number): number {
  return ((bytes[msbIdx] & 0xff) << 8) | (bytes[lsbIdx] & 0xff);
}

/**
 * SD interval / experiment lengths. Java gates all three on
 * `isSupportedSdLogSync()` (ShimmerObject.java:5055-5060), so an unsupported
 * firmware yields zeros rather than junk.
 */
function parseSd(bytes: Uint8Array, layout: InfoMemLayout): InfoMemSdConfig {
  if (!layout.supportsSdLogSync) {
    return { btInterval: 0, estimatedExpLengthMin: 0, maxExpLengthMin: 0 };
  }
  return {
    btInterval: bytes[layout.idxSDBTInterval] & 0xff,
    estimatedExpLengthMin: u16be(
      bytes,
      layout.idxEstimatedExpLengthMsb,
      layout.idxEstimatedExpLengthLsb,
    ),
    maxExpLengthMin: u16be(bytes, layout.idxMaxExpLengthMsb, layout.idxMaxExpLengthLsb),
  };
}

/** Slice one 21-byte kinematic calibration block verbatim. */
function calibBlock(bytes: Uint8Array, offset: number): Uint8Array {
  const out = new Uint8Array(GENERAL_CALIBRATION_LENGTH);
  out.set(bytes.subarray(offset, offset + GENERAL_CALIBRATION_LENGTH), 0);
  return out;
}

/**
 * The six calibration blocks, verbatim. The alt-accel / alt-mag blocks only
 * exist on Shimmer3R; on Shimmer3 the same bytes are the MPL calibration
 * region, which is deliberately not modelled (see layout.ts).
 */
function parseCalibration(bytes: Uint8Array, layout: InfoMemLayout): InfoMemCalibrationBlocks {
  const blocks: InfoMemCalibrationBlocks = {
    lnAccel: calibBlock(bytes, layout.idxAnalogAccelCalibration),
    gyro: calibBlock(bytes, layout.idxMPU9150GyroCalibration),
    mag: calibBlock(bytes, layout.idxLSM303DLHCMagCalibration),
    wrAccel: calibBlock(bytes, layout.idxLSM303DLHCAccelCalibration),
  };
  if (layout.isShimmer3R) {
    blocks.altAccel = calibBlock(bytes, layout.idxADXL371AltAccelCalibration);
    blocks.altMag = calibBlock(bytes, layout.idxLIS3MDLAltMagCalibration);
  }
  return blocks;
}

/**
 * Sync-node MAC list (InfoMem B). Stops at the first all-0xFF slot, exactly
 * like the Java parse loop (ShimmerObject.java:5359-5366).
 */
function parseSyncNodes(bytes: Uint8Array, layout: InfoMemLayout): string[] {
  if (!layout.supportsSdLogSync) return [];
  const nodes: string[] = [];
  for (let i = 0; i < MAX_SYNC_NODES; i++) {
    const offset = layout.idxNode0 + i * MAC_LENGTH;
    let allFf = true;
    for (let b = 0; b < MAC_LENGTH; b++) {
      if ((bytes[offset + b] ?? 0xff) !== 0xff) {
        allFf = false;
        break;
      }
    }
    if (allFf) break;
    nodes.push(macToHex(bytes, offset));
  }
  return nodes;
}

/** Parse the enabled + derived sensor bitmaps (parseEnabledDerivedSensorsForMaps). */
function parseSensors(
  bytes: Uint8Array,
  layout: InfoMemLayout,
): { enabledSensors: number; derivedSensors: bigint } {
  let enabled =
    (bytes[layout.idxSensors0] & 0xff) +
    (bytes[layout.idxSensors1] & 0xff) * 2 ** 8 +
    (bytes[layout.idxSensors2] & 0xff) * 2 ** 16;
  if (layout.supportsMpl) {
    enabled += (bytes[layout.idxSensors3] & 0xff) * 2 ** 24;
    enabled += (bytes[layout.idxSensors4] & 0xff) * 2 ** 32;
  }

  let derived = 0n;
  // Compatible only when the derived offsets are present (>0) and not 0xFF.
  if (
    layout.idxDerivedSensors0 > 0 &&
    bytes[layout.idxDerivedSensors0] !== MASK.DERIVED_BYTE &&
    layout.idxDerivedSensors1 > 0 &&
    bytes[layout.idxDerivedSensors1] !== MASK.DERIVED_BYTE
  ) {
    derived |= BigInt(bytes[layout.idxDerivedSensors0] & 0xff);
    derived |= BigInt(bytes[layout.idxDerivedSensors1] & 0xff) << 8n;
    if (layout.idxDerivedSensors2 > 0) {
      derived |= BigInt(bytes[layout.idxDerivedSensors2] & 0xff) << 16n;
    }
    if (layout.supportsEightByteDerived) {
      derived |= BigInt(bytes[layout.idxDerivedSensors3] & 0xff) << 24n;
      derived |= BigInt(bytes[layout.idxDerivedSensors4] & 0xff) << 32n;
      derived |= BigInt(bytes[layout.idxDerivedSensors5] & 0xff) << 40n;
      derived |= BigInt(bytes[layout.idxDerivedSensors6] & 0xff) << 48n;
      derived |= BigInt(bytes[layout.idxDerivedSensors7] & 0xff) << 56n;
    }
  }
  return { enabledSensors: enabled, derivedSensors: derived };
}

/** A neutral (all-default) config, used for an unconfigured (invalid) InfoMem. */
function emptyConfig(raw: Uint8Array): InfoMemDeviceConfig {
  return {
    samplingRateHz: 0,
    enabledSensors: 0,
    derivedSensors: 0n,
    gsrRange: 0,
    expPowerEnabled: false,
    deviceName: '',
    trialName: '',
    configTime: 0,
    trial: {
      id: 0,
      numShimmers: 0,
      syncWhenLogging: false,
      masterShimmer: false,
      buttonStart: false,
      singleTouch: false,
      tcxo: false,
      disableBluetooth: false,
    },
    btBaudRate: 0,
    macAddress: '',
    exg1: new Uint8Array(EXG_BANK_LENGTH),
    exg2: new Uint8Array(EXG_BANK_LENGTH),
    imu: {
      wrAccelRange: 0,
      wrAccelRate: 0,
      wrAccelLpm: false,
      wrAccelHrm: false,
      gyroRange: 0,
      imuRate: 0,
      magRange: 0,
      magRate: 0,
      altAccelRange: 0,
      pressureOversampling: 0,
      altMagRate: 0,
      altAccelRate: 0,
    },
    sd: { btInterval: 0, estimatedExpLengthMin: 0, maxExpLengthMin: 0 },
    calibration: {
      lnAccel: new Uint8Array(GENERAL_CALIBRATION_LENGTH),
      gyro: new Uint8Array(GENERAL_CALIBRATION_LENGTH),
      mag: new Uint8Array(GENERAL_CALIBRATION_LENGTH),
      wrAccel: new Uint8Array(GENERAL_CALIBRATION_LENGTH),
    },
    syncNodes: [],
    raw,
    valid: false,
  };
}

/**
 * Decode a Shimmer3/3R InfoMem byte array into a {@link InfoMemDeviceConfig}.
 *
 * When the first 6 bytes are all 0xFF the InfoMem is unconfigured: the returned
 * config has `valid = false` and neutral defaults (the Java driver loads
 * defaults in this case), with the raw bytes preserved.
 *
 * @param bytes the full InfoMem (≥ {@link INFOMEM_SIZE} bytes recommended;
 *   shorter input is tolerated but out-of-range fields read as 0).
 * @param ctx   firmware/hardware identity selecting the byte layout.
 */
export function parseInfoMem(bytes: Uint8Array, ctx: InfoMemContext): InfoMemDeviceConfig {
  const raw = new Uint8Array(bytes);

  if (!checkConfigBytesValid(raw)) {
    return emptyConfig(raw);
  }

  const layout = resolveInfoMemLayout(ctx);

  // Sampling rate (LSB-first divider).
  const divider =
    (raw[layout.idxSamplingRate] & 0xff) + ((raw[layout.idxSamplingRate + 1] & 0xff) << 8);
  const samplingRateHz = divider === 0 ? 0 : INFOMEM_SAMPLING_CLOCK_FREQ / divider;

  const { enabledSensors, derivedSensors } = parseSensors(raw, layout);

  const cfg3 = raw[layout.idxConfigSetupByte3] & 0xff;
  const gsrRange = bit(cfg3, BIT_SHIFT.GSR_RANGE, MASK.GSR_RANGE);
  const expPowerEnabled = bit(cfg3, BIT_SHIFT.EXP_POWER, MASK.EXP_POWER) === 1;

  const exg1 = raw.slice(layout.idxExg1, layout.idxExg1 + EXG_BANK_LENGTH);
  const exg2 = raw.slice(layout.idxExg2, layout.idxExg2 + EXG_BANK_LENGTH);
  const btBaudRate = raw[layout.idxBtCommBaudRate] & 0xff;

  const deviceName = parseName(raw, layout.idxSDShimmerName, NAME_LENGTH);
  const trialName = parseName(raw, layout.idxSDEXPIDName, NAME_LENGTH);

  // Config time (big-endian).
  let configTime = 0;
  for (let x = 0; x < CONFIG_TIME_LENGTH; x++) {
    configTime += (raw[layout.idxSDConfigTime0 + x] & 0xff) * 2 ** CONFIG_TIME_BIT_SHIFTS[x];
  }

  const cfg0 = raw[layout.idxSDExperimentConfig0] & 0xff;
  const cfg1 = raw[layout.idxSDExperimentConfig1] & 0xff;

  // Experiment-config fields gated on firmware family / SD-log-sync support,
  // matching the Java parse guards.
  const buttonStart =
    layout.isSdLoggingFirmware && bit(cfg0, BIT_SHIFT.BUTTON_START, MASK.ONE_BIT) === 1;
  const disableBluetooth =
    layout.isSdLoggingFirmware && bit(cfg0, BIT_SHIFT.DISABLE_BLUETOOTH, MASK.ONE_BIT) === 1;
  const tcxo = layout.isSdLoggingFirmware && bit(cfg1, BIT_SHIFT.TCXO, MASK.ONE_BIT) === 1;

  const syncWhenLogging =
    layout.supportsSdLogSync && bit(cfg0, BIT_SHIFT.SYNC_WHEN_LOGGING, MASK.ONE_BIT) === 1;
  const masterShimmer =
    layout.supportsSdLogSync && bit(cfg0, BIT_SHIFT.MASTER_SHIMMER, MASK.ONE_BIT) === 1;
  const singleTouch =
    layout.supportsSdLogSync && bit(cfg1, BIT_SHIFT.SINGLE_TOUCH, MASK.ONE_BIT) === 1;
  const id = layout.supportsSdLogSync ? raw[layout.idxSDMyTrialID] & 0xff : 0;
  const numShimmers = layout.supportsSdLogSync ? raw[layout.idxSDNumOfShimmers] & 0xff : 0;

  const macAddress = macToHex(raw, layout.idxMacAddress);

  return {
    samplingRateHz,
    enabledSensors,
    derivedSensors,
    gsrRange,
    expPowerEnabled,
    deviceName,
    trialName,
    configTime,
    trial: {
      id,
      numShimmers,
      syncWhenLogging,
      masterShimmer,
      buttonStart,
      singleTouch,
      tcxo,
      disableBluetooth,
    },
    btBaudRate,
    macAddress,
    exg1,
    exg2,
    imu: parseImu(raw, layout),
    sd: parseSd(raw, layout),
    calibration: parseCalibration(raw, layout),
    syncNodes: parseSyncNodes(raw, layout),
    raw,
    valid: true,
  };
}

/** Byte ranges of the sync-node MAC list (InfoMem B), for tooling/tests. */
export { INFOMEM_SIZE };
