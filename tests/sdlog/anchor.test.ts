import { describe, it, expect } from 'vitest';
import {
  firstTsOffsetFromInitialTsTicks,
  signedLeadTicks,
  SDLOG_MAX_LEAD_TICKS,
} from '../../src/devices/sdlog/anchor.js';

// Mirrors the Java driver's API_00012_SdTimestampAnchorTest (DEV-1095).
const MAX_3_BYTE = 2 ** 24;
const MAX_2_BYTE = 2 ** 16;
/** A full 40-bit counter value, well away from any 24-bit boundary. */
const INITIAL_TS = 0x12_3456_7000;
const low24 = (t: number): number => t % MAX_3_BYTE;
/** Time the decoder gives a record: header + unwrapped - offset. */
const placed = (initialTs: number, unwrapped: number, offset: number): number =>
  initialTs + unwrapped - offset;

describe('firstTsOffsetFromInitialTsTicks', () => {
  it('places a first record sampled after the header on its own time', () => {
    const raw = low24(INITIAL_TS) + 1000;
    const off = firstTsOffsetFromInitialTsTicks(INITIAL_TS, raw, MAX_3_BYTE);
    expect(placed(INITIAL_TS, raw, off)).toBe(INITIAL_TS + 1000);
  });

  it('places a first record sampled before the header before it (file 000)', () => {
    const raw = low24(INITIAL_TS) - 5243; // ~160 ms of SD start-up
    const off = firstTsOffsetFromInitialTsTicks(INITIAL_TS, raw, MAX_3_BYTE);
    expect(placed(INITIAL_TS, raw, off)).toBe(INITIAL_TS - 5243);
  });

  it('handles the low bits wrapping forward between header and record', () => {
    const initialTs = 0x42 * MAX_3_BYTE + MAX_3_BYTE - 100;
    const off = firstTsOffsetFromInitialTsTicks(initialTs, 200, MAX_3_BYTE);
    expect(placed(initialTs, 200, off)).toBe(initialTs + 300);
  });

  it('handles the low bits wrapping backward between header and record', () => {
    const initialTs = 0x42 * MAX_3_BYTE + 50;
    const raw = MAX_3_BYTE - 100;
    const off = firstTsOffsetFromInitialTsTicks(initialTs, raw, MAX_3_BYTE);
    expect(placed(initialTs, raw, off)).toBe(initialTs - 150);
  });

  it('keeps the previous behaviour for a 2-byte counter', () => {
    expect(firstTsOffsetFromInitialTsTicks(INITIAL_TS, 1234, MAX_2_BYTE)).toBe(1234);
  });

  it('keeps the previous behaviour for a zero initial timestamp', () => {
    expect(firstTsOffsetFromInitialTsTicks(0, 0xf00000, MAX_3_BYTE)).toBe(0xf00000);
  });

  it('keeps the previous behaviour beyond the plausible lead', () => {
    const tooFar = low24(INITIAL_TS) + SDLOG_MAX_LEAD_TICKS + 1;
    expect(firstTsOffsetFromInitialTsTicks(INITIAL_TS, tooFar, MAX_3_BYTE)).toBe(tooFar);
    const atLimit = low24(INITIAL_TS) + SDLOG_MAX_LEAD_TICKS;
    expect(firstTsOffsetFromInitialTsTicks(INITIAL_TS, atLimit, MAX_3_BYTE)).toBe(
      atLimit - SDLOG_MAX_LEAD_TICKS,
    );
  });
});

describe('signedLeadTicks', () => {
  it('folds the distance into the half range', () => {
    expect(signedLeadTicks(INITIAL_TS, low24(INITIAL_TS), MAX_3_BYTE)).toBe(0);
    expect(signedLeadTicks(0, MAX_3_BYTE / 2, MAX_3_BYTE)).toBe(-MAX_3_BYTE / 2);
    expect(signedLeadTicks(0, MAX_3_BYTE / 2 - 1, MAX_3_BYTE)).toBe(MAX_3_BYTE / 2 - 1);
  });
});
