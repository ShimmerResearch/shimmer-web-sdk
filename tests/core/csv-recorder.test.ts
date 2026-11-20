import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  createCsvRecorder,
  createCsvTableWriter,
  type CsvFileResult,
} from '../../src/core/csvRecorder.js';
import { ObjectCluster } from '../../src/core/ObjectCluster.js';
import { FakeWritable, blobText } from './fakeFileSystem.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createCsvTableWriter', () => {
  it('writes the header, units and rows, CRLF-terminated, with cells escaped', async () => {
    const sink = new FakeWritable();
    const w = createCsvTableWriter({
      fileName: 'a.csv',
      header: ['t', 'name'],
      units: ['ms', ''],
      sink,
    });
    w.pushCells([1, 'plain']);
    w.pushCells([2, 'has, comma']);
    const r = await w.stop();
    expect(sink.lines()).toEqual(['t,name', 'ms,', '1,plain', '2,"has, comma"']);
    expect(sink.closed).toBe(true);
    expect(r).toEqual({
      rows: 2,
      rowsDropped: 0,
      bytes: new TextEncoder().encode(sink.text()).byteLength,
      fileName: 'a.csv',
      complete: true,
      error: null,
    });
  });

  it('queues rows behind a sink that is still opening', async () => {
    let resolve!: (s: FakeWritable) => void;
    const sink = new FakeWritable();
    const w = createCsvTableWriter({
      fileName: 'late.csv',
      header: ['v'],
      sink: new Promise<FakeWritable>((r) => (resolve = r)),
      flushIntervalMs: 0,
    });
    w.pushCells([1]);
    w.pushCells([2]);
    resolve(sink);
    const r = await w.stop();
    expect(sink.lines()).toEqual(['v', '1', '2']);
    expect(r.rows).toBe(2);
  });

  it('flushes on the interval, not on every row', async () => {
    const sink = new FakeWritable();
    const w = createCsvTableWriter({
      fileName: 'f.csv',
      header: ['v'],
      sink,
      flushIntervalMs: 60_000,
    });
    for (let i = 0; i < 50; i++) w.pushCells([i]);
    await Promise.resolve();
    await Promise.resolve();
    // Only the header has gone out; the rows wait for the interval or stop().
    expect(sink.writes).toBe(1);
    await w.stop();
    expect(sink.writes).toBe(2);
    expect(sink.lines()).toHaveLength(51);
  });

  it('ends the recording on a failed write, commits what landed, and says so once', async () => {
    const sink = new FakeWritable();
    sink.failWriteAt = 2; // header write and the first row flush succeed
    const onError = vi.fn();
    const errors: string[] = [];
    const w = createCsvTableWriter({
      fileName: 'short.csv',
      header: ['v'],
      sink,
      flushIntervalMs: 0,
      onError,
      log: { error: (m) => errors.push(m) },
    });
    w.pushCells([1]); // flush #2 — lands
    w.pushCells([2]); // flush #3 — fails
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(w.active).toBe(false);
    expect(w.pushCells([3])).toBe(false);

    const info = onError.mock.calls[0][0] as CsvFileResult;
    expect(info).toMatchObject({ rows: 1, rowsDropped: 1, complete: false, error: 'disk full' });
    expect(errors[0]).toMatch(/INCOMPLETE: 1 rows written, 1 lost/);

    const r = await w.stop();
    // The short file was committed, not left empty behind a locked handle.
    expect(sink.closed).toBe(true);
    expect(sink.lines()).toEqual(['v', '1']);
    expect(r).toEqual(info);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports a close failure by return, not callback, and aborts the stream', async () => {
    const sink = new FakeWritable();
    sink.failClose = true;
    const onError = vi.fn();
    const w = createCsvTableWriter({ fileName: 'c.csv', header: ['v'], sink, onError });
    w.pushCells([1]);
    const r = await w.stop();
    expect(r.complete).toBe(false);
    expect(r.error).toBe('close refused');
    expect(sink.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats a sink that fails to open like a failed write', async () => {
    const onError = vi.fn();
    const w = createCsvTableWriter({
      fileName: 'o.csv',
      header: ['v'],
      sink: Promise.reject(new Error('permission denied')),
      onError,
    });
    w.pushCells([1]);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    const r = await w.stop();
    expect(r).toMatchObject({
      rows: 0,
      rowsDropped: 1,
      complete: false,
      error: 'permission denied',
    });
  });

  it('buffers in memory without a sink and hands the file to `download` on stop', async () => {
    const download = vi.fn();
    const w = createCsvTableWriter({ fileName: 'm.csv', header: ['v'], download });
    w.pushCells([1]);
    w.pushCells([2]);
    expect(download).not.toHaveBeenCalled();
    const r = await w.stop();
    expect(download).toHaveBeenCalledTimes(1);
    const [name, blob] = download.mock.calls[0];
    expect(name).toBe('m.csv');
    expect(await blobText(blob)).toBe('v\r\n1\r\n2\r\n');
    expect(r).toMatchObject({ rows: 2, complete: true });
  });

  it('is idempotent: a second stop writes nothing and returns the same numbers', async () => {
    const sink = new FakeWritable();
    const w = createCsvTableWriter({ fileName: 'i.csv', header: ['v'], sink });
    w.pushCells([1]);
    const a = await w.stop();
    const writes = sink.writes;
    const b = await w.stop();
    expect(b).toEqual(a);
    expect(sink.writes).toBe(writes);
  });
});

describe('createCsvRecorder (ObjectCluster)', () => {
  function frame(ticks: number, calMs: number, x: number): ObjectCluster {
    const oc = new ObjectCluster('Shimmer3R-TEST');
    oc.add('TIMESTAMP', ticks, 'ticks', 'raw');
    oc.add('TIMESTAMP', calMs, 'ms', 'cal');
    oc.add('ACCEL_X', x, 'm/s^2', 'cal');
    return oc;
  }

  const columns = [
    { name: 'TIMESTAMP', kind: 'raw' as const, unit: 'ticks' },
    { name: 'TIMESTAMP', kind: 'cal' as const, unit: 'ms', header: 'TIMESTAMP_CAL' },
    { name: 'ACCEL_X', kind: 'cal' as const, unit: 'm/s^2', header: 'ACCEL_X_CAL' },
  ];

  it('writes the raw TIMESTAMP as its own column and keeps TIMESTAMP_CAL as data', async () => {
    const sink = new FakeWritable();
    vi.stubGlobal('showSaveFilePicker', async () => ({
      name: 'picked.csv',
      createWritable: async () => sink,
    }));
    const rec = createCsvRecorder({ fileNameFn: () => 'suggested.csv' });
    expect(await rec.start(columns)).toBe(true);
    expect(rec.active).toBe(true);
    expect(rec.push(1000.4, frame(32768, 1000, 9.81))).toBe(true);
    const r = await rec.stop();
    expect(sink.lines()).toEqual([
      'HostTime_ms,TIMESTAMP,TIMESTAMP_CAL,ACCEL_X_CAL',
      'ms,ticks,ms,m/s^2',
      '1000,32768,1000,9.81',
    ]);
    expect(r).toMatchObject({ rows: 1, fileName: 'picked.csv', complete: true });
  });

  it('refuses frames whose width moved, once the file is open', async () => {
    const warnings: string[] = [];
    const download = vi.fn();
    const rec = createCsvRecorder({
      preferFileSystemAccess: false,
      download,
      log: { warn: (m) => warnings.push(m) },
    });
    await rec.start(columns);
    expect(rec.push(0, frame(1, 1, 1))).toBe(true);
    const wider = frame(2, 2, 2);
    wider.add('ACCEL_Y', 0, 'm/s^2', 'cal');
    expect(rec.push(0, wider)).toBe(false);
    expect(rec.push(0, wider)).toBe(false);
    expect(warnings.filter((w) => /rows refused/.test(w))).toHaveLength(1);
    const r = await rec.stop();
    expect(r.rows).toBe(1);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('resolves false, and records nothing, when the user cancels the picker', async () => {
    vi.stubGlobal('showSaveFilePicker', async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    const rec = createCsvRecorder();
    expect(await rec.start(columns)).toBe(false);
    expect(rec.active).toBe(false);
    expect(rec.push(0, frame(1, 1, 1))).toBe(false);
  });

  it('falls back to memory when the picker is unavailable for another reason', async () => {
    vi.stubGlobal('showSaveFilePicker', async () => {
      throw new Error('not allowed in this frame');
    });
    const download = vi.fn();
    const warnings: string[] = [];
    const rec = createCsvRecorder({ download, log: { warn: (m) => warnings.push(m) } });
    expect(await rec.start(columns)).toBe(true);
    rec.push(0, frame(1, 1, 1));
    await rec.stop();
    expect(warnings[0]).toMatch(/buffering in memory instead/);
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('refuses to start with no data columns', async () => {
    const rec = createCsvRecorder({ preferFileSystemAccess: false });
    expect(await rec.start([{ name: 'TIMESTAMP', kind: 'raw' }])).toBe(false);
  });

  it('omits the host-time column and units row when asked', async () => {
    const download = vi.fn();
    const rec = createCsvRecorder({
      preferFileSystemAccess: false,
      hostTimeColumn: false,
      unitsRow: false,
      download,
    });
    await rec.start(columns);
    rec.push(0, frame(5, 6, 7));
    await rec.stop();
    expect(await blobText(download.mock.calls[0][1])).toBe(
      'TIMESTAMP,TIMESTAMP_CAL,ACCEL_X_CAL\r\n5,6,7\r\n',
    );
  });
});
