import { describe, it, expect } from 'vitest';
import {
  parseInfoMem,
  generateInfoMem,
  deviceWriteDivergentRanges,
  resolveInfoMemLayout,
  INFOMEM_SIZE,
} from '../../src/devices/infomem/index.js';
import { CTX } from './fixtures.js';

/** A minimal valid config for a given ctx (built by parsing a seeded array). */
function seedConfig(ctx = CTX.modernShimmer3) {
  const raw = new Uint8Array(INFOMEM_SIZE);
  raw[0] = 64; // sampling divider LSB → 512 Hz, also makes first 6 bytes non-0xFF
  const cfg = parseInfoMem(raw, ctx);
  return { ...cfg };
}

describe('generateInfoMem — device-write finalization', () => {
  it('forces the MAC to all-0xFF and sets the config-file-creation flag', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const cfg = seedConfig(ctx);
    cfg.macAddress = 'AABBCCDDEEFF';
    const bytes = generateInfoMem(cfg, ctx, { forDeviceWrite: true });

    for (let i = 0; i < 6; i++) expect(bytes[l.idxMacAddress + i]).toBe(0xff);
    // Config-file-write flag bit set (bit 0 of the config-delay byte).
    expect(bytes[l.idxSDConfigDelayFlag] & 0x01).toBe(0x01);
  });

  it('does NOT force MAC/flag when forDeviceWrite is false (storage form)', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const base = new Uint8Array(INFOMEM_SIZE);
    for (let i = 0; i < 6; i++) base[l.idxMacAddress + i] = 0x11 + i; // real MAC in base
    base[l.idxSDConfigDelayFlag] = 0x00;
    const cfg = seedConfig(ctx);
    const bytes = generateInfoMem(cfg, ctx, { base });
    // MAC preserved from base (not forced 0xFF).
    expect(bytes[l.idxMacAddress]).toBe(0x11);
    expect(bytes[l.idxSDConfigDelayFlag] & 0x01).toBe(0x00);
  });
});

describe('generateInfoMem — base preservation of unmodelled bytes', () => {
  it('preserves genuinely unmodelled regions (MPL calibration, reserved bytes) from the base', () => {
    const ctx = CTX.modernShimmer3;
    const base = new Uint8Array(INFOMEM_SIZE);
    // Fill unmodelled regions with a sentinel; also make first 6 bytes non-0xFF.
    base.fill(0x5a);
    base[0] = 0; // will be overwritten by sampling rate anyway
    // Parse the SAME base so every modelled field is an identity write.
    const cfg = { ...parseInfoMem(base, ctx), samplingRateHz: 256 };
    const bytes = generateInfoMem(cfg, ctx, { base });

    // MPL accel/mag calibration region (128+5 .. 128+46) — deliberately not
    // modelled (ConfigByteLayoutShimmer3.java:226-248), must survive verbatim.
    expect(bytes[133]).toBe(0x5a);
    expect(bytes[154]).toBe(0x5a);
    // MPL gyro calibration region == FW `unusedIdx175To186[12]`.
    expect(bytes[175]).toBe(0x5a);
    expect(bytes[186]).toBe(0x5a);
    // ConfigSetupByte6 (idx 132) is MPL-only / FW `unusedIdx132`.
    expect(bytes[132]).toBe(0x5a);
    // Reserved InfoMem D bytes 123-127 (FW `unusedIdx123`..`unusedIdx127`).
    for (let i = 123; i <= 127; i++) expect(bytes[i]).toBe(0x5a);
    // Sampling rate WAS written.
    const divider = (bytes[0] & 0xff) + ((bytes[1] & 0xff) << 8);
    expect(32768 / divider).toBeCloseTo(256, 6);
  });

  it('read-modify-writes ConfigSetupByte3, preserving its unmodelled bits', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const base = new Uint8Array(INFOMEM_SIZE);
    base[0] = 1; // valid
    // Alt-accel range = 0b11 (bits 6-7), pressure oversampling LSB = 0 (bits 4-5).
    base[l.idxConfigSetupByte3] = 0b1100_0000;
    const cfg = { ...parseInfoMem(base, ctx), gsrRange: 3, expPowerEnabled: true };
    const bytes = generateInfoMem(cfg, ctx, { base });
    // Alt-accel range preserved, GSR + expPower layered in:
    // 0b1100_0000 | (3<<1) | 1 = 0b1100_0111
    expect(bytes[l.idxConfigSetupByte3]).toBe(0b1100_0111);
  });

  it('leaves the Shimmer3R-only ConfigSetupByte4/5 bits alone on a Shimmer3 context', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const base = new Uint8Array(INFOMEM_SIZE);
    base[0] = 1;
    // On Shimmer3 these bytes hold MPU9150 DMP/MPL settings — never touched.
    base[l.idxConfigSetupByte4] = 0xa5;
    base[l.idxConfigSetupByte5] = 0x5a;
    const cfg = parseInfoMem(base, ctx);
    const bytes = generateInfoMem(cfg, ctx, { base });
    expect(bytes[l.idxConfigSetupByte4]).toBe(0xa5);
    expect(bytes[l.idxConfigSetupByte5]).toBe(0x5a);
  });
});

describe('generateInfoMem — name truncation / padding', () => {
  it('truncates a >12-char name to 12 bytes', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const cfg = seedConfig(ctx);
    cfg.deviceName = 'ThisNameIsWayTooLong';
    const bytes = generateInfoMem(cfg, ctx, { forDeviceWrite: false });
    const decoded = String.fromCharCode(
      ...bytes.subarray(l.idxSDShimmerName, l.idxSDShimmerName + 12),
    );
    expect(decoded).toBe('ThisNameIsWa'); // first 12 chars
  });

  it('pads a short name with 0xFF', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const cfg = seedConfig(ctx);
    cfg.deviceName = 'AB';
    const bytes = generateInfoMem(cfg, ctx, { forDeviceWrite: false });
    expect(bytes[l.idxSDShimmerName]).toBe(0x41);
    expect(bytes[l.idxSDShimmerName + 1]).toBe(0x42);
    for (let i = 2; i < 12; i++) expect(bytes[l.idxSDShimmerName + i]).toBe(0xff);
  });
});

describe('generateInfoMem — field encoding round-trip through parse', () => {
  it('encodes trial bit-fields, config time (BE) and derived (bigint) correctly', () => {
    const ctx = CTX.shimmer3R;
    const cfg = seedConfig(ctx);
    cfg.samplingRateHz = 128;
    cfg.enabledSensors = 0x0a0b0c;
    cfg.derivedSensors = 0x01020304050607n;
    cfg.gsrRange = 4;
    cfg.expPowerEnabled = true;
    cfg.deviceName = 'DevX';
    cfg.trialName = 'Trial9';
    cfg.configTime = 0x1234abcd;
    cfg.btBaudRate = 7;
    cfg.trial = {
      id: 9,
      numShimmers: 5,
      syncWhenLogging: true,
      masterShimmer: false,
      buttonStart: true,
      singleTouch: false,
      tcxo: true,
      disableBluetooth: true,
    };
    const bytes = generateInfoMem(cfg, ctx, { forDeviceWrite: false });
    const round = parseInfoMem(bytes, ctx);
    expect(round.samplingRateHz).toBeCloseTo(128, 6);
    expect(round.enabledSensors).toBe(0x0a0b0c);
    expect(round.derivedSensors).toBe(0x01020304050607n);
    expect(round.gsrRange).toBe(4);
    expect(round.expPowerEnabled).toBe(true);
    expect(round.deviceName).toBe('DevX');
    expect(round.trialName).toBe('Trial9');
    expect(round.configTime).toBe(0x1234abcd);
    expect(round.btBaudRate).toBe(7);
    expect(round.trial).toMatchObject(cfg.trial);
  });
});

describe('deviceWriteDivergentRanges', () => {
  it('reports the MAC (6 bytes) and config-delay (1 byte) ranges', () => {
    const ctx = CTX.modernShimmer3;
    const l = resolveInfoMemLayout(ctx);
    const r = deviceWriteDivergentRanges(ctx);
    expect(r.mac).toEqual({ start: l.idxMacAddress, length: 6 });
    expect(r.configDelayFlag).toEqual({ start: l.idxSDConfigDelayFlag, length: 1 });
  });
});
