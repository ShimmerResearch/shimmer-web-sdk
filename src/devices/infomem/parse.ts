/**
 * InfoMem → {@link InfoMemDeviceConfig} decode.
 *
 * Ported from `ShimmerObject#configBytesParse` (ShimmerObject.java:4931-5111)
 * and `#parseEnabledDerivedSensorsForMaps` (:5113-5149). Pure and byte-exact:
 * offsets come from {@link resolveInfoMemLayout}, field semantics from the Java
 * accessors.
 */

import type { InfoMemContext, InfoMemDeviceConfig } from './types.js';
import {
  BIT_SHIFT,
  CONFIG_TIME_BIT_SHIFTS,
  CONFIG_TIME_LENGTH,
  EXG_BANK_LENGTH,
  INFOMEM_SIZE,
  MAC_LENGTH,
  MASK,
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
    raw,
    valid: true,
  };
}

/** Byte ranges of the sync-node MAC list (InfoMem B), for tooling/tests. */
export { INFOMEM_SIZE };
