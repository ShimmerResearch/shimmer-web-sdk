import { describe, it, expect } from 'vitest';
import {
  SHIMMER3_FACTORY_TEST_TYPE,
  SHIMMER3_FACTORY_TEST_TYPES,
  shimmer3FactoryTestTypeInfo,
  requireShimmer3FactoryTestType,
  buildSetFactoryTestCommand,
  classifyLiteProtocolAck,
} from '../../src/devices/shimmer3r/factoryTest.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';

describe('Shimmer3 factory-test type table', () => {
  it('numbers the four types exactly as the firmware enum does', () => {
    expect(SHIMMER3_FACTORY_TEST_TYPE).toEqual({ MAIN: 0, LEDS: 1, ICS: 2, LED_STATES: 3 });
    expect(SHIMMER3_FACTORY_TEST_TYPES.map((t) => t.value)).toEqual([0, 1, 2, 3]);
    expect(SHIMMER3_FACTORY_TEST_TYPES.map((t) => t.name)).toEqual([
      'MAIN',
      'LEDS',
      'ICS',
      'LED_STATES',
    ]);
  });

  it('carries the expected durations, default timeouts and overall-verdict flags', () => {
    const byName = Object.fromEntries(SHIMMER3_FACTORY_TEST_TYPES.map((t) => [t.name, t]));
    expect(byName.MAIN.expectedDurationMs).toBe(35_000);
    expect(byName.MAIN.defaultTimeoutMs).toBe(90_000);
    expect(byName.MAIN.hasOverall).toBe(true);
    expect(byName.LEDS.expectedDurationMs).toBe(18_000);
    expect(byName.LEDS.defaultTimeoutMs).toBe(45_000);
    expect(byName.LEDS.hasOverall).toBe(false);
    expect(byName.ICS.expectedDurationMs).toBe(15_000);
    expect(byName.ICS.defaultTimeoutMs).toBe(60_000);
    expect(byName.ICS.hasOverall).toBe(true);
    // 15 states, one 5 s dwell each (`Test/shimmer_test_leds_states.c`).
    expect(byName.LED_STATES.expectedDurationMs).toBe(75_000);
    expect(byName.LED_STATES.defaultTimeoutMs).toBe(120_000);
    expect(byName.LED_STATES.hasOverall).toBe(false);
  });

  it('gives every type a timeout with headroom over its expected duration', () => {
    for (const t of SHIMMER3_FACTORY_TEST_TYPES) {
      expect(t.defaultTimeoutMs).toBeGreaterThan(t.expectedDurationMs);
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.description.length).toBeGreaterThan(0);
    }
  });

  it('looks a type up, or answers null', () => {
    expect(shimmer3FactoryTestTypeInfo(2)?.name).toBe('ICS');
    expect(shimmer3FactoryTestTypeInfo(4)).toBeNull();
    expect(shimmer3FactoryTestTypeInfo(-1)).toBeNull();
  });

  it('refuses a type the firmware would ACK and then print nothing for', () => {
    expect(() => requireShimmer3FactoryTestType(4)).toThrow(RangeError);
    expect(() => requireShimmer3FactoryTestType(4)).toThrow(/prints no report/);
    expect(requireShimmer3FactoryTestType(0).name).toBe('MAIN');
  });
});

describe('buildSetFactoryTestCommand', () => {
  it('builds [0xA8, type]', () => {
    expect(buildSetFactoryTestCommand(0)).toEqual(new Uint8Array([0xa8, 0x00]));
    expect(buildSetFactoryTestCommand(3)).toEqual(new Uint8Array([OPCODES.SET_FACTORY_TEST, 0x03]));
  });

  it('refuses to write anything for an out-of-range type', () => {
    expect(() => buildSetFactoryTestCommand(4)).toThrow(RangeError);
    expect(() => buildSetFactoryTestCommand(255)).toThrow(RangeError);
  });
});

describe('classifyLiteProtocolAck', () => {
  it('needs more on an empty buffer', () => {
    expect(classifyLiteProtocolAck(new Uint8Array(0))).toEqual({ kind: 'need-more' });
  });

  it('reads 0xFF as the one-byte ACK', () => {
    expect(classifyLiteProtocolAck(new Uint8Array([0xff, 0x2f]))).toEqual({
      kind: 'ack',
      consumed: 1,
    });
  });

  it('reads 0xFE as a one-byte NACK, with a detail naming the byte', () => {
    const v = classifyLiteProtocolAck(new Uint8Array([0xfe]));
    expect(v.kind).toBe('nack');
    if (v.kind === 'nack') {
      expect(v.consumed).toBe(1);
      expect(v.detail).toContain('0xFE');
    }
  });

  it('treats anything else as report text already in flight', () => {
    expect(classifyLiteProtocolAck(new Uint8Array([0x2f, 0x2f]))).toEqual({ kind: 'text' });
    expect(classifyLiteProtocolAck(new Uint8Array([0x00]))).toEqual({ kind: 'text' });
  });
});
