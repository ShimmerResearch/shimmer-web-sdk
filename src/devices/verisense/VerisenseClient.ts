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
  normalizeOperationalConfig,
  parseProductionConfigPayload,
  type ProductionConfig,
  type VerisenseEventLogEntry,
  type VerisenseRecordBufferDetails,
  type VerisenseSchedulerDebugPayload,
  type VerisenseStatusPayload,
} from './protocol.js';
import { SensorBase } from './sensors/SensorBase.js';
import { SensorADC } from './sensors/SensorADC.js';
import { SensorLIS2DW12 } from './sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from './sensors/SensorLSM6DS3.js';
import { SensorPPG } from './sensors/SensorPPG.js';
import { toArrayBuffer } from '../../core/arrayBuffer.js';
import {
  defaultAcceptedCommands,
  toCommandResponse,
  validatePendingResponse,
} from './requestValidation.js';
import type {
  DeviceMode,
  PendingCommandRequest,
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
  DeviceMode,
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

  // Protocol state
  private _mode: DeviceMode = 'idle';
  private _rxStreamBuf = new Uint8Array(0);
  private _pending: PendingCommandRequest | null = null;
  private _loggedChain: Promise<void> = Promise.resolve();
  private _sync: SyncSession | null = null;

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
  get gyroAccel2(): SensorLSM6DS3 {
    return this.sensors[3];
  }
  get ppg(): SensorPPG {
    return this.sensors[4];
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

    await this.readProductionConfigFromDevice();
    await this.readOpConfigFromDevice();

    return true;
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
    await this.readProductionConfigFromDevice();
    await this.readOpConfigFromDevice();
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
    const rsp = await this._requestByCommand(command, property, payloadBytes, timeoutMs);
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

  async readProductionConfigFromDevice(): Promise<ProductionConfig> {
    const rsp = await this.readProductionConfig();
    const prod = normalizeOperationalConfig(rsp?.payload);
    if (!prod?.length) throw new Error('Invalid production config returned from device');

    this.productionConfig = prod;
    const parsed = parseProductionConfigPayload(prod);
    this.emit('productionConfig', parsed);
    return parsed;
  }

  async readOpConfigFromDevice(): Promise<Uint8Array> {
    const rsp = await this.readOperationalConfig();
    const op = normalizeOperationalConfig(rsp?.payload);
    if (!op?.length || op[0] !== 0x5a)
      throw new Error('Invalid operational config returned from device');

    this.operationalConfig = op;

    try {
      this.accel1.applyOperationalConfig(op);
      this.gyroAccel2.applyOperationalConfig(op);
      this.adc.applyOperationalConfig(op);
      this.ppg.applyOperationalConfig(op);
    } catch (e) {
      console.warn('[opcfg] apply after read failed:', e);
    }

    this.emit('opConfig', { op });
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
