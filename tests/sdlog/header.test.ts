import { describe, it, expect } from 'vitest';
import {
  parseSdLogHeader,
  SdLogFormatError,
  SDLogHeaderBitmask as BM,
} from '../../src/devices/sdlog/index.js';
import { getDefaultCalibration } from '../../src/devices/calibration/index.js';
import {
  decodeExgRegisters,
  detectExgPreset,
  EXG_PRESET_ARRAYS,
} from '../../src/devices/exg/index.js';
import { buildSdLogHeader } from './fixtures.js';

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SdLogFormatError);
    expect((e as SdLogFormatError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected SdLogFormatError(${code})`);
};

describe('parseSdLogHeader — modern Shimmer3 (256 B)', () => {
  const enabled = BM.ACCEL_LN | BM.GYRO | BM.MAG | BM.BATTERY | BM.GSR;

  it('parses the core identity and trial fields', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({
        hw: 3,
        fwId: 2,
        fwVersion: [0, 11, 5],
        samplingDivider: 512,
        enabledSensors: enabled,
        derivedSensors: 0x030201,
        mac: [0xd0, 0x2b, 0x46, 0x3d, 0xa2, 0xbb],
        trialId: 7,
        numShimmers: 3,
        syncWhenLogging: false,
        masterShimmer: true,
        buttonStart: true,
        gsrRange: 2,
        rtcDifferenceTicks: 55605813443136n,
        configTime: 1721224800,
        initialTimestampTicks: 0x0123456789,
      }),
    );

    expect(h.hardwareVersion).toBe(3);
    expect(h.firmwareId).toBe(2);
    expect(h.firmwareVersion).toEqual({ major: 0, minor: 11, internal: 5 });
    expect(h.samplingRateHz).toBe(64);
    expect(h.macAddress).toBe('d02b463da2bb');
    expect(h.enabledSensors).toBe(enabled);
    expect(h.derivedSensors).toBe(0x030201);
    expect(h.configTime).toBe(1721224800);
    expect(h.rtcDifferenceTicks).toBe(55605813443136n);
    expect(h.initialTimestampTicks).toBe(0x0123456789);
    expect(h.trial).toEqual({
      id: 7,
      numShimmers: 3,
      syncWhenLogging: false,
      masterShimmer: true,
      buttonStart: true,
    });
    expect(h.headerLengthBytes).toBe(256);
    expect(h.gsrRange).toBe(2);
    expect(h.expansionBoard).toBeNull(); // SDLog 0.11.5 < 0.12.4
  });

  it('orders channels per interpretdatapacketformat (old-IMU mag = X, Z, Y)', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({ fwVersion: [0, 11, 5], enabledSensors: enabled }),
    );
    expect(h.channels.map((c) => c.name)).toEqual([
      'LN_ACCEL_X',
      'LN_ACCEL_Y',
      'LN_ACCEL_Z',
      'BATTERY',
      'GSR',
      'GYRO_X',
      'GYRO_Y',
      'GYRO_Z',
      'MAG_X',
      'MAG_Z',
      'MAG_Y',
    ]);
    // ts(3) + LN accel(6) + battery(2) + GSR(2) + gyro(6) + mag(6)
    expect(h.timestampBytes).toBe(3);
    expect(h.packetSizeBytes).toBe(25);
    const gsr = h.channels.find((c) => c.name === 'GSR')!;
    expect(gsr.calibrated).toBe(true);
    expect(gsr.unit).toBe('uSiemens');
    const gyro = h.channels.find((c) => c.name === 'GYRO_X')!;
    expect(gyro.calibrated).toBe(false);
    expect(gyro.unit).toBeNull();
  });

  it('switches mag to X, Y, Z and BMP to BMP280 on new-IMU expansion boards', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({
        fwVersion: [0, 15, 1],
        enabledSensors: BM.MAG | BM.BMPX80,
        expansionBoard: [48, 3, 0], // GSR_UNIFIED rev >= 3
      }),
    );
    expect(h.expansionBoard).toEqual({ id: 48, rev: 3, revSpecial: 0 });
    expect(h.channels.map((c) => c.name)).toEqual([
      'MAG_X',
      'MAG_Y',
      'MAG_Z',
      'TEMPERATURE_BMP280',
      'PRESSURE_BMP280',
    ]);
    expect(h.calibrationBytes.pressure.length).toBe(24); // 22 + bytes 222-223
  });

  it('keeps BMP180 naming and 22-byte pressure calibration on old-IMU boards', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({
        fwVersion: [0, 15, 1],
        enabledSensors: BM.BMPX80,
        expansionBoard: [31, 4, 0], // SR31 rev < 6 → old IMU
      }),
    );
    expect(h.channels.map((c) => c.name)).toEqual(['TEMPERATURE_BMP180', 'PRESSURE_BMP180']);
    expect(h.calibrationBytes.pressure.length).toBe(22);
  });

  it('copies the raw calibration blocks verbatim', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({ enabledSensors: BM.ACCEL_LN, calibFill: (off) => (off * 7) & 0xff }),
    );
    expect(h.calibrationBytes.wrAccel.length).toBe(21);
    expect(h.calibrationBytes.wrAccel[0]).toBe((76 * 7) & 0xff);
    expect(h.calibrationBytes.gyro[0]).toBe((97 * 7) & 0xff);
    expect(h.calibrationBytes.mag[0]).toBe((118 * 7) & 0xff);
    expect(h.calibrationBytes.lnAccel[0]).toBe((139 * 7) & 0xff);
    expect(h.calibrationBytes.pressure[0]).toBe((160 * 7) & 0xff);
    expect(h.calibrationBytes.altAccel).toBeUndefined();
    expect(h.calibrationBytes.altMag).toBeUndefined();
  });

  it('extends derived sensors from bytes 217-221 on SDLog >= 0.13.1', () => {
    const derived = 0x030201 + 5 * 2 ** 24 + 6 * 2 ** 32;
    const older = parseSdLogHeader(
      buildSdLogHeader({
        fwVersion: [0, 12, 4],
        enabledSensors: BM.ACCEL_LN,
        derivedSensors: derived,
      }),
    );
    expect(older.derivedSensors).toBe(0x030201); // only 3 bytes read
    const newer = parseSdLogHeader(
      buildSdLogHeader({
        fwVersion: [0, 13, 1],
        enabledSensors: BM.ACCEL_LN,
        derivedSensors: derived,
      }),
    );
    expect(newer.derivedSensors).toBe(derived);
  });

  it('carries full derived-sensors fidelity above bit 52 in derivedSensorsBig', () => {
    const h = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 13, 1], // 8-byte derived sensors
      enabledSensors: BM.ACCEL_LN,
      derivedSensors: 0,
    });
    // Write an 8-byte derived-sensors value whose top bytes reach bit 63,
    // well beyond a JS number's 2^53 exact range.
    const lo = [0x01, 0x23, 0x45]; // bytes 40,41,42 → bits 0-23
    const hi = [0x67, 0x89, 0xab, 0xcd, 0xef]; // bytes 217-221 → bits 24-63
    h[40] = lo[0];
    h[41] = lo[1];
    h[42] = lo[2];
    for (let i = 0; i < 5; i++) h[217 + i] = hi[i];
    const parsed = parseSdLogHeader(h);
    const expected =
      BigInt(lo[0]) |
      (BigInt(lo[1]) << 8n) |
      (BigInt(lo[2]) << 16n) |
      (BigInt(hi[0]) << 24n) |
      (BigInt(hi[1]) << 32n) |
      (BigInt(hi[2]) << 40n) |
      (BigInt(hi[3]) << 48n) |
      (BigInt(hi[4]) << 56n);
    expect(parsed.derivedSensorsBig).toBe(expected);
    expect(parsed.derivedSensors).toBe(Number(expected));
    // The narrowed number lost low bits — proving derivedSensorsBig is needed.
    expect(BigInt(parsed.derivedSensors)).not.toBe(expected);
  });

  it('masks MPL sensor bits for LogAndStream and keeps them for SDLog', () => {
    const enabledWithMpl = BM.ACCEL_LN + BM.MPL_TEMPERATURE + BM.GYRO_MPU_MPL;
    const sdlog = parseSdLogHeader(
      buildSdLogHeader({ fwId: 2, fwVersion: [0, 13, 1], enabledSensors: enabledWithMpl }),
    );
    expect(sdlog.enabledSensors).toBe(enabledWithMpl);
    expect(sdlog.channels.map((c) => c.name)).toContain('GYRO_MPU_MPL_X');
    expect(sdlog.channels.map((c) => c.name)).toContain('MPL_TEMPERATURE');

    const las = parseSdLogHeader(
      buildSdLogHeader({ fwId: 3, fwVersion: [0, 8, 0], enabledSensors: enabledWithMpl }),
    );
    expect(las.enabledSensors).toBe(BM.ACCEL_LN); // MPL temp + >24-bit bits cleared
    expect(las.channels.map((c) => c.name)).toEqual(['LN_ACCEL_X', 'LN_ACCEL_Y', 'LN_ACCEL_Z']);
  });

  it('clears MPL channel bits when the DMP flag is set (SDLog)', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({
        fwId: 2,
        fwVersion: [0, 13, 1],
        enabledSensors: BM.ACCEL_LN + BM.MPL_TEMPERATURE + BM.GYRO_MPU_MPL,
        mpuDmp: true,
      }),
    );
    expect(h.enabledSensors).toBe(BM.ACCEL_LN);
  });

  it('selects u16 timestamps below the version-code-6 thresholds', () => {
    expect(
      parseSdLogHeader(buildSdLogHeader({ fwId: 2, fwVersion: [0, 9, 0], enabledSensors: BM.GSR }))
        .timestampBytes,
    ).toBe(2);
    expect(
      parseSdLogHeader(buildSdLogHeader({ fwId: 2, fwVersion: [0, 11, 5], enabledSensors: BM.GSR }))
        .timestampBytes,
    ).toBe(3);
    expect(
      parseSdLogHeader(buildSdLogHeader({ fwId: 3, fwVersion: [0, 5, 0], enabledSensors: BM.GSR }))
        .timestampBytes,
    ).toBe(2);
    expect(
      parseSdLogHeader(buildSdLogHeader({ fwId: 3, fwVersion: [0, 5, 4], enabledSensors: BM.GSR }))
        .timestampBytes,
    ).toBe(3);
  });

  it('follows the ladder for Shimmer3R: LogAndStream → u24, SDLog → u16', () => {
    const signalIds = [0x00, 0x01, 0x02];
    // 3R + LogAndStream >= 0.0.1 → version code 8 → 3-byte timestamp.
    expect(
      parseSdLogHeader(buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds }))
        .timestampBytes,
    ).toBe(3);
    // 3R + SDLog matches no rule in the ladder → code -1 → 2-byte timestamp
    // (ShimmerVerObject.java:270-273 only maps 3R+LogAndStream).
    expect(
      parseSdLogHeader(buildSdLogHeader({ hw: 10, fwId: 2, fwVersion: [0, 11, 5], signalIds }))
        .timestampBytes,
    ).toBe(2);
  });
});

describe('parseSdLogHeader — Shimmer3R (384 B)', () => {
  const signalIds = [0x00, 0x01, 0x02, 0x0a, 0x0b, 0x0c, 0x03, 0x14, 0x15, 0x16, 0x1a, 0x1b, 0x1c];

  it('reads the dynamic channel table at byte 314', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds }),
    );
    expect(h.hardwareVersion).toBe(10);
    expect(h.headerLengthBytes).toBe(384);
    expect(h.timestampBytes).toBe(3);
    expect(h.channels.map((c) => c.name)).toEqual([
      'LN_ACCEL_X',
      'LN_ACCEL_Y',
      'LN_ACCEL_Z',
      'GYRO_X',
      'GYRO_Y',
      'GYRO_Z',
      'BATTERY',
      'HG_ACCEL_X',
      'HG_ACCEL_Y',
      'HG_ACCEL_Z',
      'TEMPERATURE_BMP390',
      'PRESSURE_BMP390',
      'GSR',
    ]);
    // ts(3) + 6×i16(12) + battery i16(2) + 3×i12*>(6) + 2×u24(6) + GSR u16(2)
    expect(h.packetSizeBytes).toBe(3 + 12 + 2 + 6 + 6 + 2);
  });

  it('captures the alt-accel and alt-mag calibration blocks', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({
        hw: 10,
        fwId: 3,
        fwVersion: [0, 1, 0],
        signalIds: [0x00],
        calibFill: (o) => o & 0xff,
      }),
    );
    expect(h.calibrationBytes.altAccel?.length).toBe(21);
    expect(h.calibrationBytes.altAccel?.[0]).toBe(256 & 0xff);
    expect(h.calibrationBytes.altMag?.length).toBe(21);
    expect(h.calibrationBytes.altMag?.[0]).toBe(285 & 0xff);
    expect(h.calibrationBytes.pressure.length).toBe(24); // 3R always BMP280+-style
  });

  it('falls back to a u12 channel named after unknown signal IDs', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds: [0x00, 0x7f] }),
    );
    expect(h.channels[1].name).toBe('127');
    expect(h.channels[1].calibrated).toBe(false);
  });

  // Regression: the LSM6DSV gyro has 6 ranges (0-5); the MSB rides in config
  // setup byte 4 (header byte 12, bit 2). Reading only the 2-bit LSB collapsed
  // range 4→0 and 5→1, picking the wrong default sensitivity (229/114 dps).
  it('decodes the full 3-bit gyro range from config setup byte 4 (MSB)', () => {
    const r4 = parseSdLogHeader(
      buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds, gyroRange: 4 }),
    );
    expect(r4.imuRanges.gyro).toBe(4);
    // Range 4 (2000 dps) → default sensitivity diag(14). The 2-bit truncation bug
    // would have collapsed this to range 0 (diag(229)); prove they differ.
    const cal4 = getDefaultCalibration('shimmer3r', 'gyro', r4.imuRanges.gyro)!.calibration;
    expect(cal4).not.toEqual(getDefaultCalibration('shimmer3r', 'gyro', 0)!.calibration);
    expect(cal4).toEqual(getDefaultCalibration('shimmer3r', 'gyro', 4)!.calibration);

    const r5 = parseSdLogHeader(
      buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds, gyroRange: 5 }),
    );
    expect(r5.imuRanges.gyro).toBe(5);
    // Range 5 (4000 dps) → default sensitivity diag(7), not diag(114) for range 1.
    const cal5 = getDefaultCalibration('shimmer3r', 'gyro', r5.imuRanges.gyro)!.calibration;
    expect(cal5).not.toEqual(getDefaultCalibration('shimmer3r', 'gyro', 1)!.calibration);
    expect(cal5).toEqual(getDefaultCalibration('shimmer3r', 'gyro', 5)!.calibration);
  });
});

describe('parseSdLogHeader — rejection paths', () => {
  it('rejects legacy SDLog 0.5.x with LEGACY_UNSUPPORTED', () => {
    expectCode(
      () =>
        parseSdLogHeader(
          buildSdLogHeader({ fwId: 2, fwVersion: [0, 5, 43], enabledSensors: BM.GSR }),
        ),
      'LEGACY_UNSUPPORTED',
    );
  });

  it('rejects SDLog below 0.8.69 and LogAndStream below 0.5.0', () => {
    expectCode(
      () =>
        parseSdLogHeader(
          buildSdLogHeader({ fwId: 2, fwVersion: [0, 8, 68], enabledSensors: BM.GSR }),
        ),
      'LEGACY_UNSUPPORTED',
    );
    expectCode(
      () =>
        parseSdLogHeader(
          buildSdLogHeader({ fwId: 3, fwVersion: [0, 4, 9], enabledSensors: BM.GSR }),
        ),
      'LEGACY_UNSUPPORTED',
    );
  });

  it('rejects non-Shimmer3/3R hardware and GQ/StroKare firmware', () => {
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ hw: 4 })), 'UNSUPPORTED_DEVICE'); // SR30
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ hw: 2 })), 'UNSUPPORTED_DEVICE'); // Shimmer2R
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ fwId: 9 })), 'UNSUPPORTED_DEVICE'); // GQ_802154
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ fwId: 5 })), 'UNSUPPORTED_DEVICE'); // GQ_BLE
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ fwId: 15 })), 'UNSUPPORTED_DEVICE'); // StroKare
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ fwId: 1 })), 'UNSUPPORTED_DEVICE'); // BtStream
  });

  it('rejects buffers too small for the version fields or the header', () => {
    expectCode(() => parseSdLogHeader(new Uint8Array(39)), 'TOO_SMALL');
    expectCode(
      () => parseSdLogHeader(buildSdLogHeader({ enabledSensors: BM.GSR }).slice(0, 200)),
      'TOO_SMALL',
    );
    // A Shimmer3R header cut to 256 bytes is too small for the 384-byte layout.
    expectCode(
      () =>
        parseSdLogHeader(
          buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds: [0] }).slice(0, 256),
        ),
      'TOO_SMALL',
    );
  });

  it('rejects a zero sampling divider and an empty channel set', () => {
    expectCode(
      () => parseSdLogHeader(buildSdLogHeader({ samplingDivider: 0, enabledSensors: BM.GSR })),
      'BAD_HEADER',
    );
    expectCode(() => parseSdLogHeader(buildSdLogHeader({ enabledSensors: 0 })), 'BAD_HEADER');
    expectCode(
      () =>
        parseSdLogHeader(
          buildSdLogHeader({ hw: 10, fwId: 3, fwVersion: [0, 1, 0], signalIds: [] }),
        ),
      'BAD_HEADER',
    );
  });
});

describe('parseSdLogHeader — EXG register banks (ShimmerSDLog.java:252-253/322-323)', () => {
  it('extracts exg1/exg2 from bytes 56-65 / 66-75 and they decode to a preset', () => {
    const ecg1 = [...EXG_PRESET_ARRAYS.ecg.exg1];
    const ecg2 = [...EXG_PRESET_ARRAYS.ecg.exg2];
    const h = parseSdLogHeader(
      buildSdLogHeader({
        enabledSensors: BM.ACCEL_LN | BM.GSR,
        exg1: ecg1,
        exg2: ecg2,
      }),
    );
    expect([...h.exg1]).toEqual(ecg1);
    expect([...h.exg2]).toEqual(ecg2);
    expect(detectExgPreset(h.exg1, h.exg2)).toBe('ecg');
    expect(decodeExgRegisters(h.exg1).ch1.gain.gain).toBe(4);
  });

  it('yields all-zero banks on a non-EXG header', () => {
    const h = parseSdLogHeader(buildSdLogHeader({ enabledSensors: BM.ACCEL_LN | BM.GSR }));
    expect([...h.exg1]).toEqual(new Array(10).fill(0));
    expect([...h.exg2]).toEqual(new Array(10).fill(0));
  });

  it('extracts EXG banks from a Shimmer3R (384 B) header at the same offsets', () => {
    const h = parseSdLogHeader(
      buildSdLogHeader({
        hw: 10,
        fwId: 3,
        fwVersion: [0, 1, 0],
        signalIds: [0x1d],
        exg1: [...EXG_PRESET_ARRAYS['test-signal'].exg1],
        exg2: [...EXG_PRESET_ARRAYS['test-signal'].exg2],
      }),
    );
    expect(detectExgPreset(h.exg1, h.exg2)).toBe('test-signal');
  });
});
