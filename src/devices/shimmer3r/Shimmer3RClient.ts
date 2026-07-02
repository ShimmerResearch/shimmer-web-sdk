import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import { ObjectCluster } from '../../core/ObjectCluster.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import {
  OPCODES,
  SHIMMER3R_DEFAULTS,
  TIMESTAMP_FIELD,
  GSR_NAME,
  GSR_UNCAL_LIMIT_RANGE3,
  type TimestampFmt,
} from './constants.js';
import { SensorBitmapShimmer3 } from './SensorBitmap.js';
import { CHANNEL_FORMATS } from './channelFormats.js';
import {
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
  getOversamplingRatioADS1292R,
} from './calibration.js';
import { concatU8, u16le, u16be, u24le, u24be, sign16, sign24, hex2 } from './protocol.js';
import { toArrayBuffer } from '../../core/arrayBuffer.js';

// ---------------------------------------------------------------------------
// Internal schema type
// ---------------------------------------------------------------------------

interface ChannelField {
  id: number;
  name: string;
  fmt: string;
  endian: string;
  sizeBytes: number;
}

interface StreamSchema {
  timestampFmt: TimestampFmt;
  fields: ChannelField[];
  /** Total bytes per frame, including the 0x00 preamble byte. */
  frameBytes: number;
  enabledSensors: number;
  dataPreambleByte: number;
}

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface Shimmer3RClientOptions extends ShimmerClientOptions {
  /** BLE service UUID override (default: Shimmer3R service UUID). */
  serviceUUID?: string;
  /** Write characteristic UUID override. */
  rxUUID?: string;
  /** Notify characteristic UUID override. */
  txUUID?: string;
  /**
   * Force a specific timestamp width.
   * Shimmer3R firmware ≥ v1.0.22 uses 24-bit timestamps.
   * @default 'u24'
   */
  timestampFmt?: TimestampFmt;
}

// ---------------------------------------------------------------------------
// Shimmer3RClient
// ---------------------------------------------------------------------------

/**
 * Web Bluetooth client for the Shimmer3R sensor platform.
 *
 * Implements the ACK-first command flow used by Shimmer3R firmware ≥ v1.0.22:
 * every configuration command awaits an ACK (0xFF) before resolving.
 * Streaming data frames are framed with a DATA preamble (0x00).
 *
 * @example
 * ```ts
 * const client = new Shimmer3RClient({ timestampFmt: 'u24', debug: true });
 * client.onStatus = (msg) => console.log(msg);
 * client.onStreamFrame = (oc) => {
 *   const gz = oc.get('GYRO_Z', 'raw')?.value;
 *   console.log('gz =', gz);
 * };
 *
 * await client.connect();
 * await client.setSamplingRate(51.2);
 * await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
 * await client.startStreaming();
 * ```
 */
export class Shimmer3RClient extends BaseShimmerClient {
  // BLE handles
  private serviceUUID: string;
  private rxUUID: string;
  private txUUID: string;

  device: BluetoothDevice | null = null;
  private server: BluetoothRemoteGATTServer | null = null;
  private rx: BluetoothRemoteGATTCharacteristic | null = null;
  private tx: BluetoothRemoteGATTCharacteristic | null = null;

  // Protocol state
  private _rxBuf: Uint8Array = new Uint8Array(0);
  private _temps: Set<(chunk: Uint8Array) => void> = new Set();
  private schema: StreamSchema | null = null;
  private forceTimestampFmt: TimestampFmt;
  private _lastAckRemainder: Uint8Array | null = null;
  private _expectingAck = 0;
  private _streaming = false;
  private _lastTs = 0;

  // Cached device configuration
  enabledSensors = 0x000000;
  samplingRateHz = 0;
  gsrRangeSetting = 0;
  ExpPower = 0;

  /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
  readonly LIMIT_MIN_VALID_USIEMENS = 0.03;

  // Callbacks
  onInquiry:
    ((info: ReturnType<Shimmer3RClient['_interpretInquiryResponseShimmer3R']>) => void) | null =
    null;
  onExpPowerChanged: ((expPower: number) => void) | null = null;

  constructor(opts: Shimmer3RClientOptions = {}) {
    super(opts);
    this.serviceUUID = opts.serviceUUID ?? SHIMMER3R_DEFAULTS.SERVICE_UUID;
    this.rxUUID = opts.rxUUID ?? SHIMMER3R_DEFAULTS.CHAR_RX_UUID;
    this.txUUID = opts.txUUID ?? SHIMMER3R_DEFAULTS.CHAR_TX_UUID;
    this.forceTimestampFmt = opts.timestampFmt ?? 'u24';
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[Shimmer3R]', ...args);
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  override async connect(): Promise<void> {
    this._emitStatus('Requesting Bluetooth device…');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [this.serviceUUID] }],
      optionalServices: [this.serviceUUID],
    });
    this._emitStatus(`Selected: ${this.device.name ?? 'Shimmer3R'}`);
    this.server = await this.device.gatt!.connect();
    this._emitStatus('GATT connected');
    const svc = await this.server.getPrimaryService(this.serviceUUID);
    this.rx = await svc.getCharacteristic(this.rxUUID);
    this.tx = await svc.getCharacteristic(this.txUUID);
    this._emitStatus('RX/TX obtained');
    await this.tx.startNotifications();
    this.tx.addEventListener('characteristicvaluechanged', this._handleNotify);
    this._emitStatus('Notifications started');
  }

  override async disconnect(): Promise<void> {
    try {
      if (this.tx) {
        try {
          await this.tx.stopNotifications();
        } catch {
          /* ignore */
        }
        this.tx.removeEventListener('characteristicvaluechanged', this._handleNotify);
      }
      if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    } finally {
      this.device = this.server = this.rx = this.tx = null;
      this._rxBuf = new Uint8Array(0);
      this.schema = null;
      this._streaming = false;
      this.ExpPower = 0;
      this._emitStatus('Disconnected');
    }
  }

  // ---------------------------------------------------------------------------
  // BLE notify handler
  // ---------------------------------------------------------------------------

  private _handleNotify = (evt: Event): void => {
    const chunk = new Uint8Array((evt as any).target.value.buffer);
    this._log('Notify len=', chunk.length, 'data=', chunk);

    // 1) Consume an expected ACK
    if (
      chunk.length >= 1 &&
      chunk[0] === OPCODES.ACK_COMMAND_PROCESSED &&
      (this._expectingAck ?? 0) > 0
    ) {
      this._log('ACK detected at start of notify (expected)');
      this._expectingAck = Math.max(0, this._expectingAck - 1);

      const remainder = chunk.slice(1);
      this._lastAckRemainder = remainder.length ? remainder : null;

      this._emitTemp(new Uint8Array([OPCODES.ACK_COMMAND_PROCESSED]));

      if (this._lastAckRemainder) {
        if (this._streaming && this._lastAckRemainder[0] === OPCODES.DATA_PACKET) {
          this._log('Appending DATA remainder after ACK to stream buffer');
          this._rxBuf = concatU8(this._rxBuf, this._lastAckRemainder);
        } else {
          this._log('Forwarding non-DATA remainder to control handlers');
          this._emitTemp(this._lastAckRemainder);
        }
        this._lastAckRemainder = null;
      }
      return;
    }

    // 2) During streaming, all bytes are data-plane
    if (this._streaming) {
      this._rxBuf = concatU8(this._rxBuf, chunk);
    } else {
      this._emitTemp(chunk);
      if (chunk.length && chunk[0] === OPCODES.DATA_PACKET) {
        this._rxBuf = concatU8(this._rxBuf, chunk);
      }
    }

    // 3) Try parsing if schema is available
    if (this.schema) {
      try {
        this._parseBySchema();
      } catch (e) {
        this._log('parseBySchema error:', e);
      }
    }
  };

  // ---------------------------------------------------------------------------
  // Configuration commands
  // ---------------------------------------------------------------------------

  /**
   * Control the internal expansion power rail (required for ExG/EMG/ECG).
   * @param expPower 0 = disable, 1 = enable.
   */
  async setInternalExpPower(
    expPower: 0 | 1,
  ): Promise<{ expPower: number; ackRemainder: Uint8Array | null }> {
    if (expPower !== 0 && expPower !== 1) throw new Error('expPower must be 0 (off) or 1 (on)');
    if (!this.rx) throw new Error('Not connected (RX missing)');

    const cmd = new Uint8Array([OPCODES.SET_INTERNAL_EXP_POWER_ENABLE_COMMAND, expPower]);
    this._emitStatus(
      `SET_INTERNAL_EXP_POWER_ENABLE_CMD → ${expPower ? 'ON' : 'OFF'} waiting for ACK…`,
    );
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    this._emitStatus(`Expansion power ${expPower ? 'enabled' : 'disabled'} (ACK received).`);
    this.ExpPower = expPower;
    try {
      this.onExpPowerChanged?.(expPower);
    } catch (e) {
      this._log('onExpPowerChanged handler error', e);
    }
    return { expPower, ackRemainder };
  }

  /**
   * Set the GSR measurement range.
   * @param gsrRange 0 = 8–63 kΩ, 1 = 63–220 kΩ, 2 = 220–680 kΩ, 3 = 680–4700 kΩ, 4 = Auto.
   */
  async setGSRRange(
    gsrRange: number,
  ): Promise<{ gsrRange: number; ackRemainder: Uint8Array | null }> {
    if (!Number.isInteger(gsrRange) || gsrRange < 0 || gsrRange > 4) {
      throw new Error('gsrRange must be 0–4');
    }
    if (!this.rx) throw new Error('Not connected (RX missing)');

    const cmd = new Uint8Array([OPCODES.SET_GSR_RANGE_COMMAND, gsrRange & 0xff]);
    this._emitStatus('SET_GSR_RANGE → waiting for ACK…');
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('SET_GSR_RANGE (ACK received).');
    this.gsrRangeSetting = gsrRange;
    return { gsrRange, ackRemainder };
  }

  getInternalExpPower(): number {
    return this.ExpPower;
  }

  getEnabledSensors(): number {
    return this.enabledSensors;
  }

  /**
   * Enable sensors via a 24-bit bitmask.
   * Automatically performs an Inquiry after ACK to rebuild the stream schema.
   */
  async setSensors(
    sensors: number,
  ): Promise<{ sensors: number; ackRemainder: Uint8Array | null; enabledSensors: number }> {
    if (!Number.isFinite(sensors)) throw new Error('sensors must be a finite number');
    if (!this.rx) throw new Error('Not connected (RX missing)');

    sensors = (sensors >>> 0) & 0xffffff;
    const b1 = sensors & 0xff;
    const b2 = (sensors >>> 8) & 0xff;
    const b3 = (sensors >>> 16) & 0xff;
    const cmd = new Uint8Array([OPCODES.SET_SENSORS_COMMAND, b1, b2, b3]);

    this._emitStatus(
      `SET_SENSORS_CMD → bitmask=0x${sensors.toString(16).toUpperCase().padStart(6, '0')} waiting for ACK…`,
    );
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    this._emitStatus(
      `Sensors ACK received. Bitmask 0x${sensors.toString(16).toUpperCase().padStart(6, '0')} applied.`,
    );

    try {
      this._emitStatus('Performing automatic inquiry to refresh schema…');
      const info = await this.inquiry();
      this.enabledSensors = info.schema.enabledSensors;
      this._emitStatus(
        `Inquiry complete. Enabled sensors: 0x${this.enabledSensors.toString(16).toUpperCase()}`,
      );
    } catch (err: unknown) {
      this._emitStatus(`Inquiry after setSensors failed: ${(err as Error).message}`);
    }

    return { sensors, ackRemainder, enabledSensors: this.enabledSensors };
  }

  /**
   * Set the sampling rate.
   * The firmware expects a 16-bit divisor: `divisor = floor(32768 / rateHz)`.
   */
  async setSamplingRate(rateHz: number): Promise<{
    requestedHz: number;
    appliedHz: number;
    divisor: number;
    ackRemainder: Uint8Array | null;
  }> {
    if (!Number.isFinite(rateHz) || rateHz <= 0) {
      throw new Error('Sampling rate must be a positive number (Hz)');
    }
    if (!this.rx) throw new Error('Not connected (RX missing)');

    let divisor = Math.floor(32768 / rateHz);
    divisor = Math.max(1, Math.min(0xffff, divisor));

    const lsb = divisor & 0xff;
    const msb = (divisor >> 8) & 0xff;
    const cmd = new Uint8Array([OPCODES.SET_SAMPLING_RATE_COMMAND, lsb, msb]);

    this._emitStatus(
      `Set sampling rate → ${rateHz.toFixed(3)} Hz (divisor=${divisor}) — waiting for ACK…`,
    );
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    const appliedHz = 32768 / divisor;
    this.samplingRateHz = appliedHz;
    this._emitStatus(`Sampling rate ACKed. Applied ≈ ${this.samplingRateHz.toFixed(3)} Hz`);
    return { requestedHz: rateHz, appliedHz, divisor, ackRemainder };
  }

  // ---------------------------------------------------------------------------
  // Inquiry
  // ---------------------------------------------------------------------------

  /** Send INQUIRY_CMD and parse the response to build the stream schema. */
  async inquiry() {
    this._emitStatus('INQUIRY_CMD → waiting for ACK then RSP…');
    const remainder = await this._writeExpectingAck(
      new Uint8Array([OPCODES.INQUIRY_COMMAND]),
      1500,
    );

    if (remainder && remainder[0] === OPCODES.INQUIRY_RESPONSE) {
      this._log('Using post-ACK remainder as response');
      const info = this._interpretInquiryResponseShimmer3R(remainder);
      this.onInquiry?.(info);
      return info;
    }
    const rsp = await this._waitForResponse(OPCODES.INQUIRY_RESPONSE, 2000);
    this._emitStatus(`Inquiry RSP (${rsp.length} bytes)`);
    const info = this._interpretInquiryResponseShimmer3R(rsp);
    this.onInquiry?.(info);
    return info;
  }

  // ---------------------------------------------------------------------------
  // ExG configuration helpers
  // ---------------------------------------------------------------------------

  /** Enable EMG (ADS1292R) in 16-bit mode on EXG1 & EXG2. */
  async enableEMG16Bit(): Promise<void> {
    if (!this.rx) throw new Error('Not connected (RX missing)');
    await this._writeExgPages(
      new Uint8Array([
        0x61, 0x00, 0x00, 0x0a, 0x02, 0xa8, 0x10, 0x69, 0x60, 0x20, 0x00, 0x00, 0x02, 0x03,
      ]),
      new Uint8Array([
        0x61, 0x01, 0x00, 0x0a, 0x02, 0xa0, 0x10, 0xe1, 0xe1, 0x00, 0x00, 0x00, 0x02, 0x01,
      ]),
    );
    this._emitStatus('EMG 16-bit enabled on EXG1 & EXG2. Schema updated.');
  }

  /** Enable EXG test signal in 16-bit mode (useful for verifying ExG hardware). */
  async enableEXGTestSignal16Bit(): Promise<void> {
    if (!this.rx) throw new Error('Not connected (RX missing)');
    await this._writeExgPages(
      new Uint8Array([
        0x61, 0x00, 0x00, 0x0a, 0x02, 0xab, 0x10, 0x15, 0x15, 0x00, 0x00, 0x00, 0x02, 0x01,
      ]),
      new Uint8Array([
        0x61, 0x01, 0x00, 0x0a, 0x02, 0xa3, 0x10, 0x15, 0x15, 0x00, 0x00, 0x00, 0x02, 0x01,
      ]),
    );
    this._emitStatus('EXG test signal 16-bit enabled. Schema updated.');
  }

  /** Enable ECG in 16-bit mode on EXG1 & EXG2. */
  async enableECG16Bit(): Promise<void> {
    if (!this.rx) throw new Error('Not connected (RX missing)');
    await this._writeExgPages(
      new Uint8Array([
        0x61, 0x00, 0x00, 0x0a, 0x02, 0xa8, 0x10, 0x40, 0x40, 0x2d, 0x00, 0x00, 0x02, 0x03,
      ]),
      new Uint8Array([
        0x61, 0x01, 0x00, 0x0a, 0x02, 0xa0, 0x10, 0x40, 0x47, 0x00, 0x00, 0x00, 0x02, 0x01,
      ]),
    );
    this._emitStatus('ECG 16-bit enabled on EXG1 & EXG2. Schema updated.');
  }

  private async _writeExgPages(exg1: Uint8Array, exg2: Uint8Array): Promise<void> {
    const oversamplingRatio = getOversamplingRatioADS1292R(this.samplingRateHz);
    exg1 = new Uint8Array(exg1);
    exg2 = new Uint8Array(exg2);
    exg1[4] = (((exg1[4] >> 3) << 3) | oversamplingRatio) & 0xff;
    exg2[4] = (((exg2[4] >> 3) << 3) | oversamplingRatio) & 0xff;

    await this._write(exg1);
    await new Promise<void>((r) => setTimeout(r, 200));
    await this._write(exg2);
    await new Promise<void>((r) => setTimeout(r, 50));

    const targetBits =
      (SensorBitmapShimmer3.SENSOR_EXG1_16BIT | SensorBitmapShimmer3.SENSOR_EXG2_16BIT) >>> 0;
    const newMask = ((this.enabledSensors >>> 0) | targetBits) & 0xffffff;
    await this.setSensors(newMask);
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  override async startStreaming(): Promise<void> {
    if (!this.schema) this._emitStatus('Starting stream without schema (not recommended).');
    this._emitStatus('START_STREAM → waiting for ACK…');
    const remainder = await this._writeExpectingAck(
      new Uint8Array([OPCODES.START_STREAMING_COMMAND]),
      1500,
    );
    this._streaming = true;

    if (remainder?.length) {
      if (remainder[0] === OPCODES.DATA_PACKET) {
        this._rxBuf = concatU8(this._rxBuf, remainder);
      } else {
        this._emitTemp(remainder);
      }
    }
    this._emitStatus('START_STREAM ACK received; frames should follow');
  }

  override async stopStreaming(): Promise<void> {
    this._emitStatus('STOP_STREAM → sending (no ACK wait)…');
    try {
      await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
      this._emitStatus('STOP_STREAM command sent (skipped ACK wait).');
    } catch (err: unknown) {
      this._emitStatus(`STOP_STREAM write failed: ${(err as Error).message}`);
    }
    this._streaming = false;
    this._rxBuf = new Uint8Array(0);
    this._emitStatus('Streaming stopped.');
  }

  /** Start streaming AND SD card logging simultaneously. */
  async startStreamingAndLogging(): Promise<void> {
    if (!this.schema) this._emitStatus('Starting stream without schema (not recommended).');
    this._emitStatus('START_BT_STREAM_SD_LOGGING → waiting for ACK…');
    const remainder = await this._writeExpectingAck(
      new Uint8Array([OPCODES.START_SDBT_COMMAND]),
      1500,
    );
    this._streaming = true;
    if (remainder?.length) {
      if (remainder[0] === OPCODES.DATA_PACKET) {
        this._rxBuf = concatU8(this._rxBuf, remainder);
      } else {
        this._emitTemp(remainder);
      }
    }
    this._emitStatus('START_BT_STREAM_SD_LOGGING ACK received; frames should follow');
  }

  /** Stop streaming AND SD card logging. */
  async stopStreamingAndLogging(): Promise<void> {
    this._emitStatus('STOP_BT_STREAM_SD_LOGGING → sending…');
    try {
      await this._write(new Uint8Array([OPCODES.STOP_SDBT_COMMAND]));
    } catch (err: unknown) {
      this._emitStatus(`STOP_BT_STREAM_SD_LOGGING write failed: ${(err as Error).message}`);
    }
    this._streaming = false;
    this._rxBuf = new Uint8Array(0);
    this._emitStatus('Streaming + logging stopped.');
  }

  // ---------------------------------------------------------------------------
  // Inquiry response / schema building
  // ---------------------------------------------------------------------------

  private _interpretInquiryResponseShimmer3R(u8: Uint8Array) {
    let base = 0;
    if (u8[0] === OPCODES.INQUIRY_RESPONSE && u8.length >= 2) base = 1;

    const adcRaw = u16le(u8, base + 0);
    const samplingRateHz = 32768 / adcRaw;
    this.samplingRateHz = samplingRateHz;

    const cfg =
      BigInt(u8[base + 2]) |
      (BigInt(u8[base + 3]) << 8n) |
      (BigInt(u8[base + 4]) << 16n) |
      (BigInt(u8[base + 5]) << 24n) |
      (BigInt(u8[base + 6]) << 32n) |
      (BigInt(u8[base + 7]) << 40n) |
      (BigInt(u8[base + 8]) << 48n);

    const internalExpPower = Number((cfg >> 24n) & 0x1n);
    const gsrRange = Number((cfg >> 25n) & 0x7n);
    this.ExpPower = internalExpPower;
    this.gsrRangeSetting = gsrRange;

    const numCh = u8[base + 9] ?? 0;
    const bufSize = u8[base + 10] ?? 0;
    const chStart = base + 11;
    const channelIds = [...u8.slice(chStart, chStart + numCh)];

    const schema = this._buildSchemaFromChannels(channelIds, this.forceTimestampFmt ?? 'u24');
    this.schema = schema;

    this._log(
      `Schema built: timestampFmt=${schema.timestampFmt}, fields=${schema.fields.length}, enabledSensors=0x${schema.enabledSensors.toString(16)}`,
    );
    this._emitStatus(`Expansion power ${this.ExpPower ? 'enabled' : 'disabled'} (ACK received).`);

    return {
      opcode: u8[0],
      adcRaw,
      samplingRateHz,
      numChannels: numCh,
      bufferSize: bufSize,
      channelIds,
      schema,
      bytes: u8.slice(0),
    };
  }

  private _buildSchemaFromChannels(channelIds: number[], timestampFmt: TimestampFmt): StreamSchema {
    const fields: ChannelField[] = [];
    const ts = timestampFmt === 'u24' ? TIMESTAMP_FIELD.u24 : TIMESTAMP_FIELD.u16;
    let packetSize = 1 + ts.sizeBytes; // 1 = preamble 0x00
    let enabledSensors = 0;

    for (const id of channelIds) {
      const fmt = CHANNEL_FORMATS[id];
      if (!fmt) {
        fields.push({ id, name: `CH_${hex2(id)}`, fmt: 'i16', endian: 'le', sizeBytes: 2 });
        packetSize += 2;
        continue;
      }
      fields.push({ id, ...fmt });
      packetSize += fmt.sizeBytes ?? 2;

      switch (id) {
        case 0x00:
        case 0x01:
        case 0x02:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_A_ACCEL;
          break;
        case 0x04:
        case 0x05:
        case 0x06:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_D_ACCEL;
          break;
        case 0x14:
        case 0x15:
        case 0x16:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_ACCEL_ALT;
          break;
        case 0x07:
        case 0x08:
        case 0x09:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_MAG;
          break;
        case 0x0a:
        case 0x0b:
        case 0x0c:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_GYRO;
          break;
        case 0x12:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_INT_A1;
          break;
        case 0x1c:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_GSR;
          break;
        case 0x23:
        case 0x24:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG1_16BIT;
          break;
        case 0x25:
        case 0x26:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG2_16BIT;
          break;
        case 0x1e:
        case 0x1f:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG1_24BIT;
          break;
        case 0x21:
        case 0x22:
          enabledSensors |= SensorBitmapShimmer3.SENSOR_EXG2_24BIT;
          break;
        default:
          console.warn(`⚠️ Unmapped channel ID 0x${id.toString(16)} — added as generic i16.`);
      }
    }

    this.enabledSensors = enabledSensors;
    return { timestampFmt, fields, frameBytes: packetSize, enabledSensors, dataPreambleByte: 0x00 };
  }

  // ---------------------------------------------------------------------------
  // GSR calibration (applied inline during stream parsing)
  // ---------------------------------------------------------------------------

  private _calibrateData(oc: ObjectCluster): void {
    const snapshot = [...oc.fields];
    for (const field of snapshot) {
      if (field.name === GSR_NAME) {
        const rawField = oc.get(GSR_NAME, 'raw');
        const gsrraw = rawField?.value ?? null;
        if (gsrraw === null) continue;

        let adc12 = gsrraw & 0x0fff;
        let currentRange = this.gsrRangeSetting;
        if (currentRange === 4) {
          currentRange = (gsrraw >> 14) & 0x03;
        }
        if (currentRange === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3) {
          adc12 = GSR_UNCAL_LIMIT_RANGE3;
        }
        let gsrkOhm = calibrateGsrDataToResistanceFromAmplifierEq(adc12, currentRange);
        gsrkOhm = nudgeGsrResistance(gsrkOhm, this.gsrRangeSetting);
        const gsrConductanceUSiemens = (1.0 / gsrkOhm) * 1000;
        oc.add(GSR_NAME, gsrConductanceUSiemens, 'uSiemens', 'cal');
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Stream frame parser
  // ---------------------------------------------------------------------------

  private _parseBySchema(): void {
    const sch = this.schema!;
    const preamble = sch.dataPreambleByte;
    const frameBytes = sch.frameBytes >>> 0;
    const tsBytes = sch.timestampFmt === 'u16' ? 2 : 3;
    const TS_MOD = tsBytes === 3 ? 16777216 : 65536;

    let buf = this._rxBuf;
    let frames = 0;
    let drops = 0;
    let anomalies = 0;

    while (buf.length >= frameBytes * 2) {
      if (buf[0] === preamble && buf[frameBytes] === preamble) {
        let ts1: number, ts2: number;
        try {
          ts1 = tsBytes === 2 ? u16le(buf, 1) : u24le(buf, 1);
          ts2 = tsBytes === 2 ? u16le(buf, frameBytes + 1) : u24le(buf, frameBytes + 1);
        } catch {
          buf = buf.subarray(1);
          drops++;
          continue;
        }

        const dt = (((ts2 - ts1) % TS_MOD) + TS_MOD) % TS_MOD;
        if (dt === 0) {
          buf = buf.subarray(1);
          drops++;
          continue;
        }

        const frame = buf.subarray(0, frameBytes);
        try {
          let cursor = 1;
          const oc = new ObjectCluster(this.device?.name ?? 'Shimmer3R');

          const ts = tsBytes === 2 ? u16le(frame, cursor) : u24le(frame, cursor);
          cursor += tsBytes;
          oc.add('TIMESTAMP', ts, 'ticks', 'raw');

          for (const f of sch.fields) {
            if (cursor + f.sizeBytes > frame.length) {
              throw new Error(`short frame: need ${f.sizeBytes} @${cursor}, have ${frame.length}`);
            }
            let v: number;
            switch (f.fmt) {
              case 'i16':
                v = f.endian === 'be' ? sign16(u16be(frame, cursor)) : sign16(u16le(frame, cursor));
                break;
              case 'u16':
                v = f.endian === 'be' ? u16be(frame, cursor) : u16le(frame, cursor);
                break;
              case 'i24':
                v = f.endian === 'be' ? sign24(u24be(frame, cursor)) : sign24(u24le(frame, cursor));
                break;
              case 'u24':
                v = f.endian === 'be' ? u24be(frame, cursor) : u24le(frame, cursor);
                break;
              case 'i12*': {
                const msb = frame[cursor] & 0xff;
                const lsb = frame[cursor + 1] & 0xff;
                const raw12 = (msb << 4) | (lsb >> 4);
                v = raw12 & 0x800 ? raw12 - 0x1000 : raw12;
                break;
              }
              case 'u8':
                v = frame[cursor];
                break;
              default:
                v = u16le(frame, cursor);
            }
            cursor += f.sizeBytes;
            oc.add(f.name, v, null, 'raw');
          }

          if (this._lastTs) {
            const dLast = (((ts - this._lastTs) % TS_MOD) + TS_MOD) % TS_MOD;
            if (dLast === 0) {
              anomalies++;
              this._log(`⚠️ Timestamp anomaly#${anomalies}: ts=${ts}, last=${this._lastTs}, Δ=0`);
            }
          }
          this._lastTs = ts;
          this._calibrateData(oc);
          this.onStreamFrame?.(oc);
          frames++;
          buf = buf.subarray(frameBytes);
        } catch (e: unknown) {
          this._log('⚠️ frame decode error → sliding 1 byte', (e as Error).message);
          buf = buf.subarray(1);
          drops++;
        }
        continue;
      }
      buf = buf.subarray(1);
      drops++;
      if (this.debug && drops % 64 === 1) {
        this._log(`resync: dropped ${drops} byte(s) so far; bufLen=${buf.length}`);
      }
    }

    this._rxBuf = buf;
    if (drops && drops % 512 === 0) this._lastTs = 0;
    if (this.debug && (frames || drops)) {
      this._log(`parse: frames=${frames}, drops=${drops}, leftover=${this._rxBuf.length}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Low-level transport helpers
  // ---------------------------------------------------------------------------

  private async _write(u8: Uint8Array): Promise<void> {
    if (!this.rx) throw new Error('Not connected (RX missing)');
    this._log('Write', u8);
    await this.rx.writeValue(toArrayBuffer(u8));
  }

  private async _writeExpectingAck(
    u8: Uint8Array,
    ackTimeoutMs = 1000,
  ): Promise<Uint8Array | null> {
    this._expectingAck++;
    try {
      await this._write(u8);
      return await this._waitForAck(ackTimeoutMs);
    } catch (e) {
      this._expectingAck = Math.max(0, this._expectingAck - 1);
      throw e;
    }
  }

  private _waitForAck(timeoutMs = 1000): Promise<Uint8Array | null> {
    return new Promise<Uint8Array | null>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error('ACK timeout'));
      }, timeoutMs);

      const handler = (chunk: Uint8Array): void => {
        if (!chunk || chunk.length === 0) return;
        if (chunk.length === 1 && chunk[0] === OPCODES.ACK_COMMAND_PROCESSED) {
          clearTimeout(t);
          this._offTemp(handler);
          const rem = this._lastAckRemainder;
          this._lastAckRemainder = null;
          resolve(rem ?? null);
          return;
        }
        if (chunk[0] === OPCODES.ACK_COMMAND_PROCESSED && chunk.length > 1) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(chunk.slice(1));
        }
      };
      this._onTemp(handler);
    });
  }

  private _waitForResponse(expectedOpcode: number, timeoutMs = 1500): Promise<Uint8Array> {
    if (this._lastAckRemainder && this._lastAckRemainder[0] === expectedOpcode) {
      const rem = this._lastAckRemainder;
      this._lastAckRemainder = null;
      return Promise.resolve(rem);
    }
    return new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error('Response timeout'));
      }, timeoutMs);

      const handler = (chunk: Uint8Array): void => {
        if (!chunk || chunk.length === 0) return;
        if (chunk.length === 1 && chunk[0] === OPCODES.ACK_COMMAND_PROCESSED) return;
        if (chunk[0] === expectedOpcode) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(chunk);
        }
      };
      this._onTemp(handler);
    });
  }

  private _onTemp(fn: (chunk: Uint8Array) => void): void {
    this._temps.add(fn);
  }
  private _offTemp(fn: (chunk: Uint8Array) => void): void {
    this._temps.delete(fn);
  }
  private _emitTemp(buf: Uint8Array): void {
    this._temps.forEach((fn) => {
      try {
        fn(buf);
      } catch (e) {
        this._log('temp handler error', e);
      }
    });
  }
}
