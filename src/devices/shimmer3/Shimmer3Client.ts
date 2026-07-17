import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import { ObjectCluster } from '../../core/ObjectCluster.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import { OPCODES, SHIMMER3_DEFAULTS, GSR_NAME, GSR_UNCAL_LIMIT_RANGE3 } from './constants.js';
import type { TimestampFmt } from './constants.js';
import {
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
} from '../shimmer3r/calibration.js';
import {
  applyStreamingCalibration,
  parseKinematicCalibBlock,
  getGroupDefaults,
  type ImuFamily,
  type StreamingImuRanges,
  type InertialGroup,
  type KinematicCalibration,
} from '../calibration/index.js';
import {
  ACK,
  NACK,
  NEED_MORE,
  RESYNC,
  concatU8,
  u16le,
  u16be,
  u24le,
  u24be,
  sign16,
  sign24,
  interpretShimmer3InquiryResponse,
  parseShimmer3DeviceVersionResponse,
  parseShimmer3FwVersionResponse,
  shimmer3UsesThreeByteTimestamp,
  shimmer3ControlMessageLength,
  type Shimmer3InquiryResult,
  type Shimmer3StreamSchema,
  type Shimmer3DeviceVersion,
  type Shimmer3FwVersion,
} from './protocol.js';

// ---------------------------------------------------------------------------
// Constructor options
// ---------------------------------------------------------------------------

export interface Shimmer3ClientOptions extends ShimmerClientOptions {
  /**
   * The RFCOMM/SPP byte pipe to the classic Shimmer3. **Required** — classic
   * Bluetooth is impossible in a browser, so unlike {@link Shimmer3RClient} this
   * client never builds a default transport. Supply one here or to
   * {@link Shimmer3Client.connect}.
   */
  transport?: ShimmerTransport;
  /**
   * Force a specific streaming timestamp width. When omitted the width is chosen
   * from the firmware version reported during the connect handshake (u24 for
   * firmware code ≥ 6, else u16 — ShimmerObject#updateTimestampByteLength).
   */
  timestampFmt?: TimestampFmt;
  /**
   * Send a best-effort STOP_STREAMING before the buffer-flush dummy read on
   * connect, so reconnecting to a device left mid-stream is clean. Default true.
   */
  stopStreamingOnConnect?: boolean;
  /**
   * IMU generation for default inertial calibration selection. `'old'` =
   * LSM303DLHC accel/mag + MPU9x50 gyro (Shimmer3 SR<6); `'new'` = LSM303AHTR
   * accel/mag (new-IMU boards). Default `'old'`.
   *
   * HARDWARE-VERIFY: the streaming protocol does not expose the daughter-card
   * revision, so the generation cannot be auto-detected here; set this to match
   * the device when using the new-IMU boards.
   */
  imuGeneration?: 'old' | 'new';
  /**
   * Emit calibrated (`'cal'`) inertial channel values alongside the raw ones.
   * Default true. Set false to keep the pre-calibration behaviour (raw only).
   */
  emitCalibratedInertial?: boolean;
}

// ---------------------------------------------------------------------------
// Shimmer3Client
// ---------------------------------------------------------------------------

/**
 * Client for the **classic-Bluetooth (RFCOMM/SPP) Shimmer3**.
 *
 * Shimmer3 speaks the same LiteProtocol as the Shimmer3R (shared opcodes, sensor
 * bitmap, channel formats — all reused from `../shimmer3r/`), with two
 * differences this client owns:
 *
 * 1. **Unframed byte stream.** RFCOMM has no MTU and no message framing: bytes
 *    arrive split or coalesced arbitrarily. Rather than assume "one notification
 *    = one message" (as the BLE {@link Shimmer3RClient} does), this client
 *    accumulates inbound bytes and extracts complete control messages with a
 *    length-aware parser ({@link shimmer3ControlMessageLength}). This mirrors the
 *    Java driver's blocking `readBytes(n)` approach (ShimmerBluetooth) but as a
 *    non-blocking accumulator.
 * 2. **Inquiry-response layout.** Shimmer3's config word is 4 bytes vs
 *    Shimmer3R's 7 (see {@link interpretShimmer3InquiryResponse}).
 *
 * Transport injection is mandatory — `connect()` with no transport throws.
 *
 * @example
 * ```ts
 * const client = new Shimmer3Client({ transport: rfcommTransport });
 * client.onStatus = (m) => console.log(m);
 * await client.connect();               // handshake: flush → HW version → FW version
 * await client.setSamplingRate(51.2);
 * await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
 * await client.setGSRRange(2);
 * await client.startStreaming();
 * ```
 */
export class Shimmer3Client extends BaseShimmerClient {
  // Transport (byte pipe). Always injected — never built by this client.
  private _injectedTransport: ShimmerTransport | null = null;
  private _transport: ShimmerTransport | null = null;
  private _notifyUnsub: Unsubscribe | null = null;
  private _disconnectUnsub: Unsubscribe | null = null;

  // Protocol state
  private _rxBuf: Uint8Array = new Uint8Array(0);
  private _temps: Set<(chunk: Uint8Array) => void> = new Set();
  private schema: Shimmer3StreamSchema | null = null;
  private _forceTimestampFmt: TimestampFmt | undefined;
  private _timestampFmt: TimestampFmt;
  private _stopStreamingOnConnect: boolean;
  private _streaming = false;
  private _streamStarting = false;
  private _lastTs = 0;

  // Cached device info from the connect handshake
  deviceVersion: Shimmer3DeviceVersion | null = null;
  firmwareVersion: Shimmer3FwVersion | null = null;

  // Cached device configuration
  enabledSensors = 0x000000;
  samplingRateHz = 0;
  gsrRangeSetting = 0;
  ExpPower = 0;

  /** Inertial-sensor hardware ranges, refreshed from each inquiry's config word. */
  imuRanges: StreamingImuRanges = {
    lnAccel: 0, // Kionix KXRB LN accel is fixed-range on Shimmer3
    wrAccel: 0,
    gyro: 0,
    mag: 0,
    altAccel: 0,
    altMag: 0,
  };
  /** When false, inertial channels are emitted raw-only (no `'cal'` field). Default true. */
  emitCalibratedInertial = true;
  private _imuFamily: ImuFamily;
  private _deviceCalibrations: Partial<Record<InertialGroup, KinematicCalibration>> = {};

  /** Minimum valid GSR conductance in µS (below this, connectivity = "Disconnected"). */
  readonly LIMIT_MIN_VALID_USIEMENS = 0.03;

  // Callbacks
  onInquiry: ((info: Shimmer3InquiryResult) => void) | null = null;
  onExpPowerChanged: ((expPower: number) => void) | null = null;

  constructor(opts: Shimmer3ClientOptions = {}) {
    super(opts);
    this._injectedTransport = opts.transport ?? null;
    this._forceTimestampFmt = opts.timestampFmt;
    this._timestampFmt = opts.timestampFmt ?? SHIMMER3_DEFAULTS.TIMESTAMP_FMT;
    this._stopStreamingOnConnect = opts.stopStreamingOnConnect ?? true;
    this._imuFamily = opts.imuGeneration === 'new' ? 'shimmer3-new' : 'shimmer3-old';
    this.emitCalibratedInertial = opts.emitCalibratedInertial ?? true;
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[Shimmer3]', ...args);
  }

  /** Best-effort label for `ObjectCluster`s and status messages. */
  private _deviceLabel(): string {
    return this._transport?.deviceName ?? 'Shimmer3';
  }

  /** The streaming timestamp width currently in effect. */
  get timestampFmt(): TimestampFmt {
    return this._timestampFmt;
  }

  // ---------------------------------------------------------------------------
  // Connection management + handshake
  // ---------------------------------------------------------------------------

  /**
   * Open the RFCOMM connection and run the classic-Shimmer3 connect handshake.
   *
   * A transport is REQUIRED (constructor option or this parameter); classic
   * Bluetooth cannot run in a browser, so there is no default. Calling without
   * one throws.
   *
   * Handshake (ported from ShimmerBluetooth#initialize → readShimmerVersionNew →
   * readFWVersion):
   *   1. best-effort STOP_STREAMING (safety on reconnect; opt-out via options),
   *   2. dummy GET_SAMPLING_RATE write + drain to flush the RFCOMM buffer,
   *   3. GET_DEVICE_VERSION_COMMAND (0x3F) → DEVICE_VERSION_RESPONSE (HW version),
   *   4. GET_FW_VERSION_COMMAND (0x2E) → FW_VERSION_RESPONSE (firmware version),
   *   then the streaming timestamp width is derived from the firmware code.
   */
  override async connect(transport?: ShimmerTransport): Promise<void> {
    const t = transport ?? this._injectedTransport;
    if (!t) {
      throw new Error(
        'Shimmer3Client requires an injected transport: classic Bluetooth (RFCOMM/SPP) ' +
          'is not available in browsers. Pass a ShimmerTransport via the constructor ' +
          '({ transport }) or connect(transport).',
      );
    }
    this._transport = t;
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    this._emitStatus('Opening RFCOMM connection…');
    await t.connect();
    this._emitStatus(`Connected: ${this._deviceLabel()}`);

    await this._handshake();
  }

  private async _handshake(): Promise<void> {
    // 2) Flush the serial buffer with a dummy read (ShimmerBluetooth#dummyReadSamplingRate:
    //    "it actually acts to clear the write buffer"). A best-effort STOP first
    //    ensures a device left streaming from a previous session is quiesced.
    if (this._stopStreamingOnConnect) {
      try {
        await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
      } catch {
        /* ignore */
      }
    }
    this._rxBuf = new Uint8Array(0);
    this._emitStatus('Flushing RFCOMM buffer (dummy read)…');
    try {
      await this._write(new Uint8Array([OPCODES.GET_SAMPLING_RATE_COMMAND]));
    } catch {
      /* ignore */
    }
    await new Promise<void>((r) => setTimeout(r, SHIMMER3_DEFAULTS.DUMMY_READ_DRAIN_MS));
    this._rxBuf = new Uint8Array(0); // discard whatever the dummy read produced

    // 3) HW version. Responses may or may not be ACK-prefixed on classic firmware,
    //    so wait for the response opcode directly (any leading ACK is ignored).
    this._emitStatus('GET_DEVICE_VERSION → waiting for response…');
    await this._write(new Uint8Array([OPCODES.GET_DEVICE_VERSION_COMMAND]));
    const verBytes = await this._waitForResponse(
      OPCODES.DEVICE_VERSION_RESPONSE,
      SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
    );
    this.deviceVersion = parseShimmer3DeviceVersionResponse(verBytes);
    this._emitStatus(`HW version = ${this.deviceVersion.hardwareVersion}`);

    // 4) FW version.
    this._emitStatus('GET_FW_VERSION → waiting for response…');
    await this._write(new Uint8Array([OPCODES.GET_FW_VERSION_COMMAND]));
    const fwBytes = await this._waitForResponse(
      OPCODES.FW_VERSION_RESPONSE,
      SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
    );
    this.firmwareVersion = parseShimmer3FwVersionResponse(fwBytes);
    this._emitStatus(
      `FW version = ${this.firmwareVersion.major}.${this.firmwareVersion.minor}.${this.firmwareVersion.internal} (type ${this.firmwareVersion.firmwareIdentifier})`,
    );

    // Derive timestamp width from firmware unless the caller forced one.
    if (this._forceTimestampFmt === undefined) {
      this._timestampFmt = shimmer3UsesThreeByteTimestamp(this.firmwareVersion) ? 'u24' : 'u16';
    }
    this._emitStatus(`Handshake complete (timestamp = ${this._timestampFmt}).`);
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
      this.schema = null;
      this._streaming = false;
      this._streamStarting = false;
      this.ExpPower = 0;
      this._deviceCalibrations = {};
      this._emitStatus('Disconnected');
    }
  }

  private _handleTransportDisconnect = (): void => {
    this._streaming = false;
    this._streamStarting = false;
    this._emitStatus('Device disconnected');
  };

  // ---------------------------------------------------------------------------
  // Notify handler — accumulate + parse an UNFRAMED byte stream
  // ---------------------------------------------------------------------------

  private _handleNotify = (chunk: Uint8Array): void => {
    if (!chunk || chunk.length === 0) return;
    this._log('Notify len=', chunk.length, 'data=', chunk);
    this._rxBuf = concatU8(this._rxBuf, chunk);

    if (this._streaming) {
      this._parseStream();
    } else {
      this._drainControl();
    }
  };

  /**
   * Extract every complete control message currently buffered and dispatch each
   * to the temp handlers, then keep the incomplete tail for the next chunk. This
   * is what makes the unframed RFCOMM stream behave like framed BLE for the
   * ACK/response machinery below.
   */
  private _drainControl(): void {
    let buf = this._rxBuf;
    for (;;) {
      if (buf.length === 0) break;
      // While a stream is (about to be) live, DATA_PACKET (0x00) bytes belong to
      // the stream parser, not the control plane — leave them buffered.
      if ((this._streaming || this._streamStarting) && buf[0] === OPCODES.DATA_PACKET) break;

      const len = shimmer3ControlMessageLength(buf);
      if (len === NEED_MORE) break;
      if (len === RESYNC) {
        this._log(`resync: dropping unexpected control byte 0x${buf[0].toString(16)}`);
        buf = buf.subarray(1);
        continue;
      }
      if (buf.length < len) break; // full message not here yet
      this._emitTemp(new Uint8Array(buf.subarray(0, len)));
      buf = buf.subarray(len);
    }
    this._rxBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
  }

  // ---------------------------------------------------------------------------
  // Configuration commands
  // ---------------------------------------------------------------------------

  getEnabledSensors(): number {
    return this.enabledSensors;
  }

  getInternalExpPower(): number {
    return this.ExpPower;
  }

  /**
   * Enable sensors via a 24-bit bitmask (SET_SENSORS_COMMAND). Automatically
   * re-inquires after the ACK to rebuild the stream schema, matching
   * {@link Shimmer3RClient.setSensors}.
   */
  async setSensors(sensors: number): Promise<{ sensors: number; enabledSensors: number }> {
    if (!Number.isFinite(sensors)) throw new Error('sensors must be a finite number');
    if (!this._transport) throw new Error('Not connected');

    sensors = (sensors >>> 0) & 0xffffff;
    const cmd = new Uint8Array([
      OPCODES.SET_SENSORS_COMMAND,
      sensors & 0xff,
      (sensors >>> 8) & 0xff,
      (sensors >>> 16) & 0xff,
    ]);
    this._emitStatus(
      `SET_SENSORS → 0x${sensors.toString(16).toUpperCase().padStart(6, '0')} waiting for ACK…`,
    );
    await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
    this._emitStatus('Sensors ACKed; re-inquiring to refresh schema…');

    try {
      const info = await this.inquiry();
      this.enabledSensors = info.schema.enabledSensors;
    } catch (err: unknown) {
      this._emitStatus(`Inquiry after setSensors failed: ${(err as Error).message}`);
    }
    return { sensors, enabledSensors: this.enabledSensors };
  }

  /**
   * Set the sampling rate (SET_SAMPLING_RATE_COMMAND). The firmware takes a
   * 16-bit divisor `floor(32768 / rateHz)`; identical to Shimmer3R.
   */
  async setSamplingRate(
    rateHz: number,
  ): Promise<{ requestedHz: number; appliedHz: number; divisor: number }> {
    if (!Number.isFinite(rateHz) || rateHz <= 0) {
      throw new Error('Sampling rate must be a positive number (Hz)');
    }
    if (!this._transport) throw new Error('Not connected');

    let divisor = Math.floor(32768 / rateHz);
    divisor = Math.max(1, Math.min(0xffff, divisor));
    const cmd = new Uint8Array([
      OPCODES.SET_SAMPLING_RATE_COMMAND,
      divisor & 0xff,
      (divisor >> 8) & 0xff,
    ]);
    this._emitStatus(`SET_SAMPLING_RATE → ${rateHz} Hz (divisor=${divisor}) waiting for ACK…`);
    await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
    const appliedHz = 32768 / divisor;
    this.samplingRateHz = appliedHz;
    this._emitStatus(`Sampling rate ACKed. Applied ≈ ${appliedHz.toFixed(3)} Hz`);
    return { requestedHz: rateHz, appliedHz, divisor };
  }

  /**
   * Set the GSR measurement range (SET_GSR_RANGE_COMMAND).
   * @param gsrRange 0 = 8–63 kΩ, 1 = 63–220 kΩ, 2 = 220–680 kΩ, 3 = 680–4700 kΩ, 4 = Auto.
   */
  async setGSRRange(gsrRange: number): Promise<{ gsrRange: number }> {
    if (!Number.isInteger(gsrRange) || gsrRange < 0 || gsrRange > 4) {
      throw new Error('gsrRange must be 0–4');
    }
    if (!this._transport) throw new Error('Not connected');

    const cmd = new Uint8Array([OPCODES.SET_GSR_RANGE_COMMAND, gsrRange & 0xff]);
    this._emitStatus('SET_GSR_RANGE → waiting for ACK…');
    await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
    this.gsrRangeSetting = gsrRange;
    this._emitStatus('SET_GSR_RANGE (ACK received).');
    return { gsrRange };
  }

  /**
   * Control the internal expansion power rail (required for ExG/EMG/ECG).
   * @param expPower 0 = disable, 1 = enable.
   */
  async setInternalExpPower(expPower: 0 | 1): Promise<{ expPower: number }> {
    if (expPower !== 0 && expPower !== 1) throw new Error('expPower must be 0 or 1');
    if (!this._transport) throw new Error('Not connected');

    const cmd = new Uint8Array([OPCODES.SET_INTERNAL_EXP_POWER_ENABLE_COMMAND, expPower]);
    this._emitStatus(`SET_INTERNAL_EXP_POWER → ${expPower ? 'ON' : 'OFF'} waiting for ACK…`);
    await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
    this.ExpPower = expPower;
    try {
      this.onExpPowerChanged?.(expPower);
    } catch (e) {
      this._log('onExpPowerChanged handler error', e);
    }
    return { expPower };
  }

  // ---------------------------------------------------------------------------
  // Inquiry
  // ---------------------------------------------------------------------------

  /**
   * Send INQUIRY_COMMAND and parse the (Shimmer3-layout) response, building the
   * stream schema. Tolerant of an optional leading ACK before the response.
   */
  async inquiry(): Promise<Shimmer3InquiryResult> {
    if (!this._transport) throw new Error('Not connected');
    this._emitStatus('INQUIRY → waiting for response…');
    await this._write(new Uint8Array([OPCODES.INQUIRY_COMMAND]));
    const rsp = await this._waitForResponse(
      OPCODES.INQUIRY_RESPONSE,
      SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
    );
    const info = interpretShimmer3InquiryResponse(rsp, this._timestampFmt);
    this.schema = info.schema;
    this.samplingRateHz = info.samplingRateHz;
    this.enabledSensors = info.schema.enabledSensors;
    this.gsrRangeSetting = info.gsrRange;
    this.ExpPower = info.internalExpPower;
    // Inertial ranges from the config word (interpretShimmer3InquiryResponse):
    // accelRange = WR accel (LSM303), gyroRange = MPU gyro, magRange = LSM303 mag.
    // LN accel (Kionix) is fixed-range → 0.
    this.imuRanges = {
      lnAccel: 0,
      wrAccel: info.accelRange,
      gyro: info.gyroRange,
      mag: info.magRange,
      altAccel: 0,
      altMag: 0,
    };
    this._emitStatus(
      `Inquiry: ${info.numChannels} ch, ${info.samplingRateHz.toFixed(2)} Hz, ` +
        `sensors=0x${info.schema.enabledSensors.toString(16).toUpperCase()}`,
    );
    try {
      this.onInquiry?.(info);
    } catch (e) {
      this._log('onInquiry handler error', e);
    }
    return info;
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  override async startStreaming(): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    if (!this.schema) this._emitStatus('Starting stream without schema (not recommended).');
    this._streamStarting = true;
    this._lastTs = 0;
    this._emitStatus('START_STREAMING → waiting for ACK…');
    try {
      await this._writeExpectingAck(
        new Uint8Array([OPCODES.START_STREAMING_COMMAND]),
        SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS,
      );
    } catch (e) {
      this._streamStarting = false;
      throw e;
    }
    this._streaming = true;
    this._streamStarting = false;
    // Bytes that arrived after the ACK are the first data — parse them now.
    this._parseStream();
    this._emitStatus('START_STREAMING ACK received; frames should follow.');
  }

  override async stopStreaming(): Promise<void> {
    this._emitStatus('STOP_STREAMING → sending (best-effort, no ACK wait)…');
    try {
      await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
    } catch (err: unknown) {
      this._emitStatus(`STOP_STREAMING write failed: ${(err as Error).message}`);
    }
    this._streaming = false;
    this._streamStarting = false;
    this._rxBuf = new Uint8Array(0);
    this._emitStatus('Streaming stopped.');
  }

  // ---------------------------------------------------------------------------
  // Stream frame parser (schema-driven; double-preamble resync)
  // ---------------------------------------------------------------------------
  //
  // Minimal v1 parser — the streaming data path is a later phase, but building a
  // working parser here proves the schema and keeps streaming from being
  // precluded. The frame layout (0x00 preamble + timestamp + channels) is
  // identical to Shimmer3R (ShimmerObject#interpretDataPacketFormat), so this
  // follows the same double-preamble sync as Shimmer3RClient.

  private _parseStream(): void {
    if (!this.schema) return;
    const sch = this.schema;
    const preamble = sch.dataPreambleByte;
    const frameBytes = sch.frameBytes >>> 0;
    const tsBytes = sch.timestampFmt === 'u16' ? 2 : 3;

    let buf = this._rxBuf;
    while (buf.length >= frameBytes * 2) {
      if (buf[0] === preamble && buf[frameBytes] === preamble) {
        try {
          const frame = buf.subarray(0, frameBytes);
          let cursor = 1;
          const oc = new ObjectCluster(this._deviceLabel());
          const ts = tsBytes === 2 ? u16le(frame, cursor) : u24le(frame, cursor);
          cursor += tsBytes;
          oc.add('TIMESTAMP', ts, 'ticks', 'raw');

          for (const f of sch.fields) {
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
                const raw12 = ((frame[cursor] & 0xff) << 4) | ((frame[cursor + 1] & 0xff) >> 4);
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

          this._lastTs = ts;
          this._calibrateData(oc);
          this.onStreamFrame?.(oc);
          buf = buf.subarray(frameBytes);
        } catch (e) {
          this._log('frame decode error → sliding 1 byte', (e as Error).message);
          buf = buf.subarray(1);
        }
        continue;
      }
      buf = buf.subarray(1); // resync
    }
    this._rxBuf = buf.length ? new Uint8Array(buf) : new Uint8Array(0);
  }

  /** Inline GSR calibration, matching Shimmer3RClient. */
  private _calibrateData(oc: ObjectCluster): void {
    for (const field of [...oc.fields]) {
      if (field.name !== GSR_NAME) continue;
      const gsrraw = oc.get(GSR_NAME, 'raw')?.value ?? null;
      if (gsrraw === null) continue;
      let adc12 = gsrraw & 0x0fff;
      let currentRange = this.gsrRangeSetting;
      if (currentRange === 4) currentRange = (gsrraw >> 14) & 0x03;
      if (currentRange === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3) adc12 = GSR_UNCAL_LIMIT_RANGE3;
      let gsrkOhm = calibrateGsrDataToResistanceFromAmplifierEq(adc12, currentRange);
      gsrkOhm = nudgeGsrResistance(gsrkOhm, this.gsrRangeSetting);
      oc.add(GSR_NAME, (1.0 / gsrkOhm) * 1000, 'uSiemens', 'cal');
    }

    // Inertial calibration (LN/WR accel, gyro, mag): device calibration from
    // readCalibration() when available, else the range-selected default.
    if (this.emitCalibratedInertial) {
      applyStreamingCalibration(oc, {
        family: this._imuFamily,
        ranges: this.imuRanges,
        device: this._deviceCalibrations,
      });
    }
  }

  /**
   * Fetch the device's per-sensor kinematic calibration over RFCOMM and upgrade
   * the active streaming calibration (overriding the range-selected defaults).
   * Opt-in and non-fatal: a group that times out or NACKs keeps its default.
   *
   * Uses the per-sensor GET calibration commands (each answers with
   * `[responseOpcode][21-byte block]`), chosen over the 0x9A GET_CALIB_DUMP
   * because the per-sensor path is unambiguous in the Java oracle.
   *
   * HARDWARE-VERIFY: no real Shimmer3 radio has exercised this path.
   *
   * @returns the groups whose calibration was successfully read.
   */
  async readCalibration(
    timeoutMs = SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<InertialGroup[]> {
    if (!this._transport) throw new Error('Not connected');
    const plan: Array<{ group: InertialGroup; get: number; resp: number }> = [
      {
        group: 'lnAccel',
        get: OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND,
        resp: OPCODES.LN_ACCEL_CALIBRATION_RESPONSE,
      },
      {
        group: 'gyro',
        get: OPCODES.GET_GYRO_CALIBRATION_COMMAND,
        resp: OPCODES.GYRO_CALIBRATION_RESPONSE,
      },
      {
        group: 'mag',
        get: OPCODES.GET_MAG_CALIBRATION_COMMAND,
        resp: OPCODES.MAG_CALIBRATION_RESPONSE,
      },
      {
        group: 'wrAccel',
        get: OPCODES.GET_WR_ACCEL_CALIBRATION_COMMAND,
        resp: OPCODES.WR_ACCEL_CALIBRATION_RESPONSE,
      },
    ];
    const done: InertialGroup[] = [];
    for (const { group, get, resp } of plan) {
      try {
        await this._write(new Uint8Array([get]));
        const rsp = await this._waitForResponse(resp, timeoutMs);
        if (rsp.length < 22) continue; // opcode + 21-byte block
        const scale = getGroupDefaults(this._imuFamily, group)?.sensitivityScale ?? 1;
        const cal = parseKinematicCalibBlock(rsp.subarray(1, 22), { sensitivityScale: scale });
        if (cal) {
          this._deviceCalibrations[group] = cal;
          done.push(group);
        }
      } catch (err: unknown) {
        this._emitStatus(`readCalibration(${group}) skipped: ${(err as Error).message}`);
      }
    }
    return done;
  }

  // ---------------------------------------------------------------------------
  // Low-level transport + ACK/response helpers
  // ---------------------------------------------------------------------------

  private async _write(u8: Uint8Array): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    this._log('Write', u8);
    await this._transport.write(u8);
  }

  private async _writeExpectingAck(u8: Uint8Array, ackTimeoutMs: number): Promise<void> {
    await this._write(u8);
    await this._waitForAck(ackTimeoutMs);
  }

  /** Resolve on the next ACK control message; reject on NACK or timeout. */
  private _waitForAck(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error('ACK timeout'));
      }, timeoutMs);
      const handler = (msg: Uint8Array): void => {
        if (msg.length === 0) return;
        if (msg[0] === ACK) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve();
        } else if (msg[0] === NACK) {
          clearTimeout(t);
          this._offTemp(handler);
          reject(new Error('NACK received'));
        }
      };
      this._onTemp(handler);
    });
  }

  /**
   * Resolve on the next control message whose opcode matches `expectedOpcode`.
   * Leading ACKs are ignored (classic firmware may or may not ACK-prefix a
   * response); a NACK rejects.
   */
  private _waitForResponse(expectedOpcode: number, timeoutMs: number): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error(`Response timeout (opcode 0x${expectedOpcode.toString(16)})`));
      }, timeoutMs);
      const handler = (msg: Uint8Array): void => {
        if (msg.length === 0) return;
        if (msg[0] === ACK) return; // tolerate optional ACK prefix
        if (msg[0] === NACK) {
          clearTimeout(t);
          this._offTemp(handler);
          reject(new Error('NACK received'));
          return;
        }
        if (msg[0] === expectedOpcode) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(msg);
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
