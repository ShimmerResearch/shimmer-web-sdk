import { describe, it, expect } from 'vitest';
import {
  lsm6dsvAccelGyroRateHz,
  samplingRateHzFromDivider,
  checkImuRateCoversPacketRate,
  lis2dw12AccelRateHz,
  checkWrAccelRateCoversPacketRate,
} from '../../src/devices/infomem/rateCoverage.js';
import { deriveLis2dw12ConfigOnEnableChange } from '../../src/devices/infomem/deriveRates.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';

const IMU = SensorBitmapShimmer3.SENSOR_A_ACCEL | SensorBitmapShimmer3.SENSOR_GYRO;

// Codes are the values stored in ConfigSetupByte1.
const ODR_POWER_DOWN = 0;
const ODR_1_875 = 1;
const ODR_60 = 5;
const ODR_120 = 6;

describe('LSM6DSV rate lookup', () => {
  it('reads Hz out of the option table rather than a second copy of it', () => {
    expect(lsm6dsvAccelGyroRateHz(ODR_1_875)).toBe(1.875);
    expect(lsm6dsvAccelGyroRateHz(ODR_60)).toBe(60);
    expect(lsm6dsvAccelGyroRateHz(ODR_120)).toBe(120);
  });

  it('has no rate for power-down or an unknown code', () => {
    expect(lsm6dsvAccelGyroRateHz(ODR_POWER_DOWN)).toBeNull();
    expect(lsm6dsvAccelGyroRateHz(99)).toBeNull();
  });

  it('converts the stored divider to Hz', () => {
    expect(samplingRateHzFromDivider(640)).toBeCloseTo(51.2, 6);
    expect(samplingRateHzFromDivider(320)).toBeCloseTo(102.4, 6);
    expect(samplingRateHzFromDivider(0)).toBeNull();
  });
});

describe('IMU rate covers the packet rate', () => {
  it('accepts the firmware default pair', () => {
    // shimmer_config.c:183-184 pairs 51.2 Hz with "next highest", 60 Hz.
    const r = checkImuRateCoversPacketRate({
      samplingRateDivider: 640,
      imuRateCode: ODR_60,
      enabledSensors: IMU,
    });
    expect(r.short).toBe(false);
    expect(r.problem).toBeNull();
  });

  it('flags the configuration seen on the bench: 102.4 Hz packets, 1.875 Hz ODR', () => {
    // The real fault. Timestamps were regular, loss was 0% and every CRC was
    // valid, and the signal was still a staircase.
    const r = checkImuRateCoversPacketRate({
      samplingRateDivider: 320,
      imuRateCode: ODR_1_875,
      enabledSensors: IMU,
    });
    expect(r.short).toBe(true);
    expect(r.imuRateHz).toBe(1.875);
    expect(r.packetRateHz).toBeCloseTo(102.4, 6);
    expect(r.repeatsPerSample).toBeCloseTo(102.4 / 1.875, 4);
    expect(r.problem).toMatch(/staircase/);
    expect(r.problem).toMatch(/1\.875 Hz/);
  });

  it('flags the pair that is only slightly inverted', () => {
    // 102.4 Hz packets against the 60 Hz default ODR - what you get by raising
    // the sampling rate and leaving the ODR alone. Less obvious, same defect.
    const r = checkImuRateCoversPacketRate({
      samplingRateDivider: 320,
      imuRateCode: ODR_60,
      enabledSensors: IMU,
    });
    expect(r.short).toBe(true);
    expect(r.repeatsPerSample).toBeCloseTo(102.4 / 60, 4);
  });

  it('flags a powered-down IMU while its channels are enabled', () => {
    const r = checkImuRateCoversPacketRate({
      samplingRateDivider: 640,
      imuRateCode: ODR_POWER_DOWN,
      enabledSensors: IMU,
    });
    expect(r.short).toBe(true);
    expect(r.problem).toMatch(/power-down/i);
  });

  it('says nothing when neither accel nor gyro is enabled', () => {
    // The ODR is irrelevant to a stream that carries neither, and a warning
    // about a sensor the user has not enabled is worse than none.
    const r = checkImuRateCoversPacketRate({
      samplingRateDivider: 320,
      imuRateCode: ODR_1_875,
      enabledSensors: SensorBitmapShimmer3.SENSOR_GSR,
    });
    expect(r.short).toBe(false);
    expect(r.problem).toBeNull();
  });

  it('fires when only one of the pair is enabled', () => {
    for (const bit of [SensorBitmapShimmer3.SENSOR_A_ACCEL, SensorBitmapShimmer3.SENSOR_GYRO]) {
      const r = checkImuRateCoversPacketRate({
        samplingRateDivider: 320,
        imuRateCode: ODR_1_875,
        enabledSensors: bit,
      });
      expect(r.short).toBe(true);
    }
  });

  it('says nothing when the divider is unusable', () => {
    const r = checkImuRateCoversPacketRate({
      samplingRateDivider: 0,
      imuRateCode: ODR_1_875,
      enabledSensors: IMU,
    });
    expect(r.problem).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// LIS2DW12 (Shimmer3R wide-range accelerometer)
// ---------------------------------------------------------------------------

const WR = SensorBitmapShimmer3.SENSOR_D_ACCEL;

/** ConfigSetupByte0 unpacked the way the check takes it. */
function fromByte0(byte0: number) {
  return { wrAccelRateCode: byte0 >> 4, highPerformance: (byte0 & 0x01) !== 0 };
}

/** Divider for a packet rate: 32768 / divider = Hz. */
const DIV_256 = 128;
const DIV_204_8 = 160;
const DIV_128 = 256;
const DIV_51_2 = 640;

describe('LIS2DW12 rate lookup', () => {
  it('reads the high-performance list when bit 0 is set', () => {
    expect(lis2dw12AccelRateHz(1, true)).toBe(12.5);
    expect(lis2dw12AccelRateHz(6, true)).toBe(200);
    expect(lis2dw12AccelRateHz(7, true)).toBe(400);
    expect(lis2dw12AccelRateHz(9, true)).toBe(1600);
  });

  it('reads the low-power list when bit 0 is clear: 1.6 Hz at code 1, 200 Hz at the top', () => {
    expect(lis2dw12AccelRateHz(1, false)).toBe(1.6);
    expect(lis2dw12AccelRateHz(6, false)).toBe(200);
    for (const code of [7, 8, 9]) expect(lis2dw12AccelRateHz(code, false)).toBe(200);
  });

  it('has no rate for power-down or an unknown code', () => {
    expect(lis2dw12AccelRateHz(0, true)).toBeNull();
    expect(lis2dw12AccelRateHz(0, false)).toBeNull();
    expect(lis2dw12AccelRateHz(15, true)).toBeNull();
  });
});

describe('wide-range accel covers the packet rate', () => {
  it("flags the colleague's unit: 0x62 at 256 Hz, low-power, about 1 packet in 5 unfilled", () => {
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_256,
      ...fromByte0(0x62),
      enabledSensors: WR,
    });
    expect(r.lowPower).toBe(true);
    expect(r.lowPowerTooSlow).toBe(true);
    expect(r.short).toBe(true);
    expect(r.wrAccelRateHz).toBe(200);
    // 1 - 200/256. The bench measured 21.2% (the part's ceiling is ~201.7 Hz).
    expect(r.unfilledFraction).toBeCloseTo(0.21875, 5);
    expect(r.problem).toMatch(/low-power mode/);
    expect(r.problem).toMatch(/High-Performance Mode/);
    expect(r.problem).toMatch(/22%/);
  });

  it('flags low-power above 200 Hz whatever bit 1 and the rate code say', () => {
    // Bit 0 alone decides the mode: 0x60 is low-power mode 1, 0x72 a code the
    // part saturates at 200 Hz in any low-power mode.
    for (const byte0 of [0x60, 0x62, 0x70, 0x72, 0x92, 0x02 | (6 << 4)]) {
      const r = checkWrAccelRateCoversPacketRate({
        samplingRateDivider: DIV_204_8,
        ...fromByte0(byte0),
        enabledSensors: WR,
      });
      expect(r.lowPowerTooSlow, byte0.toString(16)).toBe(true);
    }
  });

  it("accepts Consensys's fix for the same unit: 0x71 at 256 Hz", () => {
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_256,
      ...fromByte0(0x71),
      enabledSensors: WR,
    });
    expect(r.short).toBe(false);
    expect(r.lowPowerTooSlow).toBe(false);
    expect(r.wrAccelRateHz).toBe(400);
    expect(r.problem).toBeNull();
  });

  it('accepts low-power at or below 200 Hz when the rate keeps up', () => {
    // The 128 Hz bench run with 0x62 had no unfilled slots.
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_128,
      ...fromByte0(0x62),
      enabledSensors: WR,
    });
    expect(r.lowPower).toBe(true);
    expect(r.lowPowerTooSlow).toBe(false);
    expect(r.problem).toBeNull();
  });

  it('flags a low-power rate below the packet rate, but not as the 200 Hz ceiling', () => {
    // Java's low-power rate, code 1, is 1.6 Hz in a low-power mode.
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_51_2,
      wrAccelRateCode: 1,
      highPerformance: false,
      enabledSensors: WR,
    });
    expect(r.short).toBe(true);
    expect(r.lowPowerTooSlow).toBe(false);
    expect(r.wrAccelRateHz).toBe(1.6);
    expect(r.problem).toMatch(/WR Accel Rate/);
  });

  it('flags a high-performance rate below the packet rate', () => {
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_256,
      ...fromByte0(0x61), // 200 Hz, high performance
      enabledSensors: WR,
    });
    expect(r.short).toBe(true);
    expect(r.lowPowerTooSlow).toBe(false);
    expect(r.unfilledFraction).toBeCloseTo(0.21875, 5);
  });

  it('flags power-down while enabled', () => {
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_51_2,
      ...fromByte0(0x01),
      enabledSensors: WR,
    });
    expect(r.short).toBe(true);
    expect(r.problem).toMatch(/power-down/);
  });

  it('says nothing when the wide-range accelerometer is not enabled', () => {
    // Consensys's disabled default is 0x02. Every other sensor on, WR accel off.
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: DIV_256,
      ...fromByte0(0x02),
      enabledSensors: 0xffffff & ~WR,
    });
    expect(r.short).toBe(false);
    expect(r.problem).toBeNull();
  });

  it('above 1600 Hz says to lower the sampling rate, since no rate code is faster', () => {
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: 16, // 2048 Hz
      ...fromByte0(0x91), // 1600 Hz, high performance
      enabledSensors: WR,
    });
    expect(r.short).toBe(true);
    expect(r.problem).toMatch(/lower the sampling rate to 1600 Hz/);
    expect(r.problem).not.toMatch(/Raise/);
  });

  it('says nothing for an unusable divider', () => {
    const r = checkWrAccelRateCoversPacketRate({
      samplingRateDivider: 0,
      ...fromByte0(0x62),
      enabledSensors: WR,
    });
    expect(r.packetRateHz).toBeNull();
    expect(r.problem).toBeNull();
  });

  it('is always satisfied by the enabled default, at every divider up to 1600 Hz', () => {
    // The point of deriving on enable: what it produces never needs this check.
    // Divider 21 is 1560 Hz; at divider 20 (1638 Hz) no rate the part has keeps up.
    for (let divider = 21; divider <= 0xffff; divider++) {
      const d = deriveLis2dw12ConfigOnEnableChange({
        enabled: true,
        samplingRateHz: 32768 / divider,
      });
      const r = checkWrAccelRateCoversPacketRate({
        samplingRateDivider: divider,
        wrAccelRateCode: d.rate,
        highPerformance: d.highPerformance,
        enabledSensors: WR,
      });
      if (r.short) expect.fail(`divider ${divider}: ${r.problem}`);
    }
  });
});
