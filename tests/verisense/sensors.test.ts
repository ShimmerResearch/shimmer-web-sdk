import { describe, it, expect, beforeEach } from 'vitest';
import { SensorADC } from '../../src/devices/verisense/sensors/SensorADC.js';
import { SensorLIS2DW12 } from '../../src/devices/verisense/sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from '../../src/devices/verisense/sensors/SensorLSM6DS3.js';
import { SensorLSM6DSV } from '../../src/devices/verisense/sensors/SensorLSM6DSV.js';
import { SensorPPG } from '../../src/devices/verisense/sensors/SensorPPG.js';
import { SensorBase } from '../../src/devices/verisense/sensors/SensorBase.js';

// ---------------------------------------------------------------------------
// SensorBase — timestamp helpers
// ---------------------------------------------------------------------------

class ConcreteSensor extends SensorBase {
  parsePayload(_: Uint8Array): unknown[] {
    return [];
  }
  applyOperationalConfig(_: Uint8Array): void {
    /* noop */
  }
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
// SensorADC
// ---------------------------------------------------------------------------

describe('SensorADC', () => {
  let gsr: SensorADC;
  beforeEach(() => {
    gsr = new SensorADC();
  });

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
    gsr.gsrEnabled = true;
    gsr.battEnabled = false;
    // 4 bytes → 2 samples
    const buf = new Uint8Array([0x00, 0x08, 0x00, 0x08]);
    const out = gsr.parsePayload(buf);
    expect(out).toHaveLength(2);
  });

  it('parses explicit battery fields from ADC payload words', () => {
    gsr.gsrEnabled = false;
    gsr.battEnabled = true;
    // raw16 = 0xCABC -> usb bit=1, charger bits=2, adc12=0xABC
    const buf = new Uint8Array([0xbc, 0xca]);
    const out = gsr.parsePayload(buf);
    expect(out).toHaveLength(1);
    expect(out[0].batt).not.toBeNull();
    expect(out[0].batt?.raw16).toBe(0xcabc);
    expect(out[0].batt?.adc12).toBe(0x0abc);
    expect(out[0].batt?.usbPluggedIn).toBe(true);
    expect(out[0].batt?.chargerStatusBits).toBe(2);
  });

  it('applies GSR+ battery scaling to mV output', () => {
    const base = new SensorADC();
    base.gsrEnabled = false;
    base.battEnabled = true;
    base.setHardwareIdentifier('VERISENSE_PULSE_PLUS');

    const gsrPlus = new SensorADC();
    gsrPlus.gsrEnabled = false;
    gsrPlus.battEnabled = true;
    gsrPlus.setHardwareIdentifier('VERISENSE_GSR_PLUS');

    const buf = new Uint8Array([0xff, 0x0f]);
    const mVBase = base.parsePayload(buf)[0].batt?.mV ?? 0;
    const mVGsrPlus = gsrPlus.parsePayload(buf)[0].batt?.mV ?? 0;
    expect(mVGsrPlus).toBeGreaterThan(mVBase);
  });

  it('applies SR62 streaming battery multiplier of 2.0', () => {
    const sensor = new SensorADC();
    sensor.gsrEnabled = false;
    sensor.battEnabled = true;
    sensor.setHardwareRevision(62, 0, 0);

    const buf = new Uint8Array([0xff, 0x0f]);
    const out = sensor.parsePayload(buf)[0].batt;
    const expected = sensor.calibrateAdcToVolts(0x0fff) * 1000.0 * 2.0;
    expect(out?.mV ?? 0).toBeCloseTo(expected, 6);
  });

  it('applies SR68.9 streaming battery multiplier of 2.469', () => {
    const sensor = new SensorADC();
    sensor.gsrEnabled = false;
    sensor.battEnabled = true;
    sensor.setHardwareRevision(68, 9, 0);

    const buf = new Uint8Array([0xff, 0x0f]);
    const out = sensor.parsePayload(buf)[0].batt;
    const expected = sensor.calibrateAdcToVolts(0x0fff) * 1000.0 * 2.469;
    expect(out?.mV ?? 0).toBeCloseTo(expected, 6);
  });

  it('falls back to hardware identifier scaling when revision is unknown', () => {
    const sensor = new SensorADC();
    sensor.gsrEnabled = false;
    sensor.battEnabled = true;
    sensor.setHardwareIdentifier('VERISENSE_GSR_PLUS');

    const buf = new Uint8Array([0xff, 0x0f]);
    const out = sensor.parsePayload(buf)[0].batt;
    const expected = sensor.calibrateAdcToVolts(0x0fff) * 1000.0 * 2.0;
    expect(out?.mV ?? 0).toBeCloseTo(expected, 6);
  });

  // DEV-874 Bug 1: the gen-2 DC GSR front end (21/150/562/1740 kΩ, 0.4986 V
  // reference, 1.8 V ADC reference) applies to every GSR-capable board except
  // the SR62 — selection must follow the hardware revision, not the
  // caller-supplied identifier string. Expected conductances are the DEV-793
  // resistor-sweep acceptance values.
  describe('gen-2 GSR calibration by hardware revision (DEV-874)', () => {
    /** 12-bit ADC count a gen-2 front end produces for a resistive load. */
    const gen2AdcForLoad = (rLoadKohms: number, rFeedbackKohms: number): number =>
      Math.round((0.4986 * (1 + rFeedbackKohms / rLoadKohms) * 4095) / 1.8);

    /** GSR-only auto-range payload word for a range + 12-bit ADC count. */
    const payloadWord = (range: number, adc12: number): Uint8Array => {
      const raw = ((range & 0x03) << 14) | (adc12 & 0x0fff);
      return new Uint8Array([raw & 0xff, (raw >> 8) & 0xff]);
    };

    const decodeGsr = (sensor: SensorADC, range: number, adc12: number) =>
      sensor.parsePayload(payloadWord(range, adc12))[0].gsr!;

    const GEN2_REF_KOHMS = [21.0, 150.0, 562.0, 1740.0];
    const SWEEP: Array<{ rKohms: number; range: number; uS: number }> = [
      { rKohms: 33, range: 0, uS: 30.3 },
      { rKohms: 100, range: 1, uS: 10.0 },
      { rKohms: 470, range: 2, uS: 2.13 },
      { rKohms: 2700, range: 3, uS: 0.37 },
    ];

    it('SR61-5 decodes the DEV-793 resistor sweep with the gen-2 resistor set', () => {
      const sensor = new SensorADC();
      sensor.setHardwareRevision(61, 5, 0);

      for (const { rKohms, range, uS } of SWEEP) {
        const adc12 = gen2AdcForLoad(rKohms, GEN2_REF_KOHMS[range]);
        const gsr = decodeGsr(sensor, range, adc12);
        expect(gsr.range).toBe(range);
        // Within 1% of the fitted load (ADC quantization only).
        expect(Math.abs(gsr.kOhms - rKohms) / rKohms).toBeLessThan(0.01);
        expect(gsr.uS).toBeCloseTo(uS, 1);
      }
    });

    it('SR68-9 uses the same gen-2 set (previously identifier-gated behavior kept)', () => {
      const sensor = new SensorADC();
      sensor.setHardwareRevision(68, 9, 0);
      const adc12 = gen2AdcForLoad(100, GEN2_REF_KOHMS[1]);
      expect(decodeGsr(sensor, 1, adc12).uS).toBeCloseTo(10.0, 1);
    });

    it('SR62 keeps the Shimmer3 resistor set, 0.5 V GSR reference and 3.0 V ADC reference', () => {
      const sensor = new SensorADC();
      sensor.setHardwareRevision(62, 0, 0);

      // 100 kΩ on range 1 (287 kΩ feedback): volts = 0.5·(1+287/100), 3.0 V ref.
      const adc12 = Math.round((0.5 * (1 + 287.0 / 100.0) * 4095) / 3.0);
      const gsr = decodeGsr(sensor, 1, adc12);
      expect(gsr.kOhms).toBeCloseTo(100, 0);
      expect(gsr.uS).toBeCloseTo(10.0, 1);
    });

    it('falls back to the identifier string only when no revision has been read', () => {
      const pulse = new SensorADC(); // default identifier VERISENSE_PULSE_PLUS
      const adc12 = gen2AdcForLoad(100, GEN2_REF_KOHMS[1]);
      expect(decodeGsr(pulse, 1, adc12).uS).toBeCloseTo(10.0, 1);

      const gsrPlus = new SensorADC();
      gsrPlus.setHardwareIdentifier('VERISENSE_GSR_PLUS');
      const adc12Sr62 = Math.round((0.5 * (1 + 287.0 / 100.0) * 4095) / 3.0);
      expect(decodeGsr(gsrPlus, 1, adc12Sr62).uS).toBeCloseTo(10.0, 1);
    });

    it('applies the gen-2 range-3 uncal clamp limit (1134) on SR61-5', () => {
      const sensor = new SensorADC();
      sensor.setHardwareRevision(61, 5, 0);
      // Below the gen-2 limit the ADC count is clamped to 1134 before calibration.
      const clamped = decodeGsr(sensor, 3, 700);
      const atLimit = decodeGsr(sensor, 3, 1134);
      expect(clamped.adc12).toBe(1134);
      expect(clamped.kOhms).toBe(atLimit.kOhms);
    });
  });

  it('decodeAdcSampleRateHz maps rate codes to 32768/divisor (Off -> null)', () => {
    expect(gsr.decodeAdcSampleRateHz(0)).toBeNull(); // Off
    expect(gsr.decodeAdcSampleRateHz(23)).toBeCloseTo(51.2, 6); // 32768/640
    expect(gsr.decodeAdcSampleRateHz(12)).toBeCloseTo(655.36, 6); // 32768/50
    expect(gsr.decodeAdcSampleRateHz(40)).toBeCloseTo(1.0, 6); // 32768/32768
    expect(gsr.decodeAdcSampleRateHz(999)).toBeNull(); // out of range
  });

  it('sets samplingRateHz from the ADC sample-rate config, not the 50 Hz default', () => {
    expect(gsr.samplingRateHz).toBe(50); // constructor default

    const op = new Uint8Array(56);
    op[2] = 0x80; // GEN_CFG_1: GSR enabled
    op[50] = 19; // ADC_CHANNEL_SETTINGS_0: rate code 19 -> 32768/256 = 128 Hz
    gsr.applyOperationalConfig(op);

    expect(gsr.gsrEnabled).toBe(true);
    expect(gsr.samplingRateHz).toBe(128);
  });

  it('spaces sample timestamps at the configured rate so blocks do not overlap (zigzag regression)', () => {
    const op = new Uint8Array(56);
    op[2] = 0x80; // GSR enabled
    op[50] = 19; // 128 Hz
    gsr.applyOperationalConfig(op);

    const n = 16;
    const decoded = gsr.parsePayload(new Uint8Array(n * 2)); // n GSR-only samples
    expect(decoded).toHaveLength(n);

    const dtMs = 1000 / 128;
    const blockDurMs = n * dtMs; // real device tick advance between consecutive blocks

    // Two consecutive blocks, last-sample tick advancing by the real block duration.
    const block1 = gsr.computeSampleTimestamps(decoded, {
      tsLastSampleMillis: blockDurMs,
      systemTsLastSampleMillis: blockDurMs,
      systemOffsetFirstTime: 0,
    });
    const block2 = gsr.computeSampleTimestamps(decoded, {
      tsLastSampleMillis: 2 * blockDurMs,
      systemTsLastSampleMillis: 2 * blockDurMs,
      systemOffsetFirstTime: 0,
    });

    // Even spacing within a block at the configured rate.
    expect(block1[1].tsMillis - block1[0].tsMillis).toBeCloseTo(dtMs, 6);
    // The last sample anchors at the block-end tick.
    expect(block1[n - 1].tsMillis).toBeCloseTo(blockDurMs, 6);
    // The whole timeline is strictly increasing across blocks: no overlap = no zigzag.
    // (At the buggy 50 Hz default the 128 Hz block would spread ~320 ms back and
    // overlap the previous block, sending the trace backwards in time.)
    const timeline = [...block1, ...block2].map((t) => t.tsMillis);
    for (let i = 1; i < timeline.length; i++) {
      expect(timeline[i]).toBeGreaterThan(timeline[i - 1]);
    }
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
    sensor.accEnabled = true;
    sensor.gyroEnabled = true;
    const buf = new Uint8Array(24); // 2 samples
    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(2);
    expect(out[0].accel).not.toBeNull();
    expect(out[0].gyro).not.toBeNull();
  });

  it('parsePayload with gyro-only parses 6 bytes per sample', () => {
    const sensor = new SensorLSM6DS3();
    sensor.accEnabled = false;
    sensor.gyroEnabled = true;
    const buf = new Uint8Array(6); // 1 sample
    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(1);
    expect(out[0].accel).toBeNull();
    expect(out[0].gyro).not.toBeNull();
  });
});

describe('SensorLSM6DSV', () => {
  it('parses tagged accel/gyro/mag entries from variable-length payload', () => {
    const sensor = new SensorLSM6DSV();

    // 16-bit little-endian entry count (3) followed by three 7-byte entries.
    const buf = new Uint8Array([
      3, 0x00, 0x10, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x08, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00,
      0x70, 0x07, 0x00, 0x08, 0x00, 0x09, 0x00,
    ]);

    const out = sensor.parsePayload(buf);
    expect(out).toHaveLength(3);
    expect(out[0].accel).not.toBeNull();
    expect(out[1].gyro).not.toBeNull();
    expect(out[2].mag).not.toBeNull();
  });

  it('applies ODR/range fields from bytes 18..20 (mag reports its configured output rate)', () => {
    const sensor = new SensorLSM6DSV();
    const op = new Uint8Array(72);
    op[1] = 0b01100000; // accel2En + gyroEn
    op[4] = 0b00000100; // magEn
    op[18] = 0x24; // odrXl = 4 (30 Hz), fsXl = 2
    op[19] = 0x13; // odrG = 3 (15 Hz), fsG = 1
    op[20] = 0x02; // mag output code 2 -> 60 Hz

    sensor.applyOperationalConfig(op);
    expect(sensor.accelHz).toBe(30);
    expect(sensor.gyroHz).toBe(15);
    // Mag reports its configured output rate (not capped at the accel/gyro hub
    // trigger); a slower trigger surfaces as mag packet loss instead.
    expect(sensor.magHz).toBe(60);
    expect(sensor.samplingRateHz).toBe(60);
  });

  it('timestamps interleaved accel/gyro streams on their own rate, not the global index', () => {
    const sensor = new SensorLSM6DSV();
    const op = new Uint8Array(72);
    op[1] = 0b01100000; // accel2En + gyroEn
    op[18] = 0x05; // odrXl = 60 Hz
    op[19] = 0x05; // odrG = 60 Hz
    sensor.applyOperationalConfig(op);

    // Interleaved decoded burst A,G,A,G,A,G (3 accel + 3 gyro).
    const a = () => ({ tag: 2, cnt: 0, accel: { cal: [0, 0, 0] }, gyro: null, mag: null });
    const g = () => ({ tag: 1, cnt: 0, accel: null, gyro: { cal: [0, 0, 0] }, mag: null });
    const decoded = [a(), g(), a(), g(), a(), g()] as unknown[];

    const ts = sensor.computeSampleTimestamps(decoded, {
      tsLastSampleMillis: 1000,
      systemTsLastSampleMillis: 1000,
      systemOffsetFirstTime: 0,
    });

    const dtMs = 1000 / 60; // 60 Hz spacing
    // Accel entries (decoded idx 0,2,4) are spaced at the accel rate, not 2x it.
    expect(ts[2].tsMillis - ts[0].tsMillis).toBeCloseTo(dtMs, 1);
    expect(ts[4].tsMillis - ts[2].tsMillis).toBeCloseTo(dtMs, 1);
    // Gyro entries (idx 1,3,5) likewise.
    expect(ts[3].tsMillis - ts[1].tsMillis).toBeCloseTo(dtMs, 1);
    // Each stream's last sample anchors at the block's last-sample time.
    expect(ts[4].tsMillis).toBeCloseTo(1000, 6);
    expect(ts[5].tsMillis).toBeCloseTo(1000, 6);
  });

  // DEV-874 Bug 2: LSM6DSV gyro default scaling must use the ST angular-rate
  // sensitivity (4.375 mdps/LSB at ±125 dps, doubling per range), NOT FS/32768 —
  // the gyro does not span the 16-bit range at nominal full scale.
  describe('gyro default scaling (DEV-874)', () => {
    /** One-entry LSM6DSV payload: 16-bit count then tag<<3 + xyz i16le. */
    const payloadFor = (tag: number, x: number): Uint8Array =>
      new Uint8Array([1, 0, (tag & 0x1f) << 3, x & 0xff, (x >> 8) & 0xff, 0, 0, 0, 0]);

    const configure = (fsGCode: number): SensorLSM6DSV => {
      const sensor = new SensorLSM6DSV();
      const op = new Uint8Array(72);
      op[1] = 0b01100000; // accel2En + gyroEn
      op[18] = 0x03; // odrXl 15 Hz, fsXl ±2g
      op[19] = ((fsGCode & 0x0f) << 4) | 0x03; // fsG | odrG 15 Hz
      sensor.applyOperationalConfig(op);
      return sensor;
    };

    it('raw 32767 at ±500 dps reads ~573.4 dps (not 500.0)', () => {
      const sensor = configure(2); // ±500 dps
      const out = sensor.parsePayload(payloadFor(1, 32767));
      expect(out[0].gyro?.cal[0]).toBeCloseTo(573.4, 1);
    });

    it('sensitivity doubles per range from 4.375 mdps/LSB at ±125 dps', () => {
      // 1 LSB in dps per full-scale code (= 1/LSB-per-dps: 228.571→14.286).
      const expected: Array<[number, number]> = [
        [0, 0.004375],
        [1, 0.00875],
        [2, 0.0175],
        [3, 0.035],
        [4, 0.07],
      ];
      for (const [code, dpsPerLsb] of expected) {
        const sensor = configure(code);
        const out = sensor.parsePayload(payloadFor(1, 1000));
        expect(out[0].gyro?.cal[0]).toBeCloseTo(1000 * dpsPerLsb, 6);
      }
    });

    it('accel default scaling is unchanged (FS/32768 · g)', () => {
      const sensor = configure(2);
      const out = sensor.parsePayload(payloadFor(2, 32767));
      expect(out[0].accel?.cal[0]).toBeCloseTo((2 / 32768) * 9.80665 * 32767, 3);
    });
  });

  it('spreads sensor-hub mag over the same block window as accel (block-derived rate)', () => {
    const sensor = new SensorLSM6DSV();
    const op = new Uint8Array(72);
    op[1] = 0b01000000; // accel2En
    op[4] = 0b00000100; // magEn (GEN_CFG_3 bit 2)
    op[18] = 0x05; // odrXl = 60 Hz
    op[20] = 0x00; // mag nominal ODR = 10 Hz (intentionally != the FIFO/hub rate)
    sensor.applyOperationalConfig(op);

    // 6 accel + 2 mag interleaved (mag is much sparser in the FIFO).
    const a = () => ({ tag: 2, cnt: 0, accel: { cal: [0, 0, 0] }, gyro: null, mag: null });
    const m = () => ({ tag: 14, cnt: 0, accel: null, gyro: null, mag: { cal: [0, 0, 0] } });
    const decoded = [a(), a(), a(), m(), a(), a(), a(), m()] as unknown[];

    const ts = sensor.computeSampleTimestamps(decoded, {
      tsLastSampleMillis: 1000,
      systemTsLastSampleMillis: 1000,
      systemOffsetFirstTime: 0,
    });

    // Block window from accel = 6 / 60 Hz = 0.1 s; 2 mag samples -> 20 Hz, 50 ms
    // apart. NOT the nominal 10 Hz (100 ms) -> the rate is derived from the block.
    expect(ts[7].tsMillis - ts[3].tsMillis).toBeCloseTo(1000 / 20, 1);
    // Mag and accel both anchor their last sample at the block end.
    expect(ts[7].tsMillis).toBeCloseTo(1000, 6);
    expect(ts[6].tsMillis).toBeCloseTo(1000, 6);
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

  it('sets samplingRateHz from PPG_SR divided by the sample-averaging factor', () => {
    const sensor = new SensorPPG();
    expect(sensor.samplingRateHz).toBe(50); // constructor default

    const op = new Uint8Array(72);
    op[60] = 1 << 2; // PPG_MODE_CONFIG2: PPG_SR code 1 -> 100 Hz
    op[59] = 2 << 5; // PPG_FIFO_CONFIG: SMP_AVE code 2 -> average 4
    sensor.applyOperationalConfig(op);

    expect(sensor.samplingRateHz).toBe(25); // 100 / 4
  });

  it('uses the base PPG_SR when sample averaging is disabled', () => {
    const sensor = new SensorPPG();
    const op = new Uint8Array(72);
    op[60] = 3 << 2; // PPG_SR code 3 -> 400 Hz
    op[59] = 0; // SMP_AVE code 0 -> no averaging (factor 1)
    sensor.applyOperationalConfig(op);

    expect(sensor.samplingRateHz).toBe(400);
  });
});
