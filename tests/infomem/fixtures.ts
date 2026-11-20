import type { InfoMemContext } from '../../src/devices/infomem/index.js';
import { INFOMEM_SIZE } from '../../src/devices/infomem/index.js';

/**
 * Firmware/hardware contexts exercising each InfoMem layout branch.
 * FW_ID: SDLOG=2, LOGANDSTREAM=3. HW_ID: Shimmer3=3, Shimmer3R=10.
 */
export const CTX = {
  /** Modern Shimmer3 + LogAndStream 0.16.11: flat addressing, derived@31, 8-byte derived. */
  modernShimmer3: {
    hardwareVersion: 3,
    firmwareId: 3,
    firmwareVersion: { major: 0, minor: 16, internal: 11 },
  } as InfoMemContext,

  /** Shimmer3 + SDLog 0.8.68: relocated offsets (derived@31) but LEGACY 0x1800 addressing, no 8-byte derived. */
  relocatedSdlog: {
    hardwareVersion: 3,
    firmwareId: 2,
    firmwareVersion: { major: 0, minor: 8, internal: 68 },
  } as InfoMemContext,

  /** Legacy-ish Shimmer3 + SDLog 0.8.69 (still legacy addressing, sync supported). */
  legacyAddrSdlog: {
    hardwareVersion: 3,
    firmwareId: 2,
    firmwareVersion: { major: 0, minor: 8, internal: 69 },
  } as InfoMemContext,

  /** Shimmer3R + LogAndStream 1.0.40: all newest branches, flat addressing. */
  shimmer3R: {
    hardwareVersion: 10,
    firmwareId: 3,
    firmwareVersion: { major: 1, minor: 0, internal: 40 },
  } as InfoMemContext,
} as const;

/** A blank valid InfoMem (all 0x00 → first 6 bytes not 0xFF once we set fields). */
export function blankInfoMem(): Uint8Array {
  return new Uint8Array(INFOMEM_SIZE);
}

/** Write a little-endian 16-bit divider at bytes 0-1. */
export function setSamplingDivider(buf: Uint8Array, divider: number): void {
  buf[0] = divider & 0xff;
  buf[1] = (divider >> 8) & 0xff;
}

/** Write an ASCII name at `offset`, padded with `pad` up to 12 bytes. */
export function setName(buf: Uint8Array, offset: number, name: string, pad = 0xff): void {
  for (let i = 0; i < 12; i++) {
    buf[offset + i] = i < name.length ? name.charCodeAt(i) : pad;
  }
}

/** Write a 32-bit big-endian value at `offset`. */
export function setBE32(buf: Uint8Array, offset: number, value: number): void {
  buf[offset] = (value >>> 24) & 0xff;
  buf[offset + 1] = (value >>> 16) & 0xff;
  buf[offset + 2] = (value >>> 8) & 0xff;
  buf[offset + 3] = value & 0xff;
}

/**
 * Build a synthetic 384-byte InfoMem in which EVERY modelled field holds a
 * distinctive non-default value AND every deliberately-unmodelled region holds
 * a non-zero sentinel (0x5A / 0xAA), so a parse→generate round trip must
 * reproduce the image byte-for-byte.
 *
 * Byte positions follow the layout that both {@link CTX.modernShimmer3} and
 * {@link CTX.shimmer3R} resolve to (all remap branches taken). Values are
 * chosen so the Shimmer3 and Shimmer3R codecs both round-trip the SAME image:
 * the Shimmer3R-only ConfigSetupByte4/5 fields sit in bytes that a Shimmer3
 * context simply preserves.
 */
export function fullFieldInfoMem(): Uint8Array {
  const b = new Uint8Array(INFOMEM_SIZE);

  // ---- InfoMem D
  setSamplingDivider(b, 32); // 32768/32 = 1024 Hz exactly
  b[2] = 1; // buffer size — generate always forces 1
  b[3] = 0x12; // sensors0
  b[4] = 0x34; // sensors1
  b[5] = 0x56; // sensors2
  // ConfigSetupByte0: wrAccelRate 9 (<<4) | wrAccelRange 2 (<<2) | LPM | HRM
  b[6] = (9 << 4) | (2 << 2) | (1 << 1) | 1; // 0x9B
  b[7] = 7; // ConfigSetupByte1 = IMU accel+gyro rate
  // ConfigSetupByte2: magRange 3 (<<5) | magRate 5 (<<2) | gyroRange LSB 1
  b[8] = (3 << 5) | (5 << 2) | 1; // 0x75
  // ConfigSetupByte3: altAccelRange 2 (<<6) | pressure LSB 1 (<<4) | gsrRange 4 (<<1) | expPower
  b[9] = (2 << 6) | (1 << 4) | (4 << 1) | 1; // 0x99
  for (let i = 0; i < 10; i++) b[10 + i] = 0x10 + i; // EXG1 bank
  for (let i = 0; i < 10; i++) b[20 + i] = 0x20 + i; // EXG2 bank
  b[30] = 5; // BT baud index
  b[31] = 0x11; // derived 0
  b[32] = 0x22; // derived 1
  b[33] = 0x33; // derived 2
  for (let i = 0; i < 21; i++) b[34 + i] = 0x40 + i; // LN-accel calib
  for (let i = 0; i < 21; i++) b[55 + i] = 0x60 + i; // gyro calib
  for (let i = 0; i < 21; i++) b[76 + i] = 0x80 + i; // mag calib
  for (let i = 0; i < 21; i++) b[97 + i] = 0xa0 + i; // WR-accel calib
  b[118] = 0x44;
  b[119] = 0x55;
  b[120] = 0x66;
  b[121] = 0x77;
  b[122] = 0x88;
  for (let i = 123; i <= 127; i++) b[i] = 0x5a; // FW unusedIdx123..127

  // ---- InfoMem C
  b[128] = 0xaa; // Sensors3 — MPL-only, FW unusedIdx128
  b[129] = 0xaa; // Sensors4 — MPL-only, FW unusedIdx129
  // ConfigSetupByte4: pressure MSB (b0) | wrAccelLpmMsb (b1, FW-only) |
  // gyroRange MSB (b2) | reserved b3-b5 all set | altAccelRate 2 (<<6)
  b[130] = 0b0011_1111 | (2 << 6); // 0xBF
  // ConfigSetupByte5: altMagRate 0x3A (bits 0-5) | reserved bits 6-7 set
  b[131] = 0x3a | 0xc0; // 0xFA
  b[132] = 0x5a; // ConfigSetupByte6 — MPL-only, FW unusedIdx132
  for (let i = 0; i < 21; i++) b[133 + i] = 0xc0 + i; // alt-accel (ADXL371) calib
  for (let i = 0; i < 21; i++) b[154 + i] = 0xe0 + i; // alt-mag (LIS3MDL) calib
  for (let i = 175; i <= 186; i++) b[i] = 0x5a; // MPL gyro calib / FW unusedIdx175To186
  setName(b, 187, 'SHIM3R');
  setName(b, 199, 'TRIAL01');
  setBE32(b, 211, 0x5f0a0b0c); // config time
  b[215] = 7; // trial id
  b[216] = 3; // number of Shimmers
  // ExperimentConfig0: buttonStart(5) | disableBluetooth(3) | syncWhenLogging(2)
  // | masterShimmer(1), plus the unmodelled showErrorLedsSd(0)/Rwc(4) sentinels.
  b[217] = (1 << 5) | (1 << 4) | (1 << 3) | (1 << 2) | (1 << 1) | 1; // 0x3F
  // ExperimentConfig1: singleTouch(7) | tcxo(4) | unmodelled lowBattStop(0)
  b[218] = (1 << 7) | (1 << 4) | 1; // 0x91
  b[219] = 60; // SD BT interval
  b[220] = 0x01; // estimated exp length MSB
  b[221] = 0x02; // estimated exp length LSB
  b[222] = 0x03; // max exp length MSB
  b[223] = 0x04; // max exp length LSB
  for (let i = 0; i < 6; i++) b[224 + i] = 0x11 * (i + 1); // MAC
  b[230] = 0x01; // config-delay flag
  b[231] = 0x77; // BT factory reset — unmodelled
  for (let i = 232; i <= 255; i++) b[i] = 0x5a; // FW unusedIdx232..255

  // ---- InfoMem B: 3 sync nodes then 0xFF padding to slot 21.
  for (let i = 0; i < 6; i++) b[256 + i] = 0xa1 + i;
  for (let i = 0; i < 6; i++) b[262 + i] = 0xb1 + i;
  for (let i = 0; i < 6; i++) b[268 + i] = 0xc1 + i;
  for (let i = 274; i <= 381; i++) b[i] = 0xff;
  b[382] = 0x5a; // FW unusedIdx382
  b[383] = 0x5a; // FW unusedIdx383

  return b;
}
