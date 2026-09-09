import { describe, expect, it } from 'vitest';
import { StreamTimeline, TICKS_PER_MS, TICKS_PER_SECOND } from '../../src/core/StreamTimeline.js';

const MOD24 = 2 ** 24;
const MOD16 = 2 ** 16;

describe('constants', () => {
  it('are the firmware’s own', () => {
    expect(TICKS_PER_SECOND).toBe(32768);
    expect(TICKS_PER_MS).toBeCloseTo(32.768, 12);
  });
});

describe('unwrapping', () => {
  it('passes the first sample through unchanged', () => {
    const t = new StreamTimeline();
    expect(t.stamp(1000).unwrappedTicks).toBe(1000);
    // deviceMs is not zeroed at stream start — it begins where the counter is.
    expect(t.stamp(1000).deviceMs).toBeCloseTo(1000 / TICKS_PER_MS, 9);
  });

  it('adds a modulo when the 24-bit counter wraps', () => {
    const t = new StreamTimeline();
    t.stamp(MOD24 - 640);
    const after = t.stamp(0); // 640 ticks later, across the boundary
    expect(after.unwrappedTicks).toBe(MOD24);
    expect(t.state.wraps).toBe(1);
  });

  it('adds a modulo when the 16-bit counter wraps', () => {
    // Older Shimmer3 firmware: the whole modulo is two seconds.
    const t = new StreamTimeline({ timestampBits: 16 });
    t.stamp(MOD16 - 100);
    expect(t.stamp(28).unwrappedTicks).toBe(MOD16 + 28);
  });

  it('treats a small backwards step as a reordered packet, not a wrap', () => {
    // The Java driver's rule adds a whole modulo here, permanently — 512 s of
    // error from one duplicated packet.
    const t = new StreamTimeline();
    t.stamp(100_000);
    const back = t.stamp(99_000);
    expect(back.unwrappedTicks).toBe(99_000);
    expect(t.state.wraps).toBe(0);
    // And the timeline recovers: the next in-order sample is where it should be.
    expect(t.stamp(101_000).unwrappedTicks).toBe(101_000);
  });

  it('stays monotonic across a wrap for a run of samples', () => {
    const t = new StreamTimeline();
    let previous = -1;
    for (let i = 0; i < 40; i++) {
      const raw = (MOD24 - 20 * 640 + i * 640) % MOD24;
      const { unwrappedTicks } = t.stamp(raw);
      expect(unwrappedTicks).toBeGreaterThan(previous);
      previous = unwrappedTicks;
    }
    expect(t.state.wraps).toBe(1);
  });

  it('recovers whole wraps that went by unseen, using the host clock', () => {
    // A 16-bit counter wraps every 2 s, so a 5 s gap hides two whole wraps and
    // the counter alone cannot say how many. The host clock can.
    const t = new StreamTimeline({ timestampBits: 16 });
    t.stamp(1000, 1_000_000);
    const after = t.stamp(1500, 1_005_000);
    // 5 s at 32768 Hz is 163840 ticks; the sample's phase is 1500.
    expect(after.unwrappedTicks).toBe(1500 + 2 * MOD16);
    expect(after.deviceMs).toBeCloseTo(after.unwrappedTicks / TICKS_PER_MS, 9);
  });

  it('does not let host jitter invent a wrap inside one modulo', () => {
    const t = new StreamTimeline({ timestampBits: 16 });
    t.stamp(1000, 1_000_000);
    // Host says 100 ms, the counter says 3277 ticks: agreement, no wrap.
    expect(t.stamp(4277, 1_000_100).unwrappedTicks).toBe(4277);
  });

  it('resets the unwrap when the counter width changes', () => {
    const t = new StreamTimeline({ timestampBits: 24 });
    t.stamp(MOD24 - 10);
    t.setTimestampBits(16);
    expect(t.timestampBits).toBe(16);
    expect(t.state.wraps).toBe(0);
    expect(t.stamp(50).unwrappedTicks).toBe(50);
  });
});

describe('rwc-aligned anchoring (Shimmer3R)', () => {
  /** 2026-09-09T12:00:00Z as a tick count, the shape GET_RWC returns. */
  const unixMs = Date.UTC(2026, 8, 9, 12, 0, 0);
  const rwcTicks = BigInt(Math.round(unixMs * TICKS_PER_MS));

  it('places a sample exactly, because the stream carries the clock’s own bits', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { rttMs: 40, aligned: true });
    // The next sample's counter value is the low 24 bits of that same clock.
    const low = Number(rwcTicks % BigInt(MOD24));
    const s = t.stamp(low, 1_000_000);
    expect(s.source).toBe('rwc-aligned');
    expect(s.unixMs).toBeCloseTo(unixMs, 6);
    // Exact: an aligned anchor does not depend on when the reply was composed.
    expect(t.state.anchorUncertaintyMs).toBe(0);
  });

  it('picks the right wrap however stale the anchor is', () => {
    // 700 seconds after the reading — more than one whole 512 s wrap — the
    // counter's phase is ambiguous, and elapsed host time resolves it.
    for (const elapsedSec of [0, 300, 700, 1500]) {
      const t = new StreamTimeline();
      t.anchorToRwc(rwcTicks, 1_000_000, { aligned: true });
      const laterTicks = rwcTicks + BigInt(Math.round(elapsedSec * TICKS_PER_SECOND));
      const low = Number(laterTicks % BigInt(MOD24));
      const s = t.stamp(low, 1_000_000 + elapsedSec * 1000);
      expect(s.unixMs, `elapsed ${elapsedSec}s`).toBeCloseTo(unixMs + elapsedSec * 1000, 3);
    }
  });

  it('carries later samples forward on the device’s own clock', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { aligned: true });
    const low = Number(rwcTicks % BigInt(MOD24));
    t.stamp(low, 1_000_000);
    // 640 ticks on = 19.53 ms, whatever the host clock claims meanwhile.
    const next = t.stamp((low + 640) % MOD24, 1_000_999);
    expect(next.unixMs).toBeCloseTo(unixMs + 640 / TICKS_PER_MS, 6);
  });

  it('reports the device-minus-host skew it found', () => {
    const t = new StreamTimeline();
    // The host is a full second behind the sensor.
    const hostMs = unixMs - 1000;
    t.anchorToRwc(rwcTicks, hostMs, { aligned: true });
    t.stamp(Number(rwcTicks % BigInt(MOD24)), hostMs);
    expect(t.state.skewMs).toBeCloseTo(1000, 0);
  });
});

describe('rwc-estimated anchoring (Shimmer3)', () => {
  const unixMs = Date.UTC(2026, 8, 9, 12, 0, 0);
  const rwcTicks = BigInt(Math.round(unixMs * TICKS_PER_MS));

  it('places a sample from the exchange midpoint, and says how well', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { rttMs: 40, aligned: false });
    // The counter value is unrelated to the clock here, so any value will do.
    const s = t.stamp(123_456, 1_000_000);
    expect(s.source).toBe('rwc-estimated');
    expect(s.unixMs).toBeCloseTo(unixMs, 6);
    // Half the round trip: the best a single exchange can say.
    expect(t.state.anchorUncertaintyMs).toBe(20);
  });

  it('accounts for host time between the reading and the first sample', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { rttMs: 10, aligned: false });
    const s = t.stamp(1000, 1_000_250);
    expect(s.unixMs).toBeCloseTo(unixMs + 250, 0);
  });

  it('is unaffected by the counter’s own phase', () => {
    // The Shimmer3's counter runs from boot, so its value carries no time
    // information at all — only its DIFFERENCES do.
    const a = new StreamTimeline();
    a.anchorToRwc(rwcTicks, 1_000_000, { aligned: false });
    const b = new StreamTimeline();
    b.anchorToRwc(rwcTicks, 1_000_000, { aligned: false });
    expect(a.stamp(5, 1_000_000).unixMs).toBeCloseTo(b.stamp(9_000_000, 1_000_000).unixMs!, 6);
  });
});

describe('host anchoring (the Consensys method)', () => {
  it('takes the first sample as now, then follows the device clock', () => {
    const t = new StreamTimeline();
    t.anchorToHost(1_700_000_000_000, { rttMs: 30 });
    const first = t.stamp(500_000, 1_700_000_000_000);
    expect(first.source).toBe('host');
    expect(first.unixMs).toBe(1_700_000_000_000);
    // Java's formula: unixMs = deviceMs + (hostMs1 - deviceMs1).
    const next = t.stamp(500_000 + 32_768, 1_700_000_000_999);
    expect(next.unixMs).toBeCloseTo(1_700_000_001_000, 6);
    expect(t.state.anchorUncertaintyMs).toBe(15);
  });
});

describe('anchor lifecycle', () => {
  const unixMs = Date.UTC(2026, 8, 9, 12, 0, 0);
  const rwcTicks = BigInt(Math.round(unixMs * TICKS_PER_MS));

  it('reports no wall-clock time before an anchor', () => {
    const t = new StreamTimeline();
    const s = t.stamp(1000, 1_000_000);
    expect(s.unixMs).toBeNull();
    expect(s.source).toBeNull();
    expect(t.anchored).toBe(false);
    // The device clock still works — that needs no anchor.
    expect(s.deviceMs).toBeCloseTo(1000 / TICKS_PER_MS, 9);
  });

  it('re-anchors when the device’s clock is written', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { aligned: true });
    t.stamp(Number(rwcTicks % BigInt(MOD24)), 1_000_000);
    const before = t.state.anchorUnixMs!;

    // A clock write steps the very counter the samples are timed by, so the old
    // anchor is void and a fresh reading replaces it.
    const stepped = rwcTicks + BigInt(60 * 60 * TICKS_PER_SECOND);
    t.anchorToRwc(stepped, 1_001_000, { aligned: true });
    expect(t.anchored).toBe(false);
    const after = t.stamp(Number(stepped % BigInt(MOD24)), 1_001_000);
    expect(after.unixMs! - before).toBeCloseTo(3_600_000, 0);
  });

  it('re-binds the anchor to the next stream, without another clock read', () => {
    // A reset drops the BINDING (which is to an unwrapped tick origin that is
    // about to start again) but keeps the REQUEST (which says what the device's
    // clock read at a known host time, and stays true). So one reading on
    // connect gives every later stream a wall clock for free.
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { aligned: true });
    t.stamp(Number(rwcTicks % BigInt(MOD24)), 1_000_000);
    expect(t.anchored).toBe(true);

    t.reset();
    expect(t.anchored).toBe(false);
    expect(t.hasAnchorRequest).toBe(true);

    // 100 seconds later, a new stream. Still exact: an aligned anchor reads the
    // answer out of each sample's own counter bits.
    const laterTicks = rwcTicks + BigInt(100 * TICKS_PER_SECOND);
    const s = t.stamp(Number(laterTicks % BigInt(MOD24)), 1_100_000);
    expect(s.source).toBe('rwc-aligned');
    expect(s.unixMs).toBeCloseTo(unixMs + 100_000, 3);
  });

  it('re-applies a host anchor to the new stream’s first sample', () => {
    const t = new StreamTimeline();
    t.anchorToHost(1_700_000_000_000);
    t.stamp(1000, 1_700_000_000_000);
    t.reset();
    // "Now" is whenever the new stream's first sample arrives, which is what
    // the Consensys method means.
    const s = t.stamp(50_000, 1_700_000_030_000);
    expect(s.source).toBe('host');
    expect(s.unixMs).toBe(1_700_000_030_000);
  });

  it('forgets the request too when the anchor is cleared', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { aligned: true });
    t.stamp(Number(rwcTicks % BigInt(MOD24)), 1_000_000);
    t.clearAnchor();
    expect(t.hasAnchorRequest).toBe(false);
    t.reset();
    expect(t.stamp(1000, 1_000_100).unixMs).toBeNull();
  });

  it('clears an anchor on request without disturbing the unwrap', () => {
    const t = new StreamTimeline();
    t.anchorToRwc(rwcTicks, 1_000_000, { aligned: true });
    t.stamp(MOD24 - 640, 1_000_000);
    t.clearAnchor();
    const after = t.stamp(0, 1_000_020);
    expect(after.unixMs).toBeNull();
    expect(after.unwrappedTicks).toBe(MOD24);
  });

  it('reports its state for a host to display', () => {
    const t = new StreamTimeline();
    expect(t.state).toEqual({
      source: null,
      anchorHostMs: null,
      anchorUnixMs: null,
      anchorUncertaintyMs: 0,
      skewMs: null,
      wraps: 0,
      timestampBits: 24,
    });
  });
});
