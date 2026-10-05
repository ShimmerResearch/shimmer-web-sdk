import { describe, it, expect } from 'vitest';
import {
  LSM6DSV_ODR,
  deriveLsm6dsvAccelGyroRate,
  deriveLsm6dsvRateOnEnableChange,
} from '../../src/devices/infomem/deriveRates.js';

// Ported from SensorLSM6DSV.getGyroRateFromFreq (SensorLSM6DSV.java:676) and
// setDefaultLSM6DSVGyroSensorConfig. The table below is the Java ladder, so a
// divergence shows up as a failing case rather than as a bad config on a
// sensor.

describe('LSM6DSV accel+gyro rate from the packet rate', () => {
  it('picks the next ODR at or above the packet rate', () => {
    const cases: [number, number][] = [
      [1, 2], // 7.5 Hz
      [7.5, 2],
      [7.6, 4], // note the ladder skips code 3 (12 Hz)
      [30, 4],
      [51.2, 5], // 60 Hz — the firmware's own default pairing
      [60, 5],
      [102.4, 6], // 120 Hz
      [120, 6],
      [240, 7],
      [480, 8],
      [960, 9],
      [1920, 10],
    ];
    for (const [hz, code] of cases) {
      expect(deriveLsm6dsvAccelGyroRate({ enabled: true, samplingRateHz: hz }), `${hz} Hz`).toBe(
        code,
      );
    }
  });

  it('never selects code 3, because the Java ladder skips it', () => {
    for (let hz = 0.5; hz <= 2000; hz += 0.5) {
      expect(deriveLsm6dsvAccelGyroRate({ enabled: true, samplingRateHz: hz })).not.toBe(3);
    }
  });

  it('powers down when neither the accelerometer nor the gyroscope is enabled', () => {
    expect(deriveLsm6dsvAccelGyroRate({ enabled: false, samplingRateHz: 51.2 })).toBe(
      LSM6DSV_ODR.POWER_DOWN,
    );
  });

  it('honours an explicit low-power request regardless of the packet rate', () => {
    expect(deriveLsm6dsvAccelGyroRate({ enabled: true, samplingRateHz: 512, lowPower: true })).toBe(
      LSM6DSV_ODR.LOW_POWER,
    );
  });

  it('takes lowPower as an argument rather than inferring it from the stored rate', () => {
    /* The trap this API exists to avoid. "Low-power gyro" IS ODR code 1 — the
       driver reads the flag back from the rate — so a derivation that inferred
       it would keep a device stuck at 1.875 Hz forever. Given lowPower: false,
       a device already at code 1 derives back up. */
    expect(
      deriveLsm6dsvAccelGyroRate({ enabled: true, samplingRateHz: 51.2, lowPower: false }),
    ).toBe(5);
  });

  it('refuses to guess from an unusable rate', () => {
    for (const hz of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveLsm6dsvAccelGyroRate({ enabled: true, samplingRateHz: hz })).toBe(
        LSM6DSV_ODR.POWER_DOWN,
      );
    }
  });
});

describe('rate when the IMU is enabled or disabled', () => {
  it('clears low-power on enable, which is the only thing that does', () => {
    // setDefaultLSM6DSVGyroSensorConfig(true) -> setLowPowerGyro(false)
    expect(deriveLsm6dsvRateOnEnableChange({ enabled: true, samplingRateHz: 51.2 })).toBe(5);
    expect(deriveLsm6dsvRateOnEnableChange({ enabled: true, samplingRateHz: 102.4 })).toBe(6);
  });

  it('parks a disabled IMU at the low-power rate, as the driver does', () => {
    // setDefaultLSM6DSVGyroSensorConfig(false) -> setLowPowerGyro(true) -> code 1
    expect(deriveLsm6dsvRateOnEnableChange({ enabled: false, samplingRateHz: 51.2 })).toBe(
      LSM6DSV_ODR.LOW_POWER,
    );
  });

  it('round-trips off and back on without stranding the rate', () => {
    // The bench failure was a device left at the disabled-state rate while the
    // sensor bitmap said enabled. Toggling must recover, not persist.
    const off = deriveLsm6dsvRateOnEnableChange({ enabled: false, samplingRateHz: 51.2 });
    expect(off).toBe(LSM6DSV_ODR.LOW_POWER);
    const on = deriveLsm6dsvRateOnEnableChange({ enabled: true, samplingRateHz: 51.2 });
    expect(on).toBe(5);
  });
});
