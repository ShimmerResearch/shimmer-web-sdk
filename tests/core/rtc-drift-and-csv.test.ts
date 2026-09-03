import { describe, it, expect } from 'vitest';
import { RtcDriftMonitor } from '../../src/core/RtcDriftMonitor.js';
import { csvCell, csvRow, objectClusterColumns, objectClusterRow } from '../../src/core/csv.js';
import { ObjectCluster } from '../../src/core/ObjectCluster.js';

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

  it('prepends metadata as comment lines before the header', () => {
    const mon = new RtcDriftMonitor();
    feedDrift(mon, 2, 100);
    const rows = mon.toCsvRows({ device: 'SR68 95BC', transport: 'ble', ppm_fit: 42.1 });
    expect(rows[0]).toBe('# device: SR68 95BC');
    expect(rows[1]).toBe('# transport: ble');
    expect(rows[2]).toBe('# ppm_fit: 42.1');
    expect(rows[3]).toBe('host_iso,host_unix_s,device_unix_s,offset_s,rtt_ms,perf_monotonic_s');
    // 3 metadata lines + header + 2 data rows
    expect(rows).toHaveLength(6);
  });

  it('keeps each metadata entry a single clean comment line', () => {
    const mon = new RtcDriftMonitor();
    const rows = mon.toCsvRows({ note: '  line1\r\nline2  ' });
    expect(rows[0]).toBe('# note: line1 line2');
    // header only follows (no samples fed)
    expect(rows).toHaveLength(2);
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

describe('csvRow', () => {
  it('escapes each cell and joins with commas', () => {
    expect(csvRow(['a', 1, null, 'x,y'])).toBe('a,1,,"x,y"');
  });

  it('emits no trailing newline — the caller owns the line ending', () => {
    // A file destined for Excel on Windows wants CRLF, which only the caller
    // knows.
    expect(csvRow(['a'])).toBe('a');
    expect(csvRow([])).toBe('');
  });

  it('writes a value of 0 as a cell, not as an empty one', () => {
    // The trap in every hand-rolled CSV writer: `value || ''` blanks a zero,
    // so a stationary axis reads as missing data.
    expect(csvRow([0, 0.0, -0])).toBe('0,0,0');
  });
});

// ---------------------------------------------------------------------------
// ObjectCluster -> table
// ---------------------------------------------------------------------------

/** A frame shaped like a real one: kindless timestamp, then raw/cal pairs. */
function frame(gx: number, gxCal: number, gsr?: number): ObjectCluster {
  const oc = new ObjectCluster('Shimmer3R-TEST');
  oc.add('TIMESTAMP', 1234, 'ticks', null);
  oc.add('GYRO_X', gx, null, 'raw');
  oc.add('GYRO_X', gxCal, 'deg/s', 'cal');
  if (gsr !== undefined) oc.add('GSR', gsr, 'kOhms', 'cal');
  return oc;
}

describe('objectClusterColumns', () => {
  it('follows the frame field order and names each column by kind', () => {
    const cols = objectClusterColumns(frame(10, 1.5));
    expect(cols.map((c) => c.header)).toEqual(['TIMESTAMP', 'GYRO_X_RAW', 'GYRO_X_CAL']);
    expect(cols.map((c) => c.unit)).toEqual(['ticks', null, 'deg/s']);
    expect(cols.map((c) => c.kind)).toEqual([null, 'raw', 'cal']);
    expect(cols.every((c) => c.name === 'TIMESTAMP' || c.name === 'GYRO_X')).toBe(true);
  });

  it('filters to the requested kinds', () => {
    const oc = frame(10, 1.5);
    expect(objectClusterColumns(oc, { kinds: ['cal'] }).map((c) => c.header)).toEqual([
      'GYRO_X_CAL',
    ]);
    expect(objectClusterColumns(oc, { kinds: ['raw'] }).map((c) => c.header)).toEqual([
      'GYRO_X_RAW',
    ]);
    // Include null to keep the timestamp — a cal-only file drops it otherwise,
    // which is rarely what the caller meant.
    expect(objectClusterColumns(oc, { kinds: ['cal', null] }).map((c) => c.header)).toEqual([
      'TIMESTAMP',
      'GYRO_X_CAL',
    ]);
  });

  it('contributes one column per name/kind pair, even if a frame repeats it', () => {
    const oc = new ObjectCluster('dup');
    oc.add('A', 1, null, 'raw');
    oc.add('A', 2, null, 'raw');
    const cols = objectClusterColumns(oc);
    expect(cols).toHaveLength(1);
    // The first occurrence wins, and the row reader must agree.
    expect(objectClusterRow(oc, cols)).toEqual([1]);
  });

  it('returns nothing for an empty frame rather than throwing', () => {
    expect(objectClusterColumns(new ObjectCluster('empty'))).toEqual([]);
  });
});

describe('objectClusterRow', () => {
  it('projects a frame onto the columns in column order', () => {
    const cols = objectClusterColumns(frame(10, 1.5, 42));
    expect(objectClusterRow(frame(11, 1.6, 43), cols)).toEqual([1234, 11, 1.6, 43]);
  });

  it('writes null for a column the frame does not carry', () => {
    // The reason a column set is fixed once: without this the GSR-less frame
    // would produce a short row and every later cell would shift left.
    const cols = objectClusterColumns(frame(10, 1.5, 42));
    expect(objectClusterRow(frame(11, 1.6), cols)).toEqual([1234, 11, 1.6, null]);
  });

  it('matches the column kind exactly, unlike ObjectCluster.get', () => {
    // `get(name, null)` means "any kind", so a kindless column would otherwise
    // pick up the raw field sharing its name.
    const oc = new ObjectCluster('ambiguous');
    oc.add('A', 7, null, 'raw');
    oc.add('A', 9, null, null);
    const cols = objectClusterColumns(oc);
    expect(cols.map((c) => c.header)).toEqual(['A_RAW', 'A']);
    expect(objectClusterRow(oc, cols)).toEqual([7, 9]);
    // ObjectCluster.get would have answered 7 for the kindless lookup.
    expect(oc.get('A')?.value).toBe(7);
  });

  it('writes null for a kindless column when only a raw field shares the name', () => {
    // The other half of the exact-kind rule: with no kindless field at all,
    // there must be no fallback to the raw one — the cell stays empty.
    const oc = new ObjectCluster('raw only');
    oc.add('A', 7, null, 'raw');
    const cols = [{ name: 'A', kind: null, unit: null, header: 'A' }] as const;
    expect(objectClusterRow(oc, cols)).toEqual([null]);
  });

  it('takes the FIRST of a repeated name/kind pair, not the last', () => {
    // A repeat is a parser bug rather than a supported shape, but which one
    // wins must not drift: `objectClusterColumns` documents the first
    // occurrence, and a row that read the last would silently disagree with
    // the header its own column set produced. Three values, so "first" cannot
    // be mistaken for "last" by a two-element fixture.
    const oc = new ObjectCluster('dup');
    oc.add('A', 1, null, 'raw');
    oc.add('A', 2, null, 'raw');
    oc.add('A', 3, null, 'raw');
    const cols = objectClusterColumns(oc);
    expect(cols.map((c) => c.header)).toEqual(['A_RAW']);
    expect(objectClusterRow(oc, cols)).toEqual([1]);
  });

  it('resolves a repeated name per kind, first within each kind', () => {
    // The same name duplicated across BOTH kinds: each column takes the first
    // field of its own kind, and the kinds do not contaminate each other.
    const oc = new ObjectCluster('dup pairs');
    oc.add('A', 1, null, 'raw');
    oc.add('A', 10, 'g', 'cal');
    oc.add('A', 2, null, 'raw');
    oc.add('A', 20, 'g', 'cal');
    oc.add('A', 100, 'ticks', null);
    oc.add('A', 200, 'ticks', null);
    const cols = objectClusterColumns(oc);
    expect(cols.map((c) => c.header)).toEqual(['A_RAW', 'A_CAL', 'A']);
    expect(objectClusterRow(oc, cols)).toEqual([1, 10, 100]);
  });

  it('reads columns in column order, not frame order', () => {
    // The lookup is an index now, so prove it is still addressed by the column
    // rather than by whatever position the field happened to land in.
    const oc = frame(10, 1.5, 42);
    const cols = objectClusterColumns(oc).slice().reverse();
    expect(cols.map((c) => c.header)).toEqual(['GSR_CAL', 'GYRO_X_CAL', 'GYRO_X_RAW', 'TIMESTAMP']);
    expect(objectClusterRow(oc, cols)).toEqual([42, 1.5, 10, 1234]);
  });

  it('keeps a zero value distinct from a missing one', () => {
    const cols = objectClusterColumns(frame(0, 0, 0));
    expect(objectClusterRow(frame(0, 0), cols)).toEqual([1234, 0, 0, null]);
  });

  it('composes with csvRow into a whole file', () => {
    const first = frame(10, 1.5, 42);
    const cols = objectClusterColumns(first);
    const lines = [
      csvRow(cols.map((c) => c.header)),
      csvRow(cols.map((c) => c.unit)),
      csvRow(objectClusterRow(first, cols)),
      csvRow(objectClusterRow(frame(11, 1.6), cols)),
    ];
    expect(lines).toEqual([
      'TIMESTAMP,GYRO_X_RAW,GYRO_X_CAL,GSR_CAL',
      'ticks,,deg/s,kOhms',
      '1234,10,1.5,42',
      '1234,11,1.6,',
    ]);
  });
});
