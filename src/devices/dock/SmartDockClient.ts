import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import { concatU8 } from './protocol.js';
import { WiredShimmerClient, type WiredIdentity } from './WiredShimmerClient.js';
import type { WiredBatteryStatus } from './protocol.js';
import type { InfoMemDeviceConfig } from '../infomem/index.js';
import {
  SMARTDOCK_BASE_CMD,
  SMARTDOCK_CONNECTION_TYPE,
  SMARTDOCK_DEFAULTS,
  buildBaseCommand,
  buildSelectSlotCommand,
  extractBaseLine,
  classifyBaseResponse,
  parseSmartDockVersion,
  parseSlotOccupancy,
  parseActiveSlot,
  baseHardwareType,
  type SmartDockConnectionType,
  type SmartDockHardwareType,
  type SmartDockVersionInfo,
} from './smartDockProtocol.js';

/**
 * Thrown by {@link SmartDockClient} when a base command reply does not arrive
 * within the timeout. Distinguished from an explicit `E` error response so the
 * retry logic re-sends on timeout only (SmartDockUart.java:526-537: a timeout
 * from `waitForSmartDockResponse` triggers a re-send, whereas an error response
 * throws immediately).
 */
class SmartDockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartDockTimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface SmartDockClientOptions extends ShimmerClientOptions {
  /**
   * The SmartDock **base control** UART (a `ShimmerTransport` over the base's
   * FTDI serial port carrying the ASCII `SDx$` command channel). **Required** —
   * a SmartDock is only reachable over this wired link, so `connect()` throws
   * without one. The transport should report `capabilities.framed = false`
   * (serial is an unframed byte stream); configure the port per
   * `UART_DOCK_BAUD_RATE` (115200 8N1).
   */
  transport?: ShimmerTransport;
  /**
   * The **per-Shimmer** UART channel (a *separate* FTDI serial port on the
   * SmartDock, onto which the base routes whichever slot is active). Required
   * only for {@link SmartDockClient.identifyDockedShimmer} /
   * {@link SmartDockClient.getDockedShimmerStatus}, which drive the D1
   * `WiredShimmerClient` against the active slot. In the Java driver these are
   * two distinct COM ports (SmartDock.java:226-229). Omit it if you only need
   * dock info / occupancy / slot selection.
   */
  shimmerTransport?: ShimmerTransport;
  /** Timeout overrides (defaults ported from Java; see {@link SMARTDOCK_DEFAULTS}). */
  timeouts?: Partial<{
    /** Normal base-command reply timeout (ms). Default 1000. */
    responseTimeoutMs: number;
    /** Slot-change confirmation timeout (ms). Default 10000. */
    slotChangeTimeoutMs: number;
    /** Post-slot-change settle delay (ms). Default 1500. */
    slotChangeoverDelayMs: number;
  }>;
}

/** Result of {@link SmartDockClient.getDockInfo}. */
export interface SmartDockInfo {
  /** Base family derived from the version response's hardware-version field. */
  hardwareType: SmartDockHardwareType;
  /** Full parsed HW/FW version. */
  firmwareVersion: SmartDockVersionInfo;
  /**
   * Number of slots. Derived from `hardwareType` (base6→6, base15→15). 0 when
   * the hardware version is unrecognised — call {@link SmartDockClient.getSlotOccupancy}
   * to discover the count from the wire in that case.
   */
  slotCount: number;
}

/** One slot's occupancy. */
export interface SlotOccupancy {
  /** 1-based slot number. */
  slot: number;
  /** True when a Shimmer is docked in this slot. */
  occupied: boolean;
}

// ---------------------------------------------------------------------------
// SmartDockClient
// ---------------------------------------------------------------------------

/**
 * Client for a **SmartDock** multi-slot base (Base-6 / Base-15) — phase **D2**
 * of dock support, building on D1's single-device {@link WiredShimmerClient}.
 *
 * A SmartDock exposes two logical channels over (two) FTDI serial ports:
 *   1. a **base control** channel speaking short ASCII `SDx$` commands (this
 *      client), used to read the base version, query per-slot occupancy, and
 *      switch which slot is *active*; and
 *   2. a **per-Shimmer** UART channel onto which the base routes the active
 *      slot, spoken with the D1 binary `$`-header protocol.
 *
 * Multi-slot support is therefore: select a slot on the base channel, then talk
 * to the docked Shimmer on the per-Shimmer channel. This client **composes**
 * (does not duplicate) {@link WiredShimmerClient} for the per-Shimmer half —
 * see {@link identifyDockedShimmer} / {@link getDockedShimmerStatus}.
 *
 * Scope (D2): **READ-ONLY**. Dock info, occupancy, slot select, and per-slot
 * identify/status. NO config writes, NO SD/mass-storage (the `SDC` with-SD
 * connect and `getSDMountDelay` path exist in the Java oracle but are not
 * driven), NO bootloader/flashing.
 *
 * Robustness: the base UART is an unframed byte stream, so — like D1 — this
 * client accumulates inbound bytes and extracts complete `\r\n`-terminated
 * lines ({@link extractBaseLine}); unrecognised / partial lines are ignored,
 * which naturally resyncs after garbage. Per-op timeouts are ported from Java
 * (normal 1000 ms; slot change 10000 ms).
 *
 * Transport injection is mandatory — `connect()` with no base transport throws.
 *
 * @example
 * ```ts
 * const dock = new SmartDockClient({ transport: baseSerial, shimmerTransport: shimmerSerial });
 * await dock.connect();
 * const info = await dock.getDockInfo();       // { hardwareType, firmwareVersion, slotCount }
 * const slots = await dock.getSlotOccupancy(); // [{ slot: 1, occupied: true }, ...]
 * const id = await dock.identifyDockedShimmer(1);   // selects slot 1, then D1 identify()
 * const st = await dock.getDockedShimmerStatus(1);  // selects slot 1, then D1 getStatus()
 * ```
 */
export class SmartDockClient extends BaseShimmerClient {
  private _injectedTransport: ShimmerTransport | null = null;
  private _transport: ShimmerTransport | null = null;
  private _notifyUnsub: Unsubscribe | null = null;
  private _disconnectUnsub: Unsubscribe | null = null;

  private _rxBuf: Uint8Array = new Uint8Array(0);
  private _temps: Set<(line: string) => void> = new Set();

  /**
   * Serialization queue: all public operations chain onto this so slot
   * select + per-slot reads run as atomic, non-interleaved units. Concurrent
   * `selectSlot` / `identifyDockedShimmer` / `getDockedShimmerStatus` otherwise
   * race on the shared {@link activeSlot} and single {@link _wired} client,
   * mis-attributing one slot's data to another. See {@link _serialize}.
   */
  private _queue: Promise<unknown> = Promise.resolve();

  private _shimmerTransport: ShimmerTransport | null;
  private _wired: WiredShimmerClient | null = null;
  private _wiredConnected = false;

  private readonly _responseTimeoutMs: number;
  private readonly _slotChangeTimeoutMs: number;
  private readonly _slotChangeoverDelayMs: number;

  /** Cached dock info (from the last {@link getDockInfo}). */
  dockInfo: SmartDockInfo | null = null;
  /** The last active slot confirmed by {@link selectSlot} (1-based; -1 when disconnected). */
  activeSlot = -1;

  constructor(opts: SmartDockClientOptions = {}) {
    super(opts);
    this._injectedTransport = opts.transport ?? null;
    this._shimmerTransport = opts.shimmerTransport ?? null;
    this._responseTimeoutMs =
      opts.timeouts?.responseTimeoutMs ?? SMARTDOCK_DEFAULTS.RESPONSE_TIMEOUT_MS;
    this._slotChangeTimeoutMs =
      opts.timeouts?.slotChangeTimeoutMs ?? SMARTDOCK_DEFAULTS.SLOT_CHANGE_TIMEOUT_MS;
    this._slotChangeoverDelayMs =
      opts.timeouts?.slotChangeoverDelayMs ?? SMARTDOCK_DEFAULTS.SLOT_CHANGEOVER_DELAY_MS;
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[SmartDock]', ...args);
  }

  private _deviceLabel(): string {
    return this._transport?.deviceName ?? 'SmartDock';
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Open the SmartDock base UART connection. A base transport is REQUIRED
   * (constructor option or this parameter). The per-Shimmer transport (if
   * supplied) is opened lazily on the first docked-Shimmer op.
   */
  override async connect(transport?: ShimmerTransport): Promise<void> {
    const t = transport ?? this._injectedTransport;
    if (!t) {
      throw new Error(
        'SmartDockClient requires an injected transport: a SmartDock is only reachable ' +
          'over the base UART. Pass a ShimmerTransport via the constructor ({ transport }) ' +
          'or connect(transport).',
      );
    }
    this._transport = t;
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    this._emitStatus('Opening SmartDock base UART connection…');
    await t.connect();
    this._rxBuf = new Uint8Array(0);
    this._emitStatus(`Connected: ${this._deviceLabel()}`);
  }

  override async disconnect(): Promise<void> {
    try {
      if (this._wired && this._wiredConnected) {
        await this._wired.disconnect().catch(() => undefined);
      }
      this._notifyUnsub?.();
      this._disconnectUnsub?.();
      await this._transport?.disconnect();
    } catch {
      /* ignore */
    } finally {
      this._wiredConnected = false;
      this._wired = null;
      this._notifyUnsub = this._disconnectUnsub = null;
      this._transport = null;
      this._rxBuf = new Uint8Array(0);
      this._temps.clear();
      this._emitStatus('Disconnected');
    }
  }

  private _handleTransportDisconnect = (): void => {
    this._emitStatus('SmartDock disconnected');
  };

  /** Streaming is not part of the SmartDock protocol. */
  override async startStreaming(): Promise<void> {
    throw new Error('Streaming is not supported over the SmartDock UART.');
  }
  override async stopStreaming(): Promise<void> {
    /* no-op */
  }

  // ---------------------------------------------------------------------------
  // High-level base operations
  // ---------------------------------------------------------------------------

  /**
   * Read the base HW/FW version and derive its family + slot count. Sends
   * `SDV$` and parses the `V,<hw>,<fwId>,<major>,<minor>,<internal>` reply
   * (SmartDockUart.java:148-157, :796-806).
   */
  async getDockInfo(): Promise<SmartDockInfo> {
    return this._serialize(() => this._getDockInfoImpl());
  }

  private async _getDockInfoImpl(): Promise<SmartDockInfo> {
    const line = await this._command(
      SMARTDOCK_BASE_CMD.GET_VERSION,
      'version',
      this._responseTimeoutMs,
    );
    const firmwareVersion = parseSmartDockVersion(line);
    if (!firmwareVersion) throw new Error(`Malformed SmartDock version response: "${line}"`);
    const { hardwareType, slotCount } = baseHardwareType(firmwareVersion.hardwareVersion);
    const info: SmartDockInfo = { hardwareType, firmwareVersion, slotCount };
    this.dockInfo = info;
    this._emitStatus(
      `SmartDock ${hardwareType} (${slotCount} slots) FW ${firmwareVersion.firmwareVersionMajor}.` +
        `${firmwareVersion.firmwareVersionMinor}.${firmwareVersion.firmwareVersionInternal}`,
    );
    return info;
  }

  /**
   * Query which slots are occupied. Sends `SDQ$` and parses the
   * `Q,<map>` bitmap (one ASCII `0`/`1` per slot) into per-slot occupancy
   * (SmartDockUart.java:162-171, SmartDockUartListener.java:140-181). The number
   * of entries is the base's slot count as reported on the wire.
   */
  async getSlotOccupancy(): Promise<SlotOccupancy[]> {
    return this._serialize(() => this._getSlotOccupancyImpl());
  }

  private async _getSlotOccupancyImpl(): Promise<SlotOccupancy[]> {
    const line = await this._command(
      SMARTDOCK_BASE_CMD.QUERY_CONNECTED_SLOTS,
      'occupancy',
      this._responseTimeoutMs,
    );
    const map = parseSlotOccupancy(line);
    if (!map) throw new Error(`Malformed SmartDock occupancy response: "${line}"`);
    return map.map((occupied, i) => ({ slot: i + 1, occupied }));
  }

  /**
   * Select the active slot (WITHOUT SD access — the read path). Sends
   * `SDP,NN$`, awaits the `P,NN` confirmation with the ported ~10 s slot-change
   * timeout, verifies the returned slot matches the request (Java throws
   * `DOCK_CMD_ERR_FAIL_SET` on mismatch, SmartDockUart.java:233-241), then waits
   * the ported settle delay (1500 ms) before the per-Shimmer UART is usable
   * (SmartDock.java:674-691). Finally resyncs the per-Shimmer byte stream (the
   * slot re-route may leave stale bytes) — reusing D1's
   * {@link WiredShimmerClient.resyncStream}.
   *
   * @param slotNumber 1-based slot (1..slotCount).
   */
  async selectSlot(slotNumber: number): Promise<void> {
    return this._serialize(() =>
      this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD),
    );
  }

  /** Disconnect all slots (`SDD$`); no slot is active afterwards. */
  async disconnectAllSlots(): Promise<void> {
    return this._serialize(() => this._disconnectAllSlotsImpl());
  }

  private async _disconnectAllSlotsImpl(): Promise<void> {
    await this._command(
      SMARTDOCK_BASE_CMD.DISCONNECT_ALL,
      'disconnected',
      this._slotChangeTimeoutMs,
    );
    this.activeSlot = -1;
    this._emitStatus('All slots disconnected');
  }

  private async _selectSlotInternal(
    slotNumber: number,
    connectionType: SmartDockConnectionType,
  ): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    const cmd = buildSelectSlotCommand(slotNumber, connectionType);
    // The reply is `P,NN` (without SD) or `C,NN` (with SD).
    const wantKind =
      connectionType === SMARTDOCK_CONNECTION_TYPE.WITH_SD_CARD ? 'slotWithSd' : 'slotWithoutSd';
    const line = await this._sendWithRetry(
      cmd,
      [wantKind, 'disconnected'],
      this._slotChangeTimeoutMs,
      `select slot ${slotNumber}`,
    );
    const active = parseActiveSlot(line);
    if (!active || active.slot !== slotNumber) {
      throw new Error(
        `SmartDock slot select failed: requested ${slotNumber}, got "${line}" (DOCK_CMD_ERR_FAIL_SET)`,
      );
    }
    this.activeSlot = active.slot;
    this._emitStatus(
      `Active slot ${active.slot} selected; settling ${this._slotChangeoverDelayMs}ms`,
    );
    await this._delay(this._slotChangeoverDelayMs);
    // Resync the per-Shimmer stream for the newly routed slot.
    this._wired?.resyncStream();
  }

  // ---------------------------------------------------------------------------
  // Per-slot docked-Shimmer ops (compose D1 WiredShimmerClient)
  // ---------------------------------------------------------------------------

  /**
   * Select `slotNumber`, then read the docked Shimmer's identity by delegating
   * to the D1 {@link WiredShimmerClient.identify} over the per-Shimmer UART. The
   * per-Shimmer protocol (MAC/HW/FW/expansion) is NOT re-implemented here.
   */
  async identifyDockedShimmer(slotNumber: number): Promise<WiredIdentity> {
    return this._serialize(async () => {
      await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
      const wired = await this._ensureWired();
      return wired.identify();
    });
  }

  /**
   * Select `slotNumber`, then read the docked Shimmer's battery/charging status
   * by delegating to the D1 {@link WiredShimmerClient.getStatus}.
   */
  async getDockedShimmerStatus(slotNumber: number): Promise<WiredBatteryStatus> {
    return this._serialize(async () => {
      await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
      const wired = await this._ensureWired();
      return wired.getStatus();
    });
  }

  /**
   * Select `slotNumber`, then read + decode the docked Shimmer's InfoMem
   * configuration (configure-while-docked, phase P2). Slot-select and the
   * per-Shimmer identify + InfoMem read run as one atomic unit under this
   * client's queue, so concurrent calls for different slots cannot interleave.
   * The docked device is (re)identified after the slot change to resolve the
   * correct InfoMem byte layout for that slot.
   */
  async readInfoMemConfig(slotNumber: number): Promise<InfoMemDeviceConfig> {
    return this._serialize(async () => {
      await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
      const wired = await this._ensureWired();
      await wired.identify();
      return wired.readInfoMemConfig();
    });
  }

  /**
   * Select `slotNumber`, then encode + write a configuration to the docked
   * Shimmer's InfoMem, atomically. See
   * {@link WiredShimmerClient.writeInfoMemConfig} for the device-write and
   * verify semantics.
   */
  async writeInfoMemConfig(
    slotNumber: number,
    config: InfoMemDeviceConfig,
    opts: { verify?: boolean } = {},
  ): Promise<{ verified: boolean | null }> {
    return this._serialize(async () => {
      await this._selectSlotInternal(slotNumber, SMARTDOCK_CONNECTION_TYPE.WITHOUT_SD_CARD);
      const wired = await this._ensureWired();
      await wired.identify();
      return wired.writeInfoMemConfig(config, opts);
    });
  }

  /** Lazily build + connect the composed D1 client over the per-Shimmer transport. */
  private async _ensureWired(): Promise<WiredShimmerClient> {
    if (!this._shimmerTransport) {
      throw new Error(
        'SmartDockClient.identifyDockedShimmer / getDockedShimmerStatus require a per-Shimmer ' +
          'transport: a SmartDock routes the active slot onto a separate FTDI UART port. Pass ' +
          'it via the constructor ({ shimmerTransport }).',
      );
    }
    if (!this._wired) {
      this._wired = new WiredShimmerClient({
        debug: this.debug,
        transport: this._shimmerTransport,
      });
    }
    if (!this._wiredConnected) {
      await this._wired.connect();
      this._wiredConnected = true;
    }
    return this._wired;
  }

  // ---------------------------------------------------------------------------
  // Request/response core (base ASCII channel)
  // ---------------------------------------------------------------------------

  /** Send an ASCII base command and await a response of one of `kinds`. */
  private async _command(
    cmd: string,
    kind: Parameters<SmartDockClient['_waitForResponse']>[0][number],
    timeoutMs: number,
  ): Promise<string> {
    return this._sendWithRetry(buildBaseCommand(cmd), [kind], timeoutMs, cmd);
  }

  /**
   * Write `cmdBytes` and await a matching response, re-sending the command on a
   * missed reply for a total of `SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS` (= 2)
   * attempts before failing — mirroring SmartDockUart.java:526-537
   * (`txBytesAndWaitForReply`). Retries on TIMEOUT ONLY; an explicit `E` error
   * response ({@link SmartDockTimeoutError} is not thrown for it) propagates
   * immediately, matching the Java path where `waitForSmartDockResponse` throws
   * on an error instead of returning false.
   */
  private async _sendWithRetry(
    cmdBytes: Uint8Array,
    kinds: Parameters<SmartDockClient['_waitForResponse']>[0],
    timeoutMs: number,
    label: string,
  ): Promise<string> {
    if (!this._transport) throw new Error('Not connected');
    let lastErr: unknown;
    for (let attempt = 0; attempt < SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS; attempt++) {
      await this._transport.write(cmdBytes);
      try {
        return await this._waitForResponse(kinds, timeoutMs, label);
      } catch (err) {
        // Only a timeout is retryable; an error response fails fast.
        if (err instanceof SmartDockTimeoutError) {
          lastErr = err;
          this._log(`command "${label}" timed out (attempt ${attempt + 1}); re-sending`);
          continue;
        }
        throw err;
      }
    }
    throw lastErr instanceof Error ? lastErr : new SmartDockTimeoutError(`timeout (${label})`);
  }

  /**
   * Resolve with the first response line whose classification is in `kinds`;
   * reject on an `E` error line or timeout. Lines of any other kind (including
   * `unknown`/garbage) are ignored — this is the resync discipline.
   */
  private _waitForResponse(
    kinds: ReadonlyArray<'version' | 'occupancy' | 'slotWithoutSd' | 'slotWithSd' | 'disconnected'>,
    timeoutMs: number,
    label: string,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new SmartDockTimeoutError(`SmartDock response timeout (${label})`));
      }, timeoutMs);
      const handler = (line: string): void => {
        const k = classifyBaseResponse(line);
        if (k === 'error') {
          clearTimeout(t);
          this._offTemp(handler);
          reject(new Error(`SmartDock error response (${label})`));
          return;
        }
        if ((kinds as readonly string[]).includes(k)) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(line);
        }
        // else: ignore (unrelated line / garbage) and keep waiting.
      };
      this._onTemp(handler);
    });
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Run `fn` after every previously-queued operation has settled, so all public
   * operations execute strictly one-at-a-time (see {@link _queue}). The queue
   * never rejects — a failed op does not poison later ones — while the caller
   * still receives `fn`'s own resolution/rejection.
   */
  private _serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this._queue.then(() => fn());
    this._queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  // ---------------------------------------------------------------------------
  // RX: accumulate the unframed byte stream, extract complete `\r\n` lines
  // ---------------------------------------------------------------------------

  private _handleNotify = (chunk: Uint8Array): void => {
    if (!chunk || chunk.length === 0) return;
    this._log('Notify len=', chunk.length);
    this._rxBuf = concatU8(this._rxBuf, chunk);
    this._drain();
  };

  private _drain(): void {
    for (;;) {
      const res = extractBaseLine(this._rxBuf);
      if (!res) break;
      this._rxBuf = res.rest;
      if (res.line.length > 0) this._emitTemp(res.line);
    }
  }

  private _onTemp(fn: (line: string) => void): void {
    this._temps.add(fn);
  }
  private _offTemp(fn: (line: string) => void): void {
    this._temps.delete(fn);
  }
  private _emitTemp(line: string): void {
    this._temps.forEach((fn) => {
      try {
        fn(line);
      } catch (e) {
        this._log('temp handler error', e);
      }
    });
  }
}
