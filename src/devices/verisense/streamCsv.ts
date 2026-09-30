/**
 * CSV recording of a live Verisense stream (DEV-1116): one file per sensor
 * stream, in a session folder the user picks.
 *
 * Why one file per stream rather than one wide file: a Verisense sends one
 * packet per SENSOR, each at that sensor's own rate — accel at 51.2 Hz, GSR at
 * 50 Hz, skin temperature at a fraction of a hertz — and the LSM6DSV (id 6)
 * interleaves three sub-streams (accel, gyro, mag) in one FIFO, with each
 * decoded sample carrying exactly one of them. A single table across all of
 * that is mostly empty cells. One file per stream keeps every file
 * rectangular, and the device clock column lines them up.
 *
 * ## Timestamps
 *
 * A Verisense packet carries ONE measured time: the 24-bit tick in its header
 * (32768 Hz) is the time of the packet's LAST sample. The decoder places the
 * other samples backwards from it at the configured rate
 * (`SensorBase.extrapolateSampleTimes`). So every row gets a timestamp,
 * but only one row per packet was measured, and the file says which:
 *
 * | column          | what it is |
 * |-----------------|------------|
 * | `HostTime_ms`   | host `Date.now()` at packet arrival, placed back the same way; epoch ms, so it carries BLE latency jitter |
 * | `DeviceTime_ms` | the device clock, unwrapped, in ms — interpolated on every row but the measured one. Shared by all of a session's files: this is the column that aligns them |
 * | `PacketTick`    | the packet header's raw tick, ONLY on the row it measured (the last of the packet — for id 6, the last of each sub-stream in it); blank elsewhere |
 *
 * Keeping the raw tick on the measured row means anyone can see the anchors
 * and check or redo the interpolation, rather than having to trust it.
 *
 * Caveat, documented rather than fixed here: each decoder unwraps the tick
 * against a 60 s rollover (`SensorBase.TICKS_MAX_VALUE`, matching the C#
 * `Sensor.cs`). A stream whose packets arrived more than 60 s apart would miss
 * a wrap, and its `DeviceTime_ms` would fall a minute behind.
 *
 * ## Column layouts
 *
 * The layout for a stream is derived from its FIRST sample, the way the
 * capture page derives its columns from the first frame: which PPG channels
 * are enabled, and whether a GSR+ unit's ADC packet carries GSR, battery or
 * both, are properties of the configuration, and the configuration cannot
 * change while streaming. A later sample missing a column writes an empty
 * cell rather than shifting the row.
 *
 * No DOM access at import time.
 */

import {
  createCsvTableWriter,
  downloadCsvBlob,
  localStamp,
  type CsvByteSink,
  type CsvFileResult,
  type CsvRecorderLog,
  type CsvTableWriter,
} from '../../core/csvRecorder.js';
import { ensureDirectoryPath } from './protocolDataFlow.js';
import type { StreamPacket } from './VerisenseTypes.js';

/** One data column of a Verisense stream file. */
export interface VerisenseStreamCsvColumn {
  header: string;
  unit: string;
}

/** How one Verisense stream is written. See {@link verisenseStreamCsvLayout}. */
export interface VerisenseStreamCsvLayout {
  /** Stream key, matching the stream-stats keys: `'2'`, `'6:accel'`, … */
  key: string;
  /** Short name used in the file name: `Accel1`, `GSR_Batt`, `Mag`, … */
  label: string;
  sensorId: number;
  /** The data columns, after the {@link VERISENSE_STREAM_CSV_TIME_COLUMNS}. */
  columns: readonly VerisenseStreamCsvColumn[];
  /** Project one decoded sample onto `columns`. */
  row(sample: unknown): unknown[];
}

/** The columns every Verisense stream file starts with. See the module header. */
export const VERISENSE_STREAM_CSV_TIME_COLUMNS: readonly VerisenseStreamCsvColumn[] = [
  { header: 'HostTime_ms', unit: 'ms' },
  { header: 'DeviceTime_ms', unit: 'ms' },
  { header: 'PacketTick', unit: 'ticks' },
];

type AnySample = Record<string, unknown> | null | undefined;
type Triple = { raw?: readonly number[]; cal?: readonly number[]; units?: unknown } | null;

interface ColumnDef {
  header: string;
  unit: string;
  get: (s: AnySample) => unknown;
}

const AXES = ['X', 'Y', 'Z'] as const;

/** Booleans as 1/0, which every analysis tool reads as a number. */
function flag(v: unknown): unknown {
  return typeof v === 'boolean' ? (v ? 1 : 0) : v;
}

/** The unit string a decoder put on a sample, when it put one there. */
function unitOf(units: unknown, fallback: string): string {
  if (typeof units === 'string' && units) return units;
  const cal = (units as { cal?: unknown } | null)?.cal;
  return typeof cal === 'string' && cal ? cal : fallback;
}

/** X/Y/Z raw then X/Y/Z cal for a `{raw, cal}` triple found by `pick`. */
function tripleColumns(
  prefix: string,
  pick: (s: AnySample) => Triple,
  first: AnySample,
  calUnit: string,
  withCal = true,
): ColumnDef[] {
  const unit = unitOf(pick(first)?.units, calUnit);
  const out: ColumnDef[] = AXES.map((axis, i) => ({
    header: `${prefix}_${axis}_raw`,
    unit: 'counts',
    get: (s: AnySample) => pick(s)?.raw?.[i],
  }));
  if (withCal) {
    AXES.forEach((axis, i) =>
      out.push({
        header: `${prefix}_${axis}_cal`,
        unit,
        get: (s: AnySample) => pick(s)?.cal?.[i],
      }),
    );
  }
  return out;
}

function field(s: AnySample, ...path: string[]): unknown {
  let v: unknown = s;
  for (const p of path) v = (v as Record<string, unknown> | null | undefined)?.[p];
  return v;
}

function layout(
  key: string,
  label: string,
  sensorId: number,
  defs: ColumnDef[],
): VerisenseStreamCsvLayout | null {
  if (!defs.length) return null;
  return {
    key,
    label,
    sensorId,
    columns: defs.map(({ header, unit }) => ({ header, unit })),
    row: (sample: unknown) => defs.map((d) => flag(d.get(sample as AnySample))),
  };
}

/**
 * Which stream a decoded sample belongs to, or null for a sensor this module
 * does not know. Only id 6 splits: its samples each carry one of accel, gyro
 * or mag, and the key says which (the same keys the stream stats use).
 */
export function verisenseStreamCsvKey(sensorId: number, sample: unknown): string | null {
  const s = sample as AnySample;
  switch (sensorId) {
    case 1:
    case 2:
    case 3:
    case 4:
    case 7:
    case 8:
    case 9:
      return String(sensorId);
    case 6:
      if (s?.accel) return '6:accel';
      if (s?.gyro) return '6:gyro';
      if (s?.mag) return '6:mag';
      return null;
    default:
      return null;
  }
}

/**
 * The file layout for the stream this sample opens, derived from the sample
 * itself. Returns null for an unknown sensor, or a sample with nothing to
 * write (an ADC packet with neither GSR nor battery, say).
 */
export function verisenseStreamCsvLayout(
  sensorId: number,
  sample: unknown,
): VerisenseStreamCsvLayout | null {
  const first = sample as AnySample;
  const key = verisenseStreamCsvKey(sensorId, first);
  if (!key) return null;

  switch (key) {
    case '1': {
      // SensorADC: GSR and battery share the packet; either may be disabled.
      const defs: ColumnDef[] = [];
      const parts: string[] = [];
      if (first?.gsr) {
        parts.push('GSR');
        defs.push(
          { header: 'GSR_raw', unit: 'counts', get: (s) => field(s, 'gsr', 'raw') },
          { header: 'GSR_adc12', unit: 'counts', get: (s) => field(s, 'gsr', 'adc12') },
          { header: 'GSR_range', unit: '', get: (s) => field(s, 'gsr', 'range') },
          { header: 'GSR_V', unit: 'V', get: (s) => field(s, 'gsr', 'volts') },
          { header: 'GSR_kOhm', unit: 'kOhm', get: (s) => field(s, 'gsr', 'kOhms') },
          { header: 'GSR_uS', unit: 'uS', get: (s) => field(s, 'gsr', 'uS') },
          { header: 'GSR_connectivity', unit: '', get: (s) => field(s, 'gsr', 'connectivity') },
        );
      }
      if (first?.batt) {
        parts.push('Batt');
        defs.push(
          { header: 'Batt_raw16', unit: '', get: (s) => field(s, 'batt', 'raw16') },
          { header: 'Batt_adc12', unit: 'counts', get: (s) => field(s, 'batt', 'adc12') },
          { header: 'Batt_mV', unit: 'mV', get: (s) => field(s, 'batt', 'mV') },
          {
            header: 'Batt_usbPluggedIn',
            unit: '',
            get: (s) => field(s, 'batt', 'usbPluggedIn'),
          },
          {
            header: 'Batt_chargerStatusBits',
            unit: '',
            get: (s) => field(s, 'batt', 'chargerStatusBits'),
          },
          {
            header: 'Batt_chargerStatus',
            unit: '',
            get: (s) => field(s, 'batt', 'chargerStatus'),
          },
        );
      }
      return layout(key, parts.join('_') || 'ADC', sensorId, defs);
    }

    case '2':
      // SensorLIS2DW12: the sample IS the triple.
      return layout(
        key,
        'Accel1',
        sensorId,
        tripleColumns('Accel1', (s) => s as Triple, first, 'm/s^2'),
      );

    case '3': {
      // SensorLSM6DS3: accel and gyro together, either may be disabled.
      const defs: ColumnDef[] = [];
      const parts: string[] = [];
      if (first?.accel) {
        parts.push('Accel2');
        defs.push(...tripleColumns('Accel2', (s) => s?.accel as Triple, first, 'm/s^2'));
      }
      if (first?.gyro) {
        parts.push('Gyro');
        defs.push(...tripleColumns('Gyro', (s) => s?.gyro as Triple, first, 'deg/s'));
      }
      return layout(key, parts.join('_'), sensorId, defs);
    }

    case '4': {
      // SensorPPG. 2nd gen (hub) sends three raw LED counts in the order
      // [green, IR, red]; 1st gen sends named channels, only the enabled ones.
      if (Array.isArray(first?.leds)) {
        const names = ['GREEN', 'IR', 'RED'];
        return layout(
          key,
          'PPG',
          sensorId,
          names.map((n, i) => ({
            header: `PPG_${n}`,
            unit: 'counts',
            get: (s) => (s?.leds as number[] | undefined)?.[i],
          })),
        );
      }
      const defs: ColumnDef[] = [];
      for (const ch of ['RED', 'IR', 'GREEN', 'BLUE']) {
        const c = first?.[ch] as { units?: { raw?: string; cal?: string } } | undefined;
        if (!c) continue;
        defs.push(
          {
            header: `PPG_${ch}_raw`,
            unit: c.units?.raw || 'counts',
            get: (s) => field(s, ch, 'raw'),
          },
          {
            header: `PPG_${ch}_cal`,
            unit: c.units?.cal || 'scaled',
            get: (s) => field(s, ch, 'cal'),
          },
        );
      }
      return layout(key, 'PPG', sensorId, defs);
    }

    case '6:accel':
      return layout(
        key,
        'Accel2',
        sensorId,
        tripleColumns('Accel2', (s) => s?.accel as Triple, first, 'm/s^2'),
      );
    case '6:gyro':
      return layout(
        key,
        'Gyro',
        sensorId,
        tripleColumns('Gyro', (s) => s?.gyro as Triple, first, 'deg/s'),
      );
    case '6:mag':
      return layout(
        key,
        'Mag',
        sensorId,
        tripleColumns('Mag', (s) => s?.mag as Triple, first, 'uT'),
      );

    case '7':
      // SensorVD6283. VISIBLE and DARK share a slot on the chip, so one of the
      // two is null in every sample; both columns are kept so the file does
      // not depend on which one the first sample had.
      return layout(key, 'Light', sensorId, [
        ...['RED', 'VISIBLE', 'DARK', 'BLUE', 'GREEN', 'IR', 'CLEAR'].map((ch) => ({
          header: `Light_${ch}`,
          unit: 'counts',
          get: (s: AnySample) => s?.[ch] ?? '',
        })),
        { header: 'Lux', unit: 'lux', get: (s) => s?.lux },
        { header: 'CCT', unit: 'K', get: (s) => s?.cct },
      ]);

    case '8':
      // SensorMAX32674 (algorithm hub). Its accel is raw only.
      return layout(key, 'AlgoHub', sensorId, [
        ...tripleColumns('HubAccel', (s) => s?.accel as Triple, first, '', false),
        { header: 'HR', unit: 'bpm', get: (s) => s?.hr },
        { header: 'HR_confidence', unit: '%', get: (s) => s?.hrConfidence },
        { header: 'SpO2', unit: '%', get: (s) => s?.spo2 },
        { header: 'SpO2_confidence', unit: '%', get: (s) => s?.spo2Confidence },
        { header: 'ActivityClass', unit: '', get: (s) => s?.activityClass },
        { header: 'SCD_ContactState', unit: '', get: (s) => s?.scdContactState },
      ]);

    case '9':
      // SensorMLX90632.
      return layout(key, 'SkinTemp', sensorId, [
        { header: 'Object_raw', unit: 'counts', get: (s) => field(s, 'object', 'raw') },
        {
          header: 'Object_cal',
          unit: unitOf(field(first, 'object', 'units'), 'degC'),
          get: (s) => field(s, 'object', 'cal'),
        },
        { header: 'Ambient_raw', unit: 'counts', get: (s) => field(s, 'ambient', 'raw') },
        {
          header: 'Ambient_cal',
          unit: unitOf(field(first, 'ambient', 'units'), 'degC'),
          get: (s) => field(s, 'ambient', 'cal'),
        },
      ]);

    default:
      return null;
  }
}

/** Round to `dp` places, leaving non-numbers as an empty cell. */
function rounded(v: unknown, dp: number): unknown {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '';
  const f = 10 ** dp;
  return Math.round(v * f) / f;
}

/**
 * The time cells for one row: see the module header. `measured` is true for
 * the row the packet's tick belongs to.
 */
function timeCells(sample: AnySample, tick: number, measured: boolean): unknown[] {
  const ts = sample?.timestamps as { tsMillis?: number; systemTsMillis?: number } | undefined;
  return [
    rounded(ts?.systemTsMillis, 0),
    // Microsecond resolution: a tick is 30.5 µs, so this keeps the clock's
    // own precision without the float noise of the interpolation.
    rounded(ts?.tsMillis, 3),
    measured ? tick : '',
  ];
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

/** A finished file in memory mode, as handed to `downloadFiles`. */
export interface VerisenseStreamCsvFile {
  fileName: string;
  blob: Blob;
}

/** One stream's file in a {@link VerisenseStreamRecordingResult}. */
export interface VerisenseStreamFileResult extends CsvFileResult {
  key: string;
  label: string;
  sensorId: number;
}

/** What `stop()` returns, and what `onError` receives. */
export interface VerisenseStreamRecordingResult {
  /** The session name: the folder in the picked directory, and every file's prefix. */
  sessionName: string;
  /** False when the files went to memory and were downloaded instead. */
  toFolder: boolean;
  /** False when any file is short. */
  complete: boolean;
  /** The first failure, when there was one. */
  error: string | null;
  files: VerisenseStreamFileResult[];
}

/** Live progress of one stream's file, for a page to show while recording. */
export interface VerisenseStreamFileProgress {
  key: string;
  label: string;
  sensorId: number;
  fileName: string;
  rows: number;
}

/** Options for {@link createVerisenseStreamRecorder}. */
export interface VerisenseStreamRecorderOptions {
  /**
   * Names the session — the folder created in the picked directory, and the
   * prefix of every file in it. Called once per `start()`. Defaults to
   * `Verisense_2026-09-30_141530`.
   */
  sessionNameFn?: () => string;
  /**
   * Stream the files into a folder the user picks (default). Set false, or
   * run in a browser without `showDirectoryPicker`, to buffer in memory and
   * hand the files to `downloadFiles` on `stop()`.
   */
  preferFileSystemAccess?: boolean;
  /** Emit a second header row of units (default true). */
  unitsRow?: boolean;
  log?: CsvRecorderLog;
  /**
   * Called once when a write fails and the recording is abandoned — every
   * other file is closed first, so the result is final. `active` is already
   * false. Not called for a failure discovered inside `stop()`.
   */
  onError?: (result: VerisenseStreamRecordingResult) => void;
  /**
   * Memory mode only: receives every finished file at once, so a page can
   * bundle them. Defaults to downloading each one.
   */
  downloadFiles?: (files: VerisenseStreamCsvFile[]) => void;
}

/** A {@link createVerisenseStreamRecorder} instance. */
export interface VerisenseStreamRecorder {
  /**
   * Pick a folder and create the session in it. Must be called straight from
   * a user gesture: `showDirectoryPicker` is gesture-gated. Resolves false if
   * the user cancelled the picker.
   */
  start(): Promise<boolean>;
  /** Append a `data` packet. Returns false when nothing was recorded from it. */
  push(pkt: StreamPacket): boolean;
  stop(): Promise<VerisenseStreamRecordingResult>;
  /** One entry per stream that has opened a file so far. */
  progress(): VerisenseStreamFileProgress[];
  readonly active: boolean;
  readonly sessionName: string;
  /** True once `start()` has a folder to write into; false while buffering in memory. */
  readonly toFolder: boolean;
}

type DirectoryPicker = (opts?: {
  id?: string;
  mode?: 'read' | 'readwrite';
}) => Promise<FileSystemDirectoryHandle>;

interface OpenStream {
  layout: VerisenseStreamCsvLayout;
  writer: CsvTableWriter;
}

/**
 * Create a recorder for a live Verisense stream: feed it every `data` packet,
 * and it writes one CSV per sensor stream, each opened on that stream's first
 * sample. A sensor that starts sending later gets its file when it starts.
 *
 * One failure ends the whole recording, for the reason the table writer gives:
 * a session whose files silently stop at different points is worse than one
 * that stops, closes everything, and says so.
 */
export function createVerisenseStreamRecorder(
  opts: VerisenseStreamRecorderOptions = {},
): VerisenseStreamRecorder {
  const preferFsa = opts.preferFileSystemAccess !== false;
  const unitsRow = opts.unitsRow !== false;
  const logger = typeof opts.log === 'function' ? { log: opts.log } : (opts.log ?? {});
  const warn = (m: string) => (logger.warn ?? logger.log)?.(m);

  let active = false;
  let starting = false;
  let sessionName = '';
  /** The session folder; null in memory mode. */
  let dir: FileSystemDirectoryHandle | null = null;
  const streams = new Map<string, OpenStream>();
  /** Memory mode: finished files, collected as each writer stops. */
  let collected: VerisenseStreamCsvFile[] = [];
  /** The first failure, and the teardown it started. */
  let failure: string | null = null;
  let dying: Promise<void> | null = null;

  function result(files: VerisenseStreamFileResult[]): VerisenseStreamRecordingResult {
    const firstError = failure ?? files.find((f) => f.error)?.error ?? null;
    return {
      sessionName,
      toFolder: dir !== null,
      complete: firstError === null && files.every((f) => f.complete),
      error: firstError,
      files,
    };
  }

  function fileResult(s: OpenStream, r: CsvFileResult): VerisenseStreamFileResult {
    return { ...r, key: s.layout.key, label: s.layout.label, sensorId: s.layout.sensorId };
  }

  async function stopAll(): Promise<VerisenseStreamRecordingResult> {
    const list = [...streams.values()];
    const results = await Promise.all(list.map(async (s) => fileResult(s, await s.writer.stop())));
    if (!dir && collected.length) {
      const files = collected;
      collected = [];
      try {
        if (opts.downloadFiles) opts.downloadFiles(files);
        else for (const f of files) downloadCsvBlob(f.fileName, f.blob);
      } catch (e) {
        failure ??= String((e as { message?: unknown } | null)?.message ?? e);
      }
    }
    return result(results);
  }

  /** One writer failed: end the session, closing every other file cleanly. */
  function onWriterError(): void {
    if (dying) return;
    active = false;
    dying = stopAll().then((r) => {
      try {
        opts.onError?.(r);
      } catch (cbError) {
        warn(`CSV onError handler threw: ${String(cbError)}`);
      }
    });
  }

  function open(first: unknown, sensorId: number, key: string): OpenStream | null {
    const l = verisenseStreamCsvLayout(sensorId, first);
    if (!l) return null;
    const fileName = `${sessionName}_${l.label}.csv`;
    const header = [...VERISENSE_STREAM_CSV_TIME_COLUMNS, ...l.columns].map((c) => c.header);
    const units = unitsRow
      ? [...VERISENSE_STREAM_CSV_TIME_COLUMNS, ...l.columns].map((c) => c.unit)
      : null;
    let sink: Promise<CsvByteSink> | null = null;
    if (dir) {
      const folder = dir;
      sink = folder
        .getFileHandle(fileName, { create: true })
        .then((h) => h.createWritable() as Promise<CsvByteSink>);
    }
    const writer = createCsvTableWriter({
      fileName,
      header,
      units,
      sink,
      download: (name, blob) => collected.push({ fileName: name, blob }),
      log: opts.log,
      onError: onWriterError,
    });
    const s = { layout: l, writer };
    streams.set(key, s);
    return s;
  }

  async function start(): Promise<boolean> {
    if (active || starting) {
      warn('CSV recorder already running');
      return false;
    }
    sessionName = (opts.sessionNameFn ?? (() => `Verisense_${localStamp(new Date())}`))();
    streams.clear();
    collected = [];
    failure = null;
    dying = null;
    dir = null;

    const picker = (globalThis as { showDirectoryPicker?: DirectoryPicker }).showDirectoryPicker;
    if (preferFsa && typeof picker === 'function') {
      starting = true;
      try {
        const root = await picker({ id: 'verisense-stream-csv', mode: 'readwrite' });
        dir = await ensureDirectoryPath(root, [sessionName]);
      } catch (e) {
        // AbortError is the user closing the picker — a "no", not a reason
        // to start recording somewhere they did not ask for.
        if ((e as { name?: string } | null)?.name === 'AbortError') return false;
        warn(
          `folder picker unavailable (${String((e as { message?: unknown } | null)?.message ?? e)}) — buffering in memory instead`,
        );
        dir = null;
      } finally {
        starting = false;
      }
    }
    active = true;
    return true;
  }

  function push(pkt: StreamPacket): boolean {
    if (!active) return false;
    const samples = pkt?.decoded;
    if (!Array.isArray(samples) || !samples.length) return false;

    // The packet's tick measured the LAST sample of each stream in it (for id
    // 6, the last of each sub-stream: the decoder spreads every sub-stream
    // back from the same block end). Find those rows first.
    const keys = samples.map((s) => verisenseStreamCsvKey(pkt.sensorId, s));
    const lastIndex = new Map<string, number>();
    keys.forEach((k, i) => {
      if (k) lastIndex.set(k, i);
    });

    let wrote = false;
    for (let i = 0; i < samples.length; i++) {
      const key = keys[i];
      if (!key) continue;
      const s = streams.get(key) ?? open(samples[i], pkt.sensorId, key);
      if (!s) continue;
      const cells = [
        ...timeCells(samples[i] as AnySample, pkt.tick_u24, lastIndex.get(key) === i),
        ...s.layout.row(samples[i]),
      ];
      if (s.writer.pushCells(cells)) wrote = true;
      if (!active) break; // a failure inside pushCells ended the session
    }
    return wrote;
  }

  async function stop(): Promise<VerisenseStreamRecordingResult> {
    if (!active) {
      if (dying) await dying;
      return stopAll();
    }
    active = false;
    return stopAll();
  }

  return {
    start,
    push,
    stop,
    progress: () =>
      [...streams.values()].map((s) => ({
        key: s.layout.key,
        label: s.layout.label,
        sensorId: s.layout.sensorId,
        fileName: s.writer.fileName,
        rows: s.writer.rowsAccepted,
      })),
    get active() {
      return active;
    },
    get toFolder() {
      return dir !== null;
    },
    get sessionName() {
      return sessionName;
    },
  };
}
