import { describe, it, expect } from 'vitest';
import {
  parseInfoMem,
  generateInfoMem,
  resolveInfoMemLayout,
  INFOMEM_SIZE,
} from '../../src/devices/infomem/index.js';
import { CTX, blankInfoMem, setSamplingDivider, setName, setBE32 } from './fixtures.js';

/**
 * Hand-build a valid modern-Shimmer3 InfoMem at explicit offsets (independent
 * of the resolver) so parse offsets are pinned, then assert the decode.
 * Modern flat layout: sampling@0-1, sensors@3-5, cfg3@9, exg1@10, exg2@20,
 * baud@30, derived0-2@31-33, name@187, trial@199, configTime@211-214(BE),
 * trialId@215, numShimmers@216, expCfg0@217, expCfg1@218, mac@224-229.
 */
function buildModern(): Uint8Array {
  const b = blankInfoMem();
  setSamplingDivider(b, 64); // 32768/64 = 512 Hz
  b[2] = 1; // buffer size
  b[3] = 0xe0; // sensors0
  b[4] = 0x20; // sensors1
  b[5] = 0x01; // sensors2  → enabledSensors = 0x0120E0
  // cfg3: GSR range 2 (bits1-3), expPower on (bit0) → (2<<1)|1 = 0x05
  b[9] = 0x05;
  for (let i = 0; i < 10; i++) b[10 + i] = 0xa0 + i; // exg1
  for (let i = 0; i < 10; i++) b[20 + i] = 0xb0 + i; // exg2
  b[30] = 0x09; // baud
  b[31] = 0x07; // derived0
  b[32] = 0x00; // derived1
  b[33] = 0x00; // derived2  → derived = 0x07
  setName(b, 187, 'Shimmer_AB'); // device name
  setName(b, 199, 'MyTrial'); // trial name
  setBE32(b, 211, 0x51e2_a3c0); // config time
  b[215] = 0x04; // trial id
  b[216] = 0x03; // num shimmers
  // expCfg0: buttonStart(5), sync(2), master(1) → 0b0010_0110 = 0x26
  b[217] = (1 << 5) | (1 << 2) | (1 << 1);
  // expCfg1: singleTouch(7), tcxo(4) → 0b1001_0000 = 0x90
  b[218] = (1 << 7) | (1 << 4);
  // MAC 224-229
  const mac = [0x00, 0x06, 0x66, 0x12, 0x34, 0x56];
  mac.forEach((m, i) => (b[224 + i] = m));
  return b;
}

describe('parseInfoMem — modern Shimmer3', () => {
  const cfg = parseInfoMem(buildModern(), CTX.modernShimmer3);

  it('flags valid and decodes scalar fields', () => {
    expect(cfg.valid).toBe(true);
    expect(cfg.samplingRateHz).toBeCloseTo(512, 6);
    expect(cfg.enabledSensors).toBe(0x0120e0);
    expect(cfg.derivedSensors).toBe(0x07n);
    expect(cfg.gsrRange).toBe(2);
    expect(cfg.expPowerEnabled).toBe(true);
    expect(cfg.btBaudRate).toBe(0x09);
    expect(cfg.configTime).toBe(0x51e2a3c0);
  });

  it('decodes names, mac and EXG banks', () => {
    expect(cfg.deviceName).toBe('Shimmer_AB');
    expect(cfg.trialName).toBe('MyTrial');
    expect(cfg.macAddress).toBe('000666123456');
    expect([...cfg.exg1]).toEqual([0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9]);
    expect([...cfg.exg2]).toEqual([0xb0, 0xb1, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9]);
    expect(cfg.exg1.length).toBe(10);
  });

  it('decodes the trial/experiment bit-fields', () => {
    expect(cfg.trial).toMatchObject({
      id: 4,
      numShimmers: 3,
      buttonStart: true,
      syncWhenLogging: true,
      masterShimmer: true,
      singleTouch: true,
      tcxo: true,
      disableBluetooth: false,
    });
  });
});

describe('parseInfoMem — relocated-offsets variant (SDLog 0.8.68, legacy addressing)', () => {
  it('reads derived sensors from the relocated offset 31', () => {
    const l = resolveInfoMemLayout(CTX.relocatedSdlog);
    expect(l.idxDerivedSensors0).toBe(31);
    const b = blankInfoMem();
    setSamplingDivider(b, 1024);
    b[l.idxDerivedSensors0] = 0x03;
    b[l.idxDerivedSensors1] = 0x00;
    b[l.idxDerivedSensors2] = 0x00;
    const cfg = parseInfoMem(b, CTX.relocatedSdlog);
    expect(cfg.valid).toBe(true);
    expect(cfg.derivedSensors).toBe(0x03n);
    // 8-byte derived unsupported here → high derived bytes ignored even if set.
    b[118] = 0xff;
    expect(parseInfoMem(b, CTX.relocatedSdlog).derivedSensors).toBe(0x03n);
  });
});

describe('parseInfoMem — Shimmer3R', () => {
  it('reads 8-byte derived sensors as a full 64-bit bigint', () => {
    const l = resolveInfoMemLayout(CTX.shimmer3R);
    const b = blankInfoMem();
    setSamplingDivider(b, 32);
    // derived0-2 @ 31-33, derived3-7 @ 118-122.
    b[31] = 0x01;
    b[32] = 0x02;
    b[33] = 0x04;
    b[118] = 0x08;
    b[122] = 0x80; // byte 7 → bit 63
    const cfg = parseInfoMem(b, CTX.shimmer3R);
    expect(l.idxDerivedSensors7).toBe(122);
    expect(cfg.derivedSensors).toBe(
      0x01n | (0x02n << 8n) | (0x04n << 16n) | (0x08n << 24n) | (0x80n << 56n),
    );
  });
});

describe('parseInfoMem — invalid / unconfigured', () => {
  it('returns valid=false with neutral defaults when first 6 bytes are 0xFF', () => {
    const b = new Uint8Array(INFOMEM_SIZE).fill(0xff);
    const cfg = parseInfoMem(b, CTX.modernShimmer3);
    expect(cfg.valid).toBe(false);
    expect(cfg.samplingRateHz).toBe(0);
    expect(cfg.enabledSensors).toBe(0);
    expect(cfg.deviceName).toBe('');
    expect(cfg.raw.length).toBe(INFOMEM_SIZE);
  });
});

describe('parseInfoMem — name ASCII edge cases', () => {
  it('reads a full 12-byte name with no terminator', () => {
    const b = buildModern();
    setName(b, 187, 'ABCDEFGHIJKL', 0x41); // exactly 12 printable, pad also printable
    expect(parseInfoMem(b, CTX.modernShimmer3).deviceName).toBe('ABCDEFGHIJKL');
  });
  it('stops at the first non-printable byte (0xFF pad)', () => {
    const b = buildModern();
    setName(b, 187, 'AB', 0xff);
    expect(parseInfoMem(b, CTX.modernShimmer3).deviceName).toBe('AB');
  });
  it('stops at an embedded 0x00', () => {
    const b = buildModern();
    setName(b, 187, 'AB');
    b[187 + 2] = 0x00;
    expect(parseInfoMem(b, CTX.modernShimmer3).deviceName).toBe('AB');
  });
});

describe('parseInfoMem — round-trip parse(generate(parse(x))) == parse(x)', () => {
  const compareFields = (a: ReturnType<typeof parseInfoMem>) => ({
    samplingRateHz: a.samplingRateHz,
    enabledSensors: a.enabledSensors,
    derivedSensors: a.derivedSensors,
    gsrRange: a.gsrRange,
    expPowerEnabled: a.expPowerEnabled,
    deviceName: a.deviceName,
    trialName: a.trialName,
    configTime: a.configTime,
    trial: a.trial,
    btBaudRate: a.btBaudRate,
    exg1: [...a.exg1],
    exg2: [...a.exg2],
  });

  for (const [name, ctx] of Object.entries(CTX)) {
    it(`holds for ${name}`, () => {
      const first = parseInfoMem(buildModern(), ctx);
      // Regenerate WITHOUT device-write finalization so MAC is preserved.
      const regen = generateInfoMem(first, ctx, { base: first.raw });
      const second = parseInfoMem(regen, ctx);
      expect(compareFields(second)).toEqual(compareFields(first));
      expect(second.macAddress).toBe(first.macAddress);
    });
  }
});
