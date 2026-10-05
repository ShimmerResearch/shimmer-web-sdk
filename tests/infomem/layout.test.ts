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

describe('resolveInfoMemLayout — config-setup byte indices', () => {
  it('modern Shimmer3 puts ConfigSetupByte4/5/6 at 130/131/132 (branch 1 swap with Sensors3/4)', () => {
    const l = resolveInfoMemLayout(CTX.modernShimmer3);
    // ConfigByteLayoutShimmer3.java:336-341; FW NV_CONFIG_SETUP_BYTE4/5/6.
    expect(l.idxSensors3).toBe(128);
    expect(l.idxSensors4).toBe(129);
    expect(l.idxConfigSetupByte4).toBe(130);
    expect(l.idxConfigSetupByte5).toBe(131);
    expect(l.idxConfigSetupByte6).toBe(132);
  });

  it('Shimmer3R puts ConfigSetupByte4/5/6 at 130/131/132', () => {
    const l = resolveInfoMemLayout(CTX.shimmer3R);
    expect(l.idxConfigSetupByte4).toBe(130);
    expect(l.idxConfigSetupByte5).toBe(131);
    expect(l.idxConfigSetupByte6).toBe(132);
  });

  it('ConfigSetupByte1/2 are the fixed InfoMem D bytes 7/8', () => {
    for (const ctx of [CTX.modernShimmer3, CTX.shimmer3R, CTX.relocatedSdlog]) {
      const l = resolveInfoMemLayout(ctx);
      expect(l.idxConfigSetupByte1).toBe(7);
      expect(l.idxConfigSetupByte2).toBe(8);
    }
  });

  it('pre-branch-1 firmware keeps the default ConfigSetupByte4/5 BELOW Sensors3/4', () => {
    // BtStream 0.5.0 trips none of the remap branches.
    const l = resolveInfoMemLayout({
      hardwareVersion: 3,
      firmwareId: FW_ID.BTSTREAM,
      firmwareVersion: { major: 0, minor: 5, internal: 0 },
    });
    expect(l.idxConfigSetupByte4).toBe(128);
    expect(l.idxConfigSetupByte5).toBe(129);
    expect(l.idxSensors3).toBe(130);
    expect(l.idxSensors4).toBe(131);
  });
});

describe('resolveInfoMemLayout — kinematic calibration block indices', () => {
  it('branch 2 remaps all six blocks to the firmware NV_* positions (Shimmer3)', () => {
    const l = resolveInfoMemLayout(CTX.modernShimmer3);
    expect(l.idxAnalogAccelCalibration).toBe(34); // NV_LN_ACCEL_CALIBRATION
    expect(l.idxMPU9150GyroCalibration).toBe(55); // NV_GYRO_CALIBRATION
    expect(l.idxLSM303DLHCMagCalibration).toBe(76); // NV_MAG_CALIBRATION
    expect(l.idxLSM303DLHCAccelCalibration).toBe(97); // NV_WR_ACCEL_CALIBRATION
    expect(l.idxADXL371AltAccelCalibration).toBe(133); // NV_ALT_ACCEL_CALIBRATION 128+5
    expect(l.idxLIS3MDLAltMagCalibration).toBe(154); // NV_ALT_MAG_CALIBRATION 128+26
    expect(l.lengthGeneralCalibrationBytes).toBe(21);
  });

  it('Shimmer3R resolves the same calibration positions', () => {
    const l = resolveInfoMemLayout(CTX.shimmer3R);
    expect([
      l.idxAnalogAccelCalibration,
      l.idxMPU9150GyroCalibration,
      l.idxLSM303DLHCMagCalibration,
      l.idxLSM303DLHCAccelCalibration,
      l.idxADXL371AltAccelCalibration,
      l.idxLIS3MDLAltMagCalibration,
    ]).toEqual([34, 55, 76, 97, 133, 154]);
    expect(l.isShimmer3R).toBe(true);
  });

  it('pre-branch-2 firmware keeps the un-remapped defaults', () => {
    const l = resolveInfoMemLayout({
      hardwareVersion: 3,
      firmwareId: FW_ID.BTSTREAM,
      firmwareVersion: { major: 0, minor: 5, internal: 0 },
    });
    expect([
      l.idxAnalogAccelCalibration,
      l.idxMPU9150GyroCalibration,
      l.idxLSM303DLHCMagCalibration,
      l.idxLSM303DLHCAccelCalibration,
    ]).toEqual([31, 52, 73, 94]);
    expect(l.isShimmer3R).toBe(false);
  });
});

describe('resolveInfoMemLayout — SD config-time and trial byte indices', () => {
  it('config-time bytes 0-3 are consecutive at 211-214', () => {
    const l = resolveInfoMemLayout(CTX.modernShimmer3);
    expect([
      l.idxSDConfigTime0,
      l.idxSDConfigTime1,
      l.idxSDConfigTime2,
      l.idxSDConfigTime3,
    ]).toEqual([211, 212, 213, 214]);
  });

  it('SD interval / experiment-length indices match the firmware NV_* map', () => {
    for (const ctx of [CTX.modernShimmer3, CTX.shimmer3R]) {
      const l = resolveInfoMemLayout(ctx);
      expect(l.idxSDBTInterval).toBe(128 + 91); // NV_SD_BT_INTERVAL = 219
      expect(l.idxEstimatedExpLengthMsb).toBe(128 + 92); // NV_EST_EXP_LEN_MSB = 220
      expect(l.idxEstimatedExpLengthLsb).toBe(128 + 93); // NV_EST_EXP_LEN_LSB = 221
      expect(l.idxMaxExpLengthMsb).toBe(128 + 94); // NV_MAX_EXP_LEN_MSB = 222
      expect(l.idxMaxExpLengthLsb).toBe(128 + 95); // NV_MAX_EXP_LEN_LSB = 223
    }
  });
});
