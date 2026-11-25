import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import { HandlerSet } from '../../core/handlerSet.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import { unnamedLink } from '../../core/transport/linkNoun.js';
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
  type SmartDockActiveSlot,
  type SmartDockConnectionType,
  type SmartDockHardwareType,
  type SmartDockResponseKind,
  type SmartDockVersionInfo,
} from './smartDockProtocol.js';

/** The kinds of base line that answer a command. */
type AnswerKind = Exclude<SmartDockResponseKind, 'error' | 'boot' | 'unknown'>;

/** What answers a slot change (`SDP,NN$`, `SDC,NN$`) or `SDD$`: `P,NN`, `C,NN`, or `C` / `D` for none. */
const ACTIVE_SLOT_KINDS: readonly AnswerKind[] = ['slotWithoutSd', 'slotWithSd', 'disconnected'];

/**
 * What a line of the kind awaited is to the command waiting for it:
 * - `take`: the answer for what was asked;
 * - `otherSlot`: a slot change's answer naming another slot, or a slot for
 *   `SDD$`. It may be a late answer to an earlier command, so it is not taken;
 * - `malformed`: of the kind awaited, but not holding what that kind holds.
 */
type Verdict = 'take' | 'otherSlot' | 'malformed';

/** The last try of a base command had no answer within its time. */
class SmartDockTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartDockTimeoutError';
  }
}

/** The last try of a slot change was answered with another slot (or, for `SDD$`, with a slot). */
class SmartDockOtherSlotError extends Error {
  constructor(
    message: string,
    /** What the base said it routes. */
    readonly reported: SmartDockActiveSlot,
  ) {
    super(message);
    this.name = 'SmartDockOtherSlotError';
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
    /** Wait after a try that fails before the command is sent again (ms). Default 2000. */
    retryIntervalMs: number;
  }>;
  /**
   * How many times in all a base command is sent while each try fails.
   * Default {@link SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS} (15), which a base
   * that refuses commands at random needs. A host probing a port that may not
   * be a base at all can pass fewer, at the risk of taking a refusing base for
   * no base.
   */
  commandTries?: number;
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
 * A base can refuse commands at random, so a command that is refused (`E`),
 * unanswered, or, for a slot change, answered with another slot is sent again,
 * up to {@link SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS} (15) tries 2 s apart; see
 * {@link _sendWithRetry}. Each call still ends with one result.
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
  private readonly _temps = new HandlerSet<string>((e) => this._log('temp handler error', e));

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
  private readonly _retryIntervalMs: number;
  private readonly _commandTries: number;

  /** Ends the base command in progress, saying why; it sends nothing more. */
  private readonly _aborts = new Set<(why: string) => void>();
  /** The base transport reported a disconnect; cleared by {@link connect}. */
  private _linkLost = false;

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
    this._retryIntervalMs =
      opts.timeouts?.retryIntervalMs ?? SMARTDOCK_DEFAULTS.CMD_RETRY_INTERVAL_MS;
    this._commandTries = Math.max(
      1,
      Math.floor(opts.commandTries ?? SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS),
    );
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[SmartDock]', ...args);
  }

  /**
   * The name the link reported, or `null` when it reported none. Never invented.
   *
   * This client builds no `ObjectCluster` — the dock protocol has no streaming —
   * so unlike the Shimmer3/3R clients there is no second caller needing a
   * non-null identifier, and nothing to trade off against saying so plainly.
   * The old `?? 'SmartDock'` fired on every real connect, because the base UART
   * arrives over a `WebSerialTransport` and Web Serial reports no name at all.
   */
  private _reportedDeviceName(): string | null {
    const name = this._transport?.deviceName?.trim();
    return name ? name : null;
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
    this._linkLost = false;
    this._emitStatus(`Connected: ${this._reportedDeviceName() ?? unnamedLink(t.kind)}`);
  }

  override async disconnect(): Promise<void> {
    this._abortCommands('disconnected');
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
    // A command waiting for its answer, or to be sent again, ends now rather
    // than writing to a link that has gone; so does every call queued behind it.
    this._linkLost = true;
    this._abortCommands('the link was lost');
    this._emitStatus('SmartDock disconnected');
  };

  /** End the base command in progress, if any: it rejects, and sends nothing more. */
  private _abortCommands(why: string): void {
    for (const abort of [...this._aborts]) abort(why);
  }

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
   * timeout, verifies the returned slot matches the request, then waits
   * the ported settle delay (1500 ms) before the per-Shimmer UART is usable
   * (SmartDock.java:674-691). Finally resyncs the per-Shimmer byte stream (the
   * slot re-route may leave stale bytes) — reusing D1's
   * {@link WiredShimmerClient.resyncStream}.
   *
   * An answer naming another slot fails that try, and the command is sent
   * again: it may be a late answer to an earlier command. Only after the last
   * try does the call fail (`DOCK_CMD_ERR_FAIL_SET`, as the Java does at once,
   * SmartDockUart.java:233-241), and then {@link activeSlot} is what that last
   * answer named.
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
    const cmd = SMARTDOCK_BASE_CMD.DISCONNECT_ALL;
    const line = await this._changeSlot(buildBaseCommand(cmd), -1, cmd);
    if (parseActiveSlot(line)?.slot !== -1) {
      throw new Error(`SmartDock disconnect all slots failed: got "${line}"`);
    }
    this.activeSlot = -1;
    this._emitStatus('All slots disconnected');
  }

  private async _selectSlotInternal(
    slotNumber: number,
    connectionType: SmartDockConnectionType,
  ): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    const cmd = buildSelectSlotCommand(slotNumber, connectionType);
    // The reply is `P,NN` (without SD) or `C,NN` (with SD). Like the Java, only
    // the slot is compared, not whether it was routed with its SD card.
    const line = await this._changeSlot(cmd, slotNumber, `select slot ${slotNumber}`);
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
   * {@link WiredShimmerClient.writeInfoMemConfig} for the device-write, RTC
   * (`opts.setRtc`, default true) and verify semantics.
   */
  async writeInfoMemConfig(
    slotNumber: number,
    config: InfoMemDeviceConfig,
    opts: { verify?: boolean; setRtc?: boolean } = {},
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

  /**
   * Send a query (`SDV$`, `SDQ$`) and await its answer of `kind`. A malformed
   * answer ends the call; the caller says why.
   */
  private async _command(
    cmd: string,
    kind: 'version' | 'occupancy',
    timeoutMs: number,
  ): Promise<string> {
    const holds = kind === 'version' ? parseSmartDockVersion : parseSlotOccupancy;
    return this._sendWithRetry(buildBaseCommand(cmd), [kind], timeoutMs, cmd, (line) =>
      holds(line) ? 'take' : 'malformed',
    );
  }

  /**
   * Send a slot change, or `SDD$` (`slot` -1), and await the answer naming
   * `slot` (-1: none). An answer naming another slot fails that try. If the
   * last try's does, the call fails, and {@link activeSlot} is what it named:
   * only the last try's answer is taken as what the base routes.
   */
  private async _changeSlot(cmdBytes: Uint8Array, slot: number, label: string): Promise<string> {
    try {
      return await this._sendWithRetry(
        cmdBytes,
        ACTIVE_SLOT_KINDS,
        this._slotChangeTimeoutMs,
        label,
        (line) => {
          const active = parseActiveSlot(line);
          if (!active) return 'malformed';
          return active.slot === slot ? 'take' : 'otherSlot';
        },
      );
    } catch (err) {
      if (err instanceof SmartDockOtherSlotError) this.activeSlot = err.reported.slot;
      throw err;
    }
  }

  /**
   * Write `cmdBytes` and await the base's answer of one of `kinds` that
   * `judge` takes, sending the command again while it is refused or
   * unanswered. A base can refuse commands at random: it loses bytes that
   * arrive while its main loop is busy (see
   * {@link SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS}). So:
   *
   * - The command is sent up to `commandTries` (15) times, `retryIntervalMs`
   *   (2 s) after each try that fails.
   * - A try fails on an `E`, on no answer within `timeoutMs`, or on an answer
   *   `judge` calls `otherSlot`. That answer may be a late one to an earlier
   *   command, so it is not taken.
   * - An answer `judge` takes that arrives between tries is still taken, and
   *   the command is not sent again. Anything else between tries, an `E`
   *   included, is dropped: it is not this try's.
   * - A `malformed` answer to a try in flight ends the call at once, with that
   *   line; the caller says why. It is not a refusal.
   * - Lines of other kinds (garbage, partial lines) are ignored: the resync
   *   discipline.
   * - The call ends with one result: the answer, or the last try's failure.
   *   It also ends, sending nothing more, when the link is lost or
   *   {@link disconnect} is called.
   *
   * The rule is the one that got every command through on a Base6 refusing
   * them at random (24 Nov 2026), sent from the HIL harness. This client ran
   * it from Node on 25 Nov 2026, at commit afc58f6, on that Base6 and on a
   * Base15 (both firmware 0.1.0), three runs on each: getDockInfo,
   * getSlotOccupancy, an identify, status and InfoMem read of each docked
   * Shimmer3 (four on the Base6; six on the Base15, slots 14 and 15
   * included), and disconnectAllSlots, all passing. In each run the first try
   * of `SDQ$`, `SDP,01$` and `SDD$` was cut short a byte and refused with
   * `E`, and the first `SDV$` was sent without its `$` and left unanswered;
   * each was taken on try 2.
   *
   * HARDWARE-VERIFY: not yet seen on a base: two or more failed tries in a
   * row, and `SDC,NN$` (a select with the SD card).
   */
  private _sendWithRetry(
    cmdBytes: Uint8Array,
    kinds: readonly AnswerKind[],
    timeoutMs: number,
    label: string,
    judge: (line: string) => Verdict,
  ): Promise<string> {
    const transport = this._transport;
    if (!transport) return Promise.reject(new Error('Not connected'));
    if (this._linkLost) {
      return Promise.reject(new Error(`SmartDock link lost (${label}): not sent`));
    }
    const tries = this._commandTries;
    const retryMs = this._retryIntervalMs;
    return new Promise<string>((resolve, reject) => {
      let attempt = 0;
      /** A try has been written and has neither been answered nor failed. */
      let inFlight = false;
      let ended = false;
      /** The try's answer timeout, or the wait before the next try. */
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onTry = (): string => (tries > 1 ? `, try ${attempt} of ${tries}` : '');

      const end = (err: Error | null, line = ''): void => {
        if (ended) return;
        ended = true;
        inFlight = false;
        clearTimeout(timer);
        this._offTemp(onLine);
        this._aborts.delete(abort);
        if (err) reject(err);
        else resolve(line);
      };

      const tryFailed = (err: Error): void => {
        inFlight = false;
        clearTimeout(timer);
        if (attempt >= tries) {
          end(err);
          return;
        }
        // Scheduled before the status goes out, so a host's onStatus that
        // throws cannot leave the call waiting for a try that never comes.
        timer = setTimeout(send, retryMs);
        const why = `${err.message}; sending again in ${retryMs} ms`;
        this._log(why);
        this._emitStatus(why);
      };

      const send = (): void => {
        if (ended) return;
        attempt += 1;
        const thisTry = attempt;
        inFlight = true;
        transport.write(cmdBytes).then(
          () => {
            // Already answered, refused or ended while the write was pending.
            if (ended || !inFlight || attempt !== thisTry) return;
            timer = setTimeout(
              () =>
                tryFailed(
                  new SmartDockTimeoutError(
                    `SmartDock response timeout (${label}): no answer within ${timeoutMs} ms${onTry()}`,
                  ),
                ),
              timeoutMs,
            );
          },
          (err: unknown) => end(err instanceof Error ? err : new Error(String(err))),
        );
      };

      const onLine = (line: string): void => {
        if (ended) return;
        const kind = classifyBaseResponse(line);
        if (kind === 'error') {
          if (inFlight)
            tryFailed(new Error(`SmartDock error response (${label}): refused (E)${onTry()}`));
          else this._log(`"${line}" dropped while "${label}" waits to be sent again`);
          return;
        }
        if (!(kinds as readonly string[]).includes(kind)) return;
        const verdict = judge(line);
        if (verdict === 'take') {
          end(null, line);
          return;
        }
        if (!inFlight) {
          this._log(`"${line}" dropped while "${label}" waits to be sent again`);
          return;
        }
        if (verdict === 'malformed') {
          end(null, line);
          return;
        }
        // `otherSlot`: only a slot judge says it, of a line that parsed.
        const reported = parseActiveSlot(line) as SmartDockActiveSlot;
        const said = reported.slot === -1 ? 'no slot' : `slot ${reported.slot}`;
        tryFailed(
          new SmartDockOtherSlotError(
            `SmartDock ${label} failed: the base routes ${said} ("${line}")${onTry()} ` +
              '(DOCK_CMD_ERR_FAIL_SET)',
            reported,
          ),
        );
      };

      const abort = (why: string): void =>
        end(new Error(`SmartDock command "${label}" not finished: ${why}`));

      this._onTemp(onLine);
      this._aborts.add(abort);
      send();
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
    this._temps.emit(line);
  }
}
