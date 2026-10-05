import type {
  ShimmerTransport,
  ShimmerTransportKind,
  TransportCapabilities,
  TransportWriteOptions,
  Unsubscribe,
} from './types.js';

/** A single recorded host → device write. */
export interface LoopbackWrite {
  bytes: Uint8Array;
  withResponse?: boolean;
}

/** Constructor options for {@link LoopbackTransport}. */
export interface LoopbackTransportOptions {
  /**
   * Called for every {@link LoopbackTransport.write}. Use it to script device
   * replies: inspect the outgoing frame and call {@link LoopbackTransport.notify}
   * to deliver a response. May be async (its rejection is ignored).
   */
  onWrite?: (bytes: Uint8Array, transport: LoopbackTransport) => void | Promise<void>;
  /** Override capability hints (default `{ framed: true }`, like BLE). */
  capabilities?: Partial<TransportCapabilities>;
  /** Advertised device name for labelling. */
  deviceName?: string;
}

/**
 * An in-memory {@link ShimmerTransport} for tests. It preserves notification
 * chunk boundaries (each {@link notify} call = one chunk) so client behaviour
 * such as Shimmer3R's ACK-remainder handling can be exercised without a browser
 * or hardware.
 *
 * Scripting a device: pass `onWrite`, or set it later via {@link setOnWrite},
 * and respond by calling {@link notify}. Recorded writes are available on
 * {@link writes}.
 */
export class LoopbackTransport implements ShimmerTransport {
  readonly kind: ShimmerTransportKind = 'loopback';
  readonly capabilities: TransportCapabilities;
  readonly deviceName?: string;

  /** Every write the client has issued, in order. */
  readonly writes: LoopbackWrite[] = [];
  /** Whether {@link connect} has run and {@link disconnect} has not. */
  connected = false;

  private _onWrite?: (bytes: Uint8Array, transport: LoopbackTransport) => void | Promise<void>;
  private readonly _notifyCbs = new Set<(data: Uint8Array) => void>();
  private readonly _disconnectCbs = new Set<(reason?: Error) => void>();

  constructor(opts: LoopbackTransportOptions = {}) {
    this._onWrite = opts.onWrite;
    this.capabilities = { framed: true, ...opts.capabilities };
    this.deviceName = opts.deviceName;
  }

  /** Replace the write handler (e.g. after connect-time bootstrap). */
  setOnWrite(
    fn: ((bytes: Uint8Array, transport: LoopbackTransport) => void | Promise<void>) | undefined,
  ): void {
    this._onWrite = fn;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async write(data: Uint8Array, opts?: TransportWriteOptions): Promise<void> {
    const bytes = new Uint8Array(data);
    this.writes.push({ bytes, withResponse: opts?.withResponse });
    if (this._onWrite) {
      await this._onWrite(bytes, this);
    }
  }

  onNotify(cb: (data: Uint8Array) => void): Unsubscribe {
    this._notifyCbs.add(cb);
    return () => this._notifyCbs.delete(cb);
  }

  onDisconnect(cb: (reason?: Error) => void): Unsubscribe {
    this._disconnectCbs.add(cb);
    return () => this._disconnectCbs.delete(cb);
  }

  /**
   * Deliver one inbound notification chunk to every {@link onNotify} listener,
   * exactly as given (no merge / re-split). Accepts a `Uint8Array` or number[].
   */
  notify(data: Uint8Array | number[]): void {
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    for (const cb of this._notifyCbs) cb(u8);
  }

  /** Simulate a link drop / requested disconnect. */
  emitDisconnect(reason?: Error): void {
    for (const cb of this._disconnectCbs) cb(reason);
  }

  /** The last recorded write, or undefined. */
  get lastWrite(): LoopbackWrite | undefined {
    return this.writes[this.writes.length - 1];
  }
}
