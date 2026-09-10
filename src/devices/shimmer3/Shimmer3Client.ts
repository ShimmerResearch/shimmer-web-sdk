import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import { HandlerSet } from '../../core/handlerSet.js';
import { ObjectCluster } from '../../core/ObjectCluster.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import { unnamedLink } from '../../core/transport/linkNoun.js';
import { drainByteStream, type DrainVerdict } from '../../core/framing.js';
import { OPCODES, BT_FEATURE, SHIMMER3_DEFAULTS } from './constants.js';
import type { TimestampFmt } from './constants.js';
import {} from '../shimmer3r/calibration.js';
import {
  parseKinematicCalibBlock,
  getGroupDefaults,
  getDefaultCalibration,
  type ImuFamily,
  type StreamingImuRanges,
  type InertialGroup,
  type KinematicCalibration,
  type CalibDump,
} from '../calibration/index.js';
import { CHANNEL_UNITS } from '../../core/units.js';
import { StreamTimeline, TICKS_PER_MS, type TimelineState } from '../../core/StreamTimeline.js';
import { UNIX_TIMESTAMP_NAME } from '../calibration/streamChannels.js';
import { msToRtcBytesLE } from '../dock/protocol.js';
import {
  ADC_BITS,
  ADC_VREF_VOLTS,
  calibrateStreamFrame,
  type StreamCalibrationInfo,
  type StreamCalibrationSource,
  type StreamCalibrationState,
} from '../calibration/streamChannels.js';
import { selectDumpCalibrations, type DumpCalibrationsByGroup } from '../calibration/sensorIds.js';
import { summariseExgBanks } from '../exg/calibration.js';
import type { ExgBanks } from '../exg/knobs.js';
import { parsePressureCalibrationResponse, type PressureCalibration } from '../pressure/index.js';
import {
  resolveInfoMemLayout,
  INFOMEM_PAGE_SIZE,
  MAC_LENGTH,
  INVALID_MAC_IDS,
} from '../infomem/layout.js';
import {
  ACK,
  NACK,
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
  shimmer3SupportsExg,
  deriveShimmer3FirmwareVersionCode,
  shimmer3UsesThreeByteTimestamp,
  shimmer3ControlMessageLength,
  type Shimmer3InquiryResult,
  type Shimmer3StreamSchema,
  type Shimmer3DeviceVersion,
  type Shimmer3FwVersion,
} from './protocol.js';
import {
  EXG_BANK_LENGTH,
  EXG_CHIP1,
  EXG_CHIP2,
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
 * Client for the **Classic-Bluetooth (RFCOMM/SPP) Shimmer3**.
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
  private readonly _temps = new HandlerSet<Uint8Array>((e) => this._log('temp handler error', e));
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

  /**
   * Every usable block from a calibration dump, by group and range
   * ({@link applyCalibDump}).
   */
  private _dumpCalibrations: DumpCalibrationsByGroup = {};

  /**
   * Blocks fetched by {@link readCalibration}, with the range each was read at
   * — those commands answer for the configured range without saying which, so
   * a block stops applying once a range moves.
   */
  private _btCommandCalibrations: Partial<
    Record<InertialGroup, { cal: KinematicCalibration; range: number }>
  > = {};

  /** Both ExG chips' register banks, when read; `null` assumes chip defaults. */
  private _exgBanks: ExgBanks | null = null;

  /** Where {@link _exgBanks} came from, for {@link calibrationInfo}. */
  private _exgBanksSource: 'device' | 'infomem' | null = null;

  /** The fitted pressure part and its trim, or `null` when unread. */
  private _pressureCalibration: PressureCalibration | null = null;

  /**
   * Configured pressure oversampling, 0-3, from the inquiry's config word. The
   * BMP180 and BMP280 a Shimmer3 can carry both use it.
   */
  pressureOversampling = 0;

  /**
   * Unwraps the sample counter and, once anchored, places every sample on a
   * wall clock. The width follows the firmware: 16 bits — a 2-second wrap — on
   * anything older than LogAndStream 0.5.4.
   */
  private _timeline = new StreamTimeline({ timestampBits: 24 });

  /** Whether {@link startStreaming} reads the real-world clock first. */
  anchorStreamClock = true;

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

  /**
   * The name the link reported, or `null` when it reported none. Never invented.
   *
   * An empty or whitespace name counts as none: a transport reporting `''` has
   * told us nothing, and both callers below need to agree on that.
   */
  private _reportedDeviceName(): string | null {
    const name = this._transport?.deviceName?.trim();
    return name ? name : null;
  }

  /**
   * Stable, non-null identifier for {@link ObjectCluster.deviceId}, which every
   * streamed frame carries.
   *
   * The generation name is the fallback because a frame must always be
   * attributable to something — and that is precisely why it must never be
   * printed as though it were a name the link supplied. Status text uses
   * {@link _reportedDeviceName} instead; keeping the two apart is the whole
   * point of there being two methods.
   */
  private _deviceId(): string {
    return this._reportedDeviceName() ?? 'Shimmer3';
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
   * A transport is REQUIRED (constructor option or this parameter): Web
   * Bluetooth cannot open an RFCOMM socket, so there is no default. In a browser
   * the working transport is a {@link WebSerialTransport} over the virtual COM
   * port the OS creates for a Shimmer paired over Classic Bluetooth. Calling
   * without one throws.
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
        'Shimmer3Client requires an injected transport: Web Bluetooth cannot open an ' +
          'RFCOMM/SPP socket. In a browser, pair the sensor over Classic Bluetooth and ' +
          'pass a WebSerialTransport over the COM port the OS creates for it ' +
          '(allowedBluetoothServiceClassIds: [SHIMMER3_SPP_UUID]); elsewhere pass any ' +
          'ShimmerTransport via the constructor ({ transport }) or connect(transport).',
      );
    }
    this._transport = t;
    this._armDisconnectNotification();
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    this._emitStatus('Opening RFCOMM connection…');
    await t.connect();
    /* Same split as Shimmer3RClient: the name the link reported, and no
     * invented one where it reported none. `t` rather than `this._transport`,
     * so a disconnect() racing the await above cannot make this describe a
     * link other than the one it just opened. */
    this._emitStatus(`Connected: ${this._reportedDeviceName() ?? unnamedLink(t.kind)}`);

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
      this.schema = null;
      this._streaming = false;
      this._streamStarting = false;
      this.ExpPower = 0;
      this._resetCalibrationState();
      this._timeline.reset();
      this._emitStatus('Disconnected');
    }
  }

  /** Handle an unexpected transport disconnect (the link dropped under us). */
  private _handleTransportDisconnect = (reason?: Error): void => {
    this._streaming = false;
    this._streamStarting = false;
    this._emitStatus('Device disconnected');
    this._emitDisconnect(reason);
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
    /* Dispatch each message as it is extracted, NOT in a batch afterwards: the
     * `_awaitInq`/`_awaitCmd` gates in _inspectControlHead are decremented
     * synchronously inside the waiter handlers that _emitTemp invokes. Draining
     * first and emitting later would inspect every head byte against the gate
     * state as it was before any response was delivered, so a stray 0x02 sharing
     * a read with a genuine INQUIRY_RESPONSE would still look awaited and get
     * framed - swallowing the ACK behind it. */
    const { rest } = drainByteStream(this._rxBuf, {
      messageLength: shimmer3ControlMessageLength,
      inspect: (buf) => this._inspectControlHead(buf),
      onMessage: (msg) => this._emitTemp(msg),
      onDrop: (byte, reason) =>
        this._log(
          reason === 'resync'
            ? `resync: dropping unexpected control byte 0x${byte.toString(16)}`
            : `drainControl: dropping gated byte 0x${byte.toString(16)}`,
        ),
    });
    this._rxBuf = rest;
  }

  /**
   * Gate the head byte before framing is attempted.
   *
   * Three bytes are only control traffic in the right context, and framing one
   * out of context would swallow the real control bytes behind it:
   *
   * - DATA_PACKET (0x00) while a stream is (about to be) live belongs to the
   *   stream parser — stop and leave it buffered.
   * - INQUIRY_RESPONSE (0x02) with no inquiry outstanding is a stray/stream
   *   byte; framing it would consume `9 + numChannels` bytes of garbage.
   * - NACK (0xFE) with no command outstanding is likewise dropped. This diverges
   *   from the Java driver (ShimmerObject processes every 0xFE unconditionally)
   *   but strictly reduces the risk of a leaked stream byte being read as a NACK.
   *   Defence-in-depth: `_onTemp` handlers are only added while `_awaitCmd > 0`,
   *   so an ungated stray 0xFE would emit to no listener anyway — this keeps that
   *   invariant explicit and survives refactors that add a longer-lived listener.
   */
  private _inspectControlHead(buf: Uint8Array): DrainVerdict {
    const head = buf[0];
    if ((this._streaming || this._streamStarting) && head === OPCODES.DATA_PACKET) return 'stop';
    if (head === OPCODES.INQUIRY_RESPONSE && this._awaitInq <= 0) return 'drop';
    if (head === NACK && this._awaitCmd <= 0) return 'drop';
    return 'frame';
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
  // The same LiteProtocol ExG command flow as Shimmer3R, ported from
  // ShimmerBluetooth.readEXGConfigurations / writeEXGConfiguration (:4014-4226)
  // and sharing the register codec and GET/SET framing in `../exg/`. Classic
  // Shimmer3 differs from the 3R in two respects: it writes the register banks
  // VERBATIM — the oversampling-ratio injection into REG1 is 3R-only, Java writes
  // reg[0] unchanged (:4224) — and its firmware range is wide enough that the
  // ExG command set has to be gated on the firmware version.
  // ---------------------------------------------------------------------------

  /**
   * Assert this device's firmware has the live ExG GET/SET commands, so an ExG
   * call on firmware without them fails immediately instead of hanging until the
   * response timeout. Applies the Java gate via {@link shimmer3SupportsExg}
   * (ShimmerBluetooth.java:4015,4026,4205,4223), which derives the firmware
   * version code from the parsed FW version plus the hardware id exactly as
   * ShimmerVerObject does. Old BtStream (code 1, or code 2 below internal 8) is
   * rejected up front.
   *
   * @throws Error when not connected, before the connect handshake has learned
   *   the versions, or on firmware without the ExG command set.
   */
  private _assertExgSupported(): void {
    if (!this._transport) throw new Error('Not connected');
    if (this.firmwareVersion == null || this.deviceVersion == null) {
      throw new Error('ExG requires a completed connect handshake (firmware version unknown)');
    }
    if (!shimmer3SupportsExg(this.firmwareVersion, this.deviceVersion.hardwareVersion)) {
      const { major, minor, internal } = this.firmwareVersion;
      const code = deriveShimmer3FirmwareVersionCode(
        this.firmwareVersion,
        this.deviceVersion.hardwareVersion,
      );
      throw new Error(
        `ExG register commands are not supported by this firmware ` +
          `(v${major}.${minor}.${internal}, firmware code ${code}). ` +
          `They need a firmware code of 3 or more — which every LogAndStream ` +
          `build, every Shimmer3R, BtStream 0.3.0 and later, and SDLog reach — ` +
          `or code 2 with an internal version of 8 or more (BtStream 0.2.8 to ` +
          `0.2.x).` +
          (code === -1
            ? ' A code of -1 means the reported version matched no known ' +
              'release, so it is refused whatever the firmware calls itself.'
            : ''),
      );
    }
  }

  /**
   * Read both ExG chips' 10-byte register banks (GET_EXG_REGS ×2 →
   * EXG_REGS_RESPONSE decode). Ported from
   * ShimmerBluetooth.readEXGConfigurations (:4014-4018): CHIP1 then CHIP2.
   *
   * @throws Error when the firmware lacks ExG support, when not connected, or
   *   while streaming (the control plane belongs to the stream parser then).
   */
  async readExgConfig(
    timeoutMs = SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<{ exg1: Uint8Array; exg2: Uint8Array }> {
    this._assertExgSupported();
    if (this._streaming) throw new Error('Cannot read ExG registers while streaming');
    const exg1 = await this._readExgChip(EXG_CHIP1, timeoutMs);
    const exg2 = await this._readExgChip(EXG_CHIP2, timeoutMs);
    /* Cache for the streaming conversion: the millivolt factor needs the PGA
       gain and the reference voltage out of these registers. */
    this._exgBanks = { exg1, exg2 };
    this._exgBanksSource = 'device';
    return { exg1, exg2 };
  }

  // ---------------------------------------------------------------------------
  // Real-world clock
  // ---------------------------------------------------------------------------

  /**
   * True when this firmware serves the real-world-clock commands.
   *
   * The Java driver gates its own `readRealTimeClock` on LogAndStream with a
   * firmware version code of 6 or more (`ShimmerBluetooth.java:2847-2853`), and
   * this follows it. Older firmware answers nothing at all rather than NACKing,
   * so asking costs a timeout — worth avoiding when the version already says.
   */
  get supportsRealWorldClock(): boolean {
    if (this.firmwareVersion == null || this.deviceVersion == null) return false;
    return (
      deriveShimmer3FirmwareVersionCode(this.firmwareVersion, this.deviceVersion.hardwareVersion) >=
      6
    );
  }

  /**
   * Read the device's real-world clock (GET_RWC → RWC_RESPONSE).
   *
   * **What a Shimmer3's real-world clock is, and why it is not the stream's
   * timestamp.** The MSP430's counter cannot be set: it free-runs from boot.
   * Setting the clock stores an offset instead, and the reply to this command
   * is `rwcTimeDiff64 + RTC_get64()` — counter plus offset
   * (`Shimmer_Driver/5xx_HAL/hal_RTC.c:73-76,85`). The offset itself never goes
   * over Bluetooth, only into an SD-file header. So unlike a Shimmer3R, whose
   * packet timestamp is the low 24 bits of this very value, a Shimmer3 leaves a
   * host to estimate where the counter stood when the reply was composed. This
   * anchors the stream timeline accordingly — `rwc-estimated`, carrying half
   * the round trip as its uncertainty.
   *
   * @throws Error when not connected, while streaming, or when the firmware
   *   does not serve the command.
   */
  async getRtcTime(
    timeoutMs = SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<{ ticks: bigint; unixMs: number }> {
    if (!this._transport) throw new Error('Not connected');
    if (this._streaming) throw new Error('Cannot read the real-world clock while streaming');
    this._assertRwcSupported('read');

    const hostBeforeMs = Date.now();
    await this._write(new Uint8Array([OPCODES.GET_RWC_COMMAND]));
    const rsp = await this._waitForResponse(OPCODES.RWC_RESPONSE, timeoutMs);
    if (rsp[0] !== OPCODES.RWC_RESPONSE || rsp.length < 9) {
      throw new Error(`Malformed RWC response (${rsp.length} bytes).`);
    }
    let ticks = 0n;
    for (let i = 8; i >= 1; i--) ticks = (ticks << 8n) | BigInt(rsp[i]);
    const hostAfterMs = Date.now();

    this._timeline.anchorToRwc(ticks, (hostBeforeMs + hostAfterMs) / 2, {
      rttMs: hostAfterMs - hostBeforeMs,
      // Never aligned on a Shimmer3: see the docblock above.
      aligned: false,
    });
    return { ticks, unixMs: Number(ticks) / TICKS_PER_MS };
  }

  /**
   * Set the device's real-world clock (SET_RWC) to a Unix millisecond time,
   * encoded as 64-bit little-endian 32768 Hz ticks.
   *
   * A plain Unix epoch, as desktop Consensys and the dock driver both write.
   * The firmware stores it as an offset from its free-running counter, so the
   * stream's own timestamps do not move — but the mapping from them to wall
   * time does, which is why any existing anchor is dropped.
   */
  async setRtcTime(unixMs: number): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    if (!Number.isFinite(unixMs)) throw new Error('setRtcTime: unixMs must be a finite number.');
    this._assertRwcSupported('write');
    const cmd = new Uint8Array(9);
    cmd[0] = OPCODES.SET_RWC_COMMAND;
    cmd.set(msToRtcBytesLE(unixMs), 1);
    await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
    this._timeline.clearAnchor();
    this._emitStatus('RWC set');
  }

  private _assertRwcSupported(verb: 'read' | 'write'): void {
    if (this.supportsRealWorldClock) return;
    if (this.firmwareVersion == null || this.deviceVersion == null) {
      throw new Error(
        `Cannot ${verb} the real-world clock before the handshake has read the ` +
          'firmware and device versions.',
      );
    }
    const { major, minor, internal } = this.firmwareVersion;
    throw new Error(
      `This firmware does not serve the real-world-clock commands ` +
        `(v${major}.${minor}.${internal}). They need a firmware version code of 6 ` +
        'or more — LogAndStream 0.5.0 and later.',
    );
  }

  /** Where the streamed wall-clock times come from, and how well. */
  get timelineState(): TimelineState {
    return this._timeline.state;
  }

  /**
   * Get the stream timeline ready, and anchor it if asked. See
   * `Shimmer3RClient._prepareStreamTimeline`; a Shimmer3's anchor is always the
   * estimated kind.
   */
  private _prepareStreamTimeline(): void {
    // The width is a firmware property the handshake has established by now:
    // 16 bits, wrapping every 2 s, on anything older than LogAndStream 0.5.4.
    this._timeline.setTimestampBits(this._timestampFmt === 'u16' ? 16 : 24);
    this._timeline.reset();
    if (!this.anchorStreamClock || this._timeline.hasAnchorRequest) return;
    /* This host's clock, the Consensys method. No round trip is spent here —
       see `Shimmer3RClient._prepareStreamTimeline` for why. A host wanting the
       sensor's own clock as the reference calls {@link getRtcTime} once, which
       needs LogAndStream 0.5.0 or later ({@link supportsRealWorldClock}). */
    this._timeline.anchorToHost(Date.now());
    this._emitStatus(
      "Stream clock anchored to this host's clock" +
        (this.supportsRealWorldClock
          ? ". Read the sensor's real-world clock (getRtcTime) for times taken from the sensor itself."
          : ' — this firmware has no real-world clock.'),
    );
  }

  /**
   * Read the fitted pressure sensor's identity and factory trim, so PRESSURE and
   * TEMPERATURE can be streamed in kPa and °C.
   *
   * The modern command is `GET_PRESSURE_CALIBRATION_COEFFICIENTS` (0xA7),
   * answering `[0xA6][1 + n][sensorId][coeffs]`. A classic Shimmer3 running
   * older LogAndStream firmware serves only the two legacy commands instead —
   * `0xA0 → 0x9F` (BMP280, 24 bytes) and `0x59 → 0x58` (BMP180, 22 bytes) — and
   * that firmware has **no NACK at all**, so an unsupported command produces
   * silence rather than a refusal
   * (`ccs_workspace/FW_Shimmer3/LogAndStream/main.c`, whose command switch has
   * no `sendNack`). Both legacy paths are therefore tried after the modern one,
   * and the part they name is inferred from which answered — with one trap
   * handled in the parser: asked for BMP180 coefficients on a BMP280 board,
   * that firmware answers a full-length block of `0x01` filler rather than
   * declining, and compensating against it would yield a confident, wrong
   * pressure.
   *
   * **A refusal is not an error**: the channels stream raw-only and this
   * returns `null`, having said so through {@link onStatus}.
   *
   * @throws Error only when not connected.
   */
  async readPressureCalibration(
    timeoutMs = SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
  ): Promise<PressureCalibration | null> {
    if (!this._transport) throw new Error('Not connected');
    if (this._streaming) throw new Error('Cannot read the pressure calibration while streaming');

    const attempts: Array<{ cmd: number; resp: number; label: string; legacy: 0 | 1 | null }> = [
      {
        cmd: OPCODES.GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND,
        resp: OPCODES.PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE,
        label: 'GET_PRESSURE_CALIBRATION_COEFFICIENTS (0xA7)',
        legacy: null,
      },
      {
        cmd: OPCODES.GET_BMP280_CALIBRATION_COEFFICIENTS_COMMAND,
        resp: OPCODES.BMP280_CALIBRATION_COEFFICIENTS_RESPONSE,
        label: 'GET_BMP280_CALIBRATION_COEFFICIENTS (0xA0)',
        legacy: 1,
      },
      {
        cmd: OPCODES.GET_BMP180_CALIBRATION_COEFFICIENTS_COMMAND,
        resp: OPCODES.BMP180_CALIBRATION_COEFFICIENTS_RESPONSE,
        label: 'GET_BMP180_CALIBRATION_COEFFICIENTS (0x59)',
        legacy: 0,
      },
    ];

    for (const attempt of attempts) {
      try {
        await this._write(new Uint8Array([attempt.cmd]));
        const frame = await this._waitForResponse(attempt.resp, timeoutMs);
        /* The modern reply is length-prefixed and self-describing; the legacy
           ones are a bare fixed-length block, so the sensor id has to come from
           which command answered. */
        const payload =
          attempt.legacy === null
            ? frame.subarray(2)
            : Uint8Array.from([attempt.legacy, ...frame.subarray(1)]);
        const calibration = parsePressureCalibrationResponse(payload);
        this._pressureCalibration = calibration;
        this._emitStatus(
          calibration.calibrated
            ? `Pressure sensor ${calibration.sensor}: coefficients loaded.`
            : `Pressure sensor ${calibration.sensor} returned a blank coefficient block; ` +
                'PRESSURE and TEMPERATURE stream raw-only.',
        );
        if (calibration.calibrated) return calibration;
        // A blank block means this was the wrong command for the fitted part;
        // keep trying the others rather than settling for it.
      } catch {
        /* No answer, or an answer that was not what it claimed. Try the next. */
      }
    }

    this._pressureCalibration = null;
    this._emitStatus(
      'No pressure calibration is available from this firmware, so PRESSURE and ' +
        'TEMPERATURE stream raw-only.',
    );
    return null;
  }

  private async _readExgChip(chip: ExgChipIndex, timeoutMs: number): Promise<Uint8Array> {
    // GET is ACK-then-response, and _waitForResponse already tolerates the
    // optional ACK prefix (as inquiry() relies on), so register for the response
    // directly instead of awaiting the ACK first — no race if the device
    // coalesces the two into one RFCOMM chunk.
    await this._write(buildGetExgRegsCommand(chip));
    const frame = await this._waitForResponse(OPCODES.EXG_REGS_RESPONSE, timeoutMs);
    return decodeExgRegsResponse(frame);
  }

  /**
   * Write both ExG chips' 10-byte register banks (SET_EXG_REGS ×2), then read
   * them back and verify. The banks go out verbatim — the oversampling-ratio
   * injection is Shimmer3R-only.
   *
   * WRITE-SAFETY DEVIATION FROM JAVA: Java applies SET_EXG_REGS immediately and
   * does not verify, relying on a timeout→disconnect failsafe
   * (ShimmerBluetooth.java:4212-4216). The safer flow is ported instead: SET →
   * await ACK → GET read-back → compare, ignoring only the read-only REG8 status
   * byte → throw on mismatch.
   *
   * @throws Error when unsupported, not connected, streaming, or on a mismatch.
   * @throws RangeError when either bank is not exactly 10 bytes.
   */
  async writeExgConfig(exg1: Uint8Array, exg2: Uint8Array): Promise<void> {
    this._assertExgSupported();
    if (this._streaming) throw new Error('Cannot write ExG registers while streaming');
    if (exg1.length !== EXG_BANK_LENGTH || exg2.length !== EXG_BANK_LENGTH) {
      throw new RangeError(
        `ExG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ${exg1.length}/${exg2.length}.`,
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
        'ExG write read-back mismatch: device registers do not match what was written',
      );
    }
    this._emitStatus('ExG registers written and verified.');
  }

  /**
   * Apply an ExG preset live: derive the register banks and the enabled-sensors
   * bitmap from the current inquiry state via the codec's `applyExgPreset`, write
   * the registers, then set the enabled sensors LAST — the desktop flow marks
   * `writeEnabledSensors(...)` "this should always be the last command"
   * (ShimmerBluetooth.java:2732,2735) and runs `writeEXGConfiguration()` earlier
   * (:2670).
   *
   * The device's own hardware version is passed through, so the joined-clock bit
   * follows `ShimmerVerObject.isSupportedExgChipClocksJoined` (:712-723) rather
   * than being forced on: a classic Shimmer3 keeps whatever bit it already had
   * (its unified-ExG board revision is not knowable from the hardware id), while
   * a Shimmer3R always gets it set.
   */
  async applyExgPresetLive(preset: ApplicableExgPreset, resolution: ExgResolution): Promise<void> {
    this._assertExgSupported();
    if (this._streaming) throw new Error('Cannot configure ExG while streaming');

    // 'off' — LIVE disable. Java never pushes zeroed register banks at the chip:
    // the ADS1292R forces its must-be bits on write (CONFIG2 bit7 = 1 etc.,
    // ExGConfigBytesDetails.java:507-525), so a zeroed SET would read back
    // non-zero and fail the verify in writeExgConfig. The disable is done purely
    // by dropping the ExG bits from the enabled-sensors bitmap
    // (writeEnabledSensors, ShimmerBluetooth.java:2732,2735; the ExG register
    // read/write only run while ExG stays enabled, :2670,4014-4018). The DOCKED
    // path (`applyExgPreset('off')`) does zero the InfoMem banks — InfoMem is
    // passive storage, and that is what detectExgPreset keys 'off' off.
    if (preset === 'off') {
      await this.setSensors(clearExgResolutionFlags(this.enabledSensors));
      this._emitStatus("ExG preset 'off' applied (ExG chips disabled). Schema updated.");
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
    // Enabled sensors last; setSensors re-inquires and refreshes the schema.
    await this.setSensors(result.enabledSensors);
    this._emitStatus(`ExG preset '${preset}' (${resolution}) applied. Schema updated.`);
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
    // A channel ID this SDK cannot describe has to reach the host, not just the
    // schema: its width was guessed, so every later channel in the frame may be
    // decoding from the wrong offset (see `buildShimmer3Schema`).
    const info = interpretShimmer3InquiryResponse(rsp, this._timestampFmt, (m) =>
      this._emitStatus(`⚠️ ${m}`),
    );
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
    this.pressureOversampling = info.pressureResolution;
    // The ranges just moved, so re-pick which stored block applies to each group.
    this._reselectDeviceCalibrations();
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

  /**
   * Arm a one-shot soft reboot that the device performs as soon as this host
   * disconnects (SET_FEATURE / FEATURE_REBOOT_ON_DISCONNECT).
   *
   * Settings that firmware only reads at boot - notably the EEPROM brand
   * record's advertising names - otherwise need a manual power-cycle. The
   * reboot cannot happen while still connected, because the link has to drop
   * for the Bluetooth module to re-read its name; so the sequence is: write
   * settings, call this, then {@link disconnect}.
   *
   * Firmware skips the reboot while sensing so that it can never truncate an
   * active SD recording, and clears the request either way - it is strictly
   * one-shot and never carries into a later disconnect.
   *
   * Requires firmware with FEATURE_REBOOT_ON_DISCONNECT support; older
   * firmware NACKs the unknown feature id.
   */
  async setRebootOnDisconnect(enabled: boolean): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    this._emitStatus(`SET_FEATURE reboot-on-disconnect=${enabled ? 1 : 0} → waiting for ACK…`);
    await this._writeExpectingAck(
      new Uint8Array([OPCODES.SET_FEATURE, BT_FEATURE.REBOOT_ON_DISCONNECT, enabled ? 1 : 0]),
      SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS,
    );
    this._emitStatus(`Reboot-on-disconnect ${enabled ? 'armed' : 'cleared'}`);
  }

  // ---------------------------------------------------------------------------
  // Daughter-card (expansion board) EEPROM memory
  // ---------------------------------------------------------------------------

  /**
   * Read from the daughter-card EEPROM memory. `offset` is a HOST offset —
   * firmware maps it past the first (HW details) EEPROM page, so host offsets
   * 0..2031 cover absolute EEPROM bytes 16..2047.
   */
  async readDaughterCardMem(offset: number, length: number): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected');
    if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
      throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
    }
    if (!Number.isInteger(length) || length < 1 || length > 128 || offset + length > 2032) {
      throw new Error('Daughter-card mem read must be 1..128 bytes within 0..2031.');
    }

    this._emitStatus(`GET_DAUGHTER_CARD_MEM ${length}B @ ${offset} → waiting for RSP…`);
    const cmd = new Uint8Array([
      OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND,
      length & 0xff,
      offset & 0xff,
      (offset >> 8) & 0xff,
    ]);
    await this._write(cmd);
    const rsp = await this._waitForResponse(
      OPCODES.DAUGHTER_CARD_MEM_RESPONSE,
      SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
    );

    /* Response is [DAUGHTER_CARD_MEM_RSP][length][data...]; the opcode and
     * length bytes are skipped when present and consistent. */
    let off = 0;
    if (rsp[off] === OPCODES.DAUGHTER_CARD_MEM_RESPONSE) off++;
    if (rsp.length > off && rsp[off] === length && rsp.length >= off + 1 + length) off++;

    const data = rsp.slice(off, off + length);
    if (data.length < length) {
      throw new Error(`Daughter-card mem read returned ${data.length} of ${length} bytes.`);
    }
    return data;
  }

  /**
   * Read the device configuration memory (InfoMem) via GET_INFOMEM_COMMAND.
   *
   * `address` is a **wire** address, not an index into the 384-byte InfoMem
   * image: older firmware addresses the D/C/B pages at 0x1800/0x1880/0x1900
   * while newer firmware and all Shimmer3Rs use a flat 0/128/256. Use
   * {@link resolveInfoMemLayout} to pick the right page base for the connected
   * device — {@link getMacAddress} shows the pattern. Max 128 bytes per read
   * (one page), which the firmware enforces too.
   */
  async readInfoMem(address: number, length: number): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected');
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error('InfoMem address must be an integer in 0..65535.');
    }
    if (!Number.isInteger(length) || length < 1 || length > 128) {
      throw new Error('InfoMem read length must be an integer in 1..128.');
    }
    /* One read must stay inside one page, or the firmware returns
     * page-boundary-dependent junk for the overhang. Every page base is
     * 128-aligned in both addressing modes (legacy 0x1800/0x1880/0x1900 and
     * flat 0/128/256), so the offset within the page is just address % 128
     * regardless of which mode the connected firmware uses. */
    if ((address % INFOMEM_PAGE_SIZE) + length > INFOMEM_PAGE_SIZE) {
      throw new Error(
        `InfoMem read ${length}B @ ${address} crosses a ${INFOMEM_PAGE_SIZE}-byte page ` +
          'boundary; split it into one read per page.',
      );
    }

    this._emitStatus(`GET_INFOMEM ${length}B @ ${address} → waiting for RSP…`);
    const cmd = new Uint8Array([
      OPCODES.GET_INFOMEM_COMMAND,
      length & 0xff,
      address & 0xff,
      (address >> 8) & 0xff,
    ]);
    await this._write(cmd);
    const rsp = await this._waitForResponse(
      OPCODES.INFOMEM_RESPONSE,
      SHIMMER3_DEFAULTS.RESPONSE_TIMEOUT_MS,
    );

    /* Response is [INFOMEM_RSP][length][data...]; the opcode and length bytes
     * are skipped when present and consistent. No reassembly needed — the
     * byte-stream framer already delivers the whole response as one message. */
    let off = 0;
    if (rsp[off] === OPCODES.INFOMEM_RESPONSE) off++;
    if (rsp.length > off && rsp[off] === length && rsp.length >= off + 1 + length) off++;

    const data = rsp.slice(off, off + length);
    if (data.length < length) {
      throw new Error(`InfoMem read returned ${data.length} of ${length} bytes.`);
    }
    return data;
  }

  /**
   * Read the device's Bluetooth MAC as a 12-char uppercase hex string.
   *
   * The MAC lives in InfoMem rather than behind a command of its own, so this
   * resolves the layout for the connected device first: `idxMacAddress` (224) is
   * an index into the InfoMem image, which only equals the wire address on
   * firmware that uses flat page addressing. Older firmware needs the C-page
   * base instead, hence the page/offset split below.
   *
   * Requires a completed {@link connect} handshake — the layout depends on the
   * hardware and firmware version it reads.
   */
  async getMacAddress(): Promise<string> {
    const fw = this.firmwareVersion;
    const hw = this.deviceVersion?.hardwareVersion;
    if (!fw || hw === undefined) {
      throw new Error('getMacAddress requires a completed connect handshake.');
    }

    const layout = resolveInfoMemLayout({
      hardwareVersion: hw,
      firmwareId: fw.firmwareIdentifier,
      firmwareVersion: { major: fw.major, minor: fw.minor, internal: fw.internal },
    });
    const pageBases = [layout.addrD, layout.addrC, layout.addrB];
    const page = Math.floor(layout.idxMacAddress / INFOMEM_PAGE_SIZE);
    const address = pageBases[page] + (layout.idxMacAddress % INFOMEM_PAGE_SIZE);

    const bytes = await this.readInfoMem(address, MAC_LENGTH);
    const mac = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();

    if (INVALID_MAC_IDS.includes(mac)) {
      throw new Error(`Device reported an unprovisioned MAC (${mac}).`);
    }
    this._emitStatus(`Device MAC: ${mac}`);
    return mac;
  }

  /**
   * Write to the daughter-card EEPROM memory. `offset` is a HOST offset (see
   * {@link readDaughterCardMem}). Max 128 bytes per write.
   */
  async writeDaughterCardMem(offset: number, data: Uint8Array): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
      throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
    }
    if (data.length < 1 || data.length > 128 || offset + data.length > 2032) {
      throw new Error('Daughter-card mem write must be 1..128 bytes within 0..2031.');
    }

    this._emitStatus(`SET_DAUGHTER_CARD_MEM ${data.length}B @ ${offset} → waiting for ACK…`);
    const cmd = new Uint8Array(4 + data.length);
    cmd[0] = OPCODES.SET_DAUGHTER_CARD_MEM_COMMAND;
    cmd[1] = data.length & 0xff;
    cmd[2] = offset & 0xff;
    cmd[3] = (offset >> 8) & 0xff;
    cmd.set(data, 4);
    await this._writeExpectingAck(cmd, SHIMMER3_DEFAULTS.ACK_TIMEOUT_MS);
    this._emitStatus('Daughter-card mem write ACKed');
  }

  // ---------------------------------------------------------------------------
  // Streaming
  // ---------------------------------------------------------------------------

  override async startStreaming(): Promise<void> {
    if (!this._transport) throw new Error('Not connected');
    if (!this.schema) this._emitStatus('Starting stream without schema (not recommended).');
    this._prepareStreamTimeline();
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
          const oc = new ObjectCluster(this._deviceId());
          const ts = tsBytes === 2 ? u16le(frame, cursor) : u24le(frame, cursor);
          cursor += tsBytes;
          oc.add('TIMESTAMP', ts, CHANNEL_UNITS.TICKS, 'raw');
          /* Unwrap the counter — every 2 s on older firmware, every 512 s on
             newer — and place it on a wall clock when anchored. */
          const stamped = this._timeline.stamp(ts, Date.now());
          oc.add('TIMESTAMP', stamped.deviceMs, CHANNEL_UNITS.MILLISECONDS, 'cal');
          if (stamped.unixMs !== null) {
            oc.add(UNIX_TIMESTAMP_NAME, stamped.unixMs, CHANNEL_UNITS.MILLISECONDS, 'cal');
          }

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
            oc.add(f.name, v, CHANNEL_UNITS.NO_UNITS, 'raw');
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

  /** The calibration state one decoded frame is converted against. */
  private _streamCalibrationState(): StreamCalibrationState {
    return {
      generation: 'shimmer3',
      family: this._imuFamily,
      ranges: this.imuRanges,
      device: this._deviceCalibrations,
      emitInertial: this.emitCalibratedInertial,
      gsrRange: this.gsrRangeSetting,
      exg: this._exgBanks,
      pressure: this._pressureCalibration,
      pressureOversampling: this.pressureOversampling,
    };
  }

  /**
   * Add a calibrated field, with a unit, for every channel this SDK can
   * convert — the same registry the Shimmer3R client uses
   * (`devices/calibration/streamChannels.ts`), so the two platforms cannot
   * drift apart on a formula.
   */
  private _calibrateData(oc: ObjectCluster): void {
    calibrateStreamFrame(oc, this._streamCalibrationState());
  }

  /** Forget everything read off the device about how to calibrate it. */
  private _resetCalibrationState(): void {
    this._deviceCalibrations = {};
    this._dumpCalibrations = {};
    this._btCommandCalibrations = {};
    this._exgBanks = null;
    this._exgBanksSource = null;
    this._pressureCalibration = null;
  }

  /**
   * Re-pick which stored calibration applies to each inertial group at the
   * ranges now configured. See the Shimmer3R client's method of the same name
   * for why a per-sensor block is dropped once its range moves.
   */
  private _reselectDeviceCalibrations(): void {
    const next: Partial<Record<InertialGroup, KinematicCalibration>> = {};
    const groups = Object.keys(this.imuRanges) as InertialGroup[];
    for (const group of groups) {
      const range = this.imuRanges[group];
      const fromDump = this._dumpCalibrations[group]?.[range];
      if (fromDump) {
        next[group] = fromDump;
        continue;
      }
      const fromCommand = this._btCommandCalibrations[group];
      if (fromCommand && fromCommand.range === range) next[group] = fromCommand.cal;
    }
    this._deviceCalibrations = next;
  }

  /**
   * Take a calibration dump this device just produced and use it for streaming.
   * See `Shimmer3RClient.applyCalibDump`.
   */
  applyCalibDump(dump: CalibDump): InertialGroup[] {
    this._dumpCalibrations = selectDumpCalibrations(dump, this._imuFamily);
    this._reselectDeviceCalibrations();
    const groups = Object.keys(this._dumpCalibrations) as InertialGroup[];
    this._emitStatus(
      groups.length
        ? `Streaming calibration now follows the dump for: ${groups.join(', ')}.`
        : 'The calibration dump held no usable inertial block; defaults stay in force.',
    );
    return groups;
  }

  /** Both ExG chips' register banks as last read, or `null`. */
  get exgBanks(): ExgBanks | null {
    return this._exgBanks;
  }

  /** The fitted pressure part and its trim, or `null` if never read. */
  get pressureCalibration(): PressureCalibration | null {
    return this._pressureCalibration;
  }

  /** What every streamed channel is being calibrated against, right now. */
  get calibrationInfo(): StreamCalibrationInfo {
    const inertial: StreamCalibrationInfo['inertial'] = {};
    const groups = Object.keys(this.imuRanges) as InertialGroup[];
    for (const group of groups) {
      const range = this.imuRanges[group];
      const defaults = getDefaultCalibration(this._imuFamily, group, range);
      if (!defaults) continue;
      const fromDump = this._dumpCalibrations[group]?.[range];
      const fromCommand = this._btCommandCalibrations[group];
      const source: StreamCalibrationSource = fromDump
        ? 'radio-dump'
        : fromCommand && fromCommand.range === range
          ? 'bt-command'
          : 'default';
      inertial[group] = {
        range,
        source,
        usingDefaultCalibration: source === 'default',
        unit: defaults.unit,
      };
    }
    return {
      inertial,
      gsr: { range: this.gsrRangeSetting },
      exg: { source: this._exgBanksSource ?? 'default', ...summariseExgBanks(this._exgBanks) },
      pressure: {
        sensor: this._pressureCalibration?.sensor ?? null,
        calibrated: this._pressureCalibration?.calibrated ?? false,
        oversampling: this.pressureOversampling,
      },
      adc: { vrefVolts: ADC_VREF_VOLTS, bits: ADC_BITS },
    };
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
          this._btCommandCalibrations[group] = { cal, range: this.imuRanges[group] };
          done.push(group);
        }
      } catch (err: unknown) {
        this._emitStatus(`readCalibration(${group}) skipped: ${(err as Error).message}`);
      }
    }
    this._reselectDeviceCalibrations();
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
    this._temps.emit(buf);
  }
}
