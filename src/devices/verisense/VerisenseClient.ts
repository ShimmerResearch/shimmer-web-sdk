import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import {
  NUS_SERVICE,
  NUS_TX,
  NUS_RX,
  READ_DATA_REQ,
  DISCONNECT_REQ,
  DATA_ACK,
  DATA_NACK,
  DATA_EOS_HDR,
} from './constants.js';
import {
  u16le_at,
  u24le,
  nowMillis,
  computeCrcLikeCSharp,
  getOriginalCrcLE,
  crc16_ccitt_false,
  normalizeOperationalConfig,
  parseProductionConfigPayload,
  type ProductionConfig,
} from './protocol.js';
import { SensorBase } from './sensors/SensorBase.js';
import { SensorGSR } from './sensors/SensorGSR.js';
import { SensorLIS2DW12 } from './sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from './sensors/SensorLSM6DS3.js';
import { SensorPPG } from './sensors/SensorPPG.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type TransportKind = 'ble' | 'serial' | null;
export type DeviceMode = 'idle' | 'streaming' | 'command' | 'logged';

export interface SensorMap {
  1: SensorGSR;
  2: SensorLIS2DW12;
  3: SensorLSM6DS3;
  4: SensorPPG;
}

export interface StreamPacket {
  sensorId: number;
  tick_u24: number;
  decoded: unknown[] | null;
  rawPayload: Uint8Array;
  crcOk: boolean | null;
}

export interface TransferLoggedDataOptions {
  fileHandle?: FileSystemFileHandle | null;
  timeoutMs?: number;
  maxNack?: number;
  maxCrcNack?: number;
  onProgress?:
    | ((info: { payloadIndex: number; bytesWritten: number; crcOk: boolean }) => void)
    | null;
}

export interface TransferLoggedDataResult {
  ok: boolean;
  bytesWritten: number;
  blob?: Blob;
}

export interface VerisenseClientOptions {
  hardwareIdentifier?: string;
  stripStreamCrc?: boolean;
  verifyStreamCrc?: boolean;
  debug?: boolean;
}

// ---------------------------------------------------------------------------
// Internal sync state
// ---------------------------------------------------------------------------

interface SyncSession {
  receiving: boolean;
  lastReply: string;
  nackCount: number;
  nackCrcCount: number;
  maxNack: number;
  maxCrcNack: number;
  lastRxAt: number;
  timeoutMs: number;
  bytesWritten: number;
  resolve: (v: { ok: boolean; bytesWritten: number }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setInterval> | null;
  writable: FileSystemWritableFileStream | null;
  chunks: Uint8Array[];
  onProgress:
    | ((info: { payloadIndex: number; bytesWritten: number; crcOk: boolean }) => void)
    | null;
}

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
 * - BLE streaming (accel, GSR, gyro, PPG)
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
  private _buf = new Uint8Array(0);
  private _newPayload = true;
  private _expectedLen = 0;
  private _pending: {
    resolve: (v: { payload: Uint8Array }) => void;
    reject: (e: Error) => void;
  } | null = null;
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
      1: new SensorGSR(),
      2: new SensorLIS2DW12(),
      3: new SensorLSM6DS3(),
      4: new SensorPPG(),
    };

    this.sensors[1].setHardwareIdentifier(this.hardwareIdentifier);
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[Verisense]', ...args);
  }

  // Quick access aliases
  get gsr(): SensorGSR {
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
    this.rx.addEventListener('characteristicvaluechanged', (ev) => {
      const dv = (ev as any).target.value as DataView;
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
      void this.writeBytes(DISCONNECT_REQ, { withResponse: false });
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
    this._mode = 'streaming';
    this._resetAssembler();
    await this.writeBytes(this._makeReq(0x2a, [0x01]));
    this.emit('streaming', { on: true });
  }

  override async stopStreaming(): Promise<void> {
    await this.writeBytes(this._makeReq(0x2a, [0x02]));
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
      nackCount: 0,
      nackCrcCount: 0,
      maxNack,
      maxCrcNack,
      lastRxAt: Date.now(),
      timeoutMs,
      bytesWritten: 0,
      resolve: null!,
      reject: null!,
      timer: null,
      writable,
      chunks,
      onProgress: onProgress ?? null,
    };
    this._sync = sync;

    const donePromise = new Promise<{ ok: boolean; bytesWritten: number }>((resolve, reject) => {
      sync.resolve = resolve;
      sync.reject = reject;
    });

    sync.timer = setInterval(
      async () => {
        if (!this._sync?.receiving) return;
        const age = Date.now() - this._sync.lastRxAt;
        if (age < this._sync.timeoutMs) return;

        try {
          if (this._sync.lastReply === 'NONE') {
            await this.writeBytes(READ_DATA_REQ, { withResponse: true });
          } else {
            this._clearSyncRxBuffers('timeout-nack');
            await this.writeBytes(DATA_NACK);
            this._sync.nackCount++;
            this._sync.lastReply = 'NACK';
            if (this._sync.nackCount >= this._sync.maxNack) throw new Error('Too many NACK timeouts');
          }
          this._sync.lastRxAt = Date.now();
        } catch (e) {
          this._abortSync(e instanceof Error ? e : new Error(String(e)));
        }
      },
      Math.max(250, Math.floor(timeoutMs / 2)),
    );

    try {
      await this.writeBytes(READ_DATA_REQ, { withResponse: true });
      const result = await donePromise;
      await (this._loggedChain ?? Promise.resolve());

      if (!fileHandle) {
        const blob = new Blob(chunks, { type: 'application/octet-stream' });
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
      await this.tx.writeValue(u8);
      return;
    }

    const txExt = this.tx as BluetoothRemoteGATTCharacteristic & {
      writeValueWithoutResponse?(v: BufferSource): Promise<void>;
    };
    if (txExt.writeValueWithoutResponse) {
      await txExt.writeValueWithoutResponse(u8);
    } else {
      await this.tx.writeValue(u8);
    }
  }

  private _makeReq(opcode: number, payloadBytes: number[] | Uint8Array = []): Uint8Array {
    const p = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
    const out = new Uint8Array(3 + p.length);
    out[0] = opcode & 0xff;
    out[1] = p.length & 0xff;
    out[2] = (p.length >> 8) & 0xff;
    out.set(p, 3);
    return out;
  }

  async request(
    opcode: number,
    payloadBytes: number[] | Uint8Array = [],
    timeoutMs = 3000,
  ): Promise<{ payload: Uint8Array }> {
    if (this._pending) throw new Error('A request is already pending');
    this._mode = 'command';
    this._resetAssembler();

    const req = this._makeReq(opcode, payloadBytes);

    const p = new Promise<{ payload: Uint8Array }>((resolve, reject) => {
      const t = setTimeout(() => {
        this._pending = null;
        reject(new Error('Request timeout'));
      }, timeoutMs);

      this._pending = {
        resolve: (x) => {
          clearTimeout(t);
          this._pending = null;
          resolve(x);
        },
        reject: (e) => {
          clearTimeout(t);
          this._pending = null;
          reject(e);
        },
      };
    });

    await this.writeBytes(req);
    return p;
  }

  // Convenience command methods
  readStatus() {
    return this.request(0x11);
  }
  readStatus2() {
    return this.request(0x1c);
  }
  readProductionConfig() {
    return this.request(0x13);
  }
  readOperationalConfig() {
    return this.request(0x14);
  }
  readTime() {
    return this.request(0x15);
  }
  readPendingEvents() {
    return this.request(0x17);
  }
  disconnectRequest() {
    return this.request(0x2b);
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
      this.gsr.applyOperationalConfig(op);
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

    const req = this._makeReq(0x24, op);
    await this.writeBytes(req, { withResponse: true });
    await this.readOpConfigFromDevice();
  }

  async getopconfig(): Promise<Uint8Array> {
    return this.getOpConfig();
  }
  async writeopconfig(op: Uint8Array | number[]): Promise<void> {
    return this.writeOpConfig(op);
  }

  getSensor(name: string | number): SensorBase | null {
    const k = String(name ?? '').toLowerCase();
    if (!k) return null;
    if (k.includes('lis2dw12') || k.includes('accel1') || k === '2') return this.accel1;
    if (k.includes('lsm6') || k.includes('gyro') || k.includes('accel2') || k === '3')
      return this.gyroAccel2;
    if (k.includes('gsr') || k === '1') return this.gsr;
    if (k.includes('ppg') || k === '4') return this.ppg;
    return null;
  }

  GetSensor(name: string | number): SensorBase | null {
    return this.getSensor(name);
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
    this._sync = null;
    this._mode = 'idle';
    s.resolve({ ok: true, bytesWritten });
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
      await this.writeBytes(DATA_NACK);
      if (s.nackCrcCount >= s.maxCrcNack) this._abortSync(new Error('Too many CRC failures'));
      s.onProgress?.({ payloadIndex, bytesWritten: s.bytesWritten, crcOk: false });
      return;
    }

    if (s.writable) {
      await s.writable.write(payloadU8);
    } else {
      s.chunks.push(payloadU8.slice());
    }
    s.bytesWritten += payloadU8.length;

    s.lastReply = 'ACK';
    s.nackCount = 0;
    s.nackCrcCount = 0;
    await this.writeBytes(DATA_ACK, { withResponse: true });
    s.onProgress?.({ payloadIndex, bytesWritten: s.bytesWritten, crcOk: true });
  }

  private _resetAssembler(): void {
    this._newPayload = true;
    this._expectedLen = 0;
    this._buf = new Uint8Array(0);
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

  private _feedStreamBytes(chunk: Uint8Array): void {
    if (this._mode === 'logged' && this._sync) this._sync.lastRxAt = Date.now();

    this._appendStreamBuf(chunk);

    for (;;) {
      if (this._rxStreamBuf.length < 3) return;

      const hdr = this._rxStreamBuf[0];
      const len = (this._rxStreamBuf[1] | (this._rxStreamBuf[2] << 8)) >>> 0;

      if (len === 0) {
        this._rxStreamBuf = this._rxStreamBuf.slice(3);
        if (this._mode === 'logged' && hdr === DATA_EOS_HDR) {
          if (this.debugSync) console.log('[sync] EOS received. Finishing.');
          this._finishSync();
        }
        continue;
      }

      if (this._rxStreamBuf.length < 3 + len) return;

      const payload = this._rxStreamBuf.slice(3, 3 + len);
      this._rxStreamBuf = this._rxStreamBuf.slice(3 + len);

      if (this._mode === 'logged') {
        this._loggedChain = (this._loggedChain ?? Promise.resolve())
          .then(() => this._handleLoggedPayload(payload))
          .catch((e: Error) => this._abortSync(e));
        continue;
      }

      if (this._mode === 'streaming') {
        this._handleStreamingPayload(payload);
        continue;
      }

      const pending = this._pending;
      this._pending = null;
      if (this._mode === 'command') this._mode = 'idle';
      if (pending) pending.resolve({ payload });
      this.emit('commandPayload', { payload });
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
