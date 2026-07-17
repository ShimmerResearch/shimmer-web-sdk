/**
 * Synthetic SD-log fixture builders, assembled byte-by-byte from the header
 * offset tables in ShimmerSDLog.java so the decoder is tested against an
 * independent encoding of the format.
 */

import type { SdLogDataType } from '../../src/devices/sdlog/index.js';

export interface HeaderFixtureOptions {
  hw?: number; // 3 = Shimmer3, 10 = Shimmer3R
  fwId?: number; // 2 = SDLog, 3 = LogAndStream
  fwVersion?: [major: number, minor: number, internal: number];
  samplingDivider?: number;
  enabledSensors?: number; // up to 40-bit
  derivedSensors?: number; // written to bytes 40-42 and 217-221
  mac?: number[];
  trialId?: number;
  numShimmers?: number;
  syncWhenLogging?: boolean;
  masterShimmer?: boolean;
  buttonStart?: boolean;
  gsrRange?: number;
  mpuDmp?: boolean;
  /** TCXO flag — SD header byte 17 bit 4. */
  tcxo?: boolean;
  rtcDifferenceTicks?: bigint;
  configTime?: number;
  initialTimestampTicks?: number;
  expansionBoard?: [id: number, rev: number, revSpecial: number];
  /** Shimmer3R only: dynamic channel table signal IDs (header bytes 315..). */
  signalIds?: number[];
  /** Optional per-block fill for the calibration areas (default pattern). */
  calibFill?: (offset: number) => number;
}

/** Build a modern Shimmer3 (256 B) or Shimmer3R (384 B) SD-log header. */
export function buildSdLogHeader(opts: HeaderFixtureOptions = {}): Uint8Array {
  const hw = opts.hw ?? 3;
  const fwId = opts.fwId ?? 2;
  const [maj, min, internal] = opts.fwVersion ?? [0, 11, 5];
  const len = hw === 10 ? 384 : 256;
  const b = new Uint8Array(len);

  const divider = opts.samplingDivider ?? 512; // 64 Hz
  b[0] = divider & 0xff;
  b[1] = (divider >> 8) & 0xff;

  const enabled = opts.enabledSensors ?? 0;
  for (let i = 0; i < 5; i++) b[3 + i] = Math.floor(enabled / 2 ** (8 * i)) % 256;

  b[11] = ((opts.gsrRange ?? 0) & 0x07) << 1;
  if (opts.mpuDmp) b[12] |= 0x80;

  b[16] =
    ((opts.buttonStart ? 1 : 0) << 5) |
    ((opts.syncWhenLogging ? 1 : 0) << 2) |
    ((opts.masterShimmer ? 1 : 0) << 1);

  // Byte 17 bit 4: TCXO flag.
  b[17] = (opts.tcxo ? 1 : 0) << 4;

  const mac = opts.mac ?? [0xd0, 0x2b, 0x46, 0x3d, 0xa2, 0xbb];
  for (let i = 0; i < 6; i++) b[24 + i] = mac[i];

  b[30] = (hw >> 8) & 0xff;
  b[31] = hw & 0xff;
  b[32] = opts.trialId ?? 1;
  b[33] = opts.numShimmers ?? 1;
  b[34] = (fwId >> 8) & 0xff;
  b[35] = fwId & 0xff;
  b[36] = (maj >> 8) & 0xff;
  b[37] = maj & 0xff;
  b[38] = min;
  b[39] = internal;

  const derived = opts.derivedSensors ?? 0;
  for (let i = 0; i < 3; i++) b[40 + i] = Math.floor(derived / 2 ** (8 * i)) % 256;
  for (let i = 0; i < 5; i++) b[217 + i] = Math.floor(derived / 2 ** (8 * (3 + i))) % 256;

  const rtc = BigInt.asUintN(64, opts.rtcDifferenceTicks ?? 0n);
  for (let i = 0; i < 8; i++) b[44 + i] = Number((rtc >> BigInt(8 * (7 - i))) & 0xffn);

  const cfgTime = opts.configTime ?? 0;
  b[52] = Math.floor(cfgTime / 2 ** 24) % 256;
  b[53] = Math.floor(cfgTime / 2 ** 16) % 256;
  b[54] = Math.floor(cfgTime / 2 ** 8) % 256;
  b[55] = cfgTime % 256;

  // Calibration areas — recognizable default pattern.
  const fill = opts.calibFill ?? ((off: number) => off & 0xff);
  for (let off = 76; off < 182; off++) b[off] = fill(off);
  b[222] = fill(222);
  b[223] = fill(223);

  if (opts.expansionBoard) {
    b[214] = opts.expansionBoard[0];
    b[215] = opts.expansionBoard[1];
    b[216] = opts.expansionBoard[2];
  }

  // Initial timestamp ticks: b[251]<<32 | b[255]<<24 | b[254]<<16 | b[253]<<8 | b[252].
  const its = opts.initialTimestampTicks ?? 0;
  b[251] = Math.floor(its / 2 ** 32) % 256;
  b[255] = Math.floor(its / 2 ** 24) % 256;
  b[254] = Math.floor(its / 2 ** 16) % 256;
  b[253] = Math.floor(its / 2 ** 8) % 256;
  b[252] = its % 256;

  if (hw === 10) {
    for (let off = 256; off < 277; off++) b[off] = fill(off);
    for (let off = 285; off < 306; off++) b[off] = fill(off);
    const ids = opts.signalIds ?? [];
    b[314] = ids.length;
    ids.forEach((id, i) => {
      b[315 + i] = id;
    });
  }

  return b;
}

/** Encode one channel value in the on-disk representation of `type`. */
export function encodeValue(type: SdLogDataType, value: number): number[] {
  switch (type) {
    case 'u8':
      return [value & 0xff];
    case 'u12':
    case 'u14':
    case 'u16':
      return [value & 0xff, (value >> 8) & 0xff];
    case 'i16': {
      const v = value & 0xffff;
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case 'u16r':
      return [(value >> 8) & 0xff, value & 0xff];
    case 'i16r': {
      const v = value & 0xffff;
      return [(v >> 8) & 0xff, v & 0xff];
    }
    case 'u24':
      return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
    case 'u24r':
      return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
    case 'i24r': {
      const v = value & 0xffffff;
      return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    }
    case 'u32r':
    case 'i32r': {
      const v = value >>> 0;
      return [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    }
    case 'i12*>': {
      const v = value & 0xfff;
      return [(v >> 4) & 0xff, (v & 0x0f) << 4];
    }
  }
}

/** Encode a data packet: little-endian timestamp + per-channel values. */
export function buildPacket(
  timestampTicks: number,
  tsBytes: 2 | 3,
  channelBytes: number[],
): number[] {
  const out = [timestampTicks & 0xff, (timestampTicks >> 8) & 0xff];
  if (tsBytes === 3) out.push((timestampTicks >> 16) & 0xff);
  return out.concat(channelBytes);
}

/** Concatenate a header and packet byte arrays into one file image. */
export function buildFile(header: Uint8Array, ...packets: number[][]): Uint8Array {
  const body = packets.flat();
  const file = new Uint8Array(header.length + body.length);
  file.set(header, 0);
  file.set(body, header.length);
  return file;
}
