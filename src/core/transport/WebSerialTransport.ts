import type {
  ShimmerTransport,
  ShimmerTransportKind,
  TransportCapabilities,
  Unsubscribe,
} from './types.js';

/** Constructor options for {@link WebSerialTransport}. */
export interface WebSerialTransportOptions {
  /** A pre-opened / pre-selected port (skips the `requestPort` picker). */
  port?: SerialPort | null;
  baudRate?: number;
  dataBits?: number;
  stopBits?: number;
  parity?: ParityType;
  flowControl?: FlowControlType;
  /** `requestPort` filters. */
  filters?: SerialPortFilter[] | null;
  /** Enable verbose console logging. */
  debug?: boolean;
}

/**
 * A {@link ShimmerTransport} over the Web Serial API (USB COM port).
 *
 * Web Serial is an unframed byte stream, so `capabilities.framed` is `false` and
 * the notify callback fires with whatever chunk the reader yields — the client's
 * assembler re-frames. Behaviour (open parameters, read-loop teardown, writer
 * lifecycle) is ported verbatim from `VerisenseBleDevice`'s former serial path.
 */
export class WebSerialTransport implements ShimmerTransport {
  readonly kind: ShimmerTransportKind = 'serial';
  readonly capabilities: TransportCapabilities = { framed: false };

  private readonly _debug: boolean;
  private readonly _openOptions: {
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: ParityType;
    flowControl: FlowControlType;
  };
  private readonly _filters: SerialPortFilter[] | null;

  private _port: SerialPort | null;
  private _abort: AbortController | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _readLoopTask: Promise<void> | null = null;

  private readonly _notifyCbs = new Set<(data: Uint8Array) => void>();
  private readonly _disconnectCbs = new Set<(reason?: Error) => void>();

  constructor(opts: WebSerialTransportOptions = {}) {
    this._port = opts.port ?? null;
    this._filters = opts.filters ?? null;
    this._debug = opts.debug ?? false;
    this._openOptions = {
      baudRate: opts.baudRate ?? 115200,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? 'none',
      flowControl: opts.flowControl ?? 'none',
    };
  }

  /** The underlying serial port, once opened. */
  get port(): SerialPort | null {
    return this._port;
  }

  async connect(): Promise<void> {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial not supported. Use Chrome/Edge on HTTPS or http://localhost.');
    }

    if (!this._port) {
      const serial = (
        navigator as unknown as {
          serial: { requestPort(o?: { filters?: SerialPortFilter[] }): Promise<SerialPort> };
        }
      ).serial;
      this._port = await serial.requestPort(this._filters ? { filters: this._filters } : undefined);
    }

    await (
      this._port as unknown as {
        open(o: {
          baudRate: number;
          dataBits: number;
          stopBits: number;
          parity: string;
          flowControl: string;
        }): Promise<void>;
      }
    ).open(this._openOptions);

    this._abort = new AbortController();
    this._startReadLoop(this._abort.signal);
  }

  async write(data: Uint8Array): Promise<void> {
    const writable = (this._port as unknown as { writable?: WritableStream<Uint8Array> })?.writable;
    if (!writable) throw new Error('Not connected');
    const writer = writable.getWriter();
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  }

  async disconnect(reason = 'user'): Promise<void> {
    try {
      this._abort?.abort();
    } catch {
      /* ignore */
    }

    const cancelActiveReader = async (): Promise<boolean> => {
      const r = this._reader;
      if (!r) return false;
      try {
        await r.cancel();
      } catch {
        /* ignore */
      }
      try {
        r.releaseLock();
      } catch {
        /* ignore */
      }
      if (this._reader === r) this._reader = null;
      return true;
    };

    await cancelActiveReader();

    const portReadableLocked = (this._port as unknown as { readable?: { locked?: boolean } })
      ?.readable?.locked;
    if (portReadableLocked && !this._reader) {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => setTimeout(r, 20));
        if (await cancelActiveReader()) break;
      }
    }

    try {
      const task = this._readLoopTask;
      if (task) await Promise.race([task, new Promise<void>((r) => setTimeout(r, 750))]);
    } catch {
      /* ignore */
    }

    try {
      const writable = (
        this._port as unknown as {
          writable?: { locked?: boolean; getWriter(): WritableStreamDefaultWriter<unknown> };
        }
      )?.writable;
      if (writable?.locked) {
        const w = writable.getWriter();
        try {
          await (w as unknown as { abort?(): void }).abort?.();
        } catch {
          /* ignore */
        }
        try {
          w.releaseLock();
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* ignore */
    }

    try {
      await (this._port as unknown as { close(): Promise<void> })?.close?.();
    } catch {
      /* ignore */
    }

    this._port = null;
    this._abort = null;
    this._reader = null;
    this._readLoopTask = null;

    if (this._debug) console.warn(`[serial] disconnect done reason=${reason}`);
  }

  onNotify(cb: (data: Uint8Array) => void): Unsubscribe {
    this._notifyCbs.add(cb);
    return () => this._notifyCbs.delete(cb);
  }

  onDisconnect(cb: (reason?: Error) => void): Unsubscribe {
    this._disconnectCbs.add(cb);
    return () => this._disconnectCbs.delete(cb);
  }

  private _emitNotify(bytes: Uint8Array): void {
    for (const cb of this._notifyCbs) {
      try {
        cb(bytes);
      } catch (e) {
        if (this._debug) console.warn('[serial] notify handler error', e);
      }
    }
  }

  private _startReadLoop(signal: AbortSignal): void {
    const port = this._port!;
    this._readLoopTask = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const readable = (port as unknown as { readable?: ReadableStream<Uint8Array> }).readable;
        if (!readable) return;
        reader = readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        this._reader = reader;

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this._emitNotify(new Uint8Array(value));
        }
      } catch (e) {
        if (!signal.aborted) console.warn('[serial] read loop error:', e);
      } finally {
        try {
          reader?.releaseLock?.();
        } catch {
          /* ignore */
        }
        if (this._reader === reader) this._reader = null;
        this._readLoopTask = null;
        if (!signal.aborted) {
          for (const cb of this._disconnectCbs) {
            try {
              cb();
            } catch {
              /* ignore */
            }
          }
        }
      }
    })();
  }
}
