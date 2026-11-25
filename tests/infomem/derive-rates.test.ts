import { describe, it, expect } from 'vitest';
import {
  LSM6DSV_ODR,
  deriveLsm6dsvAccelGyroRate,
  deriveLsm6dsvRateOnEnableChange,
  LIS2DW12_ODR,
  deriveLis2dw12AccelRate,
  deriveLis2dw12ConfigOnEnableChange,
} from '../../src/devices/infomem/deriveRates.js';
import { BIT_SHIFT } from '../../src/devices/infomem/layout.js';

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

// ---------------------------------------------------------------------------
// LIS2DW12 (Shimmer3R wide-range accelerometer)
// ---------------------------------------------------------------------------

/**
 * `SensorLIS2DW12.getAccelRateFromFreq`, transcribed line for line from
 * Shimmer-Java-Android-API master so the port can be compared with it over
 * every rate a Shimmer can be set to, not only at the hand-picked cases.
 */
function javaGetAccelRateFromFreq(isEnabled: boolean, freq: number, isLowPowerMode: boolean) {
  let accelRate = 0; // Power down
  if (isEnabled) {
    if (isLowPowerMode) {
      accelRate = 1; // 1.6Hz
    } else {
      if (freq <= 12.5) {
        accelRate = 1; // 12.5Hz
      } else if (freq <= 25) {
        accelRate = 3; // 25Hz
      } else if (freq <= 50) {
        accelRate = 4; // 50Hz
      } else if (freq <= 100) {
        accelRate = 5; // 100Hz
      } else if (freq <= 200) {
        accelRate = 6; // 200Hz
      } else if (freq <= 400) {
        accelRate = 7; // 400Hz
      } else if (freq <= 800) {
        accelRate = 8; // 800Hz
      } else {
        accelRate = 9; // 1600Hz
      }
    }
  }
  return accelRate;
}

/** ConfigSetupByte0 as the Java driver's configBytesGenerate packs it. */
function configByte0(d: {
  rate: number;
  range: number;
  lowPower: boolean;
  highPerformance: boolean;
}) {
  return (
    (d.rate << BIT_SHIFT.WR_ACCEL_RATE) |
    (d.range << BIT_SHIFT.WR_ACCEL_RANGE) |
    ((d.lowPower ? 1 : 0) << BIT_SHIFT.WR_ACCEL_LPM) |
    ((d.highPerformance ? 1 : 0) << BIT_SHIFT.WR_ACCEL_HRM)
  );
}

describe('LIS2DW12 wide-range accel rate from the packet rate', () => {
  it('follows the Java ladder at and either side of each step', () => {
    const cases: [number, number][] = [
      [1, 1],
      [12.5, 1], // 12.5 Hz: code 1 is 12.5 Hz in high performance
      [12.6, 3], // the ladder skips code 2
      [25, 3],
      [50, 4],
      [51.2, 5], // 100 Hz
      [100, 5],
      [102.4, 6], // 200 Hz
      [200, 6],
      [204.8, 7], // 400 Hz
      [256, 7], // 400 Hz: Consensys's 0x71 at 256 Hz
      [400, 7],
      [512, 8],
      [800, 8],
      [1024, 9],
      [32768, 9],
    ];
    for (const [hz, code] of cases) {
      expect(deriveLis2dw12AccelRate({ enabled: true, samplingRateHz: hz }), `${hz} Hz`).toBe(code);
    }
  });

  it('gives what Java gives for every divider a Shimmer can be set to', () => {
    for (let divider = 1; divider <= 0xffff; divider++) {
      const hz = 32768 / divider;
      for (const lowPower of [false, true]) {
        for (const enabled of [false, true]) {
          const ours = deriveLis2dw12AccelRate({ enabled, samplingRateHz: hz, lowPower });
          if (ours !== javaGetAccelRateFromFreq(enabled, hz, lowPower)) {
            expect.fail(`divider ${divider} (${hz} Hz), enabled ${enabled}, lowPower ${lowPower}`);
          }
        }
      }
    }
  });

  it('powers down a disabled sensor whatever else is asked', () => {
    expect(deriveLis2dw12AccelRate({ enabled: false, samplingRateHz: 256 })).toBe(
      LIS2DW12_ODR.POWER_DOWN,
    );
    expect(deriveLis2dw12AccelRate({ enabled: false, samplingRateHz: 256, lowPower: true })).toBe(
      LIS2DW12_ODR.POWER_DOWN,
    );
  });

  it('gives Java low-power code 1 (1.6 Hz) whatever the packet rate', () => {
    for (const hz of [1, 51.2, 256, 1024]) {
      expect(deriveLis2dw12AccelRate({ enabled: true, samplingRateHz: hz, lowPower: true })).toBe(
        LIS2DW12_ODR.LOW_POWER,
      );
    }
  });

  it('refuses to guess from an unusable rate, as the LSM6DSV port does', () => {
    for (const hz of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(deriveLis2dw12AccelRate({ enabled: true, samplingRateHz: hz })).toBe(
        LIS2DW12_ODR.POWER_DOWN,
      );
    }
  });
});

describe('LIS2DW12 defaults when the wide-range accel is enabled or disabled', () => {
  it('enabling turns low-power off and high performance on, and keeps the range', () => {
    // setDefaultLIS2DW12AccelSensorConfig(true) -> setLowPowerAccelWR(false)
    const on = deriveLis2dw12ConfigOnEnableChange({ enabled: true, samplingRateHz: 256 });
    expect(on).toEqual({ rate: 7, range: null, lowPower: false, highPerformance: true });
  });

  it('enabling at 256 Hz gives the byte Consensys wrote and the bench confirmed, 0x71', () => {
    const on = deriveLis2dw12ConfigOnEnableChange({ enabled: true, samplingRateHz: 256 });
    expect(configByte0({ ...on, range: 0 })).toBe(0x71);
  });

  it('enabling never leaves the part in low-power mode, at any rate', () => {
    for (let divider = 1; divider <= 0xffff; divider += 7) {
      const on = deriveLis2dw12ConfigOnEnableChange({
        enabled: true,
        samplingRateHz: 32768 / divider,
      });
      if (!on.highPerformance || on.lowPower || on.rate === LIS2DW12_ODR.POWER_DOWN) {
        expect.fail(`divider ${divider}: ${JSON.stringify(on)}`);
      }
    }
  });

  it('disabling parks it as Java does: power-down, ±2 g, low-power on (0x02)', () => {
    // setDefaultLIS2DW12AccelSensorConfig(false) -> setLIS2DW12AccelRange(0),
    // setLowPowerAccelWR(true); the sensor is already disabled by then
    // (ShimmerDevice.setSensorEnabledState), so the re-derived rate is 0.
    const off = deriveLis2dw12ConfigOnEnableChange({ enabled: false, samplingRateHz: 256 });
    expect(off).toEqual({
      rate: LIS2DW12_ODR.POWER_DOWN,
      range: 0,
      lowPower: true,
      highPerformance: false,
    });
    expect(configByte0({ ...off, range: off.range ?? 0 })).toBe(0x02);
  });

  it('always returns the two mode bits as opposites, as setLowPowerAccelWR does', () => {
    for (const enabled of [false, true]) {
      const d = deriveLis2dw12ConfigOnEnableChange({ enabled, samplingRateHz: 51.2 });
      expect(d.highPerformance).toBe(!d.lowPower);
    }
  });
});
