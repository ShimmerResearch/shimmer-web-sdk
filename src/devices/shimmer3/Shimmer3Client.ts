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
  shimmer3SupportsExg,
  deriveShimmer3FirmwareVersionCode,
  type Shimmer3InquiryResult,
  type Shimmer3StreamSchema,
  type Shimmer3DeviceVersion,
  type Shimmer3FwVersion,
} from './protocol.js';
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
  clearExgResolutionFlags,
  type ExgChipIndex,
  type ApplicableExgPreset,
  type ExgResolution,
} from '../exg/index.js';

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
  /** Bumped once per inbound transport chunk — used for quiescence detection. */
  private _rxSeq = 0;
  /** While true, {@link _handleNotify} only accumulates; a drain loop owns `_rxBuf`. */
  private _drainingResidual = false;
  /** Number of {@link _waitForResponse} calls currently awaiting an INQUIRY_RESPONSE. */
  private _awaitInq = 0;
  /**
   * Number of command handlers ({@link _waitForAck} / {@link _waitForResponse})
   * currently awaiting a response. Gates NACK framing in {@link _drainControl}
   * so a stray 0xFE arriving with no command in flight cannot fabricate a NACK.
   */
  private _awaitCmd = 0;

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
    this._rxSeq += 1; // for quiescence detection
    this._rxBuf = concatU8(this._rxBuf, chunk);

    // While a residual-drain is in progress the drain loop owns the buffer:
    // just accumulate, so stale stream bytes never reach the control parser.
    if (this._drainingResidual) return;

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

      // Only frame 0x02 as an INQUIRY_RESPONSE when an inquiry is actually
      // awaited; an unexpected 0x02 is a stray/stream byte and framing it would
      // swallow real control bytes. Drop it instead.
      if (buf[0] === OPCODES.INQUIRY_RESPONSE && this._awaitInq <= 0) {
        this._log('drainControl: dropping 0x02 — no INQUIRY awaited');
        buf = buf.subarray(1);
        continue;
      }

      // Same guard for NACK (0xFE): only frame it as a control message while a
      // command is genuinely awaiting a response (_awaitCmd > 0). A stray 0xFE —
      // e.g. a late residual byte arriving after the stop-drain returned early —
      // is dropped instead of framed. This diverges from the Java driver
      // (ShimmerObject processes every 0xFE unconditionally) but strictly reduces
      // the risk of a leaked stream byte being mistaken for a NACK, mirroring the
      // 0x02 gate above. Defence-in-depth: today _onTemp handlers are added only
      // while _awaitCmd > 0, so an ungated stray 0xFE would emit to no listener;
      // this guard keeps that invariant explicit and survives refactors that add
      // a longer-lived control listener.
      if (buf[0] === NACK && this._awaitCmd <= 0) {
        this._log('drainControl: dropping 0xFE — no command awaited');
        buf = buf.subarray(1);
        continue;
      }

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
  // ExG (ADS1292R) live configuration — GET / SET / preset apply
  //
  // Same LiteProtocol EXG command flow as Shimmer3R, ported from
  // ShimmerBluetooth.readEXGConfigurations / writeEXGConfiguration (:4010-4227).
  // Classic Shimmer3 differs from the 3R in one respect: it writes the register
  // banks VERBATIM — there is NO oversampling-ratio injection into REG1 (that is
  // a Shimmer3R-only step; ShimmerBluetooth.writeEXGConfiguration writes reg[0]
  // unchanged, :4220).
  // ---------------------------------------------------------------------------

  /**
   * Assert this device's firmware supports the live EXG GET/SET commands, failing
   * fast rather than letting an EXG command hang to timeout on EXG-incapable
   * firmware. Ports the Java gate `(getFirmwareVersionInternal() >= 8 &&
   * getFirmwareVersionCode() == 2) || getFirmwareVersionCode() > 2`
   * (ShimmerBluetooth.java:4011,4022,4201,4219) via {@link shimmer3SupportsExg},
   * which derives the firmware-version code from the parsed FW version + hardware
   * id exactly as ShimmerVerObject does (ShimmerVerObject.java:266-311). Old
   * BtStream (code 1, or code 2 below internal 8) is rejected up front.
   *
   * @throws Error when not connected, before the connect handshake completes, or
   *   on firmware without the EXG command set.
   */
  private _assertExgSupported(): void {
    if (!this._transport) throw new Error('Not connected');
    if (this.firmwareVersion == null || this.deviceVersion == null) {
      throw new Error('EXG requires a completed connect handshake (firmware version unknown)');
    }
    if (!shimmer3SupportsExg(this.firmwareVersion, this.deviceVersion.hardwareVersion)) {
      const { major, minor, internal } = this.firmwareVersion;
      const code = deriveShimmer3FirmwareVersionCode(
        this.firmwareVersion,
        this.deviceVersion.hardwareVersion,
      );
      throw new Error(
        `EXG register commands are not supported by this firmware ` +
          `(v${major}.${minor}.${internal}, firmware code ${code}); ` +
          `EXG requires LogAndStream (any), BtStream >= 0.2.8, or firmware code >= 3.`,
      );
    }
  }

  /**
   * Read both EXG chips' 10-byte register banks (GET_EXG_REGS ×2 →
   * EXG_REGS_RESPONSE decode). Ported from ShimmerBluetooth.readEXGConfigurations
   * (:4010-4014): CHIP1 then CHIP2.
   *
   * @throws Error when unsupported/not connected or while streaming.
   */
  async readExgConfig(
    timeoutMs = SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<{ exg1: Uint8Array; exg2: Uint8Array }> {
    this._assertExgSupported();
    if (this._streaming) throw new Error('Cannot read EXG registers while streaming');
    const exg1 = await this._readExgChip(EXG_CHIP1, timeoutMs);
    const exg2 = await this._readExgChip(EXG_CHIP2, timeoutMs);
    return { exg1, exg2 };
  }

  private async _readExgChip(chip: ExgChipIndex, timeoutMs: number): Promise<Uint8Array> {
    // GET is ACK-then-response; _waitForResponse tolerates the optional leading
    // ACK (like inquiry()), so register it directly rather than awaiting the ACK
    // separately — avoids a race if the device coalesces ACK + response.
    await this._write(buildGetExgRegsCommand(chip));
    const frame = await this._waitForResponse(EXG_REGS_RESPONSE, timeoutMs);
    return decodeExgRegsResponse(frame);
  }

  /**
   * Write both EXG chips' 10-byte register banks (SET_EXG_REGS ×2), then read
   * back and verify. Classic Shimmer3 writes the banks verbatim (no oversampling
   * injection — that is Shimmer3R-only).
   *
   * WRITE-SAFETY DEVIATION FROM JAVA: Java applies SET_EXG_REGS immediately and
   * does not verify, relying on a timeout→disconnect failsafe
   * (ShimmerBluetooth.java:4028-4034 doc comment). We port the safer flow: SET →
   * await ACK → GET read-back → compare (ignoring the read-only REG8 status byte)
   * → throw on mismatch.
   *
   * @throws Error when unsupported/not connected, while streaming, or on mismatch.
   * @throws RangeError when either bank is not exactly 10 bytes.
   */
  async writeExgConfig(exg1: Uint8Array, exg2: Uint8Array): Promise<void> {
    this._assertExgSupported();
    if (this._streaming) throw new Error('Cannot write EXG registers while streaming');
    if (exg1.length !== EXG_BANK_LENGTH || exg2.length !== EXG_BANK_LENGTH) {
      throw new RangeError(
        `EXG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ${exg1.length}/${exg2.length}.`,
      );
    }

    const b1 = new Uint8Array(exg1);
    const b2 = new Uint8Array(exg2);
    await this._writeExpectingAck(
      buildSetExgRegsCommand(EXG_CHIP1, b1),
      SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS,
    );
    await this._writeExpectingAck(
      buildSetExgRegsCommand(EXG_CHIP2, b2),
      SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS,
    );

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
   * Apply an EXG preset live: build the banks + sensor bitmap from the current
   * inquiry state via EX2's `applyExgPreset`, write the registers, then set the
   * enabled sensors LAST (ShimmerBluetooth.java:2732,2735 — enabled sensors are
   * always the last write; `writeEXGConfiguration()` runs earlier, :2670).
   */
  async applyExgPresetLive(preset: ApplicableExgPreset, resolution: ExgResolution): Promise<void> {
    this._assertExgSupported();
    if (this._streaming) throw new Error('Cannot configure EXG while streaming');

    // 'off' — LIVE disable. Java never pushes zeroed register banks to the chip;
    // the ADS1292R forces its must-be bits on write (CONFIG2 bit7=1 etc.,
    // ExGConfigBytesDetails.java:507-525), so a zeroed SET would fail the
    // read-back-verify in writeExgConfig. The disable is done purely by dropping
    // the EXG bits from the enabled-sensors bitmap (writeEnabledSensors is the
    // last command, ShimmerBluetooth.java:2732,2735; readEXGConfigurations /
    // writeEXGConfiguration only run while EXG stays enabled, :2670,4010-4014).
    // The DOCKED path (`applyExgPreset('off')`) still zeroes the InfoMem banks —
    // InfoMem is passive storage and EX1's detectExgPreset keys 'off' off them.
    if (preset === 'off') {
      const cleared = clearExgResolutionFlags(this.enabledSensors);
      await this.setSensors(cleared);
      this._emitStatus("EXG preset 'off' applied (EXG chips disabled). Schema updated.");
      return;
    }

    const current = await this.readExgConfig();
    const result = applyExgPreset(
      {
        exg1: current.exg1,
        exg2: current.exg2,
        enabledSensors: this.enabledSensors,
        samplingRateHz: this.samplingRateHz,
        hardwareVersion: this.deviceVersion?.hardwareVersion,
      },
      preset,
      resolution,
    );

    await this.writeExgConfig(result.exg1, result.exg2);
    await this.setSensors(result.enabledSensors);
    this._emitStatus(`EXG preset '${preset}' (${resolution}) applied. Schema updated.`);
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
    // Stale buffered bytes (e.g. residual post-stop stream data) would desync
    // the ACK wait for START — drain to quiescence and discard them first. A
    // clean state (empty buffer) skips this entirely.
    if (this._rxBuf.length > 0) {
      this._drainingResidual = true;
      try {
        await this._drainQuiescent(300, 2000);
      } finally {
        this._drainingResidual = false;
      }
      this._log('start: discarded', this._rxBuf.length, 'stale byte(s) pre-START');
      this._rxBuf = new Uint8Array(0);
    }
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
    this._emitStatus('STOP_STREAMING → sending, then draining residual stream…');
    try {
      await this._write(new Uint8Array([OPCODES.STOP_STREAMING_COMMAND]));
    } catch (err: unknown) {
      this._emitStatus(`STOP_STREAMING write failed: ${(err as Error).message}`);
    }
    // In-flight stream packets keep arriving for hundreds of ms after STOP.
    // Flipping to control mode instantly would let residual data hit
    // _drainControl, where a stray 0xFE fabricates a NACK and a stray 0x02
    // swallows real bytes (including ACKs). Keep the stream parser active while
    // draining (or accumulate-only if we weren't in streaming mode — e.g.
    // quiescing a device left streaming unattended), and only re-enable the
    // control plane once the pipe has been quiet for ~300 ms.
    this._streamStarting = false;
    if (!this._streaming) this._drainingResidual = true;
    try {
      await this._drainQuiescent(300, 3000);
    } finally {
      this._drainingResidual = false;
    }
    if (this._rxBuf.length) {
      this._log('stop drain: discarding', this._rxBuf.length, 'residual byte(s)');
    }
    this._streaming = false;
    this._rxBuf = new Uint8Array(0);
    this._emitStatus('Streaming stopped.');
  }

  /**
   * Resolve once no bytes have arrived for `quietMs` (checked every 50 ms via
   * the `_rxSeq` counter bumped in {@link _handleNotify}), or `maxMs` overall.
   *
   * HEURISTIC (hardware QA, please probe): the Shimmer3 streaming protocol has
   * no end-of-stream handshake — STOP_STREAMING is ACKed but the firmware does
   * not signal when the last data frame has been flushed over RFCOMM. Draining
   * "until quiet" is therefore best-effort: the 300 ms quiet window / 3 s cap
   * are tuned guesses, not protocol guarantees. Too short and a late residual
   * frame leaks into the next command's control parsing; too long and stop()
   * stalls. Values may need adjusting against real BT latency/buffering.
   */
  private async _drainQuiescent(quietMs: number, maxMs: number): Promise<void> {
    const start = Date.now();
    let lastSeq = this._rxSeq;
    let quietSince = Date.now();
    for (;;) {
      await new Promise<void>((r) => setTimeout(r, 50));
      if (this._rxSeq !== lastSeq) {
        lastSeq = this._rxSeq;
        quietSince = Date.now();
      }
      if (Date.now() - quietSince >= quietMs) return;
      if (Date.now() - start >= maxMs) {
        this._log('drainQuiescent: max wait reached with pipe still active');
        return;
      }
    }
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
      // Mark a command in flight so _drainControl frames NACK (0xFE) only while
      // this window is open; balanced on every settle path below.
      this._awaitCmd += 1;
      const settle = (): void => {
        this._awaitCmd = Math.max(0, this._awaitCmd - 1);
      };
      const t = setTimeout(() => {
        settle();
        this._offTemp(handler);
        reject(new Error('ACK timeout'));
      }, timeoutMs);
      const handler = (msg: Uint8Array): void => {
        if (msg.length === 0) return;
        if (msg[0] === ACK) {
          clearTimeout(t);
          settle();
          this._offTemp(handler);
          resolve();
        } else if (msg[0] === NACK) {
          clearTimeout(t);
          settle();
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
      // Track that an INQUIRY_RESPONSE is genuinely awaited so _drainControl
      // only frames 0x02 while this window is open. _awaitCmd (bumped for every
      // command) gates NACK framing the same way.
      if (expectedOpcode === OPCODES.INQUIRY_RESPONSE) this._awaitInq += 1;
      this._awaitCmd += 1;
      const settleInq = (): void => {
        if (expectedOpcode === OPCODES.INQUIRY_RESPONSE) {
          this._awaitInq = Math.max(0, this._awaitInq - 1);
        }
        this._awaitCmd = Math.max(0, this._awaitCmd - 1);
      };
      const t = setTimeout(() => {
        settleInq();
        this._offTemp(handler);
        reject(new Error(`Response timeout (opcode 0x${expectedOpcode.toString(16)})`));
      }, timeoutMs);
      const handler = (msg: Uint8Array): void => {
        if (msg.length === 0) return;
        if (msg[0] === ACK) return; // tolerate optional ACK prefix
        if (msg[0] === NACK) {
          clearTimeout(t);
          settleInq();
          this._offTemp(handler);
          reject(new Error('NACK received'));
          return;
        }
        if (msg[0] === expectedOpcode) {
          clearTimeout(t);
          settleInq();
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
