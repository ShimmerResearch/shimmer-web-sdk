import { describe, it, expect } from 'vitest';
import { SensorVD6283 } from '../../src/devices/verisense/sensors/SensorVD6283.js';
import { SensorMLX90632 } from '../../src/devices/verisense/sensors/SensorMLX90632.js';
import { SensorMAX32674 } from '../../src/devices/verisense/sensors/SensorMAX32674.js';
import {
  createBlankVerisenseOperationalConfig,
  VERISENSE_OP_CONFIG_BYTE_SIZE,
  VERISENSE_OPERATIONAL_FIELD_SCHEMA,
  VERISENSE_SENSOR_ENABLE_FIELDS,
  readVerisenseOperationalFieldValue,
  writeVerisenseOperationalFieldValue,
  type VerisenseOperationalField,
} from '../../src/devices/verisense/operationalConfig.js';
import { OP_IDX, OP_CONFIG_VERSION_V9 } from '../../src/devices/verisense/constants.js';

const u24 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];

describe('SensorVD6283 (ambient light, id 7)', () => {
  it('decodes a 6-channel 18-byte sample', () => {
    const s = new SensorVD6283();
    const bytes = Uint8Array.from([
      ...u24(0x010203), // RED
      ...u24(0x040506), // VISIBLE
      ...u24(0x070809), // BLUE
      ...u24(0x0a0b0c), // GREEN
      ...u24(0x0d0e0f), // IR
      ...u24(0x101112), // CLEAR
    ]);
    const out = s.parsePayload(bytes);
    expect(out).toHaveLength(1);
    expect(out[0].RED).toBe(0x010203);
    expect(out[0].VISIBLE).toBe(0x040506);
    expect(out[0].BLUE).toBe(0x070809);
    expect(out[0].GREEN).toBe(0x0a0b0c);
    expect(out[0].IR).toBe(0x0d0e0f);
    expect(out[0].CLEAR).toBe(0x101112);
    // Derived lux/CCT are computed and finite.
    expect(Number.isFinite(out[0].lux)).toBe(true);
    expect(out[0].lux).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(out[0].cct)).toBe(true);
  });

  it('applies enable bit + sample rate from op-config', () => {
    const s = new SensorVD6283();
    const op = createBlankVerisenseOperationalConfig();
    op[OP_IDX.GEN_CFG_3] |= 1 << 3; // AMBIENT_LIGHT_EN
    op[OP_IDX.LIGHT_SAMPLE_RATE_INDEX] = 2; // 1 Hz
    s.applyOperationalConfig(op);
    expect(s.enabled).toBe(true);
    expect(s.samplingRateHz).toBe(1);
  });
});

describe('SensorMLX90632 (skin temp, id 9)', () => {
  it('decodes object + ambient centi-degree sample', () => {
    const s = new SensorMLX90632();
    const bytes = Uint8Array.from([...u16(3650), ...u16(2500)]); // 36.50C, 25.00C
    const out = s.parsePayload(bytes);
    expect(out).toHaveLength(1);
    expect(out[0].object.cal).toBeCloseTo(36.5);
    expect(out[0].ambient.cal).toBeCloseTo(25.0);
  });

  it('applies enable bit from op-config', () => {
    const s = new SensorMLX90632();
    const op = createBlankVerisenseOperationalConfig();
    op[OP_IDX.GEN_CFG_3] |= 1 << 4; // SKIN_TEMP_EN
    s.applyOperationalConfig(op);
    expect(s.enabled).toBe(true);
  });
});

describe('SensorMAX32674 (algo hub, id 8)', () => {
  it('decodes a count-prefixed 32-byte sample', () => {
    const s = new SensorMAX32674();
    const bytes = Uint8Array.from([
      1, // sample count
      ...u24(1000),
      ...u24(2000),
      ...u24(3000),
      ...u24(4000),
      ...u24(5000),
      ...u24(6000), // led1..6
      ...u16(100),
      ...u16(0x10000 - 200),
      ...u16(300), // accel x=100, y=-200, z=300
      ...u16(72), // hr
      95, // hr conf
      ...u16(98), // spo2
      90, // spo2 conf
      2, // activity
      1, // scd
    ]);
    const out = s.parsePayload(bytes);
    expect(out).toHaveLength(1);
    expect(out[0].ppg).toEqual([1000, 2000, 3000, 4000, 5000, 6000]);
    expect(out[0].accel.raw).toEqual([100, -200, 300]);
    expect(out[0].hr).toBe(72);
    expect(out[0].hrConfidence).toBe(95);
    expect(out[0].spo2).toBe(98);
    expect(out[0].activityClass).toBe(2);
    expect(out[0].scdContactState).toBe(1);
  });

  it('applies algo-hub enable bit from op-config', () => {
    const s = new SensorMAX32674();
    const op = createBlankVerisenseOperationalConfig();
    op[OP_IDX.GEN_CFG_3] |= 1 << 5; // ALGO_HUB_EN
    s.applyOperationalConfig(op);
    expect(s.enabled).toBe(true);
  });
});

describe('v9 operational config schema', () => {
  it('blank config is 86 bytes, header 0x5A, version 9', () => {
    const op = createBlankVerisenseOperationalConfig();
    expect(op.length).toBe(VERISENSE_OP_CONFIG_BYTE_SIZE);
    expect(VERISENSE_OP_CONFIG_BYTE_SIZE).toBe(86);
    expect(op[0]).toBe(0x5a);
    expect(op[OP_IDX.OP_CONFIG_VERSION]).toBe(OP_CONFIG_VERSION_V9);
  });

  it('exposes the new sensor enable fields', () => {
    const keys = VERISENSE_SENSOR_ENABLE_FIELDS.map((f) => f.key);
    expect(keys).toContain('AMBIENT_LIGHT_EN');
    expect(keys).toContain('SKIN_TEMP_EN');
    expect(keys).toContain('ALGO_HUB_EN');
    // PPG_VIA_HUB is a routing-mode setting (field schema), not a sensor enable.
    expect(keys).not.toContain('PPG_VIA_HUB');
  });

  it('round-trips new schema fields', () => {
    const op = createBlankVerisenseOperationalConfig();
    for (const key of ['LIGHT_SAMPLE_RATE_INDEX', 'ALGO_OP_MODE', 'LED_LUX_THRESHOLD']) {
      const field = VERISENSE_OPERATIONAL_FIELD_SCHEMA.find(
        (f) => f.key === key,
      ) as VerisenseOperationalField;
      expect(field).toBeDefined();
      const value = key === 'LED_LUX_THRESHOLD' ? 1234 : 3;
      writeVerisenseOperationalFieldValue(op, field, value);
      expect(readVerisenseOperationalFieldValue(op, field)).toBe(value);
    }
  });
});
