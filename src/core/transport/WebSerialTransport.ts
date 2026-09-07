import type {
  ShimmerTransport,
  ShimmerTransportKind,
  TransportCapabilities,
  Unsubscribe,
} from './types.js';
import {
  describePlatformSupport,
  transportAdvice,
  type TransportNeed,
} from '../platformSupport.js';

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
  filters?: readonly SerialPortFilter[] | null;
  /**
   * Service class IDs the port picker is *permitted* to surface Bluetooth
   * (RFCOMM/SPP) ports for — pass `[SHIMMER3_SPP_UUID]` to reach a Shimmer
   * paired over Classic Bluetooth. Chrome hides Bluetooth serial ports entirely
   * unless the origin names their service class, so `filters` alone is not
   * enough.
   *
   * **This permits; it does not narrow.** On its own it makes the picker offer
   * every COM port *and* every paired Bluetooth device. To narrow the list, also
   * pass {@link filters} with the same service class:
   *
   * ```ts
   * filters: [{ bluetoothServiceClassId: SHIMMER3_SPP_UUID }],
   * allowedBluetoothServiceClassIds: [SHIMMER3_SPP_UUID],
   * ```
   */
  allowedBluetoothServiceClassIds?: readonly BluetoothServiceClassId[] | null;
  /**
   * Read buffer size handed to `port.open`. Defaults to the browser's own
   * default (8 KiB in Chrome); raise it for bulk transfers so a slow turn of
   * the read loop cannot stall the sender.
   */
  bufferSize?: number;
  /**
   * Reported {@link ShimmerTransport.kind}. Defaults to `'serial'`; pass
   * `'rfcomm'` when the port is a Classic-Bluetooth virtual COM port so logs
   * and UI can tell the two apart (no client behaviour depends on it).
   */
  kind?: ShimmerTransportKind;
  /**
   * Abandon `port.open()` after this many ms (0 disables). Opening a classic
   * Bluetooth COM port is what actually establishes the RFCOMM link, so the
   * call can block for tens of seconds when the sensor is asleep or out of
   * range — where a USB CDC port either opens at once or fails at once.
   * Defaults to 15 s.
   */
  openTimeoutMs?: number;
  /**
   * DTR (data-terminal-ready) line state asserted right after the port opens.
   * Defaults to TRUE together with {@link requestToSend}: the Shimmer
   * single-slot dock wires the docked sensor's reset to the COM-port control
   * lines and holds the sensor in RESET until both DTR and RTS are asserted,
   * and asserted lines are also the safe norm for USB-CDC devices (hardware
   * that ignores them behaves the same either way). Set false only for
   * hardware that needs the line deasserted.
   */
  dataTerminalReady?: boolean;
  /** RTS (request-to-send) line state asserted right after the port opens.
   * Defaults to TRUE — see {@link dataTerminalReady}. */
  requestToSend?: boolean;
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
  readonly kind: ShimmerTransportKind;
  readonly capabilities: TransportCapabilities = { framed: false };

  private readonly _debug: boolean;
  private readonly _openOptions: {
    baudRate: number;
    dataBits: number;
    stopBits: number;
    parity: ParityType;
    flowControl: FlowControlType;
    bufferSize?: number;
  };
  private readonly _filters: readonly SerialPortFilter[] | null;
  private readonly _allowedBluetoothServiceClassIds: readonly BluetoothServiceClassId[] | null;
  private readonly _openTimeoutMs: number;
  private readonly _signals: { dataTerminalReady: boolean; requestToSend: boolean };

  private _port: SerialPort | null;
  private _abort: AbortController | null = null;
  private _reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _readLoopTask: Promise<void> | null = null;

  private readonly _notifyCbs = new Set<(data: Uint8Array) => void>();
  private readonly _disconnectCbs = new Set<(reason?: Error) => void>();

  constructor(opts: WebSerialTransportOptions = {}) {
    this._port = opts.port ?? null;
    this._filters = opts.filters ?? null;
    this._allowedBluetoothServiceClassIds = opts.allowedBluetoothServiceClassIds ?? null;
    this._openTimeoutMs = opts.openTimeoutMs ?? 15_000;
    this.kind = opts.kind ?? 'serial';
    this._signals = {
      dataTerminalReady: opts.dataTerminalReady ?? true,
      requestToSend: opts.requestToSend ?? true,
    };
    this._debug = opts.debug ?? false;
    this._openOptions = {
      baudRate: opts.baudRate ?? 115200,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? 'none',
      flowControl: opts.flowControl ?? 'none',
      ...(opts.bufferSize !== undefined ? { bufferSize: opts.bufferSize } : {}),
    };
  }

  /** The underlying serial port, once opened. */
  get port(): SerialPort | null {
    return this._port;
  }

  /**
   * Which kind of link this transport was configured to open, for choosing the
   * right advice when Web Serial is missing.
   *
   * Deliberately not `this._allowedBluetoothServiceClassIds ? ... : ...`: an
   * empty array is truthy, so `allowedBluetoothServiceClassIds: []` would be
   * called Bluetooth, and a caller who passed only a `bluetoothServiceClassId`
   * filter without the permission would be told about a wired dock. Both cases
   * would hand the user advice for the wrong link - most visibly on iOS, where
   * the two messages differ in kind rather than in wording.
   */
  private _need(): TransportNeed {
    if (this._allowedBluetoothServiceClassIds?.length) return 'classicBluetooth';
    if (this._filters?.some((f) => f.bluetoothServiceClassId !== undefined)) {
      return 'classicBluetooth';
    }
    return 'wiredSerial';
  }

  async connect(): Promise<void> {
    /*
     * Snapshot before the guard rather than testing `navigator` directly: with no
     * global navigator at all (Node, React Native) `'serial' in navigator` throws
     * before any message can be produced, so the descriptive error below would be
     * unreachable exactly where it is most needed.
     *
     * Platform-specific wording, because "use a desktop browser" is wrong on
     * Android (Chrome 138+ serves RFCOMM ports) and misleading on iOS, where no
     * browser will ever have this. The gate is still a capability check - the
     * platform only chooses the words.
     */
    const support = describePlatformSupport();
    if (!support.webSerial) {
      throw new Error(transportAdvice(support, this._need()) ?? 'Web Serial is not available.');
    }

    if (!this._port) {
      const serial = (
        navigator as unknown as {
          serial: { requestPort(o?: SerialPortRequestOptions): Promise<SerialPort> };
        }
      ).serial;
      // Unknown dictionary members are ignored by WebIDL, so naming the
      // Bluetooth service classes is safe on browsers that predate them.
      const request: SerialPortRequestOptions = {};
      /*
       * Copied, not aliased. The public options accept `readonly` arrays so a
       * frozen shared default (SHIMMER3_SPP_SERIAL_OPTIONS) can be spread
       * straight in, but SerialPortRequestOptions is a WebIDL dictionary typed
       * with mutable arrays - and passing a frozen array into it would also let
       * the caller's constant be reached by anything that mutates the request.
       */
      if (this._filters) request.filters = [...this._filters];
      if (this._allowedBluetoothServiceClassIds) {
        request.allowedBluetoothServiceClassIds = [...this._allowedBluetoothServiceClassIds];
      }
      this._port = await serial.requestPort(Object.keys(request).length ? request : undefined);
    }

    await this._openWithTimeout();

    // Assert DTR/RTS now that the port is open. The Shimmer single-slot dock
    // holds the docked sensor in RESET until both lines are asserted, so a
    // port opened without them leaves the sensor unresponsive. Non-fatal when
    // unsupported: not every serial stack implements setSignals, and hardware
    // that ignores the control lines behaves the same either way.
    try {
      await (
        this._port as unknown as {
          setSignals?(s: { dataTerminalReady: boolean; requestToSend: boolean }): Promise<void>;
        }
      ).setSignals?.(this._signals);
    } catch (e) {
      if (this._debug) console.warn('[WebSerialTransport] setSignals failed (continuing):', e);
    }

    this._abort = new AbortController();
    this._startReadLoop(this._abort.signal);
  }

  /**
   * `port.open()`, bounded by {@link WebSerialTransportOptions.openTimeoutMs}.
   *
   * Opening a Classic-Bluetooth COM port is what brings the RFCOMM link up, so
   * an asleep or out-of-range sensor blocks here rather than failing fast. If
   * the timeout wins we still close the port should the open land later —
   * otherwise the OS keeps an orphaned handle and the next attempt fails with
   * "port already open" instead of the real reason.
   */
  private async _openWithTimeout(): Promise<void> {
    const port = this._port as unknown as {
      open(o: SerialOptions): Promise<void>;
      close(): Promise<void>;
    };
    const opening = port.open(this._openOptions);
    if (this._openTimeoutMs <= 0) return opening;

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        opening,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(
                `Timed out after ${this._openTimeoutMs} ms opening the serial port. ` +
                  'If this is a Bluetooth serial port: check the sensor is powered, in range, ' +
                  'and still paired with this host.',
              ),
            );
          }, this._openTimeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (timedOut) {
        // Never leave the late open unobserved (unhandled rejection) or the
        // port held open behind our back.
        void opening.then(
          () => port.close().catch(() => undefined),
          () => undefined,
        );
        this._port = null;
      }
    }
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
