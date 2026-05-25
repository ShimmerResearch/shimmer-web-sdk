import { describe, it, expect, beforeEach } from 'vitest';
import { SensorGSR } from '../../src/devices/verisense/sensors/SensorGSR.js';
import { SensorLIS2DW12 } from '../../src/devices/verisense/sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from '../../src/devices/verisense/sensors/SensorLSM6DS3.js';
import { SensorPPG } from '../../src/devices/verisense/sensors/SensorPPG.js';
import { SensorBase } from '../../src/devices/verisense/sensors/SensorBase.js';

// ---------------------------------------------------------------------------
// SensorBase — timestamp helpers
// ---------------------------------------------------------------------------

class ConcreteSensor extends SensorBase {
  parsePayload(_: Uint8Array): unknown[] { return []; }
  applyOperationalConfig(_: Uint8Array): void { /* noop */ }
}

describe('SensorBase.unwrapTicks', () => {
  it('starts at 0 and increments monotonically', () => {
    const s = new ConcreteSensor();
    expect(s.unwrapTicks(100)).toBe(100);
    expect(s.unwrapTicks(200)).toBe(200);
  });

  it('handles rollover by incrementing cycle', () => {
    const s = new ConcreteSensor();
    const MAX = SensorBase.TICKS_MAX_VALUE;
    // Advance near the rollover
    s.unwrapTicks(MAX - 100);
    // Simulate tick counter wrapping back to near zero
    const unwrapped = s.unwrapTicks(50);
    expect(unwrapped).toBe(MAX + 50);
  });
});

describe('SensorBase.extrapolateSampleTimes', () => {
  it('returns the last-sample time when there is only one sample', () => {
    const s = new ConcreteSensor();
    const t = s.extrapolateSampleTimes({
      numSamples: 1,
      i: 0,
      samplingRateHz: 50,
      tsLastSampleMillis: 1000,
      systemTsLastSampleMillis: 2000,
      systemOffsetFirstTime: null,
    });
    expect(t.tsMillis).toBeCloseTo(1000);
    expect(t.systemTsMillis).toBeCloseTo(2000);
  });

  it('offsets earlier samples backwards in time', () => {
    const s = new ConcreteSensor();
    const t0 = s.extrapolateSampleTimes({
      numSamples: 4,
      i: 0,
      samplingRateHz: 100,
      tsLastSampleMillis: 1000,
      systemTsLastSampleMillis: 2000,
      systemOffsetFirstTime: null,
    });
    // sample 0 should be 30 ms earlier than last sample (3 intervals @ 10 ms)
    expect(t0.tsMillis).toBeCloseTo(970);
  });
});

// ---------------------------------------------------------------------------
// SensorGSR
// ---------------------------------------------------------------------------

describe('SensorGSR', () => {
  let gsr: SensorGSR;
  beforeEach(() => { gsr = new SensorGSR(); });

  it('defaults to auto-range (4)', () => {
    expect(gsr.gsrRangeSetting).toBe(4);
  });

  it('calibrateAdcToVolts returns a positive voltage for a positive ADC value', () => {
    const v = gsr.calibrateAdcToVolts(2000);
    expect(v).toBeGreaterThan(0);
  });

  it('nudgeGsrResistance clamps to range limits', () => {
    gsr.setGsrRangeSetting(0);
    expect(gsr.nudgeGsrResistance(1)).toBe(8.0);
    expect(gsr.nudgeGsrResistance(999)).toBe(63.0);
    expect(gsr.nudgeGsrResistance(30)).toBe(30);
  });

  it('parsePayload returns one sample per 2 bytes (GSR-only mode)', () => {
    gsr.gsrEnabled  = true;
    gsr.battEnabled = false;
    // 4 bytes → 2 samples
    const buf = new Uint8Array([0x00, 0x08, 0x00, 0x08]);
    const out = gsr.parsePayload(buf);
    expect(out).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// SensorLIS2DW12
// ---------------------------------------------------------------------------

describe('SensorLIS2DW12', () => {
  it('parsePayload parses 6 bytes per sample', () => {
    const sensor = new SensorLIS2DW12();
    const buf = new Uint8Array(12); // 2 samples
    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(2);
    expect(out[0]).toHaveProperty('raw');
    expect(out[0]).toHaveProperty('cal');
  });
});

// ---------------------------------------------------------------------------
// SensorLSM6DS3
// ---------------------------------------------------------------------------

describe('SensorLSM6DS3', () => {
  it('parsePayload with gyro+accel enabled parses 12 bytes per sample', () => {
    const sensor = new SensorLSM6DS3();
    sensor.accEnabled  = true;
    sensor.gyroEnabled = true;
    const buf = new Uint8Array(24); // 2 samples
    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(2);
    expect(out[0].accel).not.toBeNull();
    expect(out[0].gyro).not.toBeNull();
  });

  it('parsePayload with gyro-only parses 6 bytes per sample', () => {
    const sensor = new SensorLSM6DS3();
    sensor.accEnabled  = false;
    sensor.gyroEnabled = true;
    const buf = new Uint8Array(6); // 1 sample
    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(1);
    expect(out[0].accel).toBeNull();
    expect(out[0].gyro).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SensorPPG
// ---------------------------------------------------------------------------

describe('SensorPPG', () => {
  it('returns empty array when no channels enabled', () => {
    const sensor = new SensorPPG();
    const out = sensor.parsePayload(new Uint8Array(6));
    expect(out).toHaveLength(0);
  });

  it('parses 3 bytes per enabled channel', () => {
    const sensor = new SensorPPG();
    sensor.setChannels({ RED: true, IR: true });
    // 6 bytes → 1 sample (2 channels × 3 bytes)
    const buf = new Uint8Array(6);
    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(1);
    expect(out[0]).toHaveProperty('RED');
    expect(out[0]).toHaveProperty('IR');
  });

  it('calibrateValue returns a non-negative number', () => {
    const sensor = new SensorPPG();
    sensor.setAdcResolutionIndex(0);
    expect(sensor.calibrateValue(1024)).toBeGreaterThanOrEqual(0);
  });
});
