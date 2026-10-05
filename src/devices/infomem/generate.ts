/**
 * {@link InfoMemDeviceConfig} → InfoMem byte array.
 *
 * Ported from `ShimmerObject#configBytesGenerate` (ShimmerObject.java:5162-5380).
 *
 * Byte-layout, endianness and field gating are byte-exact against the Java
 * oracle. One deliberate structural refinement: the Java generate rebuilds the
 * whole InfoMem from scratch (0x00-filled) because a full `ShimmerObject`
 * carries every sub-setting (sensor rates/ranges, calibration blocks, sync-node
 * list) and rewrites them via per-sensor `configBytesGenerate`. This codec
 * intentionally models only the subset in {@link InfoMemDeviceConfig}, so it
 * instead layers the modelled fields over a BASE byte array (read-modify-write),
 * preserving every unmodelled region (sensor rate/range bytes, calibration
 * blocks, sync-node MAC list, showErrorLeds / low-batt bits). This matches the
 * real configure-while-docked flow (read InfoMem → change a field → write back)
 * and the spec requirement that "unknown regions must be preserved from a base
 * byte array".
 *
 * HARDWARE-VERIFY: the device-write finalization — forcing the MAC to all-0xFF
 * (so firmware re-reads it from the BT transceiver) and setting the
 * config-file-creation flag in the config-delay byte (so firmware regenerates
 * its SD config on undock/power-cycle) — is faithfully ported, but whether the
 * device accepts and applies the written InfoMem can only be confirmed on real
 * hardware.
 */

import type { InfoMemContext, InfoMemDeviceConfig } from './types.js';
import { parseInfoMem, INFOMEM_SAMPLING_CLOCK_FREQ } from './parse.js';
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
  resolveInfoMemLayout,
  type InfoMemLayout,
} from './layout.js';

export interface GenerateInfoMemOptions {
  /**
   * Byte array whose unmodelled regions are preserved. Defaults to the
   * config's own {@link InfoMemDeviceConfig.raw}. Copied (min length) into the
   * output before the modelled fields are layered on top.
   */
  base?: Uint8Array;
  /**
   * When true, apply the device-write finalization (MAC → 0xFF, config-file-
   * creation flag set). Use when the bytes are about to be written to the
   * device over the dock UART. Default false (produces a "for storage"
   * representation that leaves the MAC and config-delay byte as-is).
   */
  forDeviceWrite?: boolean;
}

/** Byte ranges that {@link generateInfoMem} intentionally leaves diverged after a device write. */
export interface DeviceWriteDivergentRanges {
  /** MAC address bytes (forced to 0xFF). */
  mac: { start: number; length: number };
  /** Config-delay / config-file-creation-flag byte. */
  configDelayFlag: { start: number; length: number };
}

/** Overwrite a contiguous byte range. */
function setBytes(out: Uint8Array, offset: number, src: ArrayLike<number>): void {
  for (let i = 0; i < src.length; i++) out[offset + i] = src[i] & 0xff;
}

/** Read-modify-write a single bit-field within a byte, preserving other bits. */
function setBitField(
  out: Uint8Array,
  offset: number,
  shift: number,
  mask: number,
  value: number,
): void {
  const cleared = out[offset] & ~(mask << shift) & 0xff;
  out[offset] = (cleared | ((value & mask) << shift)) & 0xff;
}

/**
 * Encode a {@link InfoMemDeviceConfig} to a {@link INFOMEM_SIZE}-byte InfoMem
 * array ready to write to the device (128-byte chunks) or store.
 */
export function generateInfoMem(
  config: InfoMemDeviceConfig,
  ctx: InfoMemContext,
  opts: GenerateInfoMemOptions = {},
): Uint8Array {
  const layout = resolveInfoMemLayout(ctx);
  const out = new Uint8Array(INFOMEM_SIZE); // 0x00-filled

  // Preserve unmodelled regions from the base (or the config's own raw bytes).
  const base = opts.base ?? config.raw;
  if (base && base.length > 0) {
    out.set(base.subarray(0, Math.min(base.length, INFOMEM_SIZE)), 0);
  }

  writeModelledFields(out, config, layout);

  if (opts.forDeviceWrite && layout.isSdLoggingFirmware) {
    applyDeviceWriteFinalization(out, config, layout);
  }

  return out;
}

function writeModelledFields(
  out: Uint8Array,
  config: InfoMemDeviceConfig,
  layout: InfoMemLayout,
): void {
  // Sampling rate (LSB-first divider = round(clock / Hz)).
  const divider =
    config.samplingRateHz > 0 ? Math.round(INFOMEM_SAMPLING_CLOCK_FREQ / config.samplingRateHz) : 0;
  out[layout.idxSamplingRate] = divider & 0xff;
  out[layout.idxSamplingRate + 1] = (divider >> 8) & 0xff;

  // Buffer size forced to 1 (BtStream rejects InfoMem otherwise) — ShimmerObject.java:5192.
  out[layout.idxBufferSize] = 1;

  // Enabled sensors: bytes 0-2 (bits 0-23). Bytes 3-4 (MPL) are written by the
  // Java per-sensor generate, not the main path, so they are left to base.
  out[layout.idxSensors0] = config.enabledSensors & 0xff;
  out[layout.idxSensors1] = (config.enabledSensors >>> 8) & 0xff;
  out[layout.idxSensors2] = (config.enabledSensors >>> 16) & 0xff;

  // GSR range + expansion-board power (ConfigSetupByte3 bits 1-3 / bit 0),
  // read-modify-write so the byte's other bits (pressure/accel range) survive.
  setBitField(
    out,
    layout.idxConfigSetupByte3,
    BIT_SHIFT.GSR_RANGE,
    MASK.GSR_RANGE,
    config.gsrRange,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte3,
    BIT_SHIFT.EXP_POWER,
    MASK.EXP_POWER,
    config.expPowerEnabled ? 1 : 0,
  );

  // EXG register banks (10 bytes each).
  setBytes(out, layout.idxExg1, exgBank(config.exg1));
  setBytes(out, layout.idxExg2, exgBank(config.exg2));

  // Bluetooth baud.
  out[layout.idxBtCommBaudRate] = config.btBaudRate & 0xff;

  // Derived sensors (only when the layout has them, matching parse gating).
  if (layout.idxDerivedSensors0 > 0 && layout.idxDerivedSensors1 > 0) {
    const d = config.derivedSensors;
    out[layout.idxDerivedSensors0] = derivedByte(d, 0n);
    out[layout.idxDerivedSensors1] = derivedByte(d, 8n);
    if (layout.idxDerivedSensors2 > 0) out[layout.idxDerivedSensors2] = derivedByte(d, 16n);
    if (layout.supportsEightByteDerived) {
      out[layout.idxDerivedSensors3] = derivedByte(d, 24n);
      out[layout.idxDerivedSensors4] = derivedByte(d, 32n);
      out[layout.idxDerivedSensors5] = derivedByte(d, 40n);
      out[layout.idxDerivedSensors6] = derivedByte(d, 48n);
      out[layout.idxDerivedSensors7] = derivedByte(d, 56n);
    }
  }

  // Names: up to 12 ASCII chars, remaining bytes padded 0xFF.
  writeName(out, layout.idxSDShimmerName, config.deviceName);
  writeName(out, layout.idxSDEXPIDName, config.trialName);

  // Config time (big-endian).
  for (let x = 0; x < CONFIG_TIME_LENGTH; x++) {
    out[layout.idxSDConfigTime0 + x] =
      Math.floor(config.configTime / 2 ** CONFIG_TIME_BIT_SHIFTS[x]) & 0xff;
  }

  // Experiment-config bit-fields (read-modify-write, gated like the Java parse/generate).
  const t = config.trial;
  if (layout.isSdLoggingFirmware) {
    setBitField(
      out,
      layout.idxSDExperimentConfig0,
      BIT_SHIFT.BUTTON_START,
      MASK.ONE_BIT,
      t.buttonStart ? 1 : 0,
    );
    setBitField(
      out,
      layout.idxSDExperimentConfig0,
      BIT_SHIFT.DISABLE_BLUETOOTH,
      MASK.ONE_BIT,
      t.disableBluetooth ? 1 : 0,
    );
    setBitField(out, layout.idxSDExperimentConfig1, BIT_SHIFT.TCXO, MASK.ONE_BIT, t.tcxo ? 1 : 0);
  }
  if (layout.supportsSdLogSync) {
    setBitField(
      out,
      layout.idxSDExperimentConfig0,
      BIT_SHIFT.SYNC_WHEN_LOGGING,
      MASK.ONE_BIT,
      t.syncWhenLogging ? 1 : 0,
    );
    setBitField(
      out,
      layout.idxSDExperimentConfig0,
      BIT_SHIFT.MASTER_SHIMMER,
      MASK.ONE_BIT,
      t.masterShimmer ? 1 : 0,
    );
    setBitField(
      out,
      layout.idxSDExperimentConfig1,
      BIT_SHIFT.SINGLE_TOUCH,
      MASK.ONE_BIT,
      t.singleTouch ? 1 : 0,
    );
    out[layout.idxSDMyTrialID] = t.id & 0xff;
    out[layout.idxSDNumOfShimmers] = t.numShimmers & 0xff;
  }

  writeImu(out, config, layout);
  writeSd(out, config, layout);
  writeCalibration(out, config, layout);
  writeSyncNodes(out, config, layout);
}

/**
 * IMU rate/range fields into ConfigSetupByte0-5, all read-modify-write so the
 * unmodelled bits in those bytes (the firmware-only `wrAccelLpModeMsb`, the
 * MPL bits on Shimmer3, every reserved bit) keep their base value.
 *
 * The composite MSB bits (gyro range bit 2, pressure oversampling bit 2) are
 * written ONLY on Shimmer3R — on Shimmer3 they belong to the MPL region of
 * ConfigSetupByte4 and must not be disturbed.
 */
function writeImu(out: Uint8Array, config: InfoMemDeviceConfig, layout: InfoMemLayout): void {
  const imu = config.imu;

  // ConfigSetupByte0 — WR accel (LSM303DLHC/LSM303AH/LIS2DW12).
  setBitField(
    out,
    layout.idxConfigSetupByte0,
    BIT_SHIFT.WR_ACCEL_RATE,
    MASK.WR_ACCEL_RATE,
    imu.wrAccelRate,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte0,
    BIT_SHIFT.WR_ACCEL_RANGE,
    MASK.WR_ACCEL_RANGE,
    imu.wrAccelRange,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte0,
    BIT_SHIFT.WR_ACCEL_LPM,
    MASK.WR_ACCEL_LPM,
    imu.wrAccelLpm ? 1 : 0,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte0,
    BIT_SHIFT.WR_ACCEL_HRM,
    MASK.WR_ACCEL_HRM,
    imu.wrAccelHrm ? 1 : 0,
  );

  // ConfigSetupByte1 — whole byte is the IMU accel+gyro rate.
  setBitField(out, layout.idxConfigSetupByte1, BIT_SHIFT.IMU_RATE, MASK.IMU_RATE, imu.imuRate);

  // ConfigSetupByte2 — mag range/rate + gyro-range low bits.
  setBitField(out, layout.idxConfigSetupByte2, BIT_SHIFT.MAG_RANGE, MASK.MAG_RANGE, imu.magRange);
  setBitField(out, layout.idxConfigSetupByte2, BIT_SHIFT.MAG_RATE, MASK.MAG_RATE, imu.magRate);
  setBitField(
    out,
    layout.idxConfigSetupByte2,
    BIT_SHIFT.GYRO_RANGE_LSB,
    MASK.GYRO_RANGE_LSB,
    imu.gyroRange,
  );

  // ConfigSetupByte3 — alt/LN accel range + pressure-oversampling low bits.
  // (GSR range and exp power are written by the caller above.)
  setBitField(
    out,
    layout.idxConfigSetupByte3,
    BIT_SHIFT.ALT_ACCEL_RANGE,
    MASK.ALT_ACCEL_RANGE,
    imu.altAccelRange,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte3,
    BIT_SHIFT.PRESSURE_OVERSAMPLING_LSB,
    MASK.PRESSURE_OVERSAMPLING_LSB,
    imu.pressureOversampling,
  );

  if (!layout.isShimmer3R) return;

  // ---- Shimmer3R-only: ConfigSetupByte4/5.
  setBitField(
    out,
    layout.idxConfigSetupByte4,
    BIT_SHIFT.GYRO_RANGE_MSB,
    MASK.GYRO_RANGE_MSB,
    imu.gyroRange >> COMPOSITE_MSB_SHIFT,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte4,
    BIT_SHIFT.PRESSURE_OVERSAMPLING_MSB,
    MASK.PRESSURE_OVERSAMPLING_MSB,
    imu.pressureOversampling >> COMPOSITE_MSB_SHIFT,
  );
  setBitField(
    out,
    layout.idxConfigSetupByte4,
    BIT_SHIFT.ALT_ACCEL_RATE,
    MASK.ALT_ACCEL_RATE,
    imu.altAccelRate,
  );
  // ConfigSetupByte5 bits 0-5 (NOT byte 4 — see BIT_SHIFT.ALT_MAG_RATE).
  setBitField(
    out,
    layout.idxConfigSetupByte5,
    BIT_SHIFT.ALT_MAG_RATE,
    MASK.ALT_MAG_RATE,
    imu.altMagRate,
  );
}

/** SD interval + big-endian experiment lengths, gated like the Java generate. */
function writeSd(out: Uint8Array, config: InfoMemDeviceConfig, layout: InfoMemLayout): void {
  if (!layout.supportsSdLogSync) return;
  const sd = config.sd;
  out[layout.idxSDBTInterval] = sd.btInterval & 0xff;
  out[layout.idxEstimatedExpLengthMsb] = (sd.estimatedExpLengthSec >> 8) & 0xff;
  out[layout.idxEstimatedExpLengthLsb] = sd.estimatedExpLengthSec & 0xff;
  out[layout.idxMaxExpLengthMsb] = (sd.maxExpLengthMin >> 8) & 0xff;
  out[layout.idxMaxExpLengthLsb] = sd.maxExpLengthMin & 0xff;
}

/**
 * The 21-byte kinematic calibration blocks, byte-for-byte as modelled — an
 * identity write unless the caller replaced an array. Blocks shorter than 21
 * bytes are zero-padded; longer ones are truncated.
 */
function writeCalibration(
  out: Uint8Array,
  config: InfoMemDeviceConfig,
  layout: InfoMemLayout,
): void {
  const c = config.calibration;
  setBytes(out, layout.idxAnalogAccelCalibration, calibBlock(c.lnAccel));
  setBytes(out, layout.idxMPU9150GyroCalibration, calibBlock(c.gyro));
  setBytes(out, layout.idxLSM303DLHCMagCalibration, calibBlock(c.mag));
  setBytes(out, layout.idxLSM303DLHCAccelCalibration, calibBlock(c.wrAccel));
  if (layout.isShimmer3R) {
    if (c.altAccel) setBytes(out, layout.idxADXL371AltAccelCalibration, calibBlock(c.altAccel));
    if (c.altMag) setBytes(out, layout.idxLIS3MDLAltMagCalibration, calibBlock(c.altMag));
  }
}

/**
 * Sync-node MAC list into InfoMem B: the listed MACs at `idxNode0 + i*6`, the
 * remaining slots padded with 0xFF (ShimmerObject.java:5353-5366).
 *
 * DELIBERATE DEVIATION: Java additionally blanks the WHOLE list to 0xFF when
 * `mSyncWhenLogging == 0`. This codec writes the list as modelled, so a
 * read-change-write cycle cannot silently destroy a stored node list just
 * because sync happens to be off; a caller that wants the Java behaviour sets
 * `syncNodes: []`.
 *
 * The list is TERMINATED by the first all-0xFF slot — that is where
 * `parseSyncNodes` stops, and the firmware reads it the same way. So the first
 * missing, malformed or literally all-0xFF entry ends the list here too, and
 * every slot after it is padded. Writing a real MAC behind a terminator would
 * put bytes in the image that no reader can reach, and the list would come
 * back shorter than it went in.
 */
function writeSyncNodes(out: Uint8Array, config: InfoMemDeviceConfig, layout: InfoMemLayout): void {
  if (!layout.supportsSdLogSync) return;
  let terminated = false;
  for (let i = 0; i < MAX_SYNC_NODES; i++) {
    const offset = layout.idxNode0 + i * MAC_LENGTH;
    const mac = terminated ? undefined : config.syncNodes[i];
    // macFromHex already yields all-0xFF for unparseable input, so this one
    // test covers a bad string and a real FFFFFFFFFFFF alike.
    const bytes = mac === undefined ? undefined : macFromHex(mac);
    if (bytes === undefined || bytes.every((b) => b === 0xff)) {
      terminated = true;
      for (let b = 0; b < MAC_LENGTH; b++) out[offset + b] = 0xff;
    } else {
      setBytes(out, offset, bytes);
    }
  }
}

/** 12-char hex → 6 bytes (UtilShimmer.hexStringToByteArray). Bad input → invalid MAC. */
function macFromHex(hex: string): Uint8Array {
  const out = new Uint8Array(MAC_LENGTH).fill(0xff);
  if (!/^[0-9a-fA-F]{12}$/.test(hex)) return out;
  for (let i = 0; i < MAC_LENGTH; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Normalise a calibration block to exactly 21 bytes. */
function calibBlock(block: Uint8Array): Uint8Array {
  if (block.length === GENERAL_CALIBRATION_LENGTH) return block;
  const b = new Uint8Array(GENERAL_CALIBRATION_LENGTH);
  b.set(block.subarray(0, GENERAL_CALIBRATION_LENGTH), 0);
  return b;
}

/**
 * Device-write finalization (ShimmerObject.java:5320-5339): force the MAC to
 * all-0xFF and set the config-file-creation flag. These are the ONLY bytes that
 * intentionally diverge from a plain round-trip after a device write — see
 * {@link deviceWriteDivergentRanges}.
 */
function applyDeviceWriteFinalization(
  out: Uint8Array,
  config: InfoMemDeviceConfig,
  layout: InfoMemLayout,
): void {
  // MAC → invalid (0xFF×6): firmware re-reads it from the BT transceiver.
  for (let i = 0; i < MAC_LENGTH; i++) out[layout.idxMacAddress + i] = 0xff;

  // Config-delay byte: set the config-file-write flag bit when requested.
  out[layout.idxSDConfigDelayFlag] = 0;
  // We always request a new SD config on undock (mirrors mConfigFileCreationFlag=true
  // in the desktop write path). HARDWARE-VERIFY: this flag is what makes the FW
  // regenerate its SD config on undock/power-cycle.
  const flag = MASK.SD_CFG_FILE_WRITE_FLAG << BIT_SHIFT.SD_CFG_FILE_WRITE_FLAG;
  out[layout.idxSDConfigDelayFlag] |= flag;
  void config;
}

/**
 * Byte ranges that {@link generateInfoMem} with `forDeviceWrite` intentionally
 * leaves diverged from the input config — used by the write-back verify to
 * exclude them from the byte comparison.
 */
export function deviceWriteDivergentRanges(ctx: InfoMemContext): DeviceWriteDivergentRanges {
  const layout = resolveInfoMemLayout(ctx);
  return {
    mac: { start: layout.idxMacAddress, length: MAC_LENGTH },
    configDelayFlag: { start: layout.idxSDConfigDelayFlag, length: 1 },
  };
}

/**
 * Byte-compare `written` against `readback` over the full InfoMem, ignoring the
 * ranges a device write intentionally leaves diverged — pass
 * {@link deviceWriteDivergentRanges} for the context that was written.
 *
 * This is what makes a write-back verify meaningful. A read-back after a device
 * write is NEVER byte-identical to what was sent: the firmware overwrites the
 * MAC bytes with the address it reads from its own Bluetooth transceiver, and
 * it rewrites the config-delay / config-file-creation flag byte as it
 * regenerates its SD configuration. Comparing the whole image would therefore
 * report a mismatch on every successful write, and comparing nothing would
 * report success on a corrupt one.
 *
 * Shared by the dock and radio config-write paths so both draw the exclusion
 * line in exactly the same place.
 */
export function compareInfoMemExcluding(
  written: Uint8Array,
  readback: Uint8Array,
  ranges: DeviceWriteDivergentRanges,
): boolean {
  if (written.length !== readback.length) return false;
  const excluded = new Set<number>();
  for (const r of [ranges.mac, ranges.configDelayFlag]) {
    for (let i = 0; i < r.length; i++) excluded.add(r.start + i);
  }
  for (let i = 0; i < written.length; i++) {
    if (excluded.has(i)) continue;
    if (written[i] !== readback[i]) return false;
  }
  return true;
}

function exgBank(bank: Uint8Array): Uint8Array {
  if (bank.length === EXG_BANK_LENGTH) return bank;
  const b = new Uint8Array(EXG_BANK_LENGTH);
  b.set(bank.subarray(0, EXG_BANK_LENGTH), 0);
  return b;
}

function derivedByte(value: bigint, shift: bigint): number {
  return Number((value >> shift) & 0xffn);
}

function writeName(out: Uint8Array, offset: number, name: string): void {
  for (let i = 0; i < NAME_LENGTH; i++) {
    out[offset + i] = i < name.length ? name.charCodeAt(i) & 0xff : 0xff;
  }
}

/** Re-export so the client can round-trip without importing parse separately. */
export { parseInfoMem };
