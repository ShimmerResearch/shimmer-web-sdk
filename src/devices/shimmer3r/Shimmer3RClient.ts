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
import { WebBluetoothTransport } from '../../core/transport/WebBluetoothTransport.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import {
  EXG_BANK_LENGTH,
  EXG_CHIP1,
  EXG_CHIP2,
  EXG_REGS_RESPONSE,
  buildGetExgRegsCommand,
  buildSetExgRegsCommand,
  decodeExgRegsResponse,
  exgBanksEqualIgnoringStatus,
  applyExgPreset,
  type ExgChipIndex,
  type ApplicableExgPreset,
  type ExgResolution,
} from '../exg/index.js';
import {
  applyStreamingCalibration,
  parseKinematicCalibBlock,
  getGroupDefaults,
  type StreamingImuRanges,
  type InertialGroup,
  type KinematicCalibration,
} from '../calibration/index.js';

// HW_ID for Shimmer3R (ShimmerVerDetails.HW_ID). Drives the EXG joined-clock bit
// in applyExgPreset — the 3R always joins the two ADS1292R chip clocks.
const HW_ID_SHIMMER_3R = 10;

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
  /**
   * Inject a transport (byte pipe) instead of the default Web Bluetooth one. Lets
   * non-browser runtimes (React Native, Bluetooth Classic) or tests drive the
   * client. When omitted, `connect()` builds a {@link WebBluetoothTransport} over
   * the configured service/characteristic UUIDs, so browser usage is unchanged.
   */
  transport?: ShimmerTransport;
  /**
   * Emit calibrated (`'cal'`) inertial channel values alongside the raw ones.
   * Default true. Set false to keep the pre-calibration behaviour (raw only).
   */
  emitCalibratedInertial?: boolean;
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
  // BLE UUIDs (used to build the default Web Bluetooth transport)
  private serviceUUID: string;
  private rxUUID: string;
  private txUUID: string;

  /**
   * The selected `BluetoothDevice` when connected over the default Web Bluetooth
   * transport; `null` for injected transports (React Native / loopback).
   */
  device: BluetoothDevice | null = null;

  // Transport (byte pipe). Injected via options/connect, or a WebBluetoothTransport by default.
  private _injectedTransport: ShimmerTransport | null = null;
  private _transport: ShimmerTransport | null = null;
  private _notifyUnsub: Unsubscribe | null = null;
  private _disconnectUnsub: Unsubscribe | null = null;

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

  /**
   * Inertial-sensor hardware ranges, refreshed from each inquiry's config word.
   * Used to select the default calibration for streaming inertial channels.
   */
  imuRanges: StreamingImuRanges = {
    lnAccel: 0,
    wrAccel: 0,
    gyro: 0,
    mag: 0,
    altAccel: 0,
    altMag: 0,
  };
  /** When false, inertial channels are emitted raw-only (no `'cal'` field). Default true. */
  emitCalibratedInertial = true;
  /**
   * Device calibrations fetched via {@link readCalibration}. These override the
   * range-selected defaults (calibration source-priority ladder).
   */
  private _deviceCalibrations: Partial<Record<InertialGroup, KinematicCalibration>> = {};

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
    this._injectedTransport = opts.transport ?? null;
    this.emitCalibratedInertial = opts.emitCalibratedInertial ?? true;
  }

  /** Best-effort label for `ObjectCluster`s and status messages. */
  private _deviceLabel(): string {
    return this.device?.name ?? this._transport?.deviceName ?? 'Shimmer3R';
  }

  /** Build the default Web Bluetooth transport over the configured UUIDs. */
  private _makeWebTransport(): WebBluetoothTransport {
    return new WebBluetoothTransport({
      serviceUUID: this.serviceUUID,
      // Shimmer3R: the RX characteristic is the host→device write pipe; TX is the
      // device→host notify pipe. Writes are acknowledged (write-with-response),
      // matching the previous `rx.writeValue(...)` behaviour.
      writeCharUUID: this.rxUUID,
      notifyCharUUID: this.txUUID,
      requestDeviceOptions: {
        filters: [{ services: [this.serviceUUID] }],
        optionalServices: [this.serviceUUID],
      },
      defaultWriteWithResponse: true,
      debug: this.debug,
      logTag: '[Shimmer3R:ble]',
    });
  }

  protected override _log(...args: unknown[]): void {
    if (this.debug) console.log('[Shimmer3R]', ...args);
  }

  // ---------------------------------------------------------------------------
  // Connection management
  // ---------------------------------------------------------------------------

  /**
   * Open a connection. In a browser this triggers the Web Bluetooth device
   * picker (unchanged behaviour). Pass a {@link ShimmerTransport} to drive the
   * client over a different pipe (React Native, Bluetooth Classic, tests); it
   * takes precedence over any transport supplied to the constructor.
   */
  override async connect(transport?: ShimmerTransport): Promise<void> {
    const t = transport ?? this._injectedTransport ?? this._makeWebTransport();
    this._transport = t;
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    this._emitStatus('Requesting Bluetooth device…');
    await t.connect();
    if (t instanceof WebBluetoothTransport) this.device = t.device;
    this._emitStatus(`Selected: ${this._deviceLabel()}`);
    this._emitStatus('GATT connected');
    this._emitStatus('RX/TX obtained');
    this._emitStatus('Notifications started');
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
      this.device = null;
      this._rxBuf = new Uint8Array(0);
      this.schema = null;
      this._streaming = false;
      this.ExpPower = 0;
      this._deviceCalibrations = {};
      this._emitStatus('Disconnected');
    }
  }

  /** Handle an unexpected / requested transport disconnect. */
  private _handleTransportDisconnect = (): void => {
    this._streaming = false;
    this._emitStatus('Device disconnected');
  };

  // ---------------------------------------------------------------------------
  // Notify handler (fed raw notification chunks by the transport)
  // ---------------------------------------------------------------------------

  private _handleNotify = (chunk: Uint8Array): void => {
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
    if (!this._transport) throw new Error('Not connected (RX missing)');

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
    if (!this._transport) throw new Error('Not connected (RX missing)');

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
    if (!this._transport) throw new Error('Not connected (RX missing)');

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
    if (!this._transport) throw new Error('Not connected (RX missing)');

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
  // ExG (ADS1292R) live configuration — GET / SET / preset apply
  //
  // Codec-driven port of the Java EXG BT command flow
  // (ShimmerBluetooth.readEXGConfigurations / writeEXGConfiguration, :4010-4227),
  // replacing the previous hardcoded 16-bit-only preset byte arrays. The
  // register banks now come from the shared EX1/EX2 codec (`../exg/`), and the
  // live GET/SET framing from `../exg/live.ts`.
  // ---------------------------------------------------------------------------

  /**
   * Read both EXG chips' 10-byte register banks over the radio
   * (GET_EXG_REGS ×2 → EXG_REGS_RESPONSE decode). Ported from
   * ShimmerBluetooth.readEXGConfigurations, which issues one GET for CHIP1 then
   * CHIP2 (ShimmerBluetooth.java:4010-4014).
   *
   * @throws Error when not connected or while streaming (the read-back needs the
   *   control plane, which is owned by the data plane during streaming).
   */
  async readExgConfig(timeoutMs = 1500): Promise<{ exg1: Uint8Array; exg2: Uint8Array }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) throw new Error('Cannot read EXG registers while streaming');
    const exg1 = await this._readExgChip(EXG_CHIP1, timeoutMs);
    const exg2 = await this._readExgChip(EXG_CHIP2, timeoutMs);
    return { exg1, exg2 };
  }

  private async _readExgChip(chip: ExgChipIndex, timeoutMs: number): Promise<Uint8Array> {
    // GET is ACK-then-response like INQUIRY; the response can be piggybacked in
    // the same notification as the ACK (Shimmer3R firmware coalesces them), so
    // reuse the ACK-remainder path exactly as inquiry() does.
    const remainder = await this._writeExpectingAck(buildGetExgRegsCommand(chip), timeoutMs);
    const frame =
      remainder && remainder[0] === EXG_REGS_RESPONSE
        ? remainder
        : await this._waitForResponse(EXG_REGS_RESPONSE, timeoutMs);
    return decodeExgRegsResponse(frame);
  }

  /**
   * Write both EXG chips' 10-byte register banks over the radio
   * (SET_EXG_REGS ×2), then read them back and verify.
   *
   * Ports ShimmerBluetooth.writeEXGConfiguration (:4200-4227) — per-chip, one
   * 14-byte instruction each — with the Shimmer3R-specific oversampling-ratio
   * injection into REG1 (bank byte 0): the ADS1292R data-rate/oversampling field
   * is derived from the live sampling rate via `getOversamplingRatioADS1292R`
   * (calibration.ts:89, the 3R BT path — distinct from the docked InfoMem
   * `exgRateSettingFromFreq`), matching the previous `_writeExgPages` behaviour.
   *
   * WRITE-SAFETY DEVIATION FROM JAVA: the Java driver applies SET_EXG_REGS
   * immediately on the device and does NOT verify — it relies on a
   * timeout→disconnect failsafe if the write silently fails
   * (ShimmerBluetooth.java:4028-4034 doc comment; the register array is stored
   * driver-side only after the plain ACK, :2132). We port the safer flow: SET →
   * await ACK → GET read-back → compare (ignoring the read-only REG8 status
   * byte) → throw on mismatch, so a bad/no-op write surfaces as an error here
   * rather than as a later disconnect.
   *
   * @throws Error when not connected, while streaming, or when read-back mismatches.
   * @throws RangeError when either bank is not exactly 10 bytes.
   */
  async writeExgConfig(exg1: Uint8Array, exg2: Uint8Array): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) throw new Error('Cannot write EXG registers while streaming');
    if (exg1.length !== EXG_BANK_LENGTH || exg2.length !== EXG_BANK_LENGTH) {
      throw new RangeError(
        `EXG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ${exg1.length}/${exg2.length}.`,
      );
    }

    const b1 = this._injectOversamplingRatio(exg1);
    const b2 = this._injectOversamplingRatio(exg2);

    await this._writeExpectingAck(buildSetExgRegsCommand(EXG_CHIP1, b1), 1500);
    await this._writeExpectingAck(buildSetExgRegsCommand(EXG_CHIP2, b2), 1500);

    // Read-back-verify (see write-safety note above).
    const readBack = await this.readExgConfig();
    if (
      !exgBanksEqualIgnoringStatus(b1, readBack.exg1) ||
      !exgBanksEqualIgnoringStatus(b2, readBack.exg2)
    ) {
      throw new Error(
        'EXG write read-back mismatch: device registers do not match what was written',
      );
    }
    this._emitStatus('EXG registers written and verified.');
  }

  /**
   * 3R-specific: overwrite the REG1 (bank byte 0) low 3 bits with the ADS1292R
   * oversampling ratio for the current sampling rate. Reproduces the previous
   * `_writeExgPages` step `exg[4] = ((exg[4]>>3)<<3) | ratio` — byte 4 of the old
   * 14-byte instruction was register byte 0. Classic Shimmer3 does NOT do this
   * (ShimmerBluetooth.writeEXGConfiguration writes the bank verbatim).
   */
  private _injectOversamplingRatio(bank: Uint8Array): Uint8Array {
    const ratio = getOversamplingRatioADS1292R(this.samplingRateHz);
    const out = new Uint8Array(bank);
    out[0] = (((out[0] >> 3) << 3) | ratio) & 0xff;
    return out;
  }

  /**
   * Apply an EXG preset live: build the register banks + sensor bitmap from the
   * client's current inquiry state (sampling rate, enabled sensors, hardware
   * version) via EX2's `applyExgPreset`, write the registers, then update the
   * enabled-sensors bitmap.
   *
   * ORDER (ShimmerBluetooth): EXG registers are written first and the enabled
   * sensors LAST — the desktop write flow marks `writeEnabledSensors(...)` with
   * "this should always be the last command" (ShimmerBluetooth.java:2732,2735),
   * and `writeEXGConfiguration()` runs earlier in the same flow (:2670).
   * `setSensors` re-inquires, so the schema/enabledSensors reflect the new preset.
   */
  async applyExgPresetLive(preset: ApplicableExgPreset, resolution: ExgResolution): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) throw new Error('Cannot configure EXG while streaming');

    // Seed the apply from the device's current banks so the oscillator-clock
    // preserve path (classic rev>=4) is honoured; on 3R the banks are fully
    // determined by the preset regardless.
    const current = await this.readExgConfig();
    const result = applyExgPreset(
      {
        exg1: current.exg1,
        exg2: current.exg2,
        enabledSensors: this.enabledSensors,
        samplingRateHz: this.samplingRateHz,
        hardwareVersion: HW_ID_SHIMMER_3R,
      },
      preset,
      resolution,
    );

    await this.writeExgConfig(result.exg1, result.exg2);
    // Enabled sensors last (re-inquires to refresh the schema).
    await this.setSensors(result.enabledSensors);
    this._emitStatus(`EXG preset '${preset}' (${resolution}) applied. Schema updated.`);
  }

  /** Enable EMG (ADS1292R) in 16-bit mode on EXG1 & EXG2. */
  async enableEMG16Bit(): Promise<void> {
    await this.applyExgPresetLive('emg', '16bit');
  }

  /** Enable EXG test signal in 16-bit mode (useful for verifying ExG hardware). */
  async enableEXGTestSignal16Bit(): Promise<void> {
    await this.applyExgPresetLive('test-signal', '16bit');
  }

  /** Enable ECG in 16-bit mode on EXG1 & EXG2. */
  async enableECG16Bit(): Promise<void> {
    await this.applyExgPresetLive('ecg', '16bit');
  }

  // ---------------------------------------------------------------------------
  // Calibration fetch (opt-in)
  // ---------------------------------------------------------------------------

  /**
   * Fetch the device's per-sensor kinematic calibration over the radio and
   * upgrade the active streaming calibration to use it (overriding the
   * range-selected defaults). Opt-in and non-fatal: any group that times out or
   * NACKs is skipped and keeps its default.
   *
   * Uses the per-sensor GET calibration commands, each of which answers with
   * `[responseOpcode][21-byte kinematic block]`
   * (ShimmerBluetooth: ACCEL/GYRO/MAG/LSM303DLHC_ACCEL_CALIBRATION_RESPONSE are
   * all 21-byte payloads). Chosen over the 0x9A GET_CALIB_DUMP because the
   * per-sensor commands + 21-byte responses are unambiguous in the Java oracle,
   * whereas the chunked dump read sequence is not verifiable for this transport.
   *
   * HARDWARE-VERIFY: no real Shimmer3R radio has exercised this path; the
   * command/response opcodes and 21-byte block layout are ported from the Java
   * driver but not confirmed end-to-end against hardware.
   *
   * @returns the set of groups whose calibration was successfully read.
   */
  async readCalibration(timeoutMs = 1500): Promise<InertialGroup[]> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
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
      {
        group: 'altAccel',
        get: OPCODES.GET_ALT_ACCEL_CALIBRATION_COMMAND,
        resp: OPCODES.ALT_ACCEL_CALIBRATION_RESPONSE,
      },
      {
        group: 'altMag',
        get: OPCODES.GET_ALT_MAG_CALIBRATION_COMMAND,
        resp: OPCODES.ALT_MAG_CALIBRATION_RESPONSE,
      },
    ];
    const done: InertialGroup[] = [];
    for (const { group, get, resp } of plan) {
      try {
        const cal = await this._readOneCalibration(group, get, resp, timeoutMs);
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

  private async _readOneCalibration(
    group: InertialGroup,
    getOpcode: number,
    respOpcode: number,
    timeoutMs: number,
  ): Promise<KinematicCalibration | null> {
    const remainder = await this._writeExpectingAck(new Uint8Array([getOpcode]), timeoutMs);
    const rsp =
      remainder && remainder[0] === respOpcode
        ? remainder
        : await this._waitForResponse(respOpcode, timeoutMs);
    if (rsp.length < 22) return null; // opcode + 21-byte block
    const block = rsp.subarray(1, 22);
    const scale = getGroupDefaults('shimmer3r', group)?.sensitivityScale ?? 1;
    return parseKinematicCalibBlock(block, { sensitivityScale: scale });
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

    // Inertial ranges from the config setup bytes (ConfigByteLayoutShimmer3):
    //   WR accel (LIS2DW12): setup0 bits 2-3  → cfg bits 2-3
    //   gyro (LSM6DSV): LSB setup2 bits 0-1 (cfg bits 16-17) + MSB setup4 bit 2
    //     (cfg bit 34) → 6 ranges (0-5)
    //   LN accel (LSM6DSV): setup3 bits 6-7 → cfg bits 30-31
    // mag/alt-accel/alt-mag are single-range or not carried here → 0.
    const gyroLsb = Number((cfg >> 16n) & 0x3n);
    const gyroMsb = Number((cfg >> 34n) & 0x1n);
    this.imuRanges = {
      lnAccel: Number((cfg >> 30n) & 0x3n),
      wrAccel: Number((cfg >> 2n) & 0x3n),
      gyro: gyroLsb | (gyroMsb << 2),
      mag: 0,
      altAccel: 0,
      altMag: 0,
    };

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

    // Inertial calibration (accel/gyro/mag/alt): device calibration from
    // readCalibration() when available, else the range-selected default.
    if (this.emitCalibratedInertial) {
      applyStreamingCalibration(oc, {
        family: 'shimmer3r',
        ranges: this.imuRanges,
        device: this._deviceCalibrations,
      });
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
          const oc = new ObjectCluster(this._deviceLabel());

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
    if (!this._transport) throw new Error('Not connected (RX missing)');
    this._log('Write', u8);
    await this._transport.write(u8);
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
