import { describe, it, expect } from 'vitest';
import {
  lsm6dsvAccelGyroRateHz,
  samplingRateHzFromDivider,
  checkImuRateCoversPacketRate,
} from '../../src/devices/infomem/rateCoverage.js';
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
