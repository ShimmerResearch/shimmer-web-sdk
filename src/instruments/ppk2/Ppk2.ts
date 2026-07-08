/**
 * Nordic Power Profiler Kit II (PPK2) Web Serial driver.
 *
 * The PPK2 is used as a battery substitute (source-meter mode) and/or an
 * inline ammeter, streaming calibrated current samples at 100 kS/s. This
 * driver owns a single continuous read loop and routes incoming bytes by
 * phase: the ASCII metadata blob after GET_META_DATA, the binary sample
 * stream between AVERAGE_START/AVERAGE_STOP, and discard otherwise (the
 * device sends nothing else; all remaining commands are fire-and-forget).
 *
 * The driver keeps no sample history — `onSamples` delivers calibrated
 * microamp batches and bounded aggregation (RunningStats/MinMaxDownsampler)
 * is the caller's job. Keep the callback cheap: at 100 kS/s (400 KB/s) any
 * per-chunk rendering must be deferred (e.g. requestAnimationFrame).
 */

import { PPK2_BAUD_RATE, PPK2_CMD, PPK2_USB_PRODUCT_ID, PPK2_USB_VENDOR_ID } from './constants.js';
import {
  clampSourceVoltageMv,
  clonePpk2Modifiers,
  convertSourceVoltage,
  DEFAULT_PPK2_MODIFIERS,
  parsePpk2Metadata,
  Ppk2SampleDecoder,
  type Ppk2Modifiers,
  type Ppk2SampleBatch,
} from './ppk2Codec.js';

export interface Ppk2Options {
  /** Calibrated sample batches while measuring. Must be cheap — no rendering. */
  onSamples?: (batch: Ppk2SampleBatch) => void;
  /** Fired when the link drops unexpectedly (e.g. USB cable pulled). */
  onDisconnected?: () => void;
  onError?: (error: Error) => void;
}

type Ppk2Phase = 'idle' | 'meta' | 'stream';

const METADATA_TIMEOUT_MS = 2000;
const METADATA_ATTEMPTS = 2;

export class Ppk2 {
  /** Web Serial picker filter matching the PPK2's USB identity. */
  static readonly USB_FILTER: SerialPortFilter = {
    usbVendorId: PPK2_USB_VENDOR_ID,
    usbProductId: PPK2_USB_PRODUCT_ID,
  };

  private readonly opts: Ppk2Options;

  private port: SerialPort | null = null;
  private abortCtrl: AbortController | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private readLoopTask: Promise<void> | null = null;

  private phase: Ppk2Phase = 'idle';
  private metaDecoder = new TextDecoder();
  private metaText = '';
  private metaWaiter: { resolve: (text: string) => void; reject: (e: Error) => void } | null = null;

  private decoder = new Ppk2SampleDecoder(DEFAULT_PPK2_MODIFIERS, 0);
  private _modifiers: Ppk2Modifiers | null = null;
  private _currentVddMv: number | null = null;
  private _measuring = false;
  private _dutPowerOn = false;

  constructor(opts: Ppk2Options = {}) {
    this.opts = opts;
  }

  get isConnected(): boolean {
    return this.port !== null;
  }

  get isMeasuring(): boolean {
    return this._measuring;
  }

  get isDutPowerOn(): boolean {
    return this._dutPowerOn;
  }

  /** Calibration modifiers read during connect(), or null before then. */
  get modifiers(): Ppk2Modifiers | null {
    return this._modifiers ? clonePpk2Modifiers(this._modifiers) : null;
  }

  get currentVddMv(): number | null {
    return this._currentVddMv;
  }

  /**
   * Open the PPK2 serial port (browser picker filtered to the PPK2 USB IDs
   * unless a port is supplied) and read the device's calibration metadata.
   */
  async connect(opts: { port?: SerialPort | null } = {}): Promise<void> {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial not supported. Use Chrome/Edge on HTTPS or http://localhost.');
    }
    if (this.port) {
      throw new Error('PPK2 already connected');
    }

    const serial = (navigator as unknown as { serial: Serial }).serial;
    const port = opts.port ?? (await serial.requestPort({ filters: [Ppk2.USB_FILTER] }));

    await port.open({
      baudRate: PPK2_BAUD_RATE,
      // ~2.5 s of stream headroom so a busy main thread cannot overflow the
      // 400 KB/s measurement stream.
      bufferSize: 1 << 20,
    });

    this.port = port;
    this.phase = 'idle';
    this.abortCtrl = new AbortController();
    this.startReadLoop(this.abortCtrl.signal);

    try {
      await this.getMetadata();
    } catch (e) {
      await this.disconnect();
      throw e;
    }
  }

  /**
   * Best-effort teardown: stop measuring, remove DUT power, then close the
   * port. Idempotent; write failures are swallowed (the device may already
   * be gone).
   */
  async disconnect(): Promise<void> {
    const port = this.port;
    if (!port) return;

    try {
      if (this._measuring) await this.stopMeasuring();
    } catch {
      /* ignore */
    }
    try {
      if (this._dutPowerOn) await this.toggleDutPower(false);
    } catch {
      /* ignore */
    }

    await this.teardownLink('user');
  }

  /** Request + parse the calibration metadata blob (retries once on timeout). */
  async getMetadata(): Promise<Ppk2Modifiers> {
    let lastError: Error = new Error('PPK2 metadata read failed');
    for (let attempt = 0; attempt < METADATA_ATTEMPTS; attempt++) {
      try {
        const text = await this.requestMetadataOnce();
        const modifiers = parsePpk2Metadata(text);
        this._modifiers = modifiers;
        this.decoder.setModifiers(modifiers);
        return clonePpk2Modifiers(modifiers);
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e));
        if (!this.port) break;
      }
    }
    throw lastError;
  }

  /** Source-meter mode: the PPK2 supplies power to the DUT and measures it. */
  async useSourceMeter(): Promise<void> {
    await this.write([PPK2_CMD.SET_POWER_MODE, PPK2_CMD.AVG_NUM_SET]); // 0x11 0x02
  }

  /** Ampere-meter mode: the PPK2 measures current from an external supply. */
  async useAmpereMeter(): Promise<void> {
    await this.write([PPK2_CMD.SET_POWER_MODE, PPK2_CMD.TRIGGER_SET]); // 0x11 0x01
  }

  /** Set the source (or expected input) voltage; required before measuring. */
  async setSourceVoltage(mV: number): Promise<void> {
    const clamped = clampSourceVoltageMv(mV);
    const [b1, b2] = convertSourceVoltage(clamped);
    await this.write([PPK2_CMD.REGULATOR_SET, b1, b2]);
    this._currentVddMv = clamped;
    this.decoder.setSourceVoltage(clamped);
  }

  async toggleDutPower(on: boolean): Promise<void> {
    await this.write([PPK2_CMD.DEVICE_RUNNING_SET, on ? 0x01 : 0x00]);
    this._dutPowerOn = on;
  }

  /** Start the continuous 100 kS/s measurement stream. */
  async startMeasuring(): Promise<void> {
    if (this._currentVddMv === null) {
      throw new Error('Source/input voltage not set — call setSourceVoltage() first');
    }
    this.decoder.reset();
    this.phase = 'stream';
    this._measuring = true;
    await this.write([PPK2_CMD.AVERAGE_START]);
  }

  /** Stop the measurement stream; straggler bytes are discarded. */
  async stopMeasuring(): Promise<void> {
    this._measuring = false;
    this.phase = 'idle';
    await this.write([PPK2_CMD.AVERAGE_STOP]);
  }

  // --- internals ---

  private async requestMetadataOnce(): Promise<string> {
    if (!this.port) throw new Error('PPK2 not connected');
    if (this.metaWaiter) throw new Error('PPK2 metadata read already in progress');

    this.metaText = '';
    this.metaDecoder = new TextDecoder();
    this.phase = 'meta';

    const waiter = new Promise<string>((resolve, reject) => {
      this.metaWaiter = { resolve, reject };
    });
    const timer = setTimeout(() => {
      this.settleMetaWaiter(null, new Error('Timed out waiting for PPK2 metadata'));
    }, METADATA_TIMEOUT_MS);

    try {
      await this.write([PPK2_CMD.GET_META_DATA]);
      return await waiter;
    } finally {
      clearTimeout(timer);
      if (this.phase === 'meta') this.phase = 'idle';
    }
  }

  private settleMetaWaiter(text: string | null, error?: Error): void {
    const waiter = this.metaWaiter;
    if (!waiter) return;
    this.metaWaiter = null;
    if (text !== null) waiter.resolve(text);
    else waiter.reject(error ?? new Error('PPK2 metadata read failed'));
  }

  private async write(bytes: number[]): Promise<void> {
    const writable = this.port?.writable;
    if (!writable) throw new Error('PPK2 not connected');
    const writer = writable.getWriter();
    try {
      await writer.write(new Uint8Array(bytes));
    } finally {
      writer.releaseLock();
    }
  }

  private startReadLoop(signal: AbortSignal): void {
    const port = this.port!;
    this.readLoopTask = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const readable = port.readable;
        if (!readable) return;
        reader = readable.getReader();
        this.reader = reader;

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this.handleChunk(value);
        }
      } catch (e) {
        if (!signal.aborted) {
          const err = e instanceof Error ? e : new Error(String(e));
          this.opts.onError?.(err);
        }
      } finally {
        try {
          reader?.releaseLock?.();
        } catch {
          /* ignore */
        }
        if (this.reader === reader) this.reader = null;
        this.readLoopTask = null;
        if (!signal.aborted) {
          // Unexpected link loss (cable pulled / device reset).
          void this.teardownLink('link-lost');
          this.opts.onDisconnected?.();
        }
      }
    })();
  }

  private handleChunk(chunk: Uint8Array): void {
    switch (this.phase) {
      case 'meta': {
        this.metaText += this.metaDecoder.decode(chunk, { stream: true });
        if (this.metaText.includes('END')) {
          const text = this.metaText;
          this.metaText = '';
          this.phase = 'idle';
          this.settleMetaWaiter(text);
        }
        break;
      }
      case 'stream': {
        const batch = this.decoder.feed(chunk);
        if (batch.microAmps.length > 0) this.opts.onSamples?.(batch);
        break;
      }
      default:
        // Stragglers after AVERAGE_STOP (or unsolicited noise): discard.
        break;
    }
  }

  /** Abort the reader and close the port; safe to call multiple times. */
  private async teardownLink(reason: 'user' | 'link-lost'): Promise<void> {
    const port = this.port;
    this.port = null;
    this.phase = 'idle';
    this._measuring = false;
    this._dutPowerOn = false;
    this._currentVddMv = null;
    this.settleMetaWaiter(null, new Error(`PPK2 disconnected (${reason})`));

    try {
      this.abortCtrl?.abort();
    } catch {
      /* ignore */
    }
    this.abortCtrl = null;

    const reader = this.reader;
    this.reader = null;
    try {
      await reader?.cancel();
    } catch {
      /* ignore */
    }
    try {
      reader?.releaseLock?.();
    } catch {
      /* ignore */
    }
    try {
      const task = this.readLoopTask;
      if (task) await Promise.race([task, new Promise<void>((r) => setTimeout(r, 750))]);
    } catch {
      /* ignore */
    }
    try {
      await port?.close();
    } catch {
      /* ignore */
    }
  }
}
