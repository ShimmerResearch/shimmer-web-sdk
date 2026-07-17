import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import {
  UART_PACKET_CMD,
  UART_PROP,
  UART_CONFIG_COMMANDS,
  WIRED_DEFAULTS,
  type UartComponentProperty,
} from './constants.js';
import {
  concatU8,
  buildReadPacket,
  buildWritePacket,
  buildUartPacket,
  buildMemReadPayload,
  buildMemWritePayload,
  parseUartPacket,
  wiredPacketLength,
  isBadResponse,
  badResponseReason,
  parseMacId,
  parseVersionInfo,
  parseBatteryStatus,
  parseExpansionBoard,
  msToRtcBytesLE,
  isSupportedRtcConfigViaUart,
  NEED_MORE,
  RESYNC,
  type UartRxPacket,
  type WiredVersionInfo,
  type WiredBatteryStatus,
  type ExpansionBoardInfo,
} from './protocol.js';
import {
  resolveInfoMemLayout,
  parseInfoMem,
  generateInfoMem,
  deviceWriteDivergentRanges,
  INFOMEM_SIZE,
  INFOMEM_PAGE_SIZE,
  type InfoMemContext,
  type InfoMemDeviceConfig,
} from '../infomem/index.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface WiredShimmerClientOptions extends ShimmerClientOptions {
  /**
   * The dock UART byte pipe (a `ShimmerTransport` over the dock's FTDI serial
   * port). **Required** — a docked Shimmer is only reachable over this wired
   * link, so unlike the BLE clients this one never builds a default transport;
   * `connect()` without one throws. The transport should report
   * `capabilities.framed = false` (serial is an unframed byte stream). See
   * `UART_DOCK_BAUD_RATE` (115200 8N1) for how to configure the port.
   */
  transport?: ShimmerTransport;
}

/** Result of {@link WiredShimmerClient.identify}. */
export interface WiredIdentity {
  /** 12-char UPPERCASE hex MAC, in device byte order. */
  mac: string;
  /** Hardware version (from the VER response). */
  hardwareVersion: number;
  /** Full firmware/hardware version info. */
  firmwareVersion: WiredVersionInfo;
  /** Daughter-card / expansion board, or null when none is fitted. */
  expansionBoard: ExpansionBoardInfo | null;
}

// ---------------------------------------------------------------------------
// WiredShimmerClient
// ---------------------------------------------------------------------------

/**
 * Client for a Shimmer sitting in a BasicDock/Base, talking over the dock's
 * FTDI **UART** (host↔device). This is the wired/dock protocol
 * (`com.shimmerresearch.comms.wiredProtocol`), which is entirely separate from
 * the Bluetooth LiteProtocol used by {@link Shimmer3Client} /
 * `Shimmer3RClient` — different framing (`$`-header packets with a component +
 * property address, length, payload and a Shimmer-specific CRC), a different
 * request/response state machine, and a different CRC (`./crc.ts`).
 *
 * Scope (phase D1): identify + status + property-level config for a single
 * docked device. NO mass-storage/SD, NO firmware flashing, NO multi-slot Base
 * state machine (those are later phases). Streaming is not part of the dock
 * protocol.
 *
 * Robustness: the dock UART is an unframed byte stream (serial has no message
 * boundaries), so — exactly like {@link Shimmer3Client} — this client
 * accumulates inbound bytes and extracts complete packets with a length-aware
 * parser ({@link wiredPacketLength}), tolerant of packets split, dribbled or
 * coalesced arbitrarily. A packet whose CRC fails triggers a single-byte
 * resync, matching the Java `parseSinglePacket` recovery path.
 *
 * Transport injection is mandatory — `connect()` with no transport throws.
 *
 * @example
 * ```ts
 * const client = new WiredShimmerClient({ transport: dockSerialTransport });
 * await client.connect();
 * const id = await client.identify();     // { mac, hwVersion, firmwareVersion, expansionBoard }
 * const status = await client.getStatus(); // { voltage, percentage, chargingStatus, ... }
 * const range = await client.getConfig(UART_PROP.GSR.RANGE);
 * await client.setConfig(UART_PROP.GSR.RANGE, new Uint8Array([2]));
 * ```
 */
export class WiredShimmerClient extends BaseShimmerClient {
  private _injectedTransport: ShimmerTransport | null = null;
  private _transport: ShimmerTransport | null = null;
  private _notifyUnsub: Unsubscribe | null = null;
  private _disconnectUnsub: Unsubscribe | null = null;

  private _rxBuf: Uint8Array = new Uint8Array(0);
  private _temps: Set<(pkt: UartRxPacket) => void> = new Set();

  /**
   * Serialization queue. Every public command method chains onto this so that
   * only one request/response exchange is in flight at a time — the docked
   * Shimmer speaks a strictly sequential request/response protocol and the
   * Java driver clears pending ACKs before each command
   * (AbstractCommsProtocolWired.java:318,358). Without this, overlapping
   * commands could cross-resolve on the shared temp-handler set (e.g. one
   * command's ACK satisfying another's {@link _waitForAck}), masking a failed
   * write. See {@link _serialize}.
   */
  private _queue: Promise<unknown> = Promise.resolve();

  // Cached device info
  identity: WiredIdentity | null = null;

  constructor(opts: WiredShimmerClientOptions = {}) {
    super(opts);
    this._injectedTransport = opts.transport ?? null;
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[WiredDock]', ...args);
  }

  private _deviceLabel(): string {
    return this._transport?.deviceName ?? 'Shimmer(dock)';
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Open the dock UART connection. A transport is REQUIRED (constructor option
   * or this parameter). Mirrors `BasicDock#setupDock` (open port); the identify
   * / status reads are exposed as explicit methods rather than run implicitly,
   * so callers control ordering (the Java auto-read order is preserved in
   * {@link identify}).
   */
  override async connect(transport?: ShimmerTransport): Promise<void> {
    const t = transport ?? this._injectedTransport;
    if (!t) {
      throw new Error(
        'WiredShimmerClient requires an injected transport: a docked Shimmer is only ' +
          'reachable over the dock UART. Pass a ShimmerTransport via the constructor ' +
          '({ transport }) or connect(transport).',
      );
    }
    this._transport = t;
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    this._emitStatus('Opening dock UART connection…');
    await t.connect();
    this._rxBuf = new Uint8Array(0);
    this._emitStatus(`Connected: ${this._deviceLabel()}`);
  }

  override async disconnect(): Promise<void> {
    try {
      this._notifyUnsub?.();
      this._disconnectUnsub?.();
      await this._transport?.disconnect();
    } catch {
      /* ignore */
    } finally {
      this._notifyUnsub = this._disconnectUnsub = null;
      this._transport = null;
      this._rxBuf = new Uint8Array(0);
      this._temps.clear();
      this._emitStatus('Disconnected');
    }
  }

  private _handleTransportDisconnect = (): void => {
    this._emitStatus('Dock disconnected');
  };

  /**
   * Discard any buffered inbound bytes, resyncing the byte stream. Used by
   * {@link SmartDockClient} after a SmartDock slot change: switching the active
   * slot re-routes the per-Shimmer UART to a different device, so any bytes left
   * over from the previous slot must be dropped before the next request. (The
   * `_drain` parser is already tolerant of leading garbage / bad CRC, so this is
   * belt-and-braces rather than strictly required.)
   */
  resyncStream(): void {
    this._rxBuf = new Uint8Array(0);
  }

  /** Streaming is not part of the dock UART protocol. */
  override async startStreaming(): Promise<void> {
    throw new Error('Streaming is not supported over the dock UART (use the Bluetooth client).');
  }
  override async stopStreaming(): Promise<void> {
    /* no-op: the dock protocol has no stream to stop */
  }

  // ---------------------------------------------------------------------------
  // High-level operations
  // ---------------------------------------------------------------------------

  /**
   * Read the docked device's identity. Follows the order of
   * `BasicDock#internalReadShimmerDetails` (MAC → HW/FW version → daughter-card
   * ID). Battery is read separately via {@link getStatus}. The three reads run
   * as one atomic serialized unit (see {@link _serialize}).
   */
  async identify(): Promise<WiredIdentity> {
    return this._serialize(() => this._identifyImpl());
  }

  private async _identifyImpl(): Promise<WiredIdentity> {
    const mac = await this._readMacImpl();
    const firmwareVersion = await this._readVersionImpl();
    const expansionBoard = await this._readExpansionBoardImpl().catch(() => null);
    const id: WiredIdentity = {
      mac,
      hardwareVersion: firmwareVersion.hardwareVersion,
      firmwareVersion,
      expansionBoard,
    };
    this.identity = id;
    this._emitStatus(
      `Identified ${mac} HW=${id.hardwareVersion} FW=${firmwareVersion.firmwareVersionMajor}.` +
        `${firmwareVersion.firmwareVersionMinor}.${firmwareVersion.firmwareVersionInternal} ` +
        `(type ${firmwareVersion.firmwareIdentifier})`,
    );
    return id;
  }

  /** Read battery voltage / % / charging state (BAT.VALUE). */
  async getStatus(): Promise<WiredBatteryStatus> {
    return this._serialize(() => this._getStatusImpl());
  }

  private async _getStatusImpl(): Promise<WiredBatteryStatus> {
    const payload = await this._read(UART_PROP.BAT.VALUE);
    const status = parseBatteryStatus(payload);
    this._emitStatus(
      `Battery ${status.voltage.toFixed(3)} V` +
        (status.percentage !== null ? ` (~${status.percentage.toFixed(0)}%)` : '') +
        ` — ${status.chargingStatus}`,
    );
    return status;
  }

  /**
   * Read the MAC address (MAIN_PROCESSOR.MAC), retrying a total of
   * `WIRED_DEFAULTS.MAC_READ_RETRIES` (= 2) attempts as the Java dock does
   * (`AbstractDock.readMacId`, AbstractDock.java:1153 `for(i=0;i<
   * READ_MAC_RETRY_ATTEMPTS;i++)` → 2 total attempts).
   */
  async readMac(): Promise<string> {
    return this._serialize(() => this._readMacImpl());
  }

  private async _readMacImpl(): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < WIRED_DEFAULTS.MAC_READ_RETRIES; attempt++) {
      try {
        const payload = await this._read(UART_PROP.MAIN_PROCESSOR.MAC);
        return parseMacId(payload);
      } catch (err) {
        lastErr = err;
        this._log(`readMac attempt ${attempt + 1} failed: ${(err as Error).message}`);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('readMac failed');
  }

  /** Read the HW/FW version (MAIN_PROCESSOR.VER). */
  async readVersion(): Promise<WiredVersionInfo> {
    return this._serialize(() => this._readVersionImpl());
  }

  private async _readVersionImpl(): Promise<WiredVersionInfo> {
    const payload = await this._read(UART_PROP.MAIN_PROCESSOR.VER);
    return parseVersionInfo(payload);
  }

  /**
   * Read the daughter-card (expansion board) ID — the first 16 bytes of the
   * card memory (`DAUGHTER_CARD.CARD_ID`, address 0). Returns null when no board
   * is fitted. Cheap enough to include in {@link identify}.
   */
  async readExpansionBoard(): Promise<ExpansionBoardInfo | null> {
    return this._serialize(() => this._readExpansionBoardImpl());
  }

  private async _readExpansionBoardImpl(): Promise<ExpansionBoardInfo | null> {
    const payload = await this._readMem(UART_PROP.DAUGHTER_CARD.CARD_ID, 0, 16);
    return parseExpansionBoard(payload);
  }

  // ---------------------------------------------------------------------------
  // Property-level config
  // ---------------------------------------------------------------------------

  /** Read one config property's raw payload (READ). */
  async getConfig(arg: UartComponentProperty): Promise<Uint8Array> {
    if (arg.permission === 'WRITE_ONLY') {
      throw new Error(`Property ${arg.name} is write-only`);
    }
    return this._serialize(() => this._read(arg));
  }

  /** Write one config property (WRITE), resolving on ACK. */
  async setConfig(arg: UartComponentProperty, value: Uint8Array): Promise<void> {
    if (arg.permission === 'READ_ONLY') {
      throw new Error(`Property ${arg.name} is read-only`);
    }
    return this._serialize(async () => {
      await this._write(arg, value);
      this._emitStatus(`SET ${arg.name} ACKed`);
    });
  }

  /**
   * Read every property in `UART_CONFIG_COMMANDS` (the Java
   * `mListOfUartCommandsConfig` order). Individual reads that error (e.g. a
   * property the docked firmware does not implement) are captured rather than
   * aborting the batch — the returned map's value is the raw payload or the
   * Error for that property.
   */
  async getConfigAll(): Promise<Map<UartComponentProperty, Uint8Array | Error>> {
    return this._serialize(() => this._getConfigAllImpl());
  }

  private async _getConfigAllImpl(): Promise<Map<UartComponentProperty, Uint8Array | Error>> {
    const out = new Map<UartComponentProperty, Uint8Array | Error>();
    for (const arg of UART_CONFIG_COMMANDS) {
      if (arg.permission === 'WRITE_ONLY') continue;
      try {
        out.set(arg, await this._read(arg));
      } catch (err) {
        out.set(arg, err instanceof Error ? err : new Error(String(err)));
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Low-level InfoMem escape hatch (raw read/write; no layout interpretation)
  // ---------------------------------------------------------------------------

  /**
   * Raw InfoMem read (`MAIN_PROCESSOR.INFOMEM`). Returns `size` bytes from
   * `address`. The InfoMem *layout* is deliberately NOT interpreted in D1 — this
   * is a byte-level escape hatch.
   */
  async readInfoMem(address: number, size: number): Promise<Uint8Array> {
    return this._serialize(() => this._readMem(UART_PROP.MAIN_PROCESSOR.INFOMEM, address, size));
  }

  /** Raw InfoMem write (`MAIN_PROCESSOR.INFOMEM`), resolving on ACK. */
  async writeInfoMem(address: number, data: Uint8Array): Promise<void> {
    return this._serialize(async () => {
      const payload = buildMemWritePayload(UART_PROP.MAIN_PROCESSOR.INFOMEM, address, data);
      await this._writeRaw(UART_PROP.MAIN_PROCESSOR.INFOMEM, payload);
    });
  }

  // ---------------------------------------------------------------------------
  // InfoMem configuration (configure-while-docked, phase P2)
  // ---------------------------------------------------------------------------

  /**
   * Read the full {@link INFOMEM_SIZE}-byte InfoMem in 128-byte page chunks
   * (D → C → B), reassembled in order. The page addresses sent depend on the
   * firmware/hardware (legacy MSP430 0x1800/… vs. flat 0/128/256), resolved
   * from the cached {@link identity} — call {@link identify} (or
   * {@link readVersion}) first.
   */
  async readInfoMemBytes(): Promise<Uint8Array> {
    return this._serialize(() => this._readInfoMemBytesImpl(this._infoMemCtx()));
  }

  /**
   * Write the full {@link INFOMEM_SIZE}-byte InfoMem in 128-byte page chunks,
   * each resolving on its per-chunk ACK (the write guarantee is per-chunk
   * CRC + ACK). Requires a cached {@link identity} for the page addressing.
   */
  async writeInfoMemBytes(bytes: Uint8Array): Promise<void> {
    if (bytes.length !== INFOMEM_SIZE) {
      throw new Error(`writeInfoMemBytes expects ${INFOMEM_SIZE} bytes, got ${bytes.length}`);
    }
    return this._serialize(() => this._writeInfoMemBytesImpl(this._infoMemCtx(), bytes));
  }

  /**
   * Read + decode the docked device's configuration. Uses the cached
   * {@link identity} (already-read version info) as the {@link InfoMemContext}.
   */
  async readInfoMemConfig(): Promise<InfoMemDeviceConfig> {
    return this._serialize(async () => {
      const ctx = this._infoMemCtx();
      const bytes = await this._readInfoMemBytesImpl(ctx);
      return parseInfoMem(bytes, ctx);
    });
  }

  /**
   * Write the docked device's real-world clock from a host timestamp
   * (`MAIN_PROCESSOR.RTC_CFG_TIME`), resolving on ACK. Port of
   * `CommsProtocolWiredShimmerViaDock.writeRealWorldClockFromPcTime`
   * (CommsProtocolWiredShimmerViaDock.java:138-153), which calls
   * `writeRealWorldClock(System.currentTimeMillis())`.
   *
   * `nowMs` (UNIX epoch ms) is injectable for testability; it defaults to
   * `Date.now()` — captured at call time, matching the Java's use of the current
   * PC time. The payload is the 8-byte, LSB-first 32.768 kHz tick count
   * ({@link msToRtcBytesLE}).
   *
   * NB the target property is `RTC_CFG_TIME` (0x04): the Java props table marks
   * it READ_ONLY, yet the driver's SET issues a WRITE against it directly
   * (line 150), which this mirrors by going through the low-level {@link _write}
   * rather than the permission-checked {@link setConfig}.
   *
   * HARDWARE-VERIFY: the RTC payload format and RTC_CFG_TIME write have not been
   * exercised against a real dock.
   */
  async writeRtcFromHostTime(nowMs?: number): Promise<void> {
    return this._serialize(() => this._writeRtcFromHostTimeImpl(nowMs ?? Date.now()));
  }

  /** Non-serialized RTC write — callers must already hold the queue. */
  private async _writeRtcFromHostTimeImpl(nowMs: number): Promise<void> {
    const payload = msToRtcBytesLE(nowMs); // HARDWARE-VERIFY: ms × 32.768 ticks, 8 bytes LSB-first
    await this._write(UART_PROP.MAIN_PROCESSOR.RTC_CFG_TIME, payload);
    this._emitStatus('RTC set from host time');
  }

  /**
   * Encode + write a configuration to the docked device. The MAC is forced to
   * all-0xFF and the config-file-creation flag is set (device-write semantics),
   * so the firmware re-reads its MAC from the BT transceiver and regenerates the
   * SD config on undock/power-cycle.
   *
   * When `opts.setRtc` (default `true`, matching desktop), the device's
   * real-world clock is written FIRST from the host time, then the InfoMem — the
   * exact order of desktop `CallableWriteConfig.call()`
   * (BasicDock.java:1556-1587): (1) RTC write when `isSupportedRtcConfigViaUart`,
   * (2) chunked InfoMem write. The RTC write and InfoMem write are one atomic
   * queued unit. RTC failure ABORTS the config write (the InfoMem write is NOT
   * attempted) — desktop rethrows the RTC `ExecutionException` before reaching
   * the InfoMem write (BasicDock.java:1564-1573), so this is deliberately NOT
   * best-effort. On an identity that does not support RTC-via-UART the RTC write
   * is SKIPPED (not failed), also matching desktop.
   *
   * Finalization (plain config write): there is NO reboot/poll/rewrite here — the
   * device applies the new config and regenerates its SD config file on the next
   * undock / power-cycle. This is identical for Shimmer3 and Shimmer3R. The
   * reboot-then-rewrite dance is a DFU (firmware-update) concern only and is out
   * of scope for a plain config write (BasicDock.java:1556).
   *
   * With `opts.verify`, the InfoMem is read back and byte-compared against the
   * written bytes, EXCLUDING the intentionally-divergent ranges (the MAC bytes,
   * forced to 0xFF, and the config-delay/flag byte). Returns
   * `{ verified: boolean }` when verify was requested, or `{ verified: null }`
   * otherwise.
   *
   * HARDWARE-VERIFY: whether the device accepts and applies the write (and
   * regenerates its SD config on undock) can only be confirmed on real hardware.
   */
  async writeInfoMemConfig(
    config: InfoMemDeviceConfig,
    opts: { verify?: boolean; setRtc?: boolean } = {},
  ): Promise<{ verified: boolean | null }> {
    return this._serialize(async () => {
      const ctx = this._infoMemCtx();
      // (1) RTC write first, exactly as desktop CallableWriteConfig orders it.
      //     Skipped (not failed) on unsupported identities; a failure here aborts
      //     before the InfoMem write, matching the Java rethrow semantics.
      const setRtc = opts.setRtc ?? true;
      if (setRtc && isSupportedRtcConfigViaUart(ctx.hardwareVersion, ctx.firmwareId)) {
        await this._writeRtcFromHostTimeImpl(Date.now());
      }
      // (2) chunked InfoMem write.
      const bytes = generateInfoMem(config, ctx, { base: config.raw, forDeviceWrite: true });
      await this._writeInfoMemBytesImpl(ctx, bytes);
      if (!opts.verify) return { verified: null };
      const readback = await this._readInfoMemBytesImpl(ctx);
      const verified = compareInfoMemExcluding(bytes, readback, deviceWriteDivergentRanges(ctx));
      return { verified };
    });
  }

  /** Build the InfoMem layout context from the cached identity (requires identify/readVersion). */
  private _infoMemCtx(): InfoMemContext {
    const id = this.identity;
    if (!id) {
      throw new Error(
        'InfoMem operations need the device version: call identify() (or readVersion()) first.',
      );
    }
    const fv = id.firmwareVersion;
    return {
      hardwareVersion: id.hardwareVersion,
      firmwareId: fv.firmwareIdentifier,
      firmwareVersion: {
        major: fv.firmwareVersionMajor,
        minor: fv.firmwareVersionMinor,
        internal: fv.firmwareVersionInternal,
      },
    };
  }

  /** Non-serialized chunked read (D/C/B pages) — callers must already hold the queue. */
  private async _readInfoMemBytesImpl(ctx: InfoMemContext): Promise<Uint8Array> {
    const layout = resolveInfoMemLayout(ctx);
    const pageAddrs = [layout.addrD, layout.addrC, layout.addrB];
    const out = new Uint8Array(INFOMEM_SIZE);
    for (let i = 0; i < pageAddrs.length; i++) {
      const chunk = await this._readMem(
        UART_PROP.MAIN_PROCESSOR.INFOMEM,
        pageAddrs[i],
        INFOMEM_PAGE_SIZE,
      );
      if (chunk.length < INFOMEM_PAGE_SIZE) {
        throw new Error(
          `InfoMem page ${i} short read: expected ${INFOMEM_PAGE_SIZE} bytes, got ${chunk.length}`,
        );
      }
      out.set(chunk.subarray(0, INFOMEM_PAGE_SIZE), i * INFOMEM_PAGE_SIZE);
    }
    return out;
  }

  /** Non-serialized chunked write (D/C/B pages) — callers must already hold the queue. */
  private async _writeInfoMemBytesImpl(ctx: InfoMemContext, bytes: Uint8Array): Promise<void> {
    const layout = resolveInfoMemLayout(ctx);
    const pageAddrs = [layout.addrD, layout.addrC, layout.addrB];
    for (let i = 0; i < pageAddrs.length; i++) {
      const page = bytes.subarray(i * INFOMEM_PAGE_SIZE, (i + 1) * INFOMEM_PAGE_SIZE);
      const payload = buildMemWritePayload(UART_PROP.MAIN_PROCESSOR.INFOMEM, pageAddrs[i], page);
      await this._writeRaw(UART_PROP.MAIN_PROCESSOR.INFOMEM, payload);
    }
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Run `fn` after every previously-queued operation has settled, so all public
   * command methods execute strictly one-at-a-time (see {@link _queue}). The
   * queue itself never rejects — a failed op does not poison later ones — while
   * the caller still receives `fn`'s own resolution/rejection.
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
  // Request/response core
  // ---------------------------------------------------------------------------

  /** Send a READ and await the matching DATA_RESPONSE payload. */
  private async _read(
    arg: UartComponentProperty,
    timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected');
    await this._transport.write(buildReadPacket(arg));
    return this._waitForDataResponse(arg, timeoutMs);
  }

  /** Send a memory READ and await the matching DATA_RESPONSE payload. */
  private async _readMem(
    arg: UartComponentProperty,
    address: number,
    size: number,
    timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected');
    const payload = buildMemReadPayload(arg, address, size);
    await this._transport.write(buildUartPacket(UART_PACKET_CMD.READ, arg, payload));
    return this._waitForDataResponse(arg, timeoutMs);
  }

  /** Send a WRITE with a value and await ACK. */
  private async _write(
    arg: UartComponentProperty,
    value: Uint8Array,
    timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    await this._transport.write(buildWritePacket(arg, value));
    await this._waitForAck(timeoutMs);
  }

  /** Send a WRITE with a pre-built payload (e.g. mem write) and await ACK. */
  private async _writeRaw(
    arg: UartComponentProperty,
    payload: Uint8Array,
    timeoutMs = WIRED_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    await this._transport.write(buildUartPacket(UART_PACKET_CMD.WRITE, arg, payload));
    await this._waitForAck(timeoutMs);
  }

  /** Resolve with the payload of a DATA_RESPONSE matching comp+prop; reject on bad/timeout. */
  private _waitForDataResponse(arg: UartComponentProperty, timeoutMs: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error(`Response timeout (READ ${arg.name})`));
      }, timeoutMs);
      const handler = (pkt: UartRxPacket): void => {
        if (isBadResponse(pkt.command)) {
          clearTimeout(t);
          this._offTemp(handler);
          reject(new Error(`Device error: ${badResponseReason(pkt.command)} (READ ${arg.name})`));
          return;
        }
        if (
          pkt.command === UART_PACKET_CMD.DATA_RESPONSE &&
          pkt.component === arg.component &&
          pkt.property === arg.property
        ) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(pkt.payload);
        }
      };
      this._onTemp(handler);
    });
  }

  /** Resolve on the next ACK; reject on bad response or timeout. */
  private _waitForAck(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error('ACK timeout'));
      }, timeoutMs);
      const handler = (pkt: UartRxPacket): void => {
        if (pkt.command === UART_PACKET_CMD.ACK_RESPONSE) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve();
        } else if (isBadResponse(pkt.command)) {
          clearTimeout(t);
          this._offTemp(handler);
          reject(new Error(`Device error: ${badResponseReason(pkt.command)}`));
        }
      };
      this._onTemp(handler);
    });
  }

  // ---------------------------------------------------------------------------
  // RX: accumulate an unframed byte stream, extract complete packets
  // ---------------------------------------------------------------------------

  private _handleNotify = (chunk: Uint8Array): void => {
    if (!chunk || chunk.length === 0) return;
    this._log('Notify len=', chunk.length);
    this._rxBuf = concatU8(this._rxBuf, chunk);
    this._drain();
  };

  /**
   * Extract every complete packet currently buffered and dispatch each to the
   * temp handlers, keeping the incomplete tail for the next chunk. A packet
   * whose CRC fails is dropped one byte at a time to resync (matching the Java
   * `parseSinglePacket` CRC-fail path).
   */
  private _drain(): void {
    let buf = this._rxBuf;
    for (;;) {
      if (buf.length === 0) break;
      const len = wiredPacketLength(buf);
      if (len === NEED_MORE) break;
      if (len === RESYNC) {
        this._log(`resync: dropping byte 0x${buf[0].toString(16)}`);
        buf = buf.subarray(1);
        continue;
      }
      if (buf.length < len) break; // full packet not here yet

      let pkt: UartRxPacket;
      try {
        pkt = parseUartPacket(buf);
      } catch {
        buf = buf.subarray(1); // malformed — resync
        continue;
      }
      if (!pkt.crcOk) {
        this._log('bad CRC → dropping 1 byte to resync');
        buf = buf.subarray(1);
        continue;
      }
      this._emitTemp(pkt);
      buf = buf.subarray(pkt.length);
    }
    this._rxBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
  }

  private _onTemp(fn: (pkt: UartRxPacket) => void): void {
    this._temps.add(fn);
  }
  private _offTemp(fn: (pkt: UartRxPacket) => void): void {
    this._temps.delete(fn);
  }
  private _emitTemp(pkt: UartRxPacket): void {
    this._temps.forEach((fn) => {
      try {
        fn(pkt);
      } catch (e) {
        this._log('temp handler error', e);
      }
    });
  }
}

/**
 * Byte-compare `written` against `readback` over the full InfoMem, ignoring the
 * ranges that a device write intentionally leaves diverged (the MAC bytes,
 * forced to 0xFF, and the config-delay/flag byte the firmware may rewrite).
 */
function compareInfoMemExcluding(
  written: Uint8Array,
  readback: Uint8Array,
  ranges: {
    mac: { start: number; length: number };
    configDelayFlag: { start: number; length: number };
  },
): boolean {
  if (written.length !== readback.length) return false;
  const excluded = new Set<number>();
  for (const r of [ranges.mac, ranges.configDelayFlag]) {
    for (let i = 0; i < r.length; i++) excluded.add(r.start + i);
  }
  for (let i = 0; i < written.length; i++) {
    if (excluded.has(i)) continue;
    if (written[i] !== readback[i]) return false;
  }
  return true;
}
