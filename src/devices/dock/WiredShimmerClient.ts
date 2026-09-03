import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import { drainByteStream } from '../../core/framing.js';
import {
  FactoryTestCapture,
  FactoryTestError,
  type FactoryTestRunOptions,
  type FactoryTestState,
} from '../factoryTest/capture.js';
import {
  requireShimmer3FactoryTestType,
  type Shimmer3FactoryTestTypeInfo,
} from '../shimmer3r/factoryTest.js';
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
  classifyFactoryTestAckPacket,
  parseMacId,
  parseVersionInfo,
  parseBatteryStatus,
  parseExpansionBoard,
  msToRtcBytesLE,
  isSupportedRtcConfigViaUart,
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
  compareInfoMemExcluding,
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

  /**
   * The in-flight factory-test capture, or null when none is running. Non-null
   * for the whole time the report owns the link — including the drain after a
   * cancelled or timed-out run, because the firmware has no abort command and
   * keeps printing regardless.
   */
  private _factoryTest: FactoryTestCapture | null = null;

  /**
   * Invoked whenever {@link factoryTestState} changes, synchronously. A host
   * uses it to hold its own "the link is busy" gate through the whole run,
   * including the `draining` phase when the sensor is still printing.
   */
  onFactoryTestStateChange: ((state: FactoryTestState) => void) | null = null;

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
    this._armDisconnectNotification();
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    this._emitStatus('Opening dock UART connection…');
    await t.connect();
    this._rxBuf = new Uint8Array(0);
    this._emitStatus(`Connected: ${this._deviceLabel()}`);
  }

  override async disconnect(): Promise<void> {
    // Fail an in-flight capture BEFORE the transport goes: no further bytes are
    // coming, so there is nothing to drain, and a caller awaiting the report
    // must be told rather than left waiting out the whole budget.
    this._failFactoryTest('Disconnected while the factory self-test was running.');
    // Application-initiated teardown is not a fault, so `onDisconnect` stays
    // silent — including when this call is the cleanup that follows a drop.
    this._suppressDisconnectNotification();
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

  /** Handle an unexpected transport disconnect (the dock UART went away). */
  private _handleTransportDisconnect = (reason?: Error): void => {
    this._failFactoryTest('The link dropped during the factory self-test.');
    this._emitStatus('Dock disconnected');
    this._emitDisconnect(reason);
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

  // ---------------------------------------------------------------------------
  // Factory self-test (component UART_COMPONENT.TEST)
  // ---------------------------------------------------------------------------

  /**
   * What the factory-test runner is doing: `idle` when the link is free,
   * `running` while a report is being captured, `draining` while a cancelled or
   * timed-out report is still being swallowed.
   */
  get factoryTestState(): FactoryTestState {
    return this._factoryTest?.state ?? 'idle';
  }

  /**
   * Resolve when the link is free again. Never rejects — a failed run still
   * releases the link, and this is the wait a host needs after cancelling one.
   */
  whenFactoryTestIdle(): Promise<void> {
    return this._factoryTest?.idle ?? Promise.resolve();
  }

  /**
   * Run the docked sensor's factory self-test and return its report.
   *
   * The dock protocol addresses the test as a WRITE to `UART_COMPONENT.TEST`
   * whose PROPERTY byte is the test type, with no payload
   * (`Comms/shimmer_dock_usart.c:473-486`). The firmware ACKs it and then prints
   * the same report the Bluetooth command produces — as raw text on this link,
   * with no packet framing and no CRC. A type the firmware does not know is
   * answered BAD_CMD, which surfaces here as a `nack`.
   *
   * On a Shimmer3R the report goes to the USB CDC port when the sensor is
   * plugged in by USB and to the dock UART otherwise (`hal_FactoryTest.c`), so
   * this one method serves a docked sensor and a USB-C-connected one alike.
   *
   * Two caveats worth passing on to whoever reads the report:
   * - The whole run holds this client's command queue. Nothing else reaches the
   *   sensor until the report ends — which is the truth about the firmware, not
   *   a limitation here: its main loop is blocked for the duration.
   * - **The ExG chip test cannot pass from the dock.** Shimmer3 firmware prints
   *   `- FAIL: ADS1292R test will not work from dock` because the dock UART and
   *   that chip share pins. A FAIL on that line from this transport says nothing
   *   about the board; run the test over Bluetooth to judge it.
   *
   * @param type 0 MAIN, 1 LEDS, 2 ICS, 3 LED_STATES (`Test/shimmer_test.h:21-27`).
   * @param opts see {@link FactoryTestRunOptions}; `timeoutMs` defaults to the
   *   type's own entry in `SHIMMER3_FACTORY_TEST_TYPES`. `preflight` is ignored:
   *   the dock protocol has no equivalent status read.
   * @returns the report text, CRLF line endings intact.
   *
   * HARDWARE-VERIFY: no docked Shimmer3 or USB-C Shimmer3R has run this path.
   */
  async runFactoryTest(type: number, opts: FactoryTestRunOptions = {}): Promise<string> {
    const info = requireShimmer3FactoryTestType(type);
    if (this._factoryTest) {
      throw new FactoryTestError(
        'busy',
        'A factory test is already running, or its report is still draining — ' +
          'await whenFactoryTestIdle() first.',
      );
    }
    return this._serialize(() => this._runFactoryTestImpl(info, opts));
  }

  private async _runFactoryTestImpl(
    info: Shimmer3FactoryTestTypeInfo,
    opts: FactoryTestRunOptions,
  ): Promise<string> {
    const transport = this._transport;
    if (!transport) throw new Error('Not connected');
    if (opts.signal?.aborted) throw new DOMException('Factory test aborted', 'AbortError');

    // Nothing left over from before may be mistaken for the first report line.
    this._rxBuf = new Uint8Array(0);

    const capture = new FactoryTestCapture(classifyFactoryTestAckPacket, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? info.defaultTimeoutMs,
      onStateChange: (state) => {
        /* Release before telling the host, so a host that issues its next
           command straight out of this callback is not refused by the run it
           was just told had ended. */
        if (state === 'idle') this._releaseFactoryTest();
        try {
          this.onFactoryTestStateChange?.(state);
        } catch (e) {
          this._log('onFactoryTestStateChange handler error', e);
        }
      },
    });

    this._factoryTest = capture;
    capture.start();
    this._emitStatus(`Factory test ${info.name} requested — the sensor will print its report…`);
    try {
      await transport.write(buildWritePacket(UART_PROP.TEST[info.name], new Uint8Array(0)));
    } catch (err) {
      capture.fail(
        new FactoryTestError(
          'disconnected',
          `Could not send the factory-test command: ${(err as Error).message}`,
        ),
      );
    }
    return capture.result;
  }

  /**
   * Let go of the link at the end of a run: clear the capture, then drop
   * anything the report left in the accumulator. Called from the capture's own
   * `idle` transition, so it happens before the tail bytes it hands back are
   * routed through the packet parser.
   */
  private _releaseFactoryTest(): void {
    this._factoryTest = null;
    this._rxBuf = new Uint8Array(0);
    this._emitStatus('Factory test finished — the link is free again');
  }

  /**
   * Abandon an in-flight capture because the link has gone. No drain: draining
   * exists to keep a still-arriving report out of the packet parser, and nothing
   * is arriving on a link that is closed.
   */
  private _failFactoryTest(message: string): void {
    this._factoryTest?.fail(new FactoryTestError('disconnected', message));
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

  /**
   * Read from the daughter-card EEPROM memory (`DAUGHTER_CARD.CARD_MEM`).
   * `address` is a HOST offset — firmware maps it past the first (HW details)
   * EEPROM page, so host offsets 0..2031 cover absolute EEPROM bytes 16..2047.
   */
  async readDaughterCardMem(address: number, size: number): Promise<Uint8Array> {
    if (!Number.isInteger(address) || address < 0 || address > 2031) {
      throw new Error('Daughter-card mem address must be an integer in 0..2031.');
    }
    if (!Number.isInteger(size) || size < 1 || size > 128 || address + size > 2032) {
      throw new Error('Daughter-card mem read must be 1..128 bytes within 0..2031.');
    }
    return this._serialize(() => this._readMem(UART_PROP.DAUGHTER_CARD.CARD_MEM, address, size));
  }

  /**
   * Write to the daughter-card EEPROM memory (`DAUGHTER_CARD.CARD_MEM`).
   * `address` is a HOST offset (see {@link readDaughterCardMem}).
   */
  async writeDaughterCardMem(address: number, data: Uint8Array): Promise<void> {
    if (!Number.isInteger(address) || address < 0 || address > 2031) {
      throw new Error('Daughter-card mem address must be an integer in 0..2031.');
    }
    if (data.length < 1 || data.length > 128 || address + data.length > 2032) {
      throw new Error('Daughter-card mem write must be 1..128 bytes within 0..2031.');
    }
    return this._serialize(async () => {
      const payload = buildMemWritePayload(UART_PROP.DAUGHTER_CARD.CARD_MEM, address, data);
      await this._writeRaw(UART_PROP.DAUGHTER_CARD.CARD_MEM, payload);
      this._emitStatus(`Daughter-card mem write ACKed (${data.length}B @ ${address})`);
    });
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
   * NB the target property is `RTC_CFG_TIME` (0x04) — hardware-confirmed
   * (DEV-866 drift tool bring-up): the firmware's UART_SET handler implements
   * a time write ONLY for this property (RTC_setTimeFromTicksPtr), while a
   * SET on CURR_LOCAL_TIME (0x05) is answered with BAD_CMD. The Java props
   * table's READ_ONLY flag on 0x04 was wrong; the SDK table now says
   * READ_WRITE, matching the firmware.
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
    /* A running factory test is served FIRST. Its report is bare text with no
       packet header, so the parser below would drop it a byte at a time; what
       the capture hands back is whatever was NOT report traffic. */
    let bytes = chunk;
    if (this._factoryTest) {
      const rest = this._factoryTest.feed(bytes);
      if (!rest || rest.length === 0) return;
      bytes = rest;
    }
    this._rxBuf = concatU8(this._rxBuf, bytes);
    this._drain();
  };

  /**
   * Extract every complete packet currently buffered and dispatch each to the
   * temp handlers, keeping the incomplete tail for the next chunk.
   *
   * Runs on the shared {@link drainByteStream} loop, decoding straight to
   * {@link UartRxPacket} so the temp handlers receive parsed packets. A packet
   * that frames but fails its CRC (or will not parse) is refused, and the drain
   * resyncs by ONE byte rather than skipping the whole supposed length —
   * matching the Java `parseSinglePacket` CRC-fail path, on the reasoning that a
   * bad CRC means the framing itself was probably wrong.
   */
  private _drain(): void {
    const { messages, rest } = drainByteStream<UartRxPacket>(this._rxBuf, {
      messageLength: wiredPacketLength,
      decode: (msg) => {
        let pkt: UartRxPacket;
        try {
          pkt = parseUartPacket(msg);
        } catch {
          return null; // malformed
        }
        return pkt.crcOk ? pkt : null;
      },
      onDrop: (byte, reason) =>
        this._log(
          reason === 'rejected'
            ? 'bad CRC or malformed packet → dropping 1 byte to resync'
            : `resync: dropping byte 0x${byte.toString(16)}`,
        ),
    });
    this._rxBuf = rest;
    for (const pkt of messages) this._emitTemp(pkt);
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
