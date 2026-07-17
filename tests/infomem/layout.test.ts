import { describe, it, expect } from 'vitest';
import {
  resolveInfoMemLayout,
  checkConfigBytesValid,
  fwCompare,
  isSupportedMpl,
  isSupportedSdLogSync,
  isSupportedEightByteDerivedSensors,
  INFOMEM_ADDR_LEGACY,
  INFOMEM_ADDR_FLAT,
  ANY_VERSION,
  FW_ID,
} from '../../src/devices/infomem/index.js';
import { CTX } from './fixtures.js';

describe('resolveInfoMemLayout — address base (branch 4)', () => {
  it('modern Shimmer3 (LogAndStream 0.16.11) uses flat 0-based addressing', () => {
    const l = resolveInfoMemLayout(CTX.modernShimmer3);
    expect(l.flatAddressing).toBe(true);
    expect([l.addrD, l.addrC, l.addrB]).toEqual([
      INFOMEM_ADDR_FLAT.D,
      INFOMEM_ADDR_FLAT.C,
      INFOMEM_ADDR_FLAT.B,
    ]);
  });

  it('SDLog 0.8.68 uses LEGACY MSP430 0x1800 addressing (below the 0.11.5 remap floor)', () => {
    const l = resolveInfoMemLayout(CTX.relocatedSdlog);
    expect(l.flatAddressing).toBe(false);
    expect([l.addrD, l.addrC, l.addrB]).toEqual([
      INFOMEM_ADDR_LEGACY.D, // 0x1800
      INFOMEM_ADDR_LEGACY.C, // 0x1880
      INFOMEM_ADDR_LEGACY.B, // 0x1900
    ]);
  });

  it('SDLog 0.11.5 flips to flat addressing exactly at the floor', () => {
    const l = resolveInfoMemLayout({
      hardwareVersion: 3,
      firmwareId: FW_ID.SDLOG,
      firmwareVersion: { major: 0, minor: 11, internal: 5 },
    });
    expect(l.flatAddressing).toBe(true);
    expect(l.addrD).toBe(0);
  });

  it('Shimmer3R always uses flat addressing regardless of firmware', () => {
    const l = resolveInfoMemLayout(CTX.shimmer3R);
    expect(l.flatAddressing).toBe(true);
    expect(l.addrD).toBe(0);
  });
});

describe('resolveInfoMemLayout — offset relocation branches', () => {
  it('SDLog 0.8.68 relocates DerivedSensors0-2 to 31-33 (branch 2), no 8-byte derived', () => {
    const l = resolveInfoMemLayout(CTX.relocatedSdlog);
    expect([l.idxDerivedSensors0, l.idxDerivedSensors1, l.idxDerivedSensors2]).toEqual([
      31, 32, 33,
    ]);
    // Sensors3/4 relocated to 128/129 by branch 1.
    expect([l.idxSensors3, l.idxSensors4]).toEqual([128, 129]);
    // 8-byte derived NOT supported at SDLog 0.8.68 → offsets stay 0.
    expect(l.idxDerivedSensors3).toBe(0);
    expect(l.supportsEightByteDerived).toBe(false);
    // BtFactoryReset only from LogAndStream 0.8.1 → absent here.
    expect(l.idxBtFactoryReset).toBe(0);
  });

  it('modern Shimmer3 (LogAndStream 0.16.11) has 8-byte derived at 118-122 and BtFactoryReset at 231', () => {
    const l = resolveInfoMemLayout(CTX.modernShimmer3);
    expect([l.idxDerivedSensors0, l.idxDerivedSensors1, l.idxDerivedSensors2]).toEqual([
      31, 32, 33,
    ]);
    expect([
      l.idxDerivedSensors3,
      l.idxDerivedSensors4,
      l.idxDerivedSensors5,
      l.idxDerivedSensors6,
      l.idxDerivedSensors7,
    ]).toEqual([118, 119, 120, 121, 122]);
    expect(l.idxBtFactoryReset).toBe(231);
  });

  it('fixed C-page offsets (name/trial/mac/config-time) match the oracle', () => {
    const l = resolveInfoMemLayout(CTX.modernShimmer3);
    expect(l.idxSDShimmerName).toBe(187);
    expect(l.idxSDEXPIDName).toBe(199);
    expect(l.idxSDConfigTime0).toBe(211);
    expect(l.idxSDMyTrialID).toBe(215);
    expect(l.idxSDNumOfShimmers).toBe(216);
    expect(l.idxSDExperimentConfig0).toBe(217);
    expect(l.idxSDExperimentConfig1).toBe(218);
    expect(l.idxSDBTInterval).toBe(219);
    expect(l.idxMacAddress).toBe(224);
    expect(l.idxSDConfigDelayFlag).toBe(230);
    expect(l.idxNode0).toBe(256);
  });
});

describe('feature predicates', () => {
  it('fwCompare respects FW id, >= threshold, and ANY_VERSION wildcard', () => {
    const ctx = CTX.relocatedSdlog; // SDLog 0.8.68
    expect(fwCompare(ctx, FW_ID.SDLOG, 0, 8, 68)).toBe(true); // exact (>=)
    expect(fwCompare(ctx, FW_ID.SDLOG, 0, 8, 69)).toBe(false); // below internal
    expect(fwCompare(ctx, FW_ID.LOGANDSTREAM, 0, 0, 0)).toBe(false); // wrong FW id
    expect(fwCompare(ctx, FW_ID.SDLOG, ANY_VERSION, ANY_VERSION, ANY_VERSION)).toBe(true);
  });

  it('isSupportedMpl is false for all supported/target devices', () => {
    expect(isSupportedMpl(CTX.modernShimmer3)).toBe(false);
    expect(isSupportedMpl(CTX.relocatedSdlog)).toBe(false);
    expect(isSupportedMpl(CTX.shimmer3R)).toBe(false);
    // Only Shimmer3 + SDLog in [0.7.0, 0.8.0) qualifies.
    expect(
      isSupportedMpl({
        hardwareVersion: 3,
        firmwareId: FW_ID.SDLOG,
        firmwareVersion: { major: 0, minor: 7, internal: 5 },
      }),
    ).toBe(true);
  });

  it('isSupportedSdLogSync: SDLog always, Shimmer3+LogAndStream only >=0.16.11', () => {
    expect(isSupportedSdLogSync(CTX.relocatedSdlog)).toBe(true); // SDLog
    expect(isSupportedSdLogSync(CTX.shimmer3R)).toBe(true); // 3R + LogAndStream
    expect(isSupportedSdLogSync(CTX.modernShimmer3)).toBe(true); // 3 + LAS 0.16.11
    expect(
      isSupportedSdLogSync({
        hardwareVersion: 3,
        firmwareId: FW_ID.LOGANDSTREAM,
        firmwareVersion: { major: 0, minor: 15, internal: 0 },
      }),
    ).toBe(false);
  });

  it('isSupportedEightByteDerivedSensors thresholds', () => {
    expect(isSupportedEightByteDerivedSensors(CTX.modernShimmer3)).toBe(true); // LAS 0.16.11 >= 0.7.1
    expect(isSupportedEightByteDerivedSensors(CTX.relocatedSdlog)).toBe(false); // SDLog 0.8.68 < 0.13.1
  });
});

describe('checkConfigBytesValid', () => {
  it('is false when the first 6 bytes are all 0xFF', () => {
    const b = new Uint8Array(384).fill(0xff);
    expect(checkConfigBytesValid(b)).toBe(false);
  });
  it('is true when any of the first 6 bytes differ from 0xFF', () => {
    const b = new Uint8Array(384).fill(0xff);
    b[5] = 0x00;
    expect(checkConfigBytesValid(b)).toBe(true);
  });
});
