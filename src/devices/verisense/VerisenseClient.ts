import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import {
  ASM_COMMAND,
  ASM_PROPERTY,
  DEBUG_COMMAND_ID,
  STREAM_MODE,
  type AsmCommand,
  type AsmProperty,
  type DebugCommandId,
  type TestModeId,
  NUS_SERVICE,
  NUS_TX,
  NUS_RX,
} from './constants.js';
import {
  buildHeader,
  buildMessage,
  parseHeader,
  normalizeBytePayload,
  parsePendingEvents,
  type VerisenseMessage,
  u16le_at,
  u24le,
  nowMillis,
  computeCrcLikeCSharp,
  getOriginalCrcLE,
  crc16_ccitt_false,
  parseStatusPayload,
  asmRtcBytesToUnixSeconds,
  unixSecondsToAsmRtcBytes,
  parseEventLogPayload,
  parsePayloadCrcErrorBankIndexes,
  parseRecordBufferDetailsPayload,
  parseSchedulerDebugPayload,
  parseBleLinkDebugPayload,
  normalizeOperationalConfig,
  parseProductionConfigPayload,
  VERISENSE_OP_CONFIG_BYTE_SIZE,
  type ProductionConfig,
  type VerisenseBleLinkDebugPayload,
  type VerisenseEventLogEntry,
  type VerisenseRecordBufferDetails,
  type VerisenseSchedulerDebugPayload,
  type VerisenseStatusPayload,
} from './protocol.js';
import { SensorBase } from './sensors/SensorBase.js';
import { SensorADC } from './sensors/SensorADC.js';
import { SensorLIS2DW12 } from './sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from './sensors/SensorLSM6DS3.js';
import { SensorLSM6DSV } from './sensors/SensorLSM6DSV.js';
import { SensorPPG } from './sensors/SensorPPG.js';
import { SensorVD6283 } from './sensors/SensorVD6283.js';
import { SensorMAX32674 } from './sensors/SensorMAX32674.js';
import { SensorMLX90632 } from './sensors/SensorMLX90632.js';
import { isVerisenseSecondGenerationHardware } from './hardwareModels.js';
import { toArrayBuffer } from '../../core/arrayBuffer.js';
import {
  defaultAcceptedCommands,
  toCommandResponse,
  validatePendingResponse,
} from './requestValidation.js';
import type {
  BleLinkAutoOptimizeSample,
  BleLinkAutoOptimizeOptions,
  BleLinkAutoOptimizeResult,
  BleLinkAutoOptimizeStopReason,
  DeviceMode,
  VerisenseConnectRetryInfo,
  VerisenseConnectWithRetryOptions,
  PendingCommandRequest,
  RunHardwareTestReportOptions,
  SensorMap,
  StreamPacket,
  SyncSession,
  TransferLoggedDataOptions,
  TransferLoggedDataResult,
  TransportKind,
  VerisenseClientOptions,
  VerisenseCommandResponse,
} from './VerisenseTypes.js';
export type {
  BleLinkAutoOptimizeSample,
  BleLinkAutoOptimizeOptions,
  BleLinkAutoOptimizeResult,
  BleLinkAutoOptimizeStopReason,
  DeviceMode,
  VerisenseConnectRetryInfo,
  VerisenseConnectWithRetryOptions,
  RunHardwareTestReportOptions,
  SensorMap,
  StreamPacket,
  TransferLoggedDataOptions,
  TransferLoggedDataResult,
  TransportKind,
  VerisenseClientOptions,
  VerisenseCommandResponse,
} from './VerisenseTypes.js';

// ---------------------------------------------------------------------------
// VerisenseBleDevice
// ---------------------------------------------------------------------------

/**
 * Web Bluetooth client for the Verisense sensor platform.
 *
 * Extends {@link BaseShimmerClient} and adds an event-emitter API
 * (on/off/emit) for the richer event model the Verisense protocol needs.
 *
 * Supports:
 * - BLE streaming (accel, ADC/GSR, gyro, PPG)
 * - Web Serial (USB COM port) as an alternative transport
 * - Logged-data download (`transferLoggedData`)
 * - Operational config read/write
 *
 * Events:
 * - `"connected"` — `{ name?: string; id?: string; kind?: string }`
 * - `"disconnected"` — `{ kind: TransportKind }`
 * - `"streaming"` — `{ on: boolean }`
 * - `"streamPacket"` / `"data"` — `StreamPacket`
 * - `"streamCrcFail"` — `{ claimed: number; body: Uint8Array }`
 * - `"opConfig"` — `{ op: Uint8Array }`
 * - `"productionConfig"` — `ProductionConfig`
 * - `"commandPayload"` — `{ payload: Uint8Array }`
 */
export class VerisenseBleDevice extends BaseShimmerClient {
  private static readonly MAX_FRAME_PAYLOAD_LEN = 40000;
  private static readonly MAX_DEBUG_FRAME_PAYLOAD_LEN = 0xffff;
  private static readonly BLE_LINK_MIN_FW = Object.freeze({
    major: 1,
    minor: 4,
    internal: 23,
  });
  // Static NUS UUIDs
  static readonly NUS_SERVICE = NUS_SERVICE;
  static readonly NUS_TX = NUS_TX;
  static readonly NUS_RX = NUS_RX;

  // Event emitter state
  private readonly _evMap = new Map<string, Set<(data: unknown) => void>>();

  on<T = unknown>(ev: string, fn: (data: T) => void): () => void {
    if (!this._evMap.has(ev)) this._evMap.set(ev, new Set());
    this._evMap.get(ev)!.add(fn as (d: unknown) => void);
    return () => this.off(ev, fn as (d: unknown) => void);
  }

  off(ev: string, fn: (data: unknown) => void): void {
    this._evMap.get(ev)?.delete(fn);
  }

  emit(ev: string, data?: unknown): void {
    const s = this._evMap.get(ev);
    if (s) for (const fn of s) fn(data);
  }

  // Transport handles
  private _transportKind: TransportKind = null;
  device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private service: BluetoothRemoteGATTService | null = null;
  tx: BluetoothRemoteGATTCharacteristic | null = null;
  rx: BluetoothRemoteGATTCharacteristic | null = null;
  port: SerialPort | null = null;
  private _serialAbort: AbortController | null = null;
  private _serialReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private _serialReadLoopTask: Promise<void> | null = null;
  private _onGattDisconnected: (() => void) | null = null;
  private _suppressDisconnectedEvent = false;

  // Protocol state
  private _mode: DeviceMode = 'idle';
  private _rxStreamBuf = new Uint8Array(0);
  private _pending: PendingCommandRequest | null = null;
  private _loggedChain: Promise<void> = Promise.resolve();
  private _sync: SyncSession | null = null;
  private _testReportMode = false; // Flag to capture raw streaming bytes for test reports
  private _bootstrapRequestTimeoutOverrideMs: number | null = null;
  private _isSecondGenerationHw = false;

  readonly stripStreamCrc: boolean;
  readonly verifyStreamCrc: boolean;
  readonly hardwareIdentifier: string;

  // Sensor map
  readonly sensors: SensorMap;

  // Cached configs
  operationalConfig: Uint8Array | null = null;
  productionConfig: Uint8Array | null = null;

  // Debug flags
  debugSync = true;
  private _syncRxCount = 0;
  private _syncPayloadCount = 0;

  constructor(opts: VerisenseClientOptions = {}) {
    super({ debug: opts.debug ?? true });
    this.hardwareIdentifier = opts.hardwareIdentifier ?? 'VERISENSE_PULSE_PLUS';
    this.stripStreamCrc = opts.stripStreamCrc ?? true;
    this.verifyStreamCrc = opts.verifyStreamCrc ?? false;

    this.sensors = {
      1: new SensorADC(),
      2: new SensorLIS2DW12(),
      3: new SensorLSM6DS3(),
      4: new SensorPPG(),
      6: new SensorLSM6DSV(),
      7: new SensorVD6283(),
      8: new SensorMAX32674(),
      9: new SensorMLX90632(),
    };

    this.sensors[1].setHardwareIdentifier(this.hardwareIdentifier);
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[Verisense]', ...args);
  }

  // Quick accessors
  get adc(): SensorADC {
    return this.sensors[1];
  }
  get accel1(): SensorLIS2DW12 {
    return this.sensors[2];
  }
  get gyroAccel2(): SensorLSM6DS3 | SensorLSM6DSV {
    return this._isSecondGenerationHw ? this.sensors[6] : this.sensors[3];
  }
  get gyroAccel2Lsm6ds3(): SensorLSM6DS3 {
    return this.sensors[3];
  }
  get gyroAccel2Lsm6dsv(): SensorLSM6DSV {
    return this.sensors[6];
  }
  get ppg(): SensorPPG {
    return this.sensors[4];
  }

  private _setOperationalConfigErasedFallback(lengthHint?: number): Uint8Array {
    const fallbackLen =
      lengthHint ?? this.operationalConfig?.length ?? VERISENSE_OP_CONFIG_BYTE_SIZE;
    const op = new Uint8Array(fallbackLen);
    op.fill(0xff);
    this.operationalConfig = op;
    this.emit('opConfigErased', { raw: new Uint8Array(op) });
    this.emit('opConfig', { op: new Uint8Array(op), erased: true });
    return op;
  }

  private async _bootstrapConfigsAfterConnect(): Promise<void> {
    await this.readProductionConfigFromDevice();
    try {
      await this.readOpConfigFromDevice();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const invalidOp = /Invalid operational config returned from device/i.test(msg);
      const productionErased = this._isUninitializedBlob(this.productionConfig);

      if (invalidOp && productionErased) {
        console.warn(
          '[opcfg] invalid operational config during bootstrap; treating as erased because production config is uninitialized',
          { payloadLengthHint: this.operationalConfig?.length ?? VERISENSE_OP_CONFIG_BYTE_SIZE },
        );
        this._setOperationalConfigErasedFallback();
        return;
      }

      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // BLE connect / disconnect
  // ---------------------------------------------------------------------------

  override async connect(
    opts: {
      device?: BluetoothDevice | null;
      filters?: BluetoothLEScanFilter[];
      optionalServices?: BluetoothServiceUUID[];
    } = {},
  ): Promise<boolean> {
    if (this._transportKind === 'serial' || this.port) {
      try {
        await this.disconnect();
      } catch {
        /* ignore */
      }
    }

    this._transportKind = 'ble';

    const requestOpts: RequestDeviceOptions = {
      filters: opts.filters ?? [{ services: [NUS_SERVICE] }],
      optionalServices: opts.optionalServices ?? [NUS_SERVICE],
    };

    this.device = opts.device ?? (await navigator.bluetooth.requestDevice(requestOpts));

    try {
      if (this._onGattDisconnected && this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      }
    } catch {
      /* ignore */
    }

    this._onGattDisconnected = () => {
      this._mode = 'idle';
      this._transportKind = null;
      if (this._suppressDisconnectedEvent) return;
      this.emit('disconnected', { kind: 'ble' });
    };
    this.device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

    this.server = await this.device.gatt!.connect();
    this.service = await this.server.getPrimaryService(NUS_SERVICE);
    this.tx = await this.service.getCharacteristic(NUS_TX);
    this.rx = await this.service.getCharacteristic(NUS_RX);

    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', (ev: Event) => {
      const dv = (ev.target as BluetoothRemoteGATTCharacteristic | null)?.value;
      if (!dv) return;
      const bytes = new Uint8Array(dv.buffer.slice(dv.byteOffset, dv.byteOffset + dv.byteLength));
      this._feedStreamBytes(bytes);
    });

    this._emitStatus(`Connected: ${this.device.name ?? 'Verisense'}`);
    this.emit('connected', { name: this.device.name, id: this.device.id });

    await this._bootstrapConfigsAfterConnect();

    return true;
  }

  private async _cleanupFailedBleConnectAttempt(retrySettleMs: number): Promise<void> {
    this._suppressDisconnectedEvent = true;
    try {
      if (this._onGattDisconnected && this.device) {
        this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
      }
    } catch {
      /* ignore */
    }

    try {
      if (this.device?.gatt?.connected) {
        this.device.gatt.disconnect();
      }
    } catch {
      /* ignore */
    }

    this.tx = null;
    this.rx = null;
    this.service = null;
    this.server = null;
    this._pending = null;
    this._mode = 'idle';
    this._transportKind = null;

    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, retrySettleMs)));
    this._suppressDisconnectedEvent = false;
  }

  private async _retryBootstrapInPlaceWithBudget(
    totalBudgetMs: number,
    perAttemptTimeoutMs: number,
  ): Promise<boolean> {
    const budgetMs = Math.max(1000, Math.trunc(totalBudgetMs));
    const attemptTimeoutBaseMs = Math.max(1000, Math.trunc(perAttemptTimeoutMs));
    const deadline = Date.now() + budgetMs;

    while (Date.now() < deadline) {
      const remainingMs = Math.max(1000, deadline - Date.now());
      this._bootstrapRequestTimeoutOverrideMs = Math.min(attemptTimeoutBaseMs, remainingMs);

      try {
        this._pending = null;
        this._resetAssembler();
        await this._bootstrapConfigsAfterConnect();
        return true;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const retryable =
          /Unexpected response property/i.test(msg) ||
          /A request is already pending/i.test(msg) ||
          /request timeout/i.test(msg);

        if (!retryable || Date.now() + 100 >= deadline) {
          throw e;
        }

        await new Promise<void>((resolve) => setTimeout(resolve, 100));
      }
    }

    return false;
  }

  async connectWithRetry(opts: VerisenseConnectWithRetryOptions = {}): Promise<boolean> {
    const {
      bootstrapTimeoutMs = 3000,
      pairingBootstrapTimeoutMs = 45000,
      maxRetries = 2,
      retrySettleMs = 250,
      retryOnUnexpectedProperty = true,
      onRetry = null,
      ...connectOpts
    } = opts;

    const clampedDefaultTimeoutMs = Math.max(1000, Math.trunc(bootstrapTimeoutMs));
    const clampedPairingTimeoutMs = Math.max(
      clampedDefaultTimeoutMs,
      Math.trunc(pairingBootstrapTimeoutMs),
    );
    const clampedMaxRetries = Math.max(0, Math.trunc(maxRetries));

    let lastError: unknown = null;

    for (let attempt = 0; attempt <= clampedMaxRetries; attempt += 1) {
      const attemptTimeoutMs = clampedDefaultTimeoutMs;

      this._bootstrapRequestTimeoutOverrideMs = attemptTimeoutMs;

      try {
        return await this.connect(connectOpts);
      } catch (e) {
        lastError = e;
        const msg = e instanceof Error ? e.message : String(e);
        const isRequestTimeout = /request timeout/i.test(msg);
        const isGattDisconnected = /gatt server is disconnected/i.test(msg);
        const isUnexpectedResponseProperty =
          retryOnUnexpectedProperty && /Unexpected response property/i.test(msg);

        const shouldRetry =
          (isRequestTimeout || isGattDisconnected || isUnexpectedResponseProperty) &&
          attempt < clampedMaxRetries;

        if (!shouldRetry) {
          await this._cleanupFailedBleConnectAttempt(retrySettleMs);
          throw e;
        }

        // If pairing/passkey entry is still in progress, a request timeout can occur
        // while the BLE link itself remains up. In that case, retry bootstrap in-place
        // first to avoid forcing a disconnect that interrupts Windows bonding UX.
        if (isRequestTimeout && this.device?.gatt?.connected && this.tx && this.rx) {
          onRetry?.({
            attempt,
            maxRetries: clampedMaxRetries,
            bootstrapTimeoutMs: attemptTimeoutMs,
            nextBootstrapTimeoutMs: clampedPairingTimeoutMs,
            reason: 'request-timeout',
            error: msg,
          });

          try {
            await this._retryBootstrapInPlaceWithBudget(
              clampedPairingTimeoutMs,
              clampedDefaultTimeoutMs,
            );
            return true;
          } catch (bootstrapRetryError) {
            lastError = bootstrapRetryError;
          }
        }

        let reason: VerisenseConnectRetryInfo['reason'];
        if (isRequestTimeout) {
          reason = 'request-timeout';
        } else if (isGattDisconnected) {
          reason = 'gatt-disconnected';
        } else {
          reason = 'unexpected-response-property';
        }

        onRetry?.({
          attempt,
          maxRetries: clampedMaxRetries,
          bootstrapTimeoutMs: attemptTimeoutMs,
          nextBootstrapTimeoutMs: clampedPairingTimeoutMs,
          reason,
          error: msg,
        });

        await this._cleanupFailedBleConnectAttempt(retrySettleMs);
      } finally {
        this._bootstrapRequestTimeoutOverrideMs = null;
      }
    }

    throw lastError instanceof Error ? lastError : new Error('BLE connect failed');
  }

  // --- Web Serial (USB COM port) connect ---
  async connectSerial(
    opts: {
      port?: SerialPort | null;
      baudRate?: number;
      dataBits?: number;
      stopBits?: number;
      parity?: ParityType;
      flowControl?: FlowControlType;
      filters?: SerialPortFilter[] | null;
    } = {},
  ): Promise<boolean> {
    if (!('serial' in navigator)) {
      throw new Error('Web Serial not supported. Use Chrome/Edge on HTTPS or http://localhost.');
    }

    if (this._transportKind === 'ble' && this.device?.gatt?.connected) {
      await this.disconnect();
    } else if (this._transportKind === 'serial' && this.port) {
      await this.disconnect();
    }

    this._transportKind = 'serial';
    this._mode = 'idle';
    this._resetAssembler();

    const serial = (
      navigator as unknown as {
        serial: { requestPort(o?: { filters?: SerialPortFilter[] }): Promise<SerialPort> };
      }
    ).serial;
    if (!opts.port) {
      opts.port = await serial.requestPort(opts.filters ? { filters: opts.filters } : undefined);
    }
    this.port = opts.port!;

    await (
      this.port as unknown as {
        open(o: {
          baudRate: number;
          dataBits: number;
          stopBits: number;
          parity: string;
          flowControl: string;
        }): Promise<void>;
      }
    ).open({
      baudRate: opts.baudRate ?? 115200,
      dataBits: opts.dataBits ?? 8,
      stopBits: opts.stopBits ?? 1,
      parity: opts.parity ?? 'none',
      flowControl: opts.flowControl ?? 'none',
    });

    this._serialAbort = new AbortController();
    this._startSerialReadLoop(this._serialAbort.signal);

    this._emitStatus('Connected via USB Serial');
    this.emit('connected', { kind: 'serial' });
    await this._bootstrapConfigsAfterConnect();
    return true;
  }

  private async _serialWrite(u8: Uint8Array): Promise<void> {
    const writable = (this.port as unknown as { writable?: WritableStream<Uint8Array> }).writable;
    if (!writable) throw new Error('Not connected');
    const writer = writable.getWriter();
    try {
      await writer.write(u8);
    } finally {
      writer.releaseLock();
    }
  }

  private _startSerialReadLoop(signal: AbortSignal): void {
    const port = this.port!;
    this._serialReadLoopTask = (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
      try {
        const readable = (port as unknown as { readable?: ReadableStream<Uint8Array> }).readable;
        if (!readable) return;
        reader = readable.getReader() as ReadableStreamDefaultReader<Uint8Array>;
        this._serialReader = reader;

        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value?.length) this._feedStreamBytes(new Uint8Array(value));
        }
      } catch (e) {
        if (!signal.aborted) console.warn('[serial] read loop error:', e);
      } finally {
        try {
          reader?.releaseLock?.();
        } catch {
          /* ignore */
        }
        if (this._serialReader === reader) this._serialReader = null;
        this._serialReadLoopTask = null;
        if (!signal.aborted) {
          this._mode = 'idle';
          this.emit('disconnected', { kind: 'serial' });
        }
      }
    })();
  }

  private async _serialDisconnect(reason = 'user'): Promise<void> {
    try {
      this._serialAbort?.abort();
    } catch {
      /* ignore */
    }

    const cancelActiveReader = async (): Promise<boolean> => {
      const r = this._serialReader;
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
      if (this._serialReader === r) this._serialReader = null;
      return true;
    };

    await cancelActiveReader();

    const portReadableLocked = (this.port as unknown as { readable?: { locked?: boolean } })
      ?.readable?.locked;
    if (portReadableLocked && !this._serialReader) {
      for (let i = 0; i < 10; i++) {
        await new Promise<void>((r) => setTimeout(r, 20));
        if (await cancelActiveReader()) break;
      }
    }

    try {
      const task = this._serialReadLoopTask;
      if (task) await Promise.race([task, new Promise<void>((r) => setTimeout(r, 750))]);
    } catch {
      /* ignore */
    }

    try {
      const writable = (
        this.port as unknown as {
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
      await (this.port as unknown as { close(): Promise<void> })?.close?.();
    } catch {
      /* ignore */
    }

    this.port = null;
    this._serialAbort = null;
    this._serialReader = null;
    this._serialReadLoopTask = null;

    console.warn(`[serial] disconnect done reason=${reason}`);
  }

  override async disconnect(opts: { reason?: string } = {}): Promise<boolean> {
    const kind = this._transportKind === 'serial' ? 'serial' : 'ble';

    if (this._mode === 'streaming') {
      try {
        await this.stopStreaming();
      } catch {
        /* ignore */
      }
    }

    if (this._sync) {
      try {
        this._abortSync(new Error(opts.reason ?? 'Disconnected'));
      } catch {
        /* ignore */
      }
    }

    if (this._transportKind === 'serial') {
      try {
        await this._serialDisconnect(opts.reason ?? 'user');
      } catch {
        /* ignore */
      }
    } else {
      void this.writeBytes(buildMessage(ASM_COMMAND.WRITE, ASM_PROPERTY.DEVICE_DISCONNECT), {
        withResponse: false,
      });
      try {
        if (this.rx) await this.rx.stopNotifications?.();
      } catch {
        /* ignore */
      }
      try {
        if (this._onGattDisconnected && this.device) {
          this.device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
        }
      } catch {
        /* ignore */
      }
      try {
        if (this.device?.gatt?.connected) this.device.gatt.disconnect();
      } catch {
        /* ignore */
      }
    }

    this._mode = 'idle';
    this._transportKind = null;
    this.port = null;
    this._serialAbort = null;
    this.tx = this.rx = null;
    this.service = this.server = this.device = null;

    this.emit('disconnected', { kind });
    return true;
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  override async startStreaming(): Promise<void> {
    await this.setStreamingMode(true);
    this._mode = 'streaming';
    this.emit('streaming', { on: true });
  }

  override async stopStreaming(): Promise<void> {
    await this.setStreamingMode(false);
    this._mode = 'idle';
    this.emit('streaming', { on: false });
  }

  // ---------------------------------------------------------------------------
  // Logged data transfer
  // ---------------------------------------------------------------------------

  async transferLoggedData(
    opts: TransferLoggedDataOptions = {},
  ): Promise<TransferLoggedDataResult> {
    const {
      fileHandle = null,
      timeoutMs = 1000,
      maxNack = 5,
      maxCrcNack = 5,
      onProgress = null,
    } = opts;

    const bleOk = !!(this.rx && this.tx);
    const serOk = !!this.port;
    if (!bleOk && !serOk) throw new Error('Not connected');
    if (this._mode === 'streaming') throw new Error('Stop streaming before TransferLoggedData');
    if (this._mode === 'logged') throw new Error('Already syncing logged data');

    let writable: FileSystemWritableFileStream | null = null;
    const chunks: Uint8Array[] = [];

    if (fileHandle) writable = await fileHandle.createWritable();

    this._mode = 'logged';
    this._resetAssembler();
    this._loggedChain = Promise.resolve();
    this._syncRxCount = 0;
    this._syncPayloadCount = 0;

    const sync: SyncSession = {
      receiving: true,
      lastReply: 'NONE',
      emptyAckCount: 0,
      nackCount: 0,
      nackCrcCount: 0,
      maxNack,
      maxCrcNack,
      lastRxAt: Date.now(),
      timeoutMs,
      bytesWritten: 0,
      lastPayloadIndex: 0,
      resolve: null!,
      reject: null!,
      timer: null,
      writable,
      chunks,
      onProgress: onProgress ?? null,
    };
    this._sync = sync;

    const donePromise = new Promise<{ ok: boolean; bytesWritten: number; payloadIndex: number }>(
      (resolve, reject) => {
        sync.resolve = resolve;
        sync.reject = reject;
      },
    );

    let watchdogRunning = false;
    sync.timer = setInterval(
      async () => {
        if (watchdogRunning) return;
        watchdogRunning = true;
        try {
          if (!this._sync?.receiving) return;
          const age = Date.now() - this._sync.lastRxAt;
          if (age < this._sync.timeoutMs) return;

          try {
            if (this._sync.lastReply === 'NONE') {
              await this.writeBytes(buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA), {
                withResponse: true,
              });
            } else {
              this._clearSyncRxBuffers('timeout-nack');
              await this.writeBytes(buildMessage(ASM_COMMAND.NACK_GENERIC, ASM_PROPERTY.DATA));
              this._sync.nackCount++;
              this._sync.lastReply = 'NACK';
              if (this._sync.nackCount >= this._sync.maxNack)
                throw new Error('Too many NACK timeouts');
            }
            this._sync.lastRxAt = Date.now();
          } catch (e) {
            this._abortSync(e instanceof Error ? e : new Error(String(e)));
          }
        } finally {
          watchdogRunning = false;
        }
      },
      Math.max(250, Math.floor(timeoutMs / 2)),
    );

    try {
      await this.writeBytes(buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA), {
        withResponse: true,
      });
      const result = await donePromise;
      await (this._loggedChain ?? Promise.resolve());

      if (!fileHandle) {
        const blob = new Blob(chunks.map(toArrayBuffer), { type: 'application/octet-stream' });
        return { ...result, blob };
      }

      return result;
    } finally {
      if (sync.timer) {
        clearInterval(sync.timer);
        sync.timer = null;
      }

      if (writable) await writable.close();
    }
  }

  // ---------------------------------------------------------------------------
  // Request / response helpers
  // ---------------------------------------------------------------------------

  async writeBytes(
    bytes: Uint8Array | number[],
    opts: { withResponse?: boolean } = {},
  ): Promise<void> {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);

    if (this._transportKind === 'serial') {
      await this._serialWrite(u8);
      return;
    }

    if (!this.tx) throw new Error('Not connected');

    if (opts.withResponse) {
      await this.tx.writeValue(toArrayBuffer(u8));
      return;
    }

    const txExt = this.tx as BluetoothRemoteGATTCharacteristic & {
      writeValueWithoutResponse?(v: BufferSource): Promise<void>;
    };
    if (txExt.writeValueWithoutResponse) {
      await txExt.writeValueWithoutResponse(toArrayBuffer(u8));
    } else {
      await this.tx.writeValue(toArrayBuffer(u8));
    }
  }

  private async _requestByCommand(
    command: AsmCommand,
    property: AsmProperty,
    payloadBytes: number[] | Uint8Array = [],
    timeoutMs = 3000,
    acceptedCommands?: ReadonlySet<AsmCommand>,
    acceptedProperties?: ReadonlySet<AsmProperty>,
  ): Promise<VerisenseCommandResponse> {
    if (this._pending) throw new Error('A request is already pending');
    this._mode = 'command';
    this._resetAssembler();

    const req = buildMessage(command, property, payloadBytes);
    const accepted = acceptedCommands ?? defaultAcceptedCommands(command);

    const pendingPromise = new Promise<VerisenseCommandResponse>((resolve, reject) => {
      const t = setTimeout(() => {
        this._pending = null;
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this._pending = {
        expectedProperty: property,
        acceptedCommands: accepted,
        acceptedProperties,
        resolve: (resp) => {
          clearTimeout(t);
          this._pending = null;
          resolve(resp);
        },
        reject: (e) => {
          clearTimeout(t);
          this._pending = null;
          reject(e);
        },
      };
    });

    await this.writeBytes(req);
    return pendingPromise;
  }

  async readProperty(property: AsmProperty, timeoutMs = 3000): Promise<VerisenseCommandResponse> {
    return this._requestByCommand(ASM_COMMAND.READ, property, [], timeoutMs);
  }

  async writeProperty(
    property: AsmProperty,
    payloadBytes: number[] | Uint8Array = [],
    timeoutMs = 3000,
  ): Promise<VerisenseCommandResponse> {
    return this._requestByCommand(ASM_COMMAND.WRITE, property, payloadBytes, timeoutMs);
  }

  async request(
    opcode: number,
    payloadBytes: number[] | Uint8Array = [],
    timeoutMs = 3000,
  ): Promise<{ payload: Uint8Array }> {
    const { command, property } = parseHeader(opcode & 0xff);
    const effectiveTimeoutMs =
      this._bootstrapRequestTimeoutOverrideMs != null && timeoutMs === 3000
        ? this._bootstrapRequestTimeoutOverrideMs
        : timeoutMs;
    const rsp = await this._requestByCommand(command, property, payloadBytes, effectiveTimeoutMs);
    return { payload: rsp.payload };
  }

  // Convenience command methods (all protocol properties)
  readStatus() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.STATUS1);
  }

  async readStatusParsed(): Promise<VerisenseStatusPayload> {
    const { payload } = await this.readStatus();
    return parseStatusPayload(payload, 'status1');
  }

  readStatus2() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.STATUS2);
  }

  async readStatus2Parsed(): Promise<VerisenseStatusPayload> {
    const { payload } = await this.readStatus2();
    return parseStatusPayload(payload, 'status2');
  }

  readData() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.DATA);
  }
  readProductionConfig() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.PRODUCTION_CONFIGURATION);
  }
  readOperationalConfig() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.OPERATIONAL_CONFIGURATION);
  }
  readTime() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.TIME);
  }

  async readTimeUnixSeconds(): Promise<number> {
    const { payload } = await this.readTime();
    return asmRtcBytesToUnixSeconds(payload);
  }
  readPendingEvents() {
    return this.request(ASM_COMMAND.READ | ASM_PROPERTY.PENDING_EVENTS);
  }

  async readPendingEventsParsed(): Promise<AsmProperty[]> {
    const { payload } = await this.readPendingEvents();
    return parsePendingEvents(payload);
  }

  async writeProductionConfig(bytes: Uint8Array | number[]): Promise<void> {
    const payload = normalizeBytePayload(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    if (!payload || payload.length < 11 || payload.length > 56) {
      throw new Error('writeProductionConfig: payload length must be between 11 and 56 bytes');
    }
    await this.writeProperty(ASM_PROPERTY.PRODUCTION_CONFIGURATION, payload);
  }

  async writeOperationalConfig(bytes: Uint8Array | number[]): Promise<void> {
    const payload = normalizeBytePayload(
      bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    );
    if (!payload || payload.length < 50) {
      throw new Error('writeOperationalConfig: payload length must be at least 50 bytes');
    }
    await this.writeProperty(ASM_PROPERTY.OPERATIONAL_CONFIGURATION, payload);
  }

  async writeTime(rtc7: Uint8Array | number[]): Promise<void> {
    const payload = normalizeBytePayload(rtc7 instanceof Uint8Array ? rtc7 : new Uint8Array(rtc7));
    if (!payload || payload.length !== 7) {
      throw new Error('writeTime: payload must be exactly 7 bytes');
    }
    await this.writeProperty(ASM_PROPERTY.TIME, payload);
  }

  async writeTimeUnixSeconds(unixSeconds: number): Promise<void> {
    await this.writeTime(unixSecondsToAsmRtcBytes(unixSeconds));
  }

  async enterDfuMode(): Promise<void> {
    await this.writeProperty(ASM_PROPERTY.DFU_MODE, []);
  }

  async runTestMode(testPayload: Uint8Array | number[]): Promise<void> {
    const payload = normalizeBytePayload(
      testPayload instanceof Uint8Array ? testPayload : new Uint8Array(testPayload),
    );
    if (!payload || payload.length < 2) {
      throw new Error('runTestMode: payload must contain at least [testId, hwMajor]');
    }
    await this.writeProperty(ASM_PROPERTY.TEST_MODE, payload);
  }

  async runHardwareTest(
    testId: TestModeId,
    hwMajor: number,
    hwMinor = 0,
    hwInternal = 0,
  ): Promise<void> {
    const payload = new Uint8Array([
      testId & 0xff,
      hwMajor & 0xff,
      hwMinor & 0xff,
      hwInternal & 0xff,
      (hwInternal >> 8) & 0xff,
    ]);
    await this.runTestMode(payload);
  }

  async runHardwareTestReport(
    hwMajor: number,
    hwMinor = 0,
    hwInternal = 0,
    opts: RunHardwareTestReportOptions = {},
  ): Promise<string> {
    const timeoutMs = Math.max(1000, Math.trunc(opts.timeoutMs ?? 120000));
    const completionIdleMs = Math.max(100, Math.trunc(opts.completionIdleMs ?? 1200));
    const marker = String(opts.marker ?? '').trim();
    const endMarker = String(
      opts.endMarker ??
        (marker.includes('TEST START') ? marker.replace('TEST START', 'TEST END') : ''),
    ).trim();
    const factoryTestType = Math.max(0, Math.min(0xff, Math.trunc(opts.factoryTestType ?? 0)));
    const abortSignal = opts.signal ?? null;
    const onChunk = typeof opts.onChunk === 'function' ? opts.onChunk : null;

    const TEST_REPORT_MODE_ID = 0xfe;
    const payload = new Uint8Array([
      TEST_REPORT_MODE_ID,
      hwMajor & 0xff,
      hwMinor & 0xff,
      hwInternal & 0xff,
      (hwInternal >> 8) & 0xff,
      factoryTestType & 0xff,
    ]);

    return new Promise<string>((resolve, reject) => {
      let done = false;
      let aggregate = '';
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder('latin1');
      } catch {
        decoder = new TextDecoder();
      }
      let sawMarker = marker.length === 0;
      const effectiveIdleMs = Math.max(completionIdleMs, 10000);
      let idleTimer: ReturnType<typeof setTimeout> | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let off: (() => void) | null = null;
      let onAbort: (() => void) | null = null;

      const sanitizeChunk = (text: string): string => {
        // Drop control bytes that occasionally appear in factory stream noise
        // while preserving CR/LF/TAB for report formatting.
        return text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      };

      const cleanup = () => {
        this._testReportMode = false;
        if (off) {
          try {
            off();
          } catch {
            /* ignore */
          }
          off = null;
        }
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = null;
        }
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
        }
        if (abortSignal && onAbort) {
          try {
            abortSignal.removeEventListener('abort', onAbort);
          } catch {
            /* ignore */
          }
          onAbort = null;
        }
      };

      const finish = (err?: Error) => {
        if (done) return;
        done = true;
        cleanup();
        if (err) {
          reject(err);
          return;
        }
        const tail = decoder.decode();
        if (tail) {
          aggregate += tail;
        }
        resolve(aggregate);
      };

      const scheduleIdleFinish = () => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          if (!sawMarker) return;
          finish();
        }, effectiveIdleMs);
      };

      off = this.on<Uint8Array>('testReportChunk', (rawChunk) => {
        if (done || !rawChunk?.length) return;

        const chunk = sanitizeChunk(decoder.decode(rawChunk, { stream: true }));
        if (!chunk.length) return;

        aggregate += chunk;
        if (!sawMarker && marker.length > 0 && aggregate.includes(marker)) {
          sawMarker = true;
        }

        const sawEndMarker =
          (endMarker.length > 0 && aggregate.includes(endMarker)) || /TEST END/.test(aggregate);

        if (sawEndMarker) {
          finish();
          return;
        }

        if (onChunk) {
          try {
            onChunk(chunk, aggregate);
          } catch {
            /* ignore callback errors */
          }
        }

        if (sawMarker) {
          scheduleIdleFinish();
        }
      });

      timeoutTimer = setTimeout(() => {
        finish(
          new Error(
            `runHardwareTestReport timeout after ${timeoutMs} ms while waiting for report data`,
          ),
        );
      }, timeoutMs);

      if (abortSignal) {
        if (abortSignal.aborted) {
          finish(new Error('runHardwareTestReport aborted'));
          return;
        }
        onAbort = () => finish(new Error('runHardwareTestReport aborted'));
        abortSignal.addEventListener('abort', onAbort, { once: true });
      }

      // Enable test report mode before sending command
      this._testReportMode = true;
      void this.runTestMode(payload).catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        finish(new Error(`runHardwareTestReport failed to start test mode: ${msg}`));
      });
    });
  }

  private _buildDebugPayload(
    debugId: DebugCommandId,
    args: Uint8Array | number[] = [],
  ): Uint8Array {
    const argBytes = args instanceof Uint8Array ? args : new Uint8Array(args);
    const payload = new Uint8Array(1 + argBytes.length);
    payload[0] = debugId & 0xff;
    payload.set(argBytes, 1);
    return payload;
  }

  private _debugIndexArgs(index: number): number[] {
    const i = Math.max(0, Math.min(0xff, Math.trunc(index)));
    return i > 0 ? [i] : [];
  }

  private _waitForDebugResponse(timeoutMs = 3000): Promise<{ payload: Uint8Array }> {
    return new Promise((resolve, reject) => {
      let done = false;
      let off: (() => void) | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;

      const cleanup = () => {
        if (off) {
          try {
            off();
          } catch {
            /* ignore */
          }
          off = null;
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };

      off = this.on<{
        header: number;
        command: AsmCommand;
        property: AsmProperty;
        payload: Uint8Array;
      }>('commandPayload', (evt) => {
        if (done || !evt) return;
        if (evt.command !== ASM_COMMAND.RESPONSE || evt.property !== ASM_PROPERTY.DEBUG_COMMAND)
          return;
        done = true;
        cleanup();
        resolve({ payload: evt.payload ?? new Uint8Array(0) });
      });

      timer = setTimeout(() => {
        if (done) return;
        done = true;
        cleanup();
        reject(new Error('Debug response timeout'));
      }, timeoutMs);
    });
  }

  async readDebugCommand(
    debugId: DebugCommandId,
    args: Uint8Array | number[] = [],
    timeoutMs = 3000,
  ): Promise<{ payload: Uint8Array }> {
    const payload = this._buildDebugPayload(debugId, args);
    const debugAcceptedProps = new Set<AsmProperty>([ASM_PROPERTY.DEBUG_COMMAND, 0 as AsmProperty]);

    // Python flow: WRITE DEBUG command, optional empty/transient frame, then RESPONSE DEBUG payload.
    const responsePromise = this._waitForDebugResponse(timeoutMs);
    try {
      await this._requestByCommand(
        ASM_COMMAND.WRITE,
        ASM_PROPERTY.DEBUG_COMMAND,
        payload,
        timeoutMs,
        undefined,
        debugAcceptedProps,
      );
      return await responsePromise;
    } catch (e) {
      void responsePromise.catch(() => {});
      const msg = e instanceof Error ? e.message : String(e);
      const isDebugNack = /NACK command=0x(?:50|60|70) property=0x9/i.test(msg);
      const isDebugAckPropertyZero = /Unexpected response property 0x0 \(expected 0x9\)/i.test(msg);
      if (isDebugNack || isDebugAckPropertyZero) {
        return this._waitForDebugResponse(timeoutMs);
      }
      throw e;
    }
  }

  async sendDebugCommand(
    debugId: DebugCommandId,
    args: Uint8Array | number[] = [],
    timeoutMs = 3000,
  ): Promise<{ payload: Uint8Array }> {
    const rsp = await this._requestByCommand(
      ASM_COMMAND.WRITE,
      ASM_PROPERTY.DEBUG_COMMAND,
      this._buildDebugPayload(debugId, args),
      timeoutMs,
    );
    return { payload: rsp.payload };
  }

  async readFlashLookupTable(index = 0, timeoutMs = 12000): Promise<{ payload: Uint8Array }> {
    return this.readDebugCommand(
      DEBUG_COMMAND_ID.FLASH_LOOKUP_TABLE_READ,
      this._debugIndexArgs(index),
      timeoutMs,
    );
  }

  async readRealWorldClockScheduler(index = 0): Promise<{ payload: Uint8Array }> {
    return this.readDebugCommand(DEBUG_COMMAND_ID.RWC_SCHEDULER_READ, this._debugIndexArgs(index));
  }

  async readRealWorldClockSchedulerParsed(index = 0): Promise<VerisenseSchedulerDebugPayload> {
    const { payload } = await this.readRealWorldClockScheduler(index);
    return parseSchedulerDebugPayload(payload);
  }

  async loadTestLookupTable(index = 0): Promise<{ payload: Uint8Array }> {
    return this.readDebugCommand(
      DEBUG_COMMAND_ID.LOAD_TEST_LOOKUP_TABLE,
      this._debugIndexArgs(index),
    );
  }

  async checkPayloadCrcErrors(index = 0): Promise<{ payload: Uint8Array }> {
    return this.readDebugCommand(
      DEBUG_COMMAND_ID.CHECK_PAYLOAD_CRC_ERRORS,
      this._debugIndexArgs(index),
    );
  }

  async checkPayloadCrcErrorsParsed(index = 0): Promise<number[]> {
    const { payload } = await this.checkPayloadCrcErrors(index);
    return parsePayloadCrcErrorBankIndexes(payload);
  }

  async readEventLog(index = 0): Promise<{ payload: Uint8Array }> {
    return this.readDebugCommand(DEBUG_COMMAND_ID.READ_EVENT_LOG, this._debugIndexArgs(index));
  }

  async readEventLogParsed(index = 0): Promise<VerisenseEventLogEntry[]> {
    const { payload } = await this.readEventLog(index);
    return parseEventLogPayload(payload);
  }

  async readRecordBufferDetails(index = 0): Promise<{ payload: Uint8Array }> {
    return this.readDebugCommand(
      DEBUG_COMMAND_ID.READ_RECORD_BUFFER_DETAILS,
      this._debugIndexArgs(index),
    );
  }

  async readRecordBufferDetailsParsed(index = 0): Promise<VerisenseRecordBufferDetails[]> {
    const { payload } = await this.readRecordBufferDetails(index);
    return parseRecordBufferDetailsPayload(payload);
  }

  async eraseOperationalConfig(): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.ERASE_OPERATIONAL_CONFIG);
  }

  async eraseProductionConfig(): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.ERASE_PRODUCTION_CONFIG);
  }

  async clearPendingEvents(): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.CLEAR_PENDING_EVENTS);
  }

  async eraseAllLoggedData(timeoutMs = 12000): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.ERASE_FLASH_AND_LOOKUP_TABLE, [], timeoutMs);
  }

  async testDataTransferLoop(loopCount: number): Promise<void> {
    const clamped = Math.max(0, Math.min(0xffff, Math.trunc(loopCount)));
    await this.sendDebugCommand(DEBUG_COMMAND_ID.TEST_DATA_TRANSFER_LOOP, [
      clamped & 0xff,
      (clamped >> 8) & 0xff,
    ]);
  }

  async ledTest(ledIndex: number): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.LED_TEST, [ledIndex & 0xff]);
  }

  async max86xxxLedTest(start: boolean): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.MAX86XXX_LED_TEST, [start ? 0x01 : 0x00]);
  }

  async startPowerProfilerTest(): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.POWER_PROFILER_TEST);
  }

  async requestSystemReset(): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.SYSTEM_RESET);
  }

  async startIcPowerConsumptionTest(loopCount: number, stageIntervalMs: number): Promise<void> {
    const clampedLoopCount = Math.max(0, Math.min(0xffff, Math.trunc(loopCount)));
    const clampedStageInterval = Math.max(0, Math.min(0xffff, Math.trunc(stageIntervalMs)));
    await this.sendDebugCommand(DEBUG_COMMAND_ID.IC_POWER_CONSUMPTION_TEST, [
      clampedLoopCount & 0xff,
      (clampedLoopCount >> 8) & 0xff,
      clampedStageInterval & 0xff,
      (clampedStageInterval >> 8) & 0xff,
    ]);
  }

  async deleteAllBonds(): Promise<void> {
    await this.sendDebugCommand(DEBUG_COMMAND_ID.DELETE_ALL_BONDS);
  }

  private _compareFwVersion(
    a: { major: number; minor: number; internal: number },
    b: { major: number; minor: number; internal: number },
  ): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.internal - b.internal;
  }

  private _formatFwVersion(v: { major: number; minor: number; internal: number }): string {
    return `${v.major}.${v.minor}.${v.internal}`;
  }

  private async _assertBleLinkDebugSupported(): Promise<void> {
    let parsed: ProductionConfig | null = null;

    if (this.productionConfig?.length) {
      if (this._isErasedBlob(this.productionConfig)) {
        throw new Error(
          'BLE link debug commands require firmware >= 1.4.23, but production config is erased.',
        );
      }
      parsed = parseProductionConfigPayload(this.productionConfig);
    } else {
      parsed = await this.readProductionConfigFromDevice();
      if (this._isErasedBlob(this.productionConfig)) {
        throw new Error(
          'BLE link debug commands require firmware >= 1.4.23, but production config is erased.',
        );
      }
    }

    const current = {
      major: Number(parsed.revFwMajor),
      minor: Number(parsed.revFwMinor),
      internal: Number(parsed.revFwInternal),
    };
    if (
      !Number.isFinite(current.major) ||
      !Number.isFinite(current.minor) ||
      !Number.isFinite(current.internal)
    ) {
      throw new Error(
        'BLE link debug commands require firmware >= 1.4.23, but firmware version is unavailable.',
      );
    }

    const min = VerisenseBleDevice.BLE_LINK_MIN_FW;
    if (this._compareFwVersion(current, min) < 0) {
      throw new Error(
        `BLE link debug commands require firmware >= ${this._formatFwVersion(min)} (current ${this._formatFwVersion(current)}).`,
      );
    }
  }

  async readBleLinkParams(): Promise<{ payload: Uint8Array }> {
    await this._assertBleLinkDebugSupported();
    return this.readDebugCommand(DEBUG_COMMAND_ID.BLE_LINK_PARAMS_READ);
  }

  async readBleLinkParamsParsed(): Promise<VerisenseBleLinkDebugPayload> {
    const { payload } = await this.readBleLinkParams();
    return parseBleLinkDebugPayload(payload);
  }

  async optimizeBleLink(): Promise<{ payload: Uint8Array }> {
    await this._assertBleLinkDebugSupported();
    return this.readDebugCommand(DEBUG_COMMAND_ID.BLE_LINK_OPTIMIZE);
  }

  async optimizeBleLinkParsed(): Promise<VerisenseBleLinkDebugPayload> {
    const { payload } = await this.optimizeBleLink();
    return parseBleLinkDebugPayload(payload);
  }

  private _bleLinkSignature(parsed: VerisenseBleLinkDebugPayload): string {
    return [
      parsed.attMtu,
      parsed.maxDataLength,
      parsed.connectionIntervalUnits,
      parsed.txPhy,
      parsed.rxPhy,
      parsed.isConnected ? 1 : 0,
    ].join('|');
  }

  private _bleLinkOptimizedEnough(
    parsed: VerisenseBleLinkDebugPayload,
    {
      targetConnectionIntervalUnits,
      targetPhy,
      minDataLength,
    }: {
      targetConnectionIntervalUnits: number;
      targetPhy: number;
      minDataLength: number;
    },
  ): boolean {
    const intervalOk = parsed.connectionIntervalUnits <= targetConnectionIntervalUnits;
    const phyOk = parsed.txPhy === targetPhy && parsed.rxPhy === targetPhy;
    const mtuBoundDataLength = Math.max(20, (parsed.attMtu || 23) - 3);
    const requiredDataLength = Math.min(minDataLength, mtuBoundDataLength);
    const dataLenOk = parsed.maxDataLength >= requiredDataLength;
    return intervalOk && phyOk && dataLenOk;
  }

  private _isAbortError(error: unknown): boolean {
    if ((error as { name?: string } | null)?.name === 'AbortError') return true;
    const msg = error instanceof Error ? error.message : String(error);
    return /abort/i.test(msg);
  }

  private _waitWithAbort(ms: number, signal?: AbortSignal | null): Promise<void> {
    if (!Number.isFinite(ms) || ms <= 0) return Promise.resolve();
    if (signal?.aborted) {
      const err = new Error('Operation aborted');
      err.name = 'AbortError';
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (signal) signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      const onAbort = (): void => {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        const err = new Error('Operation aborted');
        err.name = 'AbortError';
        reject(err);
      };

      if (signal) {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async autoOptimizeBleLink(
    opts: BleLinkAutoOptimizeOptions = {},
  ): Promise<BleLinkAutoOptimizeResult> {
    const startedAt = nowMillis();
    const pollIntervalMs = Math.max(100, Math.trunc(opts.pollIntervalMs ?? 700));
    const stableReadCount = Math.max(1, Math.trunc(opts.stableReadCount ?? 3));
    const maxDurationMs = Math.max(pollIntervalMs, Math.trunc(opts.maxDurationMs ?? 20000));
    const settleMode = opts.settleMode === 'stability' ? 'stability' : 'target-and-stability';
    const minSettleTimeMs = Math.max(
      0,
      Math.trunc(opts.minSettleTimeMs ?? (settleMode === 'stability' ? pollIntervalMs * 2 : 0)),
    );
    const forceOptimizeAttempts = Math.max(
      0,
      Math.trunc(opts.forceOptimizeAttempts ?? (settleMode === 'stability' ? 2 : 0)),
    );
    const targetConnectionIntervalUnits = Math.max(
      6,
      Math.trunc(opts.targetConnectionIntervalUnits ?? 6),
    );
    const targetPhy = Math.max(1, Math.min(4, Math.trunc(opts.targetPhy ?? 2)));
    const minDataLength = Math.max(20, Math.min(251, Math.trunc(opts.minDataLength ?? 251)));
    const signal = opts.signal ?? null;

    let iterations = 0;
    let optimizeAttempts = 0;
    let stableCount = 0;
    let lastSignature = '';
    let lastParsed: VerisenseBleLinkDebugPayload | null = null;

    const finish = (reason: BleLinkAutoOptimizeResult['reason']): BleLinkAutoOptimizeResult => ({
      reason,
      iterations,
      optimizeAttempts,
      stableCount,
      lastParsed,
      durationMs: Math.max(0, nowMillis() - startedAt),
    });

    if (this._transportKind !== 'ble') return finish('not-ble');
    if (signal?.aborted) return finish('aborted');

    while (nowMillis() - startedAt < maxDurationMs) {
      if (signal?.aborted) return finish('aborted');
      if (this._transportKind !== 'ble') return finish('not-ble');

      let parsed: VerisenseBleLinkDebugPayload;
      try {
        parsed = await this.readBleLinkParamsParsed();
      } catch (error) {
        if (this._isAbortError(error)) return finish('aborted');
        const msg = error instanceof Error ? error.message : String(error);
        if (
          /require firmware >=|unavailable on this firmware|firmware version is unavailable/i.test(
            msg,
          )
        ) {
          return finish('unsupported');
        }
        throw error;
      }

      iterations += 1;
      lastParsed = parsed;

      let signature = this._bleLinkSignature(parsed);
      stableCount = signature === lastSignature ? stableCount + 1 : 1;
      lastSignature = signature;

      let optimizedEnough = this._bleLinkOptimizedEnough(parsed, {
        targetConnectionIntervalUnits,
        targetPhy,
        minDataLength,
      });

      if (typeof opts.onSample === 'function') {
        opts.onSample({
          source: 'read',
          iteration: iterations,
          stableCount,
          parsed,
          signature,
          optimizedEnough,
        });
      }

      const shouldOptimize =
        settleMode === 'stability' ? optimizeAttempts < forceOptimizeAttempts : !optimizedEnough;

      if (shouldOptimize) {
        try {
          parsed = await this.optimizeBleLinkParsed();
        } catch (error) {
          if (this._isAbortError(error)) return finish('aborted');
          throw error;
        }

        optimizeAttempts += 1;
        lastParsed = parsed;
        signature = this._bleLinkSignature(parsed);
        stableCount = signature === lastSignature ? stableCount + 1 : 1;
        lastSignature = signature;

        optimizedEnough = this._bleLinkOptimizedEnough(parsed, {
          targetConnectionIntervalUnits,
          targetPhy,
          minDataLength,
        });

        if (typeof opts.onSample === 'function') {
          opts.onSample({
            source: 'optimize',
            iteration: iterations,
            stableCount,
            parsed,
            signature,
            optimizedEnough,
          });
        }
      }

      const elapsedMs = Math.max(0, nowMillis() - startedAt);
      const stableReady = stableCount >= stableReadCount && elapsedMs >= minSettleTimeMs;
      const settleReady = settleMode === 'stability' ? stableReady : stableReady && optimizedEnough;

      if (settleReady) {
        return finish('stabilized');
      }

      try {
        await this._waitWithAbort(pollIntervalMs, signal);
      } catch (error) {
        if (this._isAbortError(error)) return finish('aborted');
        throw error;
      }
    }

    return finish('timeout');
  }

  async setStreamingMode(enabled: boolean): Promise<void> {
    await this.writeProperty(
      ASM_PROPERTY.STREAM_MODE,
      [enabled ? STREAM_MODE.ENABLE : STREAM_MODE.DISABLE],
      3000,
    );
  }

  async disconnectRequest(): Promise<{ payload: Uint8Array }> {
    try {
      return await this.request(ASM_COMMAND.WRITE | ASM_PROPERTY.DEVICE_DISCONNECT, [], 1500);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/timeout/i.test(msg)) return { payload: new Uint8Array(0) };
      throw e;
    }
  }

  // ---------------------------------------------------------------------------
  // Operational config helpers
  // ---------------------------------------------------------------------------

  async getOpConfig(): Promise<Uint8Array> {
    if (this.operationalConfig?.length) return new Uint8Array(this.operationalConfig);
    throw new Error('Operational config not cached. Call readOpConfigFromDevice() first.');
  }

  private _isUniformBlob(payload: Uint8Array | null | undefined, expectedByte: number): boolean {
    if (!payload?.length) return false;
    const expected = expectedByte & 0xff;
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] !== expected) return false;
    }
    return true;
  }

  private _isErasedBlob(payload: Uint8Array | null | undefined): boolean {
    return this._isUniformBlob(payload, 0xff);
  }

  private _isZeroBlob(payload: Uint8Array | null | undefined): boolean {
    return this._isUniformBlob(payload, 0x00);
  }

  private _isUninitializedBlob(payload: Uint8Array | null | undefined): boolean {
    return this._isErasedBlob(payload) || this._isZeroBlob(payload);
  }

  async readProductionConfigFromDevice(): Promise<ProductionConfig> {
    const rsp = await this.readProductionConfig();
    const prod = normalizeOperationalConfig(rsp?.payload);
    if (!prod?.length) throw new Error('Invalid production config returned from device');

    const erased = this._isErasedBlob(prod);

    this.productionConfig = prod;
    const parsed = parseProductionConfigPayload(prod);

    if (!erased && typeof parsed.revHwMajor === 'number' && typeof parsed.revHwMinor === 'number') {
      const hwIdentifier = parsed.revHwMajor === 62 ? 'VERISENSE_GSR_PLUS' : 'VERISENSE_PULSE_PLUS';
      this.adc.setHardwareIdentifier(hwIdentifier);
      this.adc.setHardwareRevision(
        parsed.revHwMajor,
        parsed.revHwMinor,
        typeof parsed.revHwInternal === 'number' ? parsed.revHwInternal : 0,
      );
      this._isSecondGenerationHw = isVerisenseSecondGenerationHardware(
        parsed.revHwMajor,
        parsed.revHwMinor,
      );
    }

    if (erased) {
      this.emit('productionConfigErased', { raw: new Uint8Array(prod) });
    }

    this.emit('productionConfig', parsed);
    return parsed;
  }

  async readOpConfigFromDevice(): Promise<Uint8Array> {
    const rsp = await this.readOperationalConfig();
    let op = normalizeOperationalConfig(rsp?.payload);

    // Some firmware erase flows can return an empty payload for operational config.
    // Treat this as erased (all 0xFF) instead of invalid.
    if (!op?.length) {
      return this._setOperationalConfigErasedFallback();
    }

    if (this._isZeroBlob(op)) {
      console.warn('[opcfg] operational config payload is all 0x00; treating as erased');
      return this._setOperationalConfigErasedFallback(op.length);
    }

    const erased = this._isErasedBlob(op);
    if (!erased && op[0] !== 0x5a) {
      throw new Error('Invalid operational config returned from device');
    }

    this.operationalConfig = op;

    if (!erased) {
      try {
        this.accel1.applyOperationalConfig(op);
        this.sensors[3].applyOperationalConfig(op);
        this.sensors[6].applyOperationalConfig(op);
        this.adc.applyOperationalConfig(op);
        this.ppg.applyOperationalConfig(op);
        this.sensors[7].applyOperationalConfig(op);
        this.sensors[8].applyOperationalConfig(op);
        this.sensors[9].applyOperationalConfig(op);
      } catch (e) {
        console.warn('[opcfg] apply after read failed:', e);
      }
    } else {
      this.emit('opConfigErased', { raw: new Uint8Array(op) });
    }

    this.emit('opConfig', { op, erased });
    return new Uint8Array(op);
  }

  async writeOpConfig(opConfigBytes: Uint8Array | number[]): Promise<void> {
    const op = normalizeOperationalConfig(
      opConfigBytes instanceof Uint8Array ? opConfigBytes : new Uint8Array(opConfigBytes),
    );
    if (!op || op.length < 4) throw new Error('writeOpConfig: invalid opconfig');
    if (op[0] !== 0x5a) throw new Error('writeOpConfig: opconfig must start with 0x5A');

    await this.writeOperationalConfig(op);
    await this.readOpConfigFromDevice();
  }

  getSensor(name: string | number): SensorBase | null {
    const k = String(name ?? '').toLowerCase();
    if (!k) return null;
    if (k.includes('lis2dw12') || k.includes('accel1') || k === '2') return this.accel1;
    if (k.includes('lsm6dsv') || k === '6') return this.sensors[6];
    if (k.includes('lsm6') || k.includes('gyro') || k.includes('accel2') || k === '3')
      return this.gyroAccel2;
    if (k.includes('vbatt') || k.includes('batt') || k.includes('battery') || k.includes('adc'))
      return this.adc;
    if (k.includes('gsr') || k === '1') return this.adc;
    if (k.includes('ppg') || k === '4') return this.ppg;
    return null;
  }

  // ---------------------------------------------------------------------------
  // RX assembly and dispatch
  // ---------------------------------------------------------------------------

  private _abortSync(err: Error): void {
    const s = this._sync;
    if (!s) return;
    s.receiving = false;
    if (s.timer) clearInterval(s.timer);
    this._sync = null;
    this._mode = 'idle';
    s.reject(err);
  }

  private _finishSync(): void {
    const s = this._sync;
    if (!s) return;
    s.receiving = false;
    if (s.timer) clearInterval(s.timer);
    const bytesWritten = s.bytesWritten;
    const payloadIndex = s.lastPayloadIndex;
    this._sync = null;
    this._mode = 'idle';
    s.resolve({ ok: true, bytesWritten, payloadIndex });
  }

  private async _handleLoggedPayload(payloadU8: Uint8Array): Promise<void> {
    this._syncPayloadCount++;
    const s = this._sync;
    if (!s) return;

    const computed = computeCrcLikeCSharp(payloadU8);
    const original = getOriginalCrcLE(payloadU8);
    const crcOk = computed === original;
    const payloadIndex = u16le_at(payloadU8, 0);

    if (!crcOk) {
      s.lastReply = 'NACK';
      s.nackCrcCount++;
      this._clearSyncRxBuffers('crc-nack');
      await this.writeBytes(buildMessage(ASM_COMMAND.NACK_GENERIC, ASM_PROPERTY.DATA));
      if (s.nackCrcCount >= s.maxCrcNack) this._abortSync(new Error('Too many CRC failures'));
      s.onProgress?.({ payloadIndex, bytesWritten: s.bytesWritten, crcOk: false });
      return;
    }

    s.lastPayloadIndex = payloadIndex;

    if (s.writable) {
      await s.writable.write(toArrayBuffer(payloadU8));
    } else {
      s.chunks.push(new Uint8Array(payloadU8));
    }

    s.bytesWritten += payloadU8.length;
    s.emptyAckCount = 0;

    s.lastReply = 'ACK';
    s.nackCount = 0;
    s.nackCrcCount = 0;
    await this.writeBytes(buildMessage(ASM_COMMAND.ACK_NEXT_STAGE, ASM_PROPERTY.DATA), {
      withResponse: true,
    });
    s.onProgress?.({ payloadIndex, bytesWritten: s.bytesWritten, crcOk: true });
  }

  private _resetAssembler(): void {
    this._rxStreamBuf = new Uint8Array(0);
  }

  private _appendStreamBuf(chunk: Uint8Array): void {
    const merged = new Uint8Array(this._rxStreamBuf.length + chunk.length);
    merged.set(this._rxStreamBuf, 0);
    merged.set(chunk, this._rxStreamBuf.length);
    this._rxStreamBuf = merged;
  }

  private _clearSyncRxBuffers(reason = ''): void {
    this._rxStreamBuf = new Uint8Array(0);
    this._resetAssembler();
    if (this.debugSync) console.warn('[sync] cleared RX buffers', { reason });
  }

  private _isPlausibleHeaderByte(hdr: number): boolean {
    const command = hdr & 0xf0;
    const property = hdr & 0x0f;

    const validCommand =
      command === ASM_COMMAND.READ ||
      command === ASM_COMMAND.WRITE ||
      command === ASM_COMMAND.RESPONSE ||
      command === ASM_COMMAND.ACK ||
      command === ASM_COMMAND.NACK_BAD_HEADER_COMMAND ||
      command === ASM_COMMAND.NACK_BAD_HEADER_PROPERTY ||
      command === ASM_COMMAND.NACK_GENERIC ||
      command === ASM_COMMAND.ACK_NEXT_STAGE;

    if (!validCommand) return false;

    // Known properties are 0x01..0x0C; keep 0x00 permissive for transient frames.
    return property === 0 || (property >= ASM_PROPERTY.STATUS1 && property <= ASM_PROPERTY.STATUS2);
  }

  private _isPlausibleFrameStart(hdr: number, len: number): boolean {
    // Logged sync frames can be large and should be length-gated like the working single-file implementation.
    if (this._mode === 'logged') {
      return len <= VerisenseBleDevice.MAX_FRAME_PAYLOAD_LEN;
    }

    if (!this._isPlausibleHeaderByte(hdr)) return false;

    // Debug responses may carry large blobs (for example flash lookup tables),
    // while normal properties and streaming/logged payloads should stay bounded.
    const isPendingDebugCommand =
      this._mode === 'command' && this._pending?.expectedProperty === ASM_PROPERTY.DEBUG_COMMAND;
    const maxLen = isPendingDebugCommand
      ? VerisenseBleDevice.MAX_DEBUG_FRAME_PAYLOAD_LEN
      : VerisenseBleDevice.MAX_FRAME_PAYLOAD_LEN;
    return len <= maxLen;
  }

  private _resolvePendingCommand(msg: VerisenseMessage): void {
    const pending = this._pending;
    if (pending) {
      // Some firmware/transport paths emit a transient empty 0x00/0x00 frame
      // immediately before the real command response; ignore and keep waiting.
      if (
        msg.command === (0 as AsmCommand) &&
        msg.property === (0 as AsmProperty) &&
        msg.payload.length === 0
      ) {
        return;
      }

      const err = validatePendingResponse(pending, msg);
      if (err) {
        this._pending = null;
        if (this._mode === 'command') this._mode = 'idle';
        pending.reject(err);
      } else {
        this._pending = null;
        if (this._mode === 'command') this._mode = 'idle';
        pending.resolve(toCommandResponse(msg));
      }
    } else {
      this._pending = null;
      if (this._mode === 'command') this._mode = 'idle';
    }

    this.emit('commandPayload', {
      header: msg.header,
      command: msg.command,
      property: msg.property,
      payload: msg.payload,
    });
  }

  private _feedStreamBytes(chunk: Uint8Array): void {
    if (this._mode === 'logged' && this._sync) this._sync.lastRxAt = Date.now();

    // Test report data is streamed as raw text bytes after the initial ACK.
    // Once the command pending state is cleared, bypass frame parsing entirely.
    if (this._testReportMode && !this._pending) {
      if (chunk?.length) this.emit('testReportChunk', chunk);
      return;
    }

    this._appendStreamBuf(chunk);

    for (;;) {
      if (this._rxStreamBuf.length < 3) return;

      const hdr = this._rxStreamBuf[0];
      const len = (this._rxStreamBuf[1] | (this._rxStreamBuf[2] << 8)) >>> 0;

      if (!this._isPlausibleFrameStart(hdr, len)) {
        if (this.debugSync) {
          console.warn('[rx] resync: dropping byte', {
            dropped: hdr,
            nextLen: len,
            bufLen: this._rxStreamBuf.length,
          });
        }
        this._rxStreamBuf = this._rxStreamBuf.slice(1);
        continue;
      }

      if (len === 0) {
        const header = hdr & 0xff;
        const decodedHeader = parseHeader(header);
        const msg: VerisenseMessage = {
          header,
          command: decodedHeader.command,
          property: decodedHeader.property,
          payloadLength: 0,
          payload: new Uint8Array(0),
        };
        this._rxStreamBuf = this._rxStreamBuf.slice(3);
        if (this._mode === 'logged' && hdr === buildHeader(ASM_COMMAND.ACK, ASM_PROPERTY.DATA)) {
          const s = this._sync;
          if (s && s.bytesWritten === 0 && s.emptyAckCount < 6) {
            s.emptyAckCount++;
            if (this.debugSync)
              console.log('[sync] empty ACK before payload; requesting next DATA chunk.');
            void this.writeBytes(buildMessage(ASM_COMMAND.READ, ASM_PROPERTY.DATA), {
              withResponse: true,
            }).catch((e: Error) => this._abortSync(e));
            continue;
          }

          if (this.debugSync) console.log('[sync] EOS received. Finishing.');
          this._finishSync();
          continue;
        }

        if (this._mode === 'command') {
          this._resolvePendingCommand(msg);
        }
        continue;
      }

      if (this._rxStreamBuf.length < 3 + len) return;

      const payload = this._rxStreamBuf.slice(3, 3 + len);
      this._rxStreamBuf = this._rxStreamBuf.slice(3 + len);
      const header = hdr & 0xff;
      const decodedHeader = parseHeader(header);
      const msg: VerisenseMessage = {
        header,
        command: decodedHeader.command,
        property: decodedHeader.property,
        payloadLength: payload.length,
        payload,
      };

      if (this._mode === 'logged') {
        this._loggedChain = (this._loggedChain ?? Promise.resolve())
          .then(() => this._handleLoggedPayload(msg.payload))
          .catch((e: Error) => this._abortSync(e));
        continue;
      }

      if (this._mode === 'streaming') {
        this._handleStreamingPayload(msg.payload);
        continue;
      }

      this._resolvePendingCommand(msg);
    }
  }

  private _handleStreamingPayload(payload: Uint8Array): void {
    if (payload.length < 4) return;

    let body = payload;
    let crcOk: boolean | null = null;

    if (this.stripStreamCrc && payload.length >= 6) {
      const claimed = (payload[payload.length - 2] | (payload[payload.length - 1] << 8)) >>> 0;
      const dataNoCrc = payload.slice(0, payload.length - 2);

      if (this.verifyStreamCrc) {
        const calc = crc16_ccitt_false(dataNoCrc);
        crcOk = calc === claimed;
      }

      body = dataNoCrc;

      if (this.verifyStreamCrc && crcOk === false) {
        this.emit('streamCrcFail', { claimed, body: dataNoCrc });
      }
    }

    const sensorId = body[0];
    const tick = u24le(body, 1);
    const sensorPayload = body.slice(4);

    const sensor = (this.sensors as unknown as Record<number, SensorBase | undefined>)[sensorId];
    const systemTsLastSampleMillis = nowMillis();

    let tsInfo: { shimmerMillis: number; systemOffsetFirstTime: number } | null = null;
    if (sensor) tsInfo = sensor.getTimestampUnwrappedMillis(tick, systemTsLastSampleMillis);

    let decodedSamples: unknown[] | null = null;
    if (sensor) decodedSamples = sensor.parsePayload(sensorPayload);

    let samplesWithTime = decodedSamples;
    if (sensor && Array.isArray(decodedSamples) && decodedSamples.length > 0 && tsInfo) {
      const num = decodedSamples.length;
      samplesWithTime = decodedSamples.map((s, i) => ({
        ...(s as object),
        timestamps: sensor.extrapolateSampleTimes({
          numSamples: num,
          i,
          samplingRateHz: sensor.samplingRateHz,
          tsLastSampleMillis: tsInfo!.shimmerMillis,
          systemTsLastSampleMillis,
          systemOffsetFirstTime: tsInfo!.systemOffsetFirstTime,
        }),
      }));
    }

    const packet: StreamPacket = {
      sensorId,
      tick_u24: tick,
      decoded: samplesWithTime,
      rawPayload: sensorPayload,
      crcOk,
    };

    this.emit('streamPacket', packet);
    this.emit('data', packet);
  }
}
