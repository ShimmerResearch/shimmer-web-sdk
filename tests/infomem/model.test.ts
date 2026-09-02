import { describe, it, expect } from 'vitest';
import {
  parseInfoMem,
  generateInfoMem,
  resolveInfoMemLayout,
  INFOMEM_SIZE,
} from '../../src/devices/infomem/index.js';
import { CTX, fullFieldInfoMem } from './fixtures.js';

describe('InfoMem full-field round-trip identity', () => {
  it('Shimmer3 (LogAndStream 0.16.11): generate(parse(img)) === img', () => {
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, CTX.modernShimmer3);
    const out = generateInfoMem(cfg, CTX.modernShimmer3, { base: img });
    expect(Array.from(out)).toEqual(Array.from(img));
  });

  it('Shimmer3R (LogAndStream 1.0.40): generate(parse(img)) === img', () => {
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, CTX.shimmer3R);
    const out = generateInfoMem(cfg, CTX.shimmer3R, { base: img });
    expect(Array.from(out)).toEqual(Array.from(img));
  });

  it('round-trips with no explicit base (falls back to config.raw)', () => {
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, CTX.shimmer3R);
    expect(Array.from(generateInfoMem(cfg, CTX.shimmer3R))).toEqual(Array.from(img));
  });

  it('Shimmer3 parse ignores the Shimmer3R-only composite MSB bits', () => {
    const img = fullFieldInfoMem();
    // ConfigSetupByte4 has gyroRange MSB and pressure MSB set in the fixture.
    const s3 = parseInfoMem(img, CTX.modernShimmer3).imu;
    const s3r = parseInfoMem(img, CTX.shimmer3R).imu;
    expect(s3.gyroRange).toBe(1); // LSB pair only
    expect(s3r.gyroRange).toBe(5); // (1 << 2) | 1
    expect(s3.pressureOversampling).toBe(1);
    expect(s3r.pressureOversampling).toBe(5);
  });
});

describe('InfoMem golden bit positions — ConfigSetupByte0 (idx 6)', () => {
  const ctx = CTX.shimmer3R;
  const l = resolveInfoMemLayout(ctx);

  function writeOne(patch: Record<string, unknown>): Uint8Array {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1; // make the image "valid"
    const cfg = parseInfoMem(zero, ctx);
    return generateInfoMem({ ...cfg, imu: { ...cfg.imu, ...patch } }, ctx, { base: zero });
  }

  it('wrAccelRate → bits 4-7 (bitShiftLSM303DLHCAccelSamplingRate=4, mask 0x0F)', () => {
    expect(writeOne({ wrAccelRate: 9 })[l.idxConfigSetupByte0]).toBe(9 << 4);
  });

  it('wrAccelRange → bits 2-3 (bitShiftLSM303DLHCAccelRange=2, mask 0x03)', () => {
    expect(writeOne({ wrAccelRange: 3 })[l.idxConfigSetupByte0]).toBe(3 << 2);
  });

  it('wrAccelLpm → bit 1 (bitShiftLSM303DLHCAccelLPM=1)', () => {
    expect(writeOne({ wrAccelLpm: true })[l.idxConfigSetupByte0]).toBe(0b0000_0010);
  });

  it('wrAccelHrm → bit 0 (bitShiftLSM303DLHCAccelHRM=0)', () => {
    expect(writeOne({ wrAccelHrm: true })[l.idxConfigSetupByte0]).toBe(0b0000_0001);
  });

  it('leaves the firmware-only wrAccelLpModeMsb (ConfigSetupByte4 bit 1) untouched', () => {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    zero[l.idxConfigSetupByte4] = 0b0000_0010; // FW wrAccelLpModeMsb
    const cfg = parseInfoMem(zero, ctx);
    const out = generateInfoMem({ ...cfg, imu: { ...cfg.imu, wrAccelLpm: false } }, ctx, {
      base: zero,
    });
    expect(out[l.idxConfigSetupByte4] & 0b0000_0010).toBe(0b0000_0010);
  });
});

describe('InfoMem golden bit positions — ConfigSetupByte1/2/3', () => {
  const ctx = CTX.shimmer3R;
  const l = resolveInfoMemLayout(ctx);

  function writeOne(patch: Record<string, unknown>): Uint8Array {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    const cfg = parseInfoMem(zero, ctx);
    return generateInfoMem({ ...cfg, imu: { ...cfg.imu, ...patch } }, ctx, { base: zero });
  }

  it('imuRate → the whole of ConfigSetupByte1 (bitShiftMPU9150AccelGyroSamplingRate=0, mask 0xFF)', () => {
    expect(writeOne({ imuRate: 0xa5 })[l.idxConfigSetupByte1]).toBe(0xa5);
  });

  it('magRange → ConfigSetupByte2 bits 5-7 (bitShiftLSM303DLHCMagRange=5, mask 0x07)', () => {
    expect(writeOne({ magRange: 7 })[l.idxConfigSetupByte2]).toBe(7 << 5);
  });

  it('magRate → ConfigSetupByte2 bits 2-4 (bitShiftLSM303DLHCMagSamplingRate=2, mask 0x07)', () => {
    // NOT composite: bitShiftLIS2MDLMagRateMSB is commented out in
    // SensorLIS2MDL.java:581/602 and absent from the firmware struct.
    const out = writeOne({ magRate: 3 });
    expect(out[l.idxConfigSetupByte2]).toBe(3 << 2);
    expect(out[l.idxConfigSetupByte5]).toBe(0); // no MSB written into altMagRate's bits
  });

  it('gyroRange 5 on Shimmer3R → ConfigSetupByte2 bits 0-1 == 0b01 and ConfigSetupByte4 bit 2 set (SensorLSM6DSV.java:980/1017)', () => {
    const out = writeOne({ gyroRange: 5 }); // 5 = 0b101 → msb 1, lsb 0b01
    expect(out[l.idxConfigSetupByte2] & 0b0000_0011).toBe(0b01);
    expect(out[l.idxConfigSetupByte4] & 0b0000_0100).toBe(0b0000_0100);
  });

  it('gyroRange MSB is NOT written on a Shimmer3 context (those bits are MPL)', () => {
    const s3 = CTX.modernShimmer3;
    const l3 = resolveInfoMemLayout(s3);
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    const cfg = parseInfoMem(zero, s3);
    const out = generateInfoMem({ ...cfg, imu: { ...cfg.imu, gyroRange: 5 } }, s3, { base: zero });
    expect(out[l3.idxConfigSetupByte2] & 0b0000_0011).toBe(0b01);
    expect(out[l3.idxConfigSetupByte4]).toBe(0); // untouched
  });

  it('altAccelRange → ConfigSetupByte3 bits 6-7 (bitShiftMPU9150AccelRange=6, mask 0x03)', () => {
    expect(writeOne({ altAccelRange: 3 })[l.idxConfigSetupByte3]).toBe(3 << 6);
  });

  it('pressureOversampling 7 → ConfigSetupByte3 bits 4-5 == 0b11 and ConfigSetupByte4 bit 0 set (SensorBMP581.java:380)', () => {
    const out = writeOne({ pressureOversampling: 7 }); // 0b111 → msb 1, lsb 0b11
    expect((out[l.idxConfigSetupByte3] >> 4) & 0b11).toBe(0b11);
    expect(out[l.idxConfigSetupByte4] & 0b0000_0001).toBe(0b0000_0001);
  });
});

describe('InfoMem golden bit positions — Shimmer3R ConfigSetupByte4/5', () => {
  const ctx = CTX.shimmer3R;
  const l = resolveInfoMemLayout(ctx);

  function writeOne(patch: Record<string, unknown>): Uint8Array {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    const cfg = parseInfoMem(zero, ctx);
    return generateInfoMem({ ...cfg, imu: { ...cfg.imu, ...patch } }, ctx, { base: zero });
  }

  it('altAccelRate → ConfigSetupByte4 (idx 130) bits 6-7 (SensorADXL371.java:356)', () => {
    const out = writeOne({ altAccelRate: 3 });
    expect(out[l.idxConfigSetupByte4]).toBe(3 << 6);
    expect(l.idxConfigSetupByte4).toBe(130);
  });

  it('altMagRate → ConfigSetupByte5 (idx 131) bits 0-5, NOT byte 4 (SensorLIS3MDL.java:809; FW altMagRate)', () => {
    const out = writeOne({ altMagRate: 0x3a });
    expect(out[l.idxConfigSetupByte5]).toBe(0x3a);
    expect(out[l.idxConfigSetupByte4]).toBe(0); // the Java "//Config Byte4" comment is wrong
    expect(l.idxConfigSetupByte5).toBe(131);
  });

  it('altMagRate is masked to 6 bits, never spilling into bits 6-7', () => {
    expect(writeOne({ altMagRate: 0xff })[l.idxConfigSetupByte5]).toBe(0x3f);
  });

  it('ConfigSetupByte6 (idx 132) is never written — MPL-only / FW unusedIdx132', () => {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    zero[l.idxConfigSetupByte6] = 0xa5;
    const cfg = parseInfoMem(zero, ctx);
    const out = generateInfoMem(cfg, ctx, { base: zero });
    expect(out[l.idxConfigSetupByte6]).toBe(0xa5);
  });
});

describe('InfoMem sd group (interval / experiment lengths)', () => {
  const ctx = CTX.shimmer3R;
  const l = resolveInfoMemLayout(ctx);

  it('parses btInterval and the big-endian u16 experiment lengths', () => {
    const img = fullFieldInfoMem();
    const sd = parseInfoMem(img, ctx).sd;
    expect(sd.btInterval).toBe(60);
    expect(sd.estimatedExpLengthMin).toBe(0x0102);
    expect(sd.maxExpLengthMin).toBe(0x0304);
  });

  it('writes the experiment lengths MSB-first (ShimmerObject.java:5316-5319)', () => {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    const cfg = parseInfoMem(zero, ctx);
    const out = generateInfoMem(
      { ...cfg, sd: { btInterval: 0x2a, estimatedExpLengthMin: 0x1234, maxExpLengthMin: 0x5678 } },
      ctx,
      { base: zero },
    );
    expect(out[l.idxSDBTInterval]).toBe(0x2a);
    expect(out[l.idxEstimatedExpLengthMsb]).toBe(0x12);
    expect(out[l.idxEstimatedExpLengthLsb]).toBe(0x34);
    expect(out[l.idxMaxExpLengthMsb]).toBe(0x56);
    expect(out[l.idxMaxExpLengthLsb]).toBe(0x78);
  });

  it('is zeroed and not written on firmware without SD-log sync', () => {
    // BtStream 0.7.4: flat addressing but isSupportedSdLogSync() == false.
    const btstream = {
      hardwareVersion: 3,
      firmwareId: 1,
      firmwareVersion: { major: 0, minor: 7, internal: 4 },
    };
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, btstream);
    expect(cfg.sd).toEqual({ btInterval: 0, estimatedExpLengthMin: 0, maxExpLengthMin: 0 });
    const lb = resolveInfoMemLayout(btstream);
    const out = generateInfoMem(cfg, btstream, { base: img });
    expect(out[lb.idxSDBTInterval]).toBe(60); // preserved from base, not zeroed
  });
});

describe('InfoMem calibration blocks', () => {
  it('parses all six blocks verbatim on Shimmer3R', () => {
    const img = fullFieldInfoMem();
    const c = parseInfoMem(img, CTX.shimmer3R).calibration;
    expect(Array.from(c.lnAccel)).toEqual(Array.from(img.subarray(34, 55)));
    expect(Array.from(c.gyro)).toEqual(Array.from(img.subarray(55, 76)));
    expect(Array.from(c.mag)).toEqual(Array.from(img.subarray(76, 97)));
    expect(Array.from(c.wrAccel)).toEqual(Array.from(img.subarray(97, 118)));
    expect(Array.from(c.altAccel!)).toEqual(Array.from(img.subarray(133, 154)));
    expect(Array.from(c.altMag!)).toEqual(Array.from(img.subarray(154, 175)));
  });

  it('omits altAccel/altMag on Shimmer3 (those bytes are the MPL calib region)', () => {
    const c = parseInfoMem(fullFieldInfoMem(), CTX.modernShimmer3).calibration;
    expect(c.altAccel).toBeUndefined();
    expect(c.altMag).toBeUndefined();
  });

  it('stays byte-identical through a schema-style edit of an unrelated field', () => {
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, CTX.shimmer3R);
    const out = generateInfoMem({ ...cfg, deviceName: 'RENAMED' }, CTX.shimmer3R, { base: img });
    expect(Array.from(out.subarray(34, 118))).toEqual(Array.from(img.subarray(34, 118)));
    expect(Array.from(out.subarray(133, 175))).toEqual(Array.from(img.subarray(133, 175)));
  });

  it('writes a replaced 21-byte block through unchanged', () => {
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, CTX.shimmer3R);
    const replacement = new Uint8Array(21).fill(0x7e);
    const out = generateInfoMem(
      { ...cfg, calibration: { ...cfg.calibration, gyro: replacement } },
      CTX.shimmer3R,
      { base: img },
    );
    expect(Array.from(out.subarray(55, 76))).toEqual(Array.from(replacement));
    // Neighbouring blocks untouched.
    expect(Array.from(out.subarray(34, 55))).toEqual(Array.from(img.subarray(34, 55)));
    expect(Array.from(out.subarray(76, 97))).toEqual(Array.from(img.subarray(76, 97)));
  });
});

describe('InfoMem syncNodes', () => {
  const ctx = CTX.shimmer3R;
  const l = resolveInfoMemLayout(ctx);

  function generateWithNodes(nodes: string[]): Uint8Array {
    const zero = new Uint8Array(INFOMEM_SIZE);
    zero[0] = 1;
    const cfg = parseInfoMem(zero, ctx);
    return generateInfoMem({ ...cfg, syncNodes: nodes }, ctx, { base: zero });
  }

  it('parses the list, stopping at the first all-0xFF slot', () => {
    const nodes = parseInfoMem(fullFieldInfoMem(), ctx).syncNodes;
    expect(nodes).toEqual(['A1A2A3A4A5A6', 'B1B2B3B4B5B6', 'C1C2C3C4C5C6']);
  });

  it('an all-0xFF slot terminates the list even when later slots hold data', () => {
    const img = fullFieldInfoMem();
    // Slot 3 stays 0xFF; put a MAC in slot 4.
    for (let i = 0; i < 6; i++) img[l.idxNode0 + 4 * 6 + i] = 0xd1 + i;
    expect(parseInfoMem(img, ctx).syncNodes).toHaveLength(3);
  });

  it('round-trips 0 entries (whole region padded to 0xFF)', () => {
    const out = generateWithNodes([]);
    for (let i = 0; i < 21 * 6; i++) expect(out[l.idxNode0 + i]).toBe(0xff);
    expect(parseInfoMem(out, ctx).syncNodes).toEqual([]);
  });

  it('round-trips 1 entry and pads the rest with 0xFF', () => {
    const out = generateWithNodes(['0123456789AB']);
    expect(Array.from(out.subarray(l.idxNode0, l.idxNode0 + 6))).toEqual([
      0x01, 0x23, 0x45, 0x67, 0x89, 0xab,
    ]);
    for (let i = 6; i < 21 * 6; i++) expect(out[l.idxNode0 + i]).toBe(0xff);
    expect(parseInfoMem(out, ctx).syncNodes).toEqual(['0123456789AB']);
  });

  it('round-trips the full 21 entries with no padding left', () => {
    const nodes = Array.from({ length: 21 }, (_unused, i) =>
      Array.from({ length: 6 }, (_b, j) => (0x10 + i * 6 + j).toString(16).padStart(2, '0'))
        .join('')
        .toUpperCase(),
    );
    const out = generateWithNodes(nodes);
    expect(parseInfoMem(out, ctx).syncNodes).toEqual(nodes);
    // Region is exactly filled: byte 382 (FW unusedIdx382) is beyond it.
    expect(l.idxNode0 + 21 * 6).toBe(382);
  });

  it('is not read or written on firmware without SD-log sync', () => {
    const btstream = {
      hardwareVersion: 3,
      firmwareId: 1,
      firmwareVersion: { major: 0, minor: 7, internal: 4 },
    };
    const img = fullFieldInfoMem();
    const cfg = parseInfoMem(img, btstream);
    expect(cfg.syncNodes).toEqual([]);
    const out = generateInfoMem(cfg, btstream, { base: img });
    expect(Array.from(out.subarray(256, 274))).toEqual(Array.from(img.subarray(256, 274)));
  });
});

describe('InfoMem unmodelled-byte preservation on a single-field change', () => {
  it('changing one IMU field touches exactly one byte', () => {
    const img = fullFieldInfoMem();
    const ctx = CTX.shimmer3R;
    const cfg = parseInfoMem(img, ctx);
    const out = generateInfoMem({ ...cfg, imu: { ...cfg.imu, wrAccelRate: 4 } }, ctx, {
      base: img,
    });
    const diffs: number[] = [];
    for (let i = 0; i < INFOMEM_SIZE; i++) if (out[i] !== img[i]) diffs.push(i);
    expect(diffs).toEqual([resolveInfoMemLayout(ctx).idxConfigSetupByte0]);
  });

  it('changing the device name touches only its 12 name bytes', () => {
    const img = fullFieldInfoMem();
    const ctx = CTX.shimmer3R;
    const cfg = parseInfoMem(img, ctx);
    const out = generateInfoMem({ ...cfg, deviceName: 'AB' }, ctx, { base: img });
    const diffs: number[] = [];
    for (let i = 0; i < INFOMEM_SIZE; i++) if (out[i] !== img[i]) diffs.push(i);
    const start = resolveInfoMemLayout(ctx).idxSDShimmerName;
    // 'SHIM3R' → 'AB': bytes 2-5 change to 0xFF, byte 0/1 change letters.
    expect(diffs.every((d) => d >= start && d < start + 12)).toBe(true);
    expect(diffs.length).toBeGreaterThan(0);
  });
});
