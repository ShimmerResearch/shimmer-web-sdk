/**
 * CSV recording: turn a live stream into a file on the host.
 *
 * Promoted from shimmer-capture-web's `common/csv-recorder.js` (DEV-1116) so
 * that page and verisense-device-console share one copy. Two layers:
 *
 * - {@link createCsvTableWriter} writes ONE file: a header row, an optional
 *   units row, then whatever cells the caller pushes. Every consumer's
 *   recorder is built on it.
 * - {@link createCsvRecorder} is the {@link ObjectCluster} recorder the
 *   capture page uses — same API and options as the page-local original.
 *   Verisense streams go through `createVerisenseStreamRecorder`
 *   (`devices/verisense/streamCsv.ts`), which runs one writer per sensor
 *   stream.
 *
 * Cells go through {@link csvCell}, so a unit or a device name containing a
 * comma cannot shift every following column, and rows stream to disk through
 * the File System Access API instead of being held in memory until the user
 * stops — a 512 Hz session with 12 channels is tens of megabytes of string,
 * and an in-memory recording loses all of it if the tab is closed.
 *
 * That choice decides what happens when a write to the picked file fails
 * mid-recording: there is no complete copy to fall back on, so the recording
 * ENDS there rather than quietly continuing into a second, partial file. See
 * `fail()` in {@link createCsvTableWriter}.
 *
 * No DOM access at import time.
 */

import { csvCell } from './csv.js';
import type { FieldKind } from './types.js';

/** How often buffered rows are handed to the sink, by default. */
const FLUSH_INTERVAL_MS = 1000;

const encoder = new TextEncoder();

/** A logger, or a single function every message goes to. */
export type CsvRecorderLog =
  | ((message: string) => void)
  | {
      log?: (message: string) => void;
      warn?: (message: string) => void;
      error?: (message: string) => void;
    };

/**
 * Where a file's bytes go. `FileSystemWritableFileStream` satisfies this, and
 * so does anything a test wants to put in its place.
 */
export interface CsvByteSink {
  write(data: Uint8Array<ArrayBuffer>): Promise<void> | void;
  close(): Promise<void> | void;
  abort?(reason?: unknown): Promise<void> | void;
}

/** What a finished (or abandoned) file holds. */
export interface CsvFileResult {
  /** Rows that actually reached the file — what it holds. */
  rows: number;
  /** Rows the recorder accepted that never reached it. Non-zero only on failure. */
  rowsDropped: number;
  bytes: number;
  fileName: string;
  /** False when a write failed part way through; `rows`/`bytes` then describe the short file. */
  complete: boolean;
  error: string | null;
}

/** Hand a finished in-memory file to the user. */
export type CsvDownload = (fileName: string, blob: Blob) => void;

function makeLogger(log: CsvRecorderLog | undefined) {
  const logger = typeof log === 'function' ? { log } : (log ?? {});
  return {
    warn: (m: unknown) => (logger.warn ?? logger.log)?.(String(m)),
    error: (m: unknown) => (logger.error ?? logger.warn ?? logger.log)?.(String(m)),
  };
}

function errorText(e: unknown): string {
  return String((e as { message?: unknown } | null)?.message ?? e);
}

/**
 * Save a Blob through a temporary `<a download>`. The default for in-memory
 * recordings; needs a DOM, which it looks for only when called.
 */
export function downloadCsvBlob(fileName: string, blob: Blob): void {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc || typeof URL?.createObjectURL !== 'function') {
    throw new Error('no document to download into');
  }
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = fileName;
  doc.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after a delay: some browsers invalidate the URL before the
  // download starts if it is revoked synchronously.
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** Options for {@link createCsvTableWriter}. */
export interface CsvTableWriterOptions {
  /** Shown in results and log lines; also the download name in memory mode. */
  fileName: string;
  /** The heading row, written first. */
  header: readonly unknown[];
  /** A second heading row of units. Omit or pass null for none. */
  units?: readonly unknown[] | null;
  /**
   * Where the bytes go. A promise is allowed — rows queue until it settles,
   * so a file can be opened asynchronously without dropping the rows that
   * arrive meanwhile; a rejection ends the recording like a failed write.
   * Omit, or pass null, to buffer in memory and hand the file to `download`
   * on `stop()`.
   */
  sink?: CsvByteSink | Promise<CsvByteSink> | null;
  /** Memory mode only: receives the finished file. Defaults to {@link downloadCsvBlob}. */
  download?: CsvDownload;
  /** How often buffered rows are handed to the sink. */
  flushIntervalMs?: number;
  log?: CsvRecorderLog;
  /**
   * Called once, from the writer's own timeline, when a write fails and the
   * recording is abandoned. Receives what `stop()` would return. `active` is
   * already false by then; the page should repaint and say so somewhere the
   * user will see it (the log line this module writes is not enough on its
   * own). Not called for a failure discovered inside `stop()` — the caller
   * already has the result in hand.
   */
  onError?: (result: CsvFileResult & { complete: false; error: string }) => void;
}

/** One CSV file being written. See {@link createCsvTableWriter}. */
export interface CsvTableWriter {
  /** Append one row. Returns false once the writer is no longer active. */
  pushCells(cells: readonly unknown[]): boolean;
  /** Close the file (or download the buffer) and report what actually landed. Idempotent. */
  stop(): Promise<CsvFileResult>;
  /** What the file holds so far. */
  result(): CsvFileResult;
  readonly active: boolean;
  /** Rows accepted so far — the live counter a page shows while recording. */
  readonly rowsAccepted: number;
  readonly fileName: string;
}

/**
 * Start writing one CSV file: the header (and units) rows go out at once,
 * then every {@link CsvTableWriter.pushCells} row, flushed every
 * `flushIntervalMs`.
 */
export function createCsvTableWriter(opts: CsvTableWriterOptions): CsvTableWriter {
  const { warn, error: err } = makeLogger(opts.log);
  const fileName = opts.fileName;
  const flushIntervalMs = opts.flushIntervalMs ?? FLUSH_INTERVAL_MS;
  const toFile = opts.sink != null;

  let active = true;
  /** Rows `pushCells()` accepted. */
  let rowsIn = 0;
  /** Rows that actually reached the sink — what the file holds. */
  let rowsOut = 0;
  let bytes = 0;
  /**
   * Set the first time a write to the file fails, and never cleared. Once
   * set, the recording is over — see `fail()`.
   */
  let failure: string | null = null;
  /** True inside `stop()`, so a failure there is reported by return, not callback. */
  let stopping = false;
  let stopped = false;
  let pending: string[] = [];
  let lastFlushMs = 0;
  /** The open sink, once it has resolved. */
  let writable: CsvByteSink | null = null;
  /**
   * Set while a failure is committing or discarding the stream in the
   * background, so `stop()` can wait for the handle to be released.
   */
  let dying: Promise<void> | null = null;
  /** In memory mode, the whole file. */
  let memory: string[] = [];

  function row(cells: readonly unknown[]): string {
    return cells.map(csvCell).join(',') + '\r\n';
  }

  function result(): CsvFileResult {
    return {
      rows: rowsOut,
      rowsDropped: Math.max(0, rowsIn - rowsOut),
      bytes,
      fileName,
      complete: failure === null,
      error: failure,
    };
  }

  /**
   * A write to the file failed. End the recording here.
   *
   * The tempting alternative — keep going and hand the rest to an in-memory
   * buffer — produces TWO plausible-looking files: a truncated one where the
   * user asked for it, and a downloaded one holding only the post-failure
   * tail, with nothing on either saying it is a fragment. Making that
   * download complete instead would mean retaining every row in memory for
   * the whole session on the off chance of a failure, and not doing that is
   * the reason this module streams at all.
   *
   * So: one file, short, and said out loud — in the log, through `onError`,
   * and in what `stop()` returns.
   */
  function fail(e: unknown, what: 'open' | 'write' | 'close' | 'download'): void {
    if (failure) return; // the first failure is the interesting one
    failure = errorText(e);
    active = false;
    // Hand the stream to the cleanup below before clearing the reference, so
    // nothing else can write to it in the meantime.
    const orphan = writable;
    writable = null;
    pending = [];
    memory = [];
    const r = result();
    // Release the file. Dropping the reference alone leaves the handle locked
    // and the file EMPTY: a FileSystemWritableFileStream writes to a swap file
    // that only reaches the real file on close(), so with neither a close()
    // nor an abort() the user is left 0 bytes while the message below promises
    // a short one. So commit what already landed, and fall back to abort()
    // when even that fails - or go straight there when close() is what
    // failed, since there is nothing left to commit through.
    if (orphan) {
      const discard = () => Promise.resolve(orphan.abort?.()).catch(() => {});
      dying = what === 'close' ? discard() : Promise.resolve(orphan.close()).catch(discard);
    }
    err(
      `CSV ${what} failed: ${failure} — recording stopped. ${fileName} is ` +
        `INCOMPLETE: ${r.rows} rows written, ${r.rowsDropped} lost.`,
    );
    // Inside stop() the caller is already about to read the result, so a
    // callback would only duplicate it.
    if (stopping) return;
    try {
      opts.onError?.(r as CsvFileResult & { complete: false; error: string });
    } catch (cbError) {
      warn(`CSV onError handler threw: ${errorText(cbError)}`);
    }
  }

  /**
   * Serialises writes. `pushCells()` is synchronous, so a flush is kicked off
   * and chained rather than awaited; `stop()` awaits the tail. In file mode
   * the chain starts by waiting for the sink, which is what lets rows queue
   * behind a file that is still being opened.
   */
  let writeChain: Promise<void> = toFile
    ? Promise.resolve(opts.sink as CsvByteSink | Promise<CsvByteSink>).then(
        (s) => {
          if (failure) return;
          writable = s;
        },
        (e) => fail(e, 'open'),
      )
    : Promise.resolve();

  /**
   * Hand everything buffered to the sink. Returns a promise, but callers on
   * the hot path deliberately do not await it.
   */
  function flush(): Promise<void> {
    if (failure) {
      pending = [];
      return writeChain;
    }
    lastFlushMs = performance.now();
    if (!pending.length) return writeChain;
    const chunk = pending.join('');
    pending = [];
    // Rows the file will hold once THIS chunk lands. Counted on success only,
    // so a failure cannot leave `stop()` claiming rows that never arrived.
    const rowsAfter = rowsIn;
    if (toFile) {
      const encoded = encoder.encode(chunk);
      writeChain = writeChain
        .then(async () => {
          // Read at run time, not at chain time: the sink may have resolved
          // since, or a failure may have taken it away.
          const sink = writable;
          if (!sink) return;
          await sink.write(encoded);
          bytes += encoded.byteLength;
          rowsOut = rowsAfter;
        })
        .catch((e) => fail(e, 'write'));
    } else {
      memory.push(chunk);
      bytes += encoder.encode(chunk).byteLength;
      rowsOut = rowsAfter;
    }
    return writeChain;
  }

  function pushCells(cells: readonly unknown[]): boolean {
    if (!active) return false;
    pending.push(row(cells));
    rowsIn++;
    if (performance.now() - lastFlushMs >= flushIntervalMs) flush();
    return true;
  }

  /**
   * Close the file (or download the buffer) and report what actually landed.
   * Idempotent: calling it again returns the same numbers without writing.
   *
   * `complete` is false — and `error` set — when a write failed part way
   * through. `rows`/`bytes` then describe the truncated file, and
   * `rowsDropped` says how much of the capture never reached it.
   */
  async function stop(): Promise<CsvFileResult> {
    // A failure mid-session already cleared `active`, so this is the path a
    // caller reaches after one. Still wait for the stream: the cleanup runs in
    // the background from fail(), and the file is not on disk until it lands.
    if (!active || stopped) {
      if (dying) {
        await dying;
        dying = null;
      }
      return result();
    }
    active = false;
    stopped = true;
    stopping = true;
    await flush();
    if (writable) {
      try {
        await writable.close();
      } catch (e) {
        fail(e, 'close');
      }
      writable = null;
    } else if (!toFile && memory.length) {
      try {
        (opts.download ?? downloadCsvBlob)(
          fileName,
          new Blob(memory, { type: 'text/csv;charset=utf-8' }),
        );
      } catch (e) {
        fail(e, 'download');
      }
    }
    // A failure left the stream being committed or discarded in the
    // background. Wait for it, so the result is not reported before the file
    // is written and a caller that starts recording again immediately does
    // not meet a lock.
    if (dying) {
      await dying;
      dying = null;
    }
    memory = [];
    stopping = false;
    return result();
  }

  pending.push(row(opts.header));
  if (opts.units) pending.push(row(opts.units));
  flush();

  return {
    pushCells,
    stop,
    result,
    get active() {
      return active;
    },
    get rowsAccepted() {
      return rowsIn;
    },
    fileName,
  };
}

// ---------------------------------------------------------------------------
// The ObjectCluster recorder (Shimmer3 / Shimmer3R streams)
// ---------------------------------------------------------------------------

/** `shimmer-capture-2026-09-02_141530.csv` */
function defaultFileName(): string {
  return `shimmer-capture-${localStamp(new Date())}.csv`;
}

/** `2026-09-02_141530`, in local time. */
export function localStamp(d: Date): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}` +
    `_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  );
}

/** One data column of a {@link createCsvRecorder} file. */
export interface CsvRecorderColumn {
  name: string;
  kind?: FieldKind;
  unit?: string | null;
  header?: string;
}

/** A frame as {@link createCsvRecorder} reads it — an ObjectCluster fits. */
export interface CsvRecorderFrame {
  fields: readonly { name: string; value: unknown; kind: FieldKind }[];
}

/** Options for {@link createCsvRecorder}. */
export interface CsvRecorderOptions {
  /** Names the file; called once per `start()`, so a name can carry the device id or a trial name. */
  fileNameFn?: () => string;
  /**
   * Stream to a file the user picks (default). Set false, or run in a browser
   * without `showSaveFilePicker`, to buffer in memory and download on `stop()`.
   */
  preferFileSystemAccess?: boolean;
  /** Emit a second header row of units (default true). */
  unitsRow?: boolean;
  /** Emit a leading `HostTime_ms` (default true). */
  hostTimeColumn?: boolean;
  log?: CsvRecorderLog;
  /** See {@link CsvTableWriterOptions.onError}. */
  onError?: CsvTableWriterOptions['onError'];
  /** Memory mode only: receives the finished file. Defaults to {@link downloadCsvBlob}. */
  download?: CsvDownload;
}

/** A {@link createCsvRecorder} instance. */
export interface CsvRecorder {
  /**
   * Open a file and write the header. Must be called from a user gesture
   * when `preferFileSystemAccess` is on. Resolves false if the user
   * cancelled the picker, or there was nothing to record.
   */
  start(columns: readonly CsvRecorderColumn[]): Promise<boolean>;
  /** Append one frame. Returns false when the row was refused. */
  push(hostMs: number, frame: CsvRecorderFrame): boolean;
  stop(): Promise<CsvFileResult>;
  readonly active: boolean;
}

type SaveFilePicker = (opts: {
  suggestedName?: string;
  types?: { description: string; accept: Record<string, string[]> }[];
}) => Promise<FileSystemFileHandle>;

/**
 * Create a CSV recorder for {@link ObjectCluster} frames.
 *
 * Each row is `HostTime_ms` (optional), the raw `TIMESTAMP` tick counter, and
 * then the data columns the page derived from the first frame — typically
 * with `objectClusterColumns`.
 */
export function createCsvRecorder(opts: CsvRecorderOptions = {}): CsvRecorder {
  const fileNameFn = opts.fileNameFn ?? defaultFileName;
  const preferFsa = opts.preferFileSystemAccess !== false;
  const unitsRow = opts.unitsRow !== false;
  const hostTimeColumn = opts.hostTimeColumn !== false;
  const { warn } = makeLogger(opts.log);

  let writer: CsvTableWriter | null = null;
  let columns: { name: string; kind: FieldKind; unit: string; header: string }[] = [];
  /** `name|kind` → column index. Built once, so `push` is a single pass. */
  let routeByKey = new Map<string, number>();
  /** Frame width the file was opened for; a change means the schema moved. */
  let expectedFieldCount: number | null = null;
  let widthWarned = false;
  /** Guards the gap between `start()` being called and its picker settling. */
  let starting = false;

  /**
   * Is this the tick-counter timestamp that gets its own second column?
   *
   * Kind, not just name: the SDK emits `TIMESTAMP` twice per frame — `raw` in
   * ticks and `cal` in unwrapped milliseconds — and only the first is the
   * dedicated column. Matching on the name alone dropped the calibrated one
   * from the file and, on the row path, let it overwrite the raw cell it was
   * mistaken for. `null` counts as raw so a frame from before the kinds were
   * set still writes its timestamp where it always did.
   */
  function isRawTimestamp(f: { name: string; kind?: FieldKind }): boolean {
    return f.name === 'TIMESTAMP' && (f.kind ?? 'raw') === 'raw';
  }

  /**
   * The RAW `TIMESTAMP` is written separately, as the second column, and is
   * dropped from `cols` if present; a `TIMESTAMP` of any other kind is kept
   * as an ordinary column, because `TIMESTAMP_CAL` is a different number —
   * unwrapped milliseconds, where the raw column is a 24-bit tick counter
   * that restarts every 512 seconds. Consensys writes both.
   */
  async function start(cols: readonly CsvRecorderColumn[]): Promise<boolean> {
    if (writer?.active || starting) {
      warn('CSV recorder already running');
      return false;
    }
    columns = (cols ?? [])
      .filter((c) => c?.name && !isRawTimestamp(c))
      .map((c) => ({
        name: c.name,
        kind: c.kind ?? null,
        unit: c.unit ?? '',
        header: c.header ?? (c.kind ? `${c.name}_${c.kind}` : c.name),
      }));
    if (!columns.length) {
      warn('CSV recorder: nothing to record (no columns)');
      return false;
    }
    routeByKey = new Map(columns.map((c, i) => [`${c.name}|${c.kind ?? ''}`, i]));
    expectedFieldCount = null;
    widthWarned = false;

    let fileName = fileNameFn();
    let sink: CsvByteSink | null = null;
    const picker = (globalThis as { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    if (preferFsa && typeof picker === 'function') {
      starting = true;
      try {
        const handle = await picker({
          suggestedName: fileName,
          types: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
        });
        sink = await handle.createWritable();
        fileName = handle.name ?? fileName;
      } catch (e) {
        // AbortError is the user closing the picker — that is a "no", not a
        // reason to start recording somewhere they did not ask for.
        if ((e as { name?: string } | null)?.name === 'AbortError') return false;
        warn(`file picker unavailable (${errorText(e)}) — buffering in memory instead`);
        sink = null;
      } finally {
        starting = false;
      }
    }

    const head: unknown[] = [];
    if (hostTimeColumn) head.push('HostTime_ms');
    head.push('TIMESTAMP');
    for (const c of columns) head.push(c.header);

    let units: unknown[] | null = null;
    if (unitsRow) {
      units = [];
      if (hostTimeColumn) units.push('ms');
      units.push('ticks');
      for (const c of columns) units.push(c.unit ?? '');
    }

    writer = createCsvTableWriter({
      fileName,
      header: head,
      units,
      sink,
      download: opts.download,
      log: opts.log,
      onError: opts.onError,
    });
    return true;
  }

  function push(hostMs: number, frame: CsvRecorderFrame): boolean {
    if (!writer?.active) return false;
    const fields = frame?.fields;
    if (!fields) return false;

    /* Rectangularity is the whole value of a CSV. If the device's schema
     * changes mid-recording (a reconfigure, or a second stream starting) the
     * frame width moves, and appending those rows under the old header
     * silently misaligns every column. Refuse them and say so once — a
     * thousand identical warnings at 512 Hz would bury the log. */
    if (expectedFieldCount === null) {
      expectedFieldCount = fields.length;
    } else if (fields.length !== expectedFieldCount) {
      if (!widthWarned) {
        widthWarned = true;
        warn(
          `CSV: frame has ${fields.length} fields, file was opened for ${expectedFieldCount} — rows refused until the stream is restarted`,
        );
      }
      return false;
    }

    const cells: unknown[] = new Array(columns.length + 1 + (hostTimeColumn ? 1 : 0)).fill('');
    let at = 0;
    if (hostTimeColumn) cells[at++] = Math.round(hostMs);
    const tsAt = at++;
    const base = at;
    for (const f of fields) {
      if (isRawTimestamp(f)) {
        cells[tsAt] = f.value;
        continue;
      }
      const idx = routeByKey.get(`${f.name}|${f.kind ?? ''}`);
      if (idx !== undefined) cells[base + idx] = f.value;
    }
    return writer.pushCells(cells);
  }

  async function stop(): Promise<CsvFileResult> {
    if (!writer) {
      return {
        rows: 0,
        rowsDropped: 0,
        bytes: 0,
        fileName: '',
        complete: true,
        error: null,
      };
    }
    return writer.stop();
  }

  return {
    start,
    push,
    stop,
    get active() {
      return !!writer?.active;
    },
  };
}
