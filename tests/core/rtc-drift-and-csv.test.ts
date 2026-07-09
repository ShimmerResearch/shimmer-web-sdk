import { describe, it, expect } from 'vitest';
import { RtcDriftMonitor } from '../../src/core/RtcDriftMonitor.js';
import { csvCell } from '../../src/core/csv.js';

/** Feed `n` samples at `cadenceSec` cadence with the device drifting at
 * `ppm`, starting from unix time `t0`. */
function feedDrift(
  mon: RtcDriftMonitor,
  n: number,
  ppm: number,
  cadenceSec = 300,
  t0 = 1_750_000_000,
) {
  for (let i = 0; i < n; i++) {
    const hostSec = t0 + i * cadenceSec;
    mon.addSample({
      hostSec,
      devSec: hostSec + (ppm / 1e6) * (i * cadenceSec),
      rttMs: 40,
      perfMs: i * cadenceSec * 1000,
    });
  }
}

describe('RtcDriftMonitor', () => {
  it('recovers a synthetic drift rate from the least-squares fit', () => {
    const mon = new RtcDriftMonitor();
    feedDrift(mon, 12, 49.4);
    expect(mon.ppmFit()).toBeCloseTo(49.4, 3);
    expect(mon.deviceSteps).toBe(0);
    expect(mon.hostSteps).toBe(0);
  });

  it('needs two samples before fitting', () => {
    const mon = new RtcDriftMonitor();
    expect(mon.ppmFit()).toBeNull();
    feedDrift(mon, 1, 100);
    expect(mon.ppmFit()).toBeNull();
  });

  it('attributes a wall-clock jump to the host and rebaselines', () => {
    const mon = new RtcDriftMonitor();
    feedDrift(mon, 5, 1000);
    // Host NTP step: wall clock jumps -1.4 s while the monotonic clock
    // advances a normal 300 s (the DEV-844 signature).
    const last = mon.samples[mon.samples.length - 1];
    const ev = mon.addSample({
      hostSec: last.hostSec + 300 - 1.4,
      devSec: last.devSec + 300,
      rttMs: 40,
      perfMs: last.perfMs + 300_000,
    });
    expect(ev.kind).toBe('host-step');
    expect(mon.hostSteps).toBe(1);
    expect(mon.deviceSteps).toBe(0);
    // Fit restarts from the post-step sample only.
    expect(mon.samples.length).toBe(1);
  });

  it('counts a device clock step without rebaselining', () => {
    const mon = new RtcDriftMonitor();
    feedDrift(mon, 3, 0);
    const last = mon.samples[mon.samples.length - 1];
    const ev = mon.addSample({
      hostSec: last.hostSec + 300,
      devSec: last.devSec + 300 + 2.5, // device jumps 2.5 s
      rttMs: 40,
      perfMs: last.perfMs + 300_000,
    });
    expect(ev.kind).toBe('device-step');
    expect(mon.deviceSteps).toBe(1);
    expect(mon.samples.length).toBe(4);
  });

  it('rebaseline() drops samples but keeps counters; reset() clears both', () => {
    const mon = new RtcDriftMonitor();
    feedDrift(mon, 3, 0);
    mon.deviceSteps = 2;
    mon.rebaseline();
    expect(mon.samples.length).toBe(0);
    expect(mon.deviceSteps).toBe(2);
    mon.reset();
    expect(mon.deviceSteps).toBe(0);
  });

  it('exports the DEV-844 CSV format', () => {
    const mon = new RtcDriftMonitor();
    feedDrift(mon, 2, 100);
    const rows = mon.toCsvRows();
    expect(rows[0]).toBe('host_iso,host_unix_s,device_unix_s,offset_s,rtt_ms,perf_monotonic_s');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toMatch(/^\d{4}-\d{2}-\d{2}T.*,1750000000\.000,/);
  });

  it('reports the elapsed sample span in minutes', () => {
    const mon = new RtcDriftMonitor();
    expect(mon.elapsedMinutes()).toBe(0);
    feedDrift(mon, 5, 0, 300);
    expect(mon.elapsedMinutes()).toBeCloseTo(20, 6);
  });
});

describe('csvCell', () => {
  it('passes plain values through', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell(42)).toBe('42');
  });

  it('collapses whitespace runs', () => {
    expect(csvCell('  a \n b  ')).toBe('a b');
  });

  it('quotes cells containing commas or quotes', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('renders null/undefined as empty', () => {
    expect(csvCell(null)).toBe('');
    expect(csvCell(undefined)).toBe('');
  });
});
