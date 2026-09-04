import { BaseShimmerClient } from '../../core/BaseShimmerClient.js';
import { HandlerSet } from '../../core/handlerSet.js';
import { ObjectCluster } from '../../core/ObjectCluster.js';
import type { ShimmerClientOptions } from '../../core/types.js';
import {
  OPCODES,
  BT_FEATURE,
  SHIMMER3R_DEFAULTS,
  GSR_NAME,
  GSR_UNCAL_LIMIT_RANGE3,
  type TimestampFmt,
} from './constants.js';
import { generationFromHardwareVersion, type ShimmerGeneration } from './channelFormats.js';
import {
  EXG_BANK_LENGTH,
  EXG_CHIP1,
  EXG_CHIP2,
  buildGetExgRegsCommand,
  buildSetExgRegsCommand,
  exgBanksEqualIgnoringStatus,
  applyExgPreset,
  clearExgResolutionFlags,
  type ExgChipIndex,
  type ApplicableExgPreset,
  type ExgResolution,
} from '../exg/index.js';
import { buildStreamSchema, type StreamSchemaBase } from './streamSchema.js';
import {
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
  getOversamplingRatioADS1292R,
} from './calibration.js';
import {
  concatU8,
  u16le,
  u16be,
  u24le,
  u24be,
  sign16,
  sign24,
  hex2,
  parseShimmer3StatusBytes,
  type Shimmer3DeviceStatus,
} from './protocol.js';
import { msToRtcBytesLE, parseBatteryStatus, type WiredBatteryStatus } from '../dock/protocol.js';
import {
  FactoryTestCapture,
  FactoryTestError,
  type FactoryTestRunOptions,
  type FactoryTestState,
} from '../factoryTest/capture.js';
import {
  buildSetFactoryTestCommand,
  classifyLiteProtocolAck,
  requireShimmer3FactoryTestType,
} from './factoryTest.js';
import {
  parseShimmer3DeviceVersionResponse,
  type Shimmer3DeviceVersion,
} from '../shimmer3/protocol.js';
import { HW_ID } from '../infomem/layout.js';
import { WebBluetoothTransport } from '../../core/transport/WebBluetoothTransport.js';
import type { ShimmerTransport, Unsubscribe } from '../../core/transport/types.js';
import { NEED_MORE, RESYNC, drainByteStream } from '../../core/framing.js';
import { shimmer3rControlMessageLength } from './streamFraming.js';
import {
  applyStreamingCalibration,
  parseKinematicCalibBlock,
  getGroupDefaults,
  parseCalibDump,
  MAX_CALIB_DUMP_BYTES,
  type StreamingImuRanges,
  type InertialGroup,
  type KinematicCalibration,
  type CalibDump,
} from '../calibration/index.js';
import { MAC_LENGTH, INVALID_MAC_IDS } from '../infomem/layout.js';
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
import {
  SD_TRANSFER_OPCODES,
  SD_STATUS,
  SD_LIST_MAX_ENTRIES,
  SD_BLOCK_PAYLOAD_DEFAULT,
  SdTransferError,
  sdStatusToString,
  buildListDirCmd,
  buildStatCmd,
  buildDeleteCmd,
  buildFreeSpaceCmd,
  buildAbortCmd,
  buildReadCmd,
  parseListDirRsp,
  parseStatRsp,
  parseFreeSpaceRsp,
  parseDeleteRsp,
  tryExtractSdMessage,
  type SdDirEntry,
  type SdFileStat,
  type SdCardSpace,
  type SdDataFrame,
  type SdStatusFrame,
} from './sdTransfer/protocol.js';

// ---------------------------------------------------------------------------
// InfoMem constants
// ---------------------------------------------------------------------------

// InfoMem (device config memory) MAC location, mirroring ConfigByteLayoutShimmer3
// in the Shimmer Java driver: idxMacAddress = 128+96 (=224), length 6 bytes.
// 224+6 stays within one 128-byte InfoMem segment, so a single read suffices.
const INFOMEM_MAC_OFFSET = 224;

/**
 * Bytes per InfoMem / calibration-dump write chunk over a **framed** (BLE)
 * transport. The firmware's own ceiling is 128, and a byte stream uses it; BLE
 * gets 64 because that is the chunk size the EEPROM brand-record write is
 * proven to survive on real hardware, where a command has to cross several
 * notifications into a firmware receive buffer that a larger record has
 * overflowed before (DEV-802). Overridable per call via `opts.chunkBytes`.
 */
const SHIMMER3R_INFOMEM_BLE_CHUNK_BYTES = 64;

/**
 * Bytes per calibration-dump READ. Reads are safe at the firmware's full 128
 * regardless of transport — the reply is reassembled across notifications by
 * `_readLengthPrefixedResponse`, and the size limit that motivates the smaller
 * BLE write chunk is a limit on what the device can receive, not on what it can
 * send. `ShimCalib_ramRead` caps a request at 128
 * (`Calibration/shimmer_calibration.c:372-380`).
 */
const CALIB_DUMP_CHUNK_BYTES = 128;

// ---------------------------------------------------------------------------
// Stray-ACK tolerance
// ---------------------------------------------------------------------------

/**
 * A control message with a leading ACK byte stepped over, so a waiter matches
 * on the opcode the firmware composed rather than on framing sitting in front
 * of it.
 *
 * Needed because `_expectingAck` is a COUNT, not a queue: any ACK satisfies any
 * outstanding expectation. The two stop commands write without registering one
 * ({@link Shimmer3RClient.stopStreaming},
 * {@link Shimmer3RClient.stopStreamingAndLogging}) and yet the firmware ACKs
 * them, so a host that asks for something straight after a stop has that stray
 * ACK counted as its own command's — and its command's REAL reply then arrives
 * with the count already back at zero, unconsumed by the ACK branch of
 * {@link Shimmer3RClient._handleFramedChunk}. Over BLE the module packs that
 * reply in behind its own ACK, so what reaches the waiters is
 * `[0xFF][0x8A][0x71]…` with the ACK still on the front. A waiter that matches
 * at offset 0 alone misses it and times out on a reply that did arrive.
 *
 * Stepping over the byte here, rather than balancing the count by waiting for
 * the stop's ACK at the stop, is what keeps that deliberate no-ACK-wait intact
 * — see {@link Shimmer3RClient.stopStreaming} for why waiting there is the
 * worse trade. It costs nothing when the count was right all along: no message
 * the firmware composes begins with an ACK of its own, and a lone ACK is left
 * alone so the waiters go on ignoring it.
 *
 * A byte stream does not strictly need this — `_extractUnframedMessages` has
 * already split the ACK into its own message — but it is applied on both paths
 * so the two transports agree on what a waiter accepts.
 */
function withoutLeadingAck(msg: Uint8Array): Uint8Array {
  return msg.length > 1 && msg[0] === OPCODES.ACK_COMMAND_PROCESSED ? msg.subarray(1) : msg;
}

// ---------------------------------------------------------------------------
// Internal schema type
// ---------------------------------------------------------------------------

type StreamSchema = StreamSchemaBase;

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
  private readonly _temps = new HandlerSet<Uint8Array>((e) => this._log('temp handler error', e));
  private schema: StreamSchema | null = null;
  private forceTimestampFmt: TimestampFmt;
  private _lastAckRemainder: Uint8Array | null = null;
  private _expectingAck = 0;
  private _streaming = false;
  private _lastTs = 0;
  /** True while the active transport is a byte stream with no message framing. */
  private _unframed = false;
  /** Re-framing accumulator, used only when {@link _unframed}. */
  private _ctrlBuf: Uint8Array = new Uint8Array(0);
  /**
   * How many bytes a STATUS_RESPONSE payload carries: 2 on a Shimmer3R, 1 on a
   * Shimmer3 (`STATUS_BYTE_COUNT`, log-and-stream-common
   * `Comms/shimmer_bt_uart.h:259-263`). Assumed 2 until
   * {@link readDeviceVersion} says otherwise, and handed to the framer so a
   * byte stream splits the message in the right place.
   */
  private _statusPayloadBytes: 1 | 2 = 2;
  /**
   * Non-zero while a {@link getStatus} round trip is outstanding, so its answer
   * is not also reported as an unsolicited push. Counted rather than flagged:
   * two callers may be awaiting at once.
   */
  private _statusReadsInFlight = 0;

  /**
   * The in-flight factory-test capture, or null when none is running.
   *
   * Non-null for the whole time the link is unusable — from the write until the
   * report ends, INCLUDING the drain after a cancelled or timed-out run, because
   * the firmware has no abort command and keeps printing regardless. Every
   * command write is refused while it is set; see {@link runFactoryTest}.
   */
  private _factoryTest: FactoryTestCapture | null = null;

  /**
   * How many status payload bytes a STATUS_RESPONSE must carry before it is
   * worth parsing.
   *
   * Once {@link readDeviceVersion} has answered, {@link _statusPayloadBytes} is
   * a contract — the firmware sends exactly that many — so a shorter message is
   * a truncated one, not a shorter platform. Parsing it anyway would report
   * `usbPluggedIn: null`, which means "this hardware has no such field" and NOT
   * "the byte did not arrive"; the caller cannot tell those apart, so the
   * shorter message must not be surfaced as a status at all.
   *
   * Before the platform is known the 2 is only a guess biased towards this
   * client's namesake, so demanding it would reject — or time out on — the
   * perfectly valid one-byte status a Shimmer3 sends.
   */
  private get _minStatusPayloadBytes(): 1 | 2 {
    return this._deviceVersionCache ? this._statusPayloadBytes : 1;
  }

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

  /**
   * Invoked for a STATUS_RESPONSE the host did not ask for. The firmware pushes
   * one whenever docking, SD logging, streaming or the USB rail changes
   * (`ShimBt_instreamStatusRespSend`, log-and-stream-common
   * `Comms/shimmer_bt_uart.c:2445-2469`), so this is how a host learns the user
   * pressed the button or seated the sensor in a dock.
   *
   * The answer to a {@link getStatus} call is NOT delivered here — that would
   * report every state twice.
   *
   * A push whose payload is short of the connected platform's status length is
   * dropped (with a debug log) rather than parsed, so `usbPluggedIn: null` here
   * always means "a Shimmer3, which has no such field" and never "the byte went
   * missing". See {@link readDeviceVersion} for how that length is learnt.
   *
   * **Only fires while idle.** Once streaming, every inbound byte belongs to the
   * data plane and goes to the schema parser, which has no way to tell a status
   * push from sample bytes and will consume it. Do not rely on this callback to
   * notice that a recording stopped mid-stream; poll {@link getStatus} instead.
   */
  onDeviceStatus: ((status: Shimmer3DeviceStatus) => void) | null = null;

  /**
   * Invoked whenever {@link factoryTestState} changes, synchronously. A host uses
   * it to hold its own "the link is busy" gate through the whole run — including
   * the `draining` phase after a cancel, when the sensor is still printing and no
   * other command will be accepted.
   */
  onFactoryTestStateChange: ((state: FactoryTestState) => void) | null = null;

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
    // A byte-stream transport needs its message boundaries rebuilt; BLE gets
    // them from the notification boundaries and takes the untouched path.
    this._unframed = t.capabilities.framed === false;
    this._ctrlBuf = new Uint8Array(0);
    // The firmware's SD session counter restarts with the connection
    this._sdKnownSession = null;
    // Both version caches describe the device at the far end of the link, so a
    // reconnect — possibly to a different sensor — must not inherit them.
    this._fwVersionCache = null;
    this._deviceVersionCache = null;
    this._statusPayloadBytes = 2;
    this._armDisconnectNotification();
    this._notifyUnsub = t.onNotify(this._handleNotify);
    this._disconnectUnsub = t.onDisconnect(this._handleTransportDisconnect);

    /*
     * Status text follows the transport rather than assuming BLE. These four
     * messages used to be emitted unconditionally, so a Classic-Bluetooth session
     * reported "GATT connected", "RX/TX obtained" and "Notifications started" -
     * none of which exist on an RFCOMM link, which has no GATT server, no
     * characteristics and no notifications.
     *
     * That is not cosmetic. Debugging a Shimmer3R that would not appear in
     * Android's Classic-Bluetooth picker, this log read as proof the button had
     * silently fallen back to BLE; only port.getInfo() reporting an SPP service
     * class showed the link was in fact correct and the words were wrong. A log
     * that misreports the mechanism costs more than one with less detail.
     */
    const overBle = t.kind === 'ble';
    this._emitStatus(overBle ? 'Requesting Bluetooth device…' : `Opening ${t.kind} link…`);
    await t.connect();
    if (t instanceof WebBluetoothTransport) this.device = t.device;
    this._emitStatus(`Selected: ${this._deviceLabel()}`);
    if (overBle) {
      this._emitStatus('GATT connected');
      this._emitStatus('RX/TX obtained');
      this._emitStatus('Notifications started');
    } else {
      /* Naming the framing is worth a line: it is the one behavioural difference
       * between these transports inside this client, and the drain is where an
       * unframed link goes wrong. */
      this._emitStatus(
        `Connected over ${t.kind} (${this._unframed ? 'byte stream, re-framing' : 'framed'})`,
      );
    }
  }

  override async disconnect(): Promise<void> {
    // Application-initiated teardown is not a fault, so `onDisconnect` stays
    // silent — including when this call is the cleanup that follows a drop.
    this._suppressDisconnectNotification();
    // Fail an in-flight capture BEFORE the transport goes: no further bytes are
    // coming, so there is nothing left to drain, and a caller awaiting the
    // report must be told rather than left on a timer for the whole budget.
    this._failFactoryTest('Disconnected while the factory self-test was running.');
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
      this._ctrlBuf = new Uint8Array(0);
      this._unframed = false;
      this.schema = null;
      this._streaming = false;
      this.ExpPower = 0;
      this._deviceCalibrations = {};
      this._sdKnownSession = null;
      this._emitStatus('Disconnected');
    }
  }

  /** Handle an unexpected transport disconnect (the link dropped under us). */
  private _handleTransportDisconnect = (reason?: Error): void => {
    this._streaming = false;
    this._sdKnownSession = null;
    this._failFactoryTest('The link dropped during the factory self-test.');
    this._emitStatus('Device disconnected');
    this._emitDisconnect(reason);
  };

  /**
   * Abandon an in-flight factory-test capture because the link has gone. No
   * drain: draining exists only to keep a still-arriving report out of the
   * framer, and nothing is arriving on a link that is closed.
   */
  private _failFactoryTest(message: string): void {
    this._factoryTest?.fail(new FactoryTestError('disconnected', message));
  }

  // ---------------------------------------------------------------------------
  // Notify handler (fed raw notification chunks by the transport)
  // ---------------------------------------------------------------------------

  /**
   * Transport entry point. A framed transport (BLE) delivers one firmware
   * message per call and goes straight to {@link _handleFramedChunk}; an
   * unframed one (Web Serial over USB or over a Classic-Bluetooth COM port)
   * is re-framed first, then funnelled through the very same handler.
   *
   * A running factory test is served FIRST, before either path. Its report is
   * bare ASCII with no opcode, no length and no CRC, so the framer would treat
   * every line as garbage and resync through it one byte at a time — and the
   * temp handlers, which only ever see whole framed messages, would never see it
   * at all. What the capture hands back is what was NOT report traffic (a status
   * push glued after `TEST END`, a late ACK), and that continues down the normal
   * path.
   */
  private _handleNotify = (chunk: Uint8Array): void => {
    let bytes = chunk;
    if (this._factoryTest) {
      const rest = this._factoryTest.feed(bytes);
      if (!rest || rest.length === 0) return;
      bytes = rest;
    }
    if (this._unframed) {
      this._handleUnframedChunk(bytes);
      return;
    }
    this._handleFramedChunk(bytes);
  };

  private _handleFramedChunk = (chunk: Uint8Array): void => {
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
          this._maybeEmitDeviceStatus(this._lastAckRemainder);
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
      this._maybeEmitDeviceStatus(chunk);
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

  /**
   * Surface a STATUS_RESPONSE nobody asked for on {@link onDeviceStatus}.
   *
   * Called for control-plane messages only, so it never sees stream data — and
   * so a push that lands mid-stream is lost to the schema parser instead, as
   * {@link onDeviceStatus} documents.
   */
  private _maybeEmitDeviceStatus(chunk: Uint8Array): void {
    if (!this.onDeviceStatus) return;
    // A push carries the ACK prefix when the firmware's
    // `useAckPrefixForInstreamResponses` flag is on
    // (SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE, 0xA3), and a stray ACK can be
    // sitting in front of it besides; `withoutLeadingAck` covers both.
    const msg = withoutLeadingAck(chunk);
    if (msg[0] !== OPCODES.INSTREAM_CMD_RESPONSE) return;
    if (msg[1] !== OPCODES.STATUS_RESPONSE) return;
    // Somebody's answer, not news: `getStatus` reports it to its own caller.
    if (this._statusReadsInFlight > 0) return;
    // The payload must be ALL there, not merely started. A guard of three
    // bytes let a push with one status byte through on a two-byte platform, and
    // the parser then reported `usbPluggedIn: null` — indistinguishable, to the
    // caller, from a Shimmer3 that has no such field.
    const need = this._minStatusPayloadBytes;
    if (msg.length < 2 + need) {
      // Dropped rather than surfaced: nobody asked for this message, so there
      // is no caller waiting to be failed, and inventing a status is worse than
      // missing one the firmware will push again on the next change. Logged
      // because a short push means the framing is wrong, which is exactly the
      // kind of thing whoever turned `debug` on is looking for.
      this._log('Dropping truncated STATUS push:', msg.length - 2, 'payload byte(s), need', need);
      return;
    }
    try {
      this.onDeviceStatus(parseShimmer3StatusBytes(msg.subarray(2, 2 + this._statusPayloadBytes)));
    } catch (e) {
      this._log('onDeviceStatus handler error', e);
    }
  }

  // ---------------------------------------------------------------------------
  // Unframed (byte-stream) transports
  // ---------------------------------------------------------------------------

  /**
   * Re-frame an unframed transport's read into whole firmware messages, then
   * replay them through {@link _handleFramedChunk} so every command, waiter and
   * SD handler above behaves exactly as it does over BLE.
   *
   * Without this a serial read can split a response down the middle (the waiter
   * resolves with a truncated buffer) or carry two messages at once (the second
   * is swallowed as the first's ACK remainder).
   */
  private _handleUnframedChunk(chunk: Uint8Array): void {
    this._log('Serial rx len=', chunk.length, 'data=', chunk);

    // While a stream is live every byte is schema-defined stream data, whose
    // length this protocol layer cannot know — hand it straight to the parser,
    // which accumulates and so is already fragmentation-proof.
    if (this._streaming) {
      this._rxBuf = concatU8(this._rxBuf, chunk);
      this._parseStreamIfPossible();
      return;
    }

    this._ctrlBuf = concatU8(this._ctrlBuf, chunk);
    /* Dispatch as extracted, not in a batch afterwards: _coalesceAckWithResponse
     * reads `_expectingAck`, which _handleFramedChunk decrements synchronously
     * when it consumes an ACK. Batching would evaluate the coalescing decision
     * for a second ACK+response pair in the same read against a stale count. */
    const { rest, stopped } = drainByteStream(this._ctrlBuf, {
      messageLength: this._controlMessageLength,
      onMessage: (msg) => this._handleFramedChunk(msg),
      // DATA_PACKET belongs to the stream plane even before `_streaming` is set
      // (the window between START_STREAMING and its ACK). Its length comes from
      // the schema, so stop framing and let the stream parser own the rest.
      inspect: (buf) => (buf[0] === OPCODES.DATA_PACKET ? 'stop' : 'frame'),
      coalesce: this._coalesceAckWithResponse,
      onDrop: (byte) =>
        this._log(`serial resync: dropping unframeable byte 0x${byte.toString(16)}`),
    });

    if (stopped) {
      this._ctrlBuf = new Uint8Array(0);
      this._rxBuf = concatU8(this._rxBuf, rest);
      this._parseStreamIfPossible();
    } else {
      this._ctrlBuf = rest;
    }
  }

  /**
   * Merge a bare ACK with the message that follows it, emulating BLE: the module
   * packs an ACK and the response the firmware wrote straight after it into ONE
   * notification, and the waiters rely on that — `_waitForAck` hands the
   * remainder over synchronously via `_lastAckRemainder`. Emitted as two
   * separate messages, the response would arrive before the caller's `await`
   * continuation had registered its response handler, and be dropped.
   *
   * Two ACKs are never merged: the second would masquerade as the first's
   * response body.
   */
  /**
   * The framer, told how wide this platform's status response is.
   *
   * Only STATUS_RESPONSE's length depends on that — one byte on a Shimmer3, two
   * on a Shimmer3R — and only this client knows which is answering. Both the
   * drain and the coalescing check go through here rather than calling the
   * framer directly, because supplying the option in one place and forgetting
   * it in the other is not a hypothetical: it made a complete Shimmer3 status
   * look perpetually one byte short, so the ACK and its response were never
   * coalesced and the waiter timed out.
   */
  private _controlMessageLength = (buf: Uint8Array): number =>
    shimmer3rControlMessageLength(buf, { statusPayloadBytes: this._statusPayloadBytes });

  private _coalesceAckWithResponse = (msg: Uint8Array, rest: Uint8Array): number => {
    if (msg.length !== 1 || msg[0] !== OPCODES.ACK_COMMAND_PROCESSED) return 0;
    if (this._expectingAck <= 0) return 0;
    if (rest.length === 0 || rest[0] === OPCODES.ACK_COMMAND_PROCESSED) return 0;
    const nextLen = this._controlMessageLength(rest);
    if (nextLen === NEED_MORE || nextLen === RESYNC || rest.length < nextLen) return 0;
    return nextLen;
  };

  /** Run the schema parser if one has been built, swallowing parse errors. */
  private _parseStreamIfPossible(): void {
    if (!this.schema) return;
    try {
      this._parseBySchema();
    } catch (e) {
      this._log('parseBySchema error:', e);
    }
  }

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

  /**
   * Set the wide-range accelerometer (LIS2DW12) range.
   *
   * Also updates {@link imuRanges} so streaming calibration picks the matching
   * sensitivity straight away. An inquiry would refresh it from the config word
   * anyway, but callers are free to set the range after their last inquiry.
   *
   * @param wrAccelRange 0 = ±2 g, 1 = ±4 g, 2 = ±8 g, 3 = ±16 g.
   */
  async setWrAccelRange(
    wrAccelRange: number,
  ): Promise<{ wrAccelRange: number; ackRemainder: Uint8Array | null }> {
    if (!Number.isInteger(wrAccelRange) || wrAccelRange < 0 || wrAccelRange > 3) {
      throw new Error('wrAccelRange must be 0–3 (±2/4/8/16 g)');
    }
    if (!this._transport) throw new Error('Not connected (RX missing)');

    const cmd = new Uint8Array([OPCODES.SET_WR_ACCEL_RANGE_COMMAND, wrAccelRange & 0xff]);
    this._emitStatus('SET_WR_ACCEL_RANGE → waiting for ACK…');
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('SET_WR_ACCEL_RANGE (ACK received).');
    this.imuRanges = { ...this.imuRanges, wrAccel: wrAccelRange };
    return { wrAccelRange, ackRemainder };
  }

  /**
   * Set the gyroscope (LSM6DSV) range.
   *
   * Also updates {@link imuRanges}, as {@link setWrAccelRange} does.
   *
   * Note the firmware splits this setting across two config-setup bits when it
   * reports back in an inquiry (LSB pair plus one MSB bit), but the command
   * itself takes the full 0–5 index in one byte.
   *
   * @param gyroRange 0 = ±125, 1 = ±250, 2 = ±500, 3 = ±1000, 4 = ±2000,
   *   5 = ±4000 dps. (Shimmer3 supports only 0–3: ±250/500/1000/2000 dps.)
   */
  async setGyroRange(
    gyroRange: number,
  ): Promise<{ gyroRange: number; ackRemainder: Uint8Array | null }> {
    if (!Number.isInteger(gyroRange) || gyroRange < 0 || gyroRange > 5) {
      throw new Error('gyroRange must be 0–5 (±125/250/500/1000/2000/4000 dps)');
    }
    if (!this._transport) throw new Error('Not connected (RX missing)');

    const cmd = new Uint8Array([OPCODES.SET_GYRO_RANGE_COMMAND, gyroRange & 0xff]);
    this._emitStatus('SET_GYRO_RANGE → waiting for ACK…');
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('SET_GYRO_RANGE (ACK received).');
    this.imuRanges = { ...this.imuRanges, gyro: gyroRange };
    return { gyroRange, ackRemainder };
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
  // InfoMem
  // ---------------------------------------------------------------------------

  /**
   * Read a block from the device's InfoMem (config memory).
   * Request layout is [cmd, length, addrLSB, addrMSB] (address is little-endian
   * 16-bit), matching readMem()/GET_INFOMEM_COMMAND in the Shimmer Java driver.
   * @returns the raw bytes read
   */
  /**
   * Issue a command and read back a length-prefixed response
   * (`[opcode][len][data...]`), reassembling it across BLE notifications.
   *
   * A notification carries at most one ATT payload — around 42 bytes at the
   * MTU the CYW20820 negotiates — and the transport surfaces one notification
   * per chunk, so any response longer than that arrives split. Firmware writes
   * the logical response contiguously, so the fragments simply concatenate in
   * order: accumulate until `expectedLen` data bytes have arrived instead of
   * assuming the first chunk holds the whole response.
   *
   * Firmware always emits the length byte after the opcode, but its absence is
   * tolerated (older/variant firmware) by treating the first byte as a prefix
   * only when it equals the requested length.
   *
   * `headerBytes` is how many bytes sit between the opcode and the payload:
   * 1 for the `[len]` of an InfoMem or daughter-card read, 3 for the
   * `[len][offsetLo][offsetHi]` a calibration-dump reply echoes back
   * (`Comms/shimmer_bt_uart.c:2119-2127`). The whole header is recognised — and
   * skipped — on the same condition either way, that its first byte is the
   * length that was asked for, so a response with no header at all still
   * reaches the caller intact.
   */
  private async _readLengthPrefixedResponse(
    cmd: Uint8Array,
    respOpcode: number,
    expectedLen: number,
    label: string,
    headerBytes = 1,
    ackTimeoutMs = 1500,
    responseTimeoutMs = 2000,
    expectedOffset?: number,
  ): Promise<Uint8Array> {
    const remainder = await this._writeExpectingAck(cmd, ackTimeoutMs);
    const first =
      remainder && remainder[0] === respOpcode
        ? remainder
        : await this._waitForResponse(respOpcode, responseTimeoutMs);

    /* Bytes after the response opcode. */
    let acc = first[0] === respOpcode ? first.subarray(1) : first;

    /* Whether a header is present is decided by reading it, because a response
     * without one is a case this client supports (see the loopback test for an
     * InfoMem reply with no length byte). That check is unavoidably a guess for
     * a one-byte header: `[6][six bytes]` and `[six bytes beginning 0x06]` are
     * not distinguishable, and guessing wrong slices real data off the front.
     *
     * The three-byte calibration header is not in that position, so it is not
     * treated as if it were. Its two offset bytes echo the offset that was
     * requested, and checking them alongside the length turns a coincidence on
     * one byte into a coincidence on three. Previously only `buf[0]` was
     * examined and the offset bytes were ignored entirely. */
    const hasHeader = (buf: Uint8Array): boolean => {
      if (buf.length < headerBytes || buf[0] !== expectedLen) return false;
      if (headerBytes >= 3 && expectedOffset !== undefined) {
        return (buf[1] | (buf[2] << 8)) === expectedOffset;
      }
      return true;
    };
    const dataOf = (buf: Uint8Array): Uint8Array =>
      hasHeader(buf) ? buf.subarray(headerBytes) : buf;

    if (dataOf(acc).length >= expectedLen) {
      return dataOf(acc).slice(0, expectedLen);
    }

    /* Response is fragmented — collect the continuation chunks, which carry
     * raw payload bytes with no opcode of their own. */
    return new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(
          new Error(
            `${label} returned ${dataOf(acc).length} of ${expectedLen} bytes (response truncated).`,
          ),
        );
      }, responseTimeoutMs);

      const handler = (chunk: Uint8Array): void => {
        if (!chunk || chunk.length === 0) return;
        /* Every chunk from here is continuation payload — deliberately NOT
         * filtering a lone 0xFF as a stray ACK, because a payload byte can be
         * 0xFF and dropping it would silently corrupt the record. The ACK for
         * this command was already consumed before this handler was registered,
         * and commands are issued one at a time, so no other ACK can arrive
         * mid-response. */
        acc = concatU8(acc, chunk);
        const data = dataOf(acc);
        if (data.length >= expectedLen) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(data.slice(0, expectedLen));
        }
      };
      this._onTemp(handler);
    });
  }

  async readInfoMem(address: number, length: number): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error('InfoMem address must be an integer in 0..65535.');
    }
    if (!Number.isInteger(length) || length < 1 || length > 128) {
      throw new Error('InfoMem read length must be an integer in 1..128.');
    }

    this._emitStatus(`GET_INFOMEM ${length}B @ ${address} → waiting for ACK then RSP…`);
    const cmd = new Uint8Array([
      OPCODES.GET_INFOMEM_COMMAND,
      length & 0xff,
      address & 0xff,
      (address >> 8) & 0xff,
    ]);

    /* Response is [INFOMEM_RSP][length][data...]. The opcode is required (a raw
     * opcode-less chunk could be an unrelated notification, e.g. a 0x00-preamble
     * data frame, and must not be mis-captured as InfoMem payload); the length
     * byte is optional. Reads longer than one BLE notification are reassembled. */
    return this._readLengthPrefixedResponse(cmd, OPCODES.INFOMEM_RESPONSE, length, 'InfoMem read');
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
    if (!this._transport) throw new Error('Not connected (RX missing)');
    this._emitStatus(`SET_FEATURE reboot-on-disconnect=${enabled ? 1 : 0} → waiting for ACK…`);
    await this._writeExpectingAck(
      new Uint8Array([OPCODES.SET_FEATURE, BT_FEATURE.REBOOT_ON_DISCONNECT, enabled ? 1 : 0]),
      1500,
    );
    this._emitStatus(`Reboot-on-disconnect ${enabled ? 'armed' : 'cleared'}`);
  }

  /**
   * Read from the daughter-card (expansion board) EEPROM memory. `offset` is a
   * HOST offset — firmware maps it past the first (HW details) EEPROM page, so
   * host offsets 0..2031 cover absolute EEPROM bytes 16..2047.
   */
  async readDaughterCardMem(offset: number, length: number): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (!Number.isInteger(offset) || offset < 0 || offset > 2031) {
      throw new Error('Daughter-card mem offset must be an integer in 0..2031.');
    }
    if (!Number.isInteger(length) || length < 1 || length > 128 || offset + length > 2032) {
      throw new Error('Daughter-card mem read must be 1..128 bytes within 0..2031.');
    }

    this._emitStatus(`GET_DAUGHTER_CARD_MEM ${length}B @ ${offset} → waiting for ACK then RSP…`);
    const cmd = new Uint8Array([
      OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND,
      length & 0xff,
      offset & 0xff,
      (offset >> 8) & 0xff,
    ]);

    /* Response is [DAUGHTER_CARD_MEM_RSP][length][data...] — same framing
     * rationale as readInfoMem() above. The 64-byte brand record exceeds one
     * BLE notification, so the reassembly in the helper is load-bearing here. */
    return this._readLengthPrefixedResponse(
      cmd,
      OPCODES.DAUGHTER_CARD_MEM_RESPONSE,
      length,
      'Daughter-card mem read',
    );
  }

  /**
   * Write to the daughter-card (expansion board) EEPROM memory. `offset` is a
   * HOST offset (see {@link readDaughterCardMem}). Max 128 bytes per write.
   */
  async writeDaughterCardMem(offset: number, data: Uint8Array): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
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
    await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('Daughter-card mem write ACKed');
  }

  /**
   * Read the device's MAC address from InfoMem and return it as 12 uppercase hex
   * characters (e.g. "2601140185B8") — byte order as stored, matching the
   * identifier format used by Verisense.
   */
  async getMacAddress(): Promise<string> {
    const bytes = await this.readInfoMem(INFOMEM_MAC_OFFSET, MAC_LENGTH);
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

  // ---------------------------------------------------------------------------
  // InfoMem configuration over the radio
  // ---------------------------------------------------------------------------

  /**
   * Write one chunk of the device's InfoMem (SET_INFOMEM_COMMAND 0x8C, args
   * `[len][offsetLo][offsetHi][data…]`), resolving on the firmware's ACK — the
   * counterpart of {@link readInfoMem}, and the primitive that made configuring
   * a sensor over the radio possible at all: until this existed the client could
   * read the configuration image a page at a time and had no way to put one
   * back.
   *
   * `data` is at most 128 bytes, the firmware's own ceiling for the command
   * (`Comms/shimmer_bt_uart.c:1322-1327`, which also requires
   * `offset + len <= NV_NUM_RWMEM_BYTES`, 512 on this firmware); a longer chunk
   * or an out-of-range offset is NACKed rather than truncated. Most callers want
   * {@link writeInfoMemBytes} or {@link writeInfoMemConfig}, which chunk a whole
   * image for them; this is the byte-level escape hatch.
   *
   * The firmware refuses every SET while it is sensing
   * (`ShimBt_isCmdBlockedWhileSensing`, 0x8C included), so a write during
   * streaming or SD logging comes back as a NACK.
   *
   * HARDWARE-VERIFY: no real Shimmer3R has taken an InfoMem write over this
   * transport yet — the command layout is the Java driver's and the firmware's,
   * but the round trip is unconfirmed.
   */
  async writeInfoMem(address: number, data: Uint8Array): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (!Number.isInteger(address) || address < 0 || address > 0xffff) {
      throw new Error('InfoMem address must be an integer in 0..65535.');
    }
    if (data.length < 1 || data.length > INFOMEM_PAGE_SIZE) {
      throw new Error(`InfoMem write must be 1..${INFOMEM_PAGE_SIZE} bytes.`);
    }
    this._emitStatus(`SET_INFOMEM ${data.length}B @ ${address} → waiting for ACK…`);
    const cmd = new Uint8Array(4 + data.length);
    cmd[0] = OPCODES.SET_INFOMEM_COMMAND;
    cmd[1] = data.length & 0xff;
    cmd[2] = address & 0xff;
    cmd[3] = (address >> 8) & 0xff;
    cmd.set(data, 4);
    await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('InfoMem write ACKed');
  }

  /**
   * Read the whole {@link INFOMEM_SIZE}-byte configuration image in 128-byte
   * page reads (D → C → B), reassembled in order.
   *
   * The page addresses sent depend on the firmware and hardware — legacy MSP430
   * absolute 0x1800/0x1880/0x1900 versus flat 0/128/256 — and are resolved by
   * {@link resolveInfoMemLayout} from the device's own version replies, never
   * hard-coded here. A Shimmer3 on old firmware genuinely addresses its InfoMem
   * differently from a Shimmer3R, and this client talks to both, so the version
   * reads that {@link _infoMemCtx} performs are load-bearing rather than
   * defensive.
   */
  async readInfoMemBytes(): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    return this._readInfoMemBytesImpl(await this._infoMemCtx());
  }

  /**
   * Write a whole {@link INFOMEM_SIZE}-byte configuration image, chunked, each
   * chunk resolving on its own ACK.
   *
   * `opts.chunkBytes` defaults to **64 over a framed (BLE) transport and 128
   * over an unframed one**. 128 is the firmware's ceiling and the page size the
   * dock path uses, and it is what a byte stream — Classic Bluetooth over
   * RFCOMM, or the dock UART — carries happily. Over BLE the proven size is 64:
   * that is what the brand-record write survives on real hardware, where a
   * 128-byte command has to cross four notifications into a firmware receive
   * buffer that has overflowed on smaller records before (DEV-802). Pass
   * `chunkBytes` to override either default.
   *
   * Note that 64-byte chunks split each page in two, and the firmware does its
   * own bookkeeping on a chunk that starts exactly at a page base: writing
   * offset 0 makes it regenerate the calibration dump from config bytes, and
   * writing offset 128 makes it overwrite the MAC bytes and (on a Shimmer3R)
   * regenerate the dump again (`Comms/shimmer_bt_uart.c:1322-1360`). It also
   * runs `checkAndCorrectConfig` after every chunk, so a page is briefly half
   * old and half new — the same window the page-at-a-time dock write has
   * between pages, not a new one.
   *
   * Refuses while this client believes it is streaming: the firmware NACKs a
   * SET mid-stream, and a NACK partway through would leave a half-written image
   * on the device, which is far worse than not starting.
   */
  async writeInfoMemBytes(bytes: Uint8Array, opts: { chunkBytes?: number } = {}): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (bytes.length !== INFOMEM_SIZE) {
      throw new Error(`writeInfoMemBytes expects ${INFOMEM_SIZE} bytes, got ${bytes.length}`);
    }
    this._assertNotSensingForConfigWrite('InfoMem write');
    return this._writeInfoMemBytesImpl(
      await this._infoMemCtx(),
      bytes,
      this._infoMemChunkBytes(opts.chunkBytes),
    );
  }

  /**
   * Read and decode the device's configuration — {@link readInfoMemBytes}
   * followed by {@link parseInfoMem} against the same resolved layout, so every
   * field arrives named rather than as an offset a caller has to know.
   */
  async readInfoMemConfig(): Promise<InfoMemDeviceConfig> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    const ctx = await this._infoMemCtx();
    return parseInfoMem(await this._readInfoMemBytesImpl(ctx), ctx);
  }

  /**
   * Encode and write a configuration to the device over the radio — the
   * radio-side counterpart of `WiredShimmerClient.writeInfoMemConfig`, with the
   * same ordering and the same verify semantics, so a host can offer one
   * configuration screen for a docked and a connected sensor.
   *
   * The image is generated with device-write finalization: the MAC is forced to
   * all-0xFF and the config-file-creation flag is set, so the firmware re-reads
   * its MAC from the Bluetooth transceiver and regenerates its SD configuration.
   *
   * When `opts.setRtc` (default `true`, matching both the dock client and
   * desktop Consensys), the real-world clock is written FIRST from the host
   * time and only then the InfoMem — the order desktop
   * `CallableWriteConfig.call()` uses (BasicDock.java:1556-1587). An RTC failure
   * ABORTS the config write rather than being tolerated: the InfoMem write is
   * not attempted, matching the Java rethrow. The clock is written as a plain
   * Unix epoch; {@link setRtcTime} carries the detail.
   *
   * `opts.verify` (default `true`) re-reads the image afterwards and byte-
   * compares it against what was sent, EXCLUDING the ranges a device write
   * legitimately diverges in — the MAC the firmware overwrites and the
   * config-delay/config-file-creation flag byte it rewrites
   * ({@link deviceWriteDivergentRanges}). Returns `{ verified: boolean }`, or
   * `{ verified: null }` when verification was not attempted.
   *
   * Refuses before writing anything if this client believes it is streaming.
   *
   * HARDWARE-VERIFY: that the device accepts the write, applies it, and
   * regenerates its SD configuration can only be confirmed on real hardware.
   */
  async writeInfoMemConfig(
    config: InfoMemDeviceConfig,
    opts: { verify?: boolean; setRtc?: boolean } = {},
  ): Promise<{ verified: boolean | null }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    this._assertNotSensingForConfigWrite('Configuration write');
    const ctx = await this._infoMemCtx();
    // (1) RTC first, exactly as desktop CallableWriteConfig orders it. A
    //     rejection here propagates, so nothing is written to the InfoMem.
    if (opts.setRtc ?? true) await this.setRtcTime(Date.now());
    // (2) the chunked image write.
    const bytes = generateInfoMem(config, ctx, { base: config.raw, forDeviceWrite: true });
    await this._writeInfoMemBytesImpl(ctx, bytes, this._infoMemChunkBytes());
    if (!(opts.verify ?? true)) return { verified: null };
    const readback = await this._readInfoMemBytesImpl(ctx);
    const verified = compareInfoMemExcluding(bytes, readback, deviceWriteDivergentRanges(ctx));
    this._emitStatus(`Configuration write ${verified ? 'verified' : 'MISMATCHED on read-back'}`);
    return { verified };
  }

  /**
   * Ask the firmware to regenerate its SD-card configuration file from the
   * current InfoMem (UPD_SDLOG_CFG_COMMAND 0x9C, no arguments, ACK only).
   *
   * A configuration write updates the InfoMem the firmware samples with; the
   * text configuration file on the SD card, which a later offline analysis
   * reads to learn what the recording was configured as, is only rewritten when
   * the firmware is told to. Call this after {@link writeInfoMemConfig} when the
   * sensor will record to its card, so the card and the InfoMem agree.
   *
   * NACKed while sensing, like every other SET.
   */
  async updateSdLogConfig(): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    this._assertNotSensingForConfigWrite('SD configuration update');
    this._emitStatus('UPD_SDLOG_CFG → waiting for ACK…');
    await this._writeExpectingAck(new Uint8Array([OPCODES.UPD_SDLOG_CFG_COMMAND]), 1500);
    this._emitStatus('SD log configuration regenerated from InfoMem');
  }

  /**
   * Ask the firmware to apply its in-RAM calibration dump to its configuration
   * bytes and SD header, and to persist it (UPD_CALIB_DUMP_COMMAND 0x9B, no
   * arguments, ACK only).
   *
   * This is what makes a {@link writeCalibDump} take effect. The firmware also
   * applies a dump by itself the moment the bytes it has received add up to the
   * length the dump's own header declared
   * (`ShimCalib_ramWrite`, `Calibration/shimmer_calibration.c:330-370`), so on a
   * complete write this is a re-apply rather than the only trigger — which is
   * exactly why it is worth sending: it is also the way to apply a dump whose
   * declared length the host did not finish delivering.
   *
   * NACKed while sensing.
   */
  async updateCalibDump(): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    this._assertNotSensingForConfigWrite('Calibration dump update');
    this._emitStatus('UPD_CALIB_DUMP → waiting for ACK…');
    await this._writeExpectingAck(new Uint8Array([OPCODES.UPD_CALIB_DUMP_COMMAND]), 1500);
    this._emitStatus('Calibration dump applied to configuration bytes');
  }

  /**
   * Build the InfoMem layout context from the device's own version replies.
   *
   * Both reads are cached on the client (and cleared on reconnect), so asking
   * for it costs at most one round trip each per connection — cheap enough that
   * every InfoMem entry point can ask rather than making callers remember to
   * call {@link readDeviceVersion} first, which is the dock client's contract
   * only because a dock caches an identity for a slot.
   */
  private async _infoMemCtx(): Promise<InfoMemContext> {
    const dv = await this.readDeviceVersion();
    const fv = await this.readFwVersion();
    return {
      hardwareVersion: dv.hardwareVersion,
      firmwareId: fv.fwId,
      // `patch` is the Java driver's `firmwareVersionInternal` — the third
      // component of the version, not a separate field.
      firmwareVersion: { major: fv.major, minor: fv.minor, internal: fv.patch },
    };
  }

  /**
   * Chunk size for an InfoMem write: the caller's value when given, else 64 on
   * a framed (BLE) transport and the firmware's full 128 on a byte stream.
   * See {@link writeInfoMemBytes} for why the BLE default is lower.
   */
  private _infoMemChunkBytes(requested?: number): number {
    if (requested !== undefined) {
      if (!Number.isInteger(requested) || requested < 1 || requested > INFOMEM_PAGE_SIZE) {
        throw new Error(`chunkBytes must be an integer in 1..${INFOMEM_PAGE_SIZE}.`);
      }
      return requested;
    }
    return this._unframed ? INFOMEM_PAGE_SIZE : SHIMMER3R_INFOMEM_BLE_CHUNK_BYTES;
  }

  /**
   * Refuse a configuration write while this client believes it is streaming.
   *
   * The firmware would NACK it (`ShimBt_isCmdBlockedWhileSensing`), and a NACK
   * arriving partway through a chunked write leaves a half-written image on the
   * device. A named refusal also reads far better than the ACK timeout the same
   * situation used to produce.
   *
   * The guard is **only** as good as `_streaming`, which tracks the streams
   * this client started. The firmware blocks configuration writes for anything
   * it considers sensing, SD logging included, and this client holds no local
   * SD-logging flag — {@link getStatus} is the only way to learn about a log
   * started before it connected or by another host. So a write can still be
   * refused by the device after passing this check; that refusal arrives as a
   * NACK and is reported as one. The message says as much rather than implying
   * the check covers both.
   */
  /**
   * Refuse a configuration write the firmware would reject anyway.
   *
   * Covers what this client started, streaming or streaming-plus-SD-logging,
   * since both set the same flag. It cannot cover a recording the client did
   * not start — one begun with the sensor's own button, or by a scheduled
   * trial — because no local flag is set for those; there the device NACKs the
   * write, which surfaces as a failure rather than as this refusal.
   * {@link getStatus} reports the sensor's actual sensing and SD-logging state
   * for a caller that wants to know before trying.
   */
  private _assertNotSensingForConfigWrite(what: string): void {
    if (this._streaming) {
      throw new Error(
        `${what} is unavailable while this client is streaming — the firmware ` +
          'refuses every configuration write while the sensor is sensing. Call ' +
          'stopStreaming(), or stopStreamingAndLogging() if the recording was ' +
          'started with startStreamingAndLogging(), which sets the same flag.',
      );
    }
  }

  /** Paged InfoMem read (D → C → B) against an already-resolved context. */
  private async _readInfoMemBytesImpl(ctx: InfoMemContext): Promise<Uint8Array> {
    const layout = resolveInfoMemLayout(ctx);
    const pageAddrs = [layout.addrD, layout.addrC, layout.addrB];
    const out = new Uint8Array(INFOMEM_SIZE);
    for (let i = 0; i < pageAddrs.length; i++) {
      const chunk = await this.readInfoMem(pageAddrs[i], INFOMEM_PAGE_SIZE);
      if (chunk.length < INFOMEM_PAGE_SIZE) {
        throw new Error(
          `InfoMem page ${i} short read: expected ${INFOMEM_PAGE_SIZE} bytes, got ${chunk.length}`,
        );
      }
      out.set(chunk.subarray(0, INFOMEM_PAGE_SIZE), i * INFOMEM_PAGE_SIZE);
    }
    return out;
  }

  /**
   * Chunked InfoMem write against an already-resolved context.
   *
   * Addresses advance flat from the D-page base rather than being taken per
   * page, which is correct for both address bases because the three pages are
   * contiguous in each (0/128/256, and 0x1800/0x1880/0x1900). With the default
   * 128-byte chunk this reproduces the dock client's page-at-a-time write
   * exactly.
   */
  private async _writeInfoMemBytesImpl(
    ctx: InfoMemContext,
    bytes: Uint8Array,
    chunkBytes: number,
  ): Promise<void> {
    const base = resolveInfoMemLayout(ctx).addrD;
    for (let off = 0; off < INFOMEM_SIZE; off += chunkBytes) {
      const end = Math.min(off + chunkBytes, INFOMEM_SIZE);
      await this.writeInfoMem(base + off, bytes.subarray(off, end));
    }
    this._emitStatus(`InfoMem image written (${INFOMEM_SIZE}B in ${chunkBytes}B chunks)`);
  }

  // ---------------------------------------------------------------------------
  // Real-world clock (RWC)
  // ---------------------------------------------------------------------------

  /**
   * Read the device's real-world clock (GET_RWC_COMMAND).
   *
   * The response payload is the current RTC value as a 64-bit little-endian
   * tick count at 32768 Hz since the Unix epoch (the same unit SET_RWC writes:
   * `ticks = ms * 32.768`). Intended for RTC drift measurement (DEV-844 /
   * DEV-866): pair the returned time with a host timestamp taken at the
   * midpoint of the round-trip and feed {@link RtcDriftMonitor}.
   *
   * @returns the raw tick count plus the conversion to Unix milliseconds.
   */
  async getRtcTime(): Promise<{ ticks: bigint; unixMs: number }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    const remainder = await this._writeExpectingAck(
      new Uint8Array([OPCODES.GET_RWC_COMMAND]),
      1500,
    );
    const rsp =
      remainder && remainder[0] === OPCODES.RWC_RESPONSE
        ? remainder
        : await this._waitForResponse(OPCODES.RWC_RESPONSE, 2000);

    // Response is [RWC_RSP][8 bytes LSB-first]. Deliberately opcode-framed
    // ONLY (the firmware always opcode-frames the RWC response, and both paths
    // above select on the opcode): an opcode-less 8-byte chunk could be an
    // unrelated notification and must not be mis-read as a clock value — the
    // same policy as readInfoMem.
    if (rsp[0] !== OPCODES.RWC_RESPONSE || rsp.length < 9) {
      throw new Error(`Malformed RWC response (${rsp.length} bytes).`);
    }
    let ticks = 0n;
    for (let i = 8; i >= 1; i--) {
      ticks = (ticks << 8n) | BigInt(rsp[i]);
    }
    return { ticks, unixMs: Number(ticks) / 32.768 };
  }

  /**
   * Set the device's real-world clock (SET_RWC_COMMAND) to the given Unix
   * millisecond time, encoded as 64-bit little-endian 32768 Hz ticks via the
   * same {@link msToRtcBytesLE} helper as the dock path (truncating, matching
   * the Java driver's `(long)(ms * 32.768)`). Call with `Date.now()` to sync
   * the device clock to the host before a drift run.
   * The value is a plain Unix epoch: desktop Consensys and the Java dock
   * driver both write `System.currentTimeMillis() * 32.768`, and hardware set
   * by either reads back as UTC. (The Verisense console's local-civil
   * convention is that product's, not this one's — do not carry it across.)
   * For drift measurement only the rate matters, not the epoch.
   */
  async setRtcTime(unixMs: number): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (!Number.isFinite(unixMs)) {
      throw new Error('setRtcTime: unixMs must be a finite number.');
    }
    const cmd = new Uint8Array(9);
    cmd[0] = OPCODES.SET_RWC_COMMAND;
    cmd.set(msToRtcBytesLE(unixMs), 1);
    await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('RWC set');
  }

  // ---------------------------------------------------------------------------
  // ExG (ADS1292R) live configuration — GET / SET / preset apply
  //
  // Codec-driven port of the Java ExG BT command flow
  // (ShimmerBluetooth.readEXGConfigurations / writeEXGConfiguration, :4014-4226),
  // replacing the hardcoded 16-bit-only preset instruction arrays this section
  // used to carry. The register banks now come from the shared, transport-free
  // codec in `../exg/` and the GET/SET framing from `../exg/live.ts`, so
  // Shimmer3R and classic Shimmer3 share one definition of both.
  // ---------------------------------------------------------------------------

  /**
   * Read both ExG chips' 10-byte register banks over the radio
   * (GET_EXG_REGS ×2 → EXG_REGS_RESPONSE decode). Ported from
   * ShimmerBluetooth.readEXGConfigurations, which issues one GET for CHIP1 then
   * one for CHIP2 (ShimmerBluetooth.java:4014-4018).
   *
   * @throws Error when not connected, or while streaming — the read-back needs
   *   the control plane, which the data plane owns for the duration of a stream.
   */
  async readExgConfig(timeoutMs = 2000): Promise<{ exg1: Uint8Array; exg2: Uint8Array }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) throw new Error('Cannot read ExG registers while streaming');
    const exg1 = await this._readExgChip(EXG_CHIP1, timeoutMs);
    const exg2 = await this._readExgChip(EXG_CHIP2, timeoutMs);
    return { exg1, exg2 };
  }

  /**
   * Read one chip's bank. EXG_REGS_RESPONSE is `[0x62][count][reg0..reg9]` — the
   * byte after the opcode is the register COUNT the firmware is returning, which
   * it echoes from the request (`*(resPacket + packet_length++) = exgLength`,
   * `log-and-stream-common/Comms/shimmer_bt_uart.c:2227-2229`). That is the same
   * length-prefixed shape as an InfoMem or daughter-card read, so this reuses
   * {@link _readLengthPrefixedResponse} and inherits its ACK-piggyback handling,
   * notification reassembly, and tolerance of firmware that omits the prefix.
   */
  private async _readExgChip(chip: ExgChipIndex, timeoutMs: number): Promise<Uint8Array> {
    return this._readLengthPrefixedResponse(
      buildGetExgRegsCommand(chip),
      OPCODES.EXG_REGS_RESPONSE,
      EXG_BANK_LENGTH,
      `ExG chip ${chip + 1} register read`,
      1,
      1500,
      timeoutMs,
    );
  }

  /**
   * Write both ExG chips' 10-byte register banks over the radio
   * (SET_EXG_REGS ×2), then read them back and verify.
   *
   * Ports ShimmerBluetooth.writeEXGConfiguration (:4222-4226) — one 14-byte
   * instruction per chip — with the Shimmer3R-specific oversampling-ratio
   * injection into REG1 (see {@link _injectOversamplingRatio}).
   *
   * WRITE-SAFETY DEVIATION FROM JAVA: the Java driver fires SET_EXG_REGS and does
   * not verify, relying on a timeout→disconnect failsafe if the write silently
   * fails (ShimmerBluetooth.java:4212-4216; the register array is cached
   * driver-side on the bare ACK, :2132). The safer flow is ported instead:
   * SET → await ACK → GET read-back → compare, ignoring only the read-only REG8
   * status byte → throw on mismatch. A bad or no-op write therefore surfaces here
   * rather than as a puzzling disconnect later.
   *
   * @throws Error when not connected, while streaming, or on a read-back mismatch.
   * @throws RangeError when either bank is not exactly 10 bytes.
   */
  async writeExgConfig(exg1: Uint8Array, exg2: Uint8Array): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) throw new Error('Cannot write ExG registers while streaming');
    if (exg1.length !== EXG_BANK_LENGTH || exg2.length !== EXG_BANK_LENGTH) {
      throw new RangeError(
        `ExG register banks must be exactly ${EXG_BANK_LENGTH} bytes each, got ${exg1.length}/${exg2.length}.`,
      );
    }

    const b1 = this._injectOversamplingRatio(exg1);
    const b2 = this._injectOversamplingRatio(exg2);

    await this._writeExpectingAck(buildSetExgRegsCommand(EXG_CHIP1, b1), 1500);
    await this._writeExpectingAck(buildSetExgRegsCommand(EXG_CHIP2, b2), 1500);

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
   * Shimmer3R-only: overwrite REG1's (bank byte 0) low 3 bits with the ADS1292R
   * oversampling ratio for the current sampling rate. This reproduces exactly
   * what the previous `_writeExgPages` did — `exg[4] = ((exg[4] >> 3) << 3) |
   * ratio`, where byte 4 of the old 14-byte instruction was register byte 0 — and
   * keeps using {@link getOversamplingRatioADS1292R} rather than the codec's
   * `exgRateSettingFromFreq`. The two disagree on purpose: this one uses strict
   * `<` thresholds (calibration.ts:89, the live-BT path) where the docked
   * InfoMem/config-generation path uses `<=` (SensorEXG.setExGRateFromFreq), so
   * they differ at exactly the boundary rates. Classic Shimmer3 does neither —
   * ShimmerBluetooth.writeEXGConfiguration writes reg[0] verbatim (:4224).
   */
  private _injectOversamplingRatio(bank: Uint8Array): Uint8Array {
    const ratio = getOversamplingRatioADS1292R(this.samplingRateHz);
    const out = new Uint8Array(bank);
    out[0] = (((out[0] >> 3) << 3) | ratio) & 0xff;
    return out;
  }

  /**
   * Apply an ExG preset live: derive the register banks and the enabled-sensors
   * bitmap from the client's current inquiry state (sampling rate, enabled
   * sensors) via the codec's `applyExgPreset`, write the registers, then update
   * the bitmap.
   *
   * ORDER: ExG registers first, enabled sensors LAST. The desktop write flow
   * marks `writeEnabledSensors(...)` "this should always be the last command"
   * (ShimmerBluetooth.java:2732,2735) and runs `writeEXGConfiguration()` earlier
   * in the same flow (:2670). {@link setSensors} re-inquires, so the streaming
   * schema and `enabledSensors` end up reflecting the new preset.
   */
  async applyExgPresetLive(preset: ApplicableExgPreset, resolution: ExgResolution): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
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

    // Seeded from the device's current banks so that the oscillator-clock
    // PRESERVE path is honoured on hardware whose joined-clock state cannot be
    // inferred from the hardware id (a classic Shimmer3 with a rev >= 4 unified
    // ExG board). On a Shimmer3R the banks are fully determined by the preset.
    const current = await this.readExgConfig();
    const result = applyExgPreset(
      {
        exg1: current.exg1,
        exg2: current.exg2,
        enabledSensors: this.enabledSensors,
        samplingRateHz: this.samplingRateHz,
        hardwareVersion: HW_ID.SHIMMER_3R,
      },
      preset,
      resolution,
    );

    await this.writeExgConfig(result.exg1, result.exg2);
    // Enabled sensors last; setSensors re-inquires and refreshes the schema.
    await this.setSensors(result.enabledSensors);
    this._emitStatus(`ExG preset '${preset}' (${resolution}) applied. Schema updated.`);
  }

  /**
   * Enable EMG (ADS1292R) in 16-bit mode.
   *
   * Thin wrapper over {@link applyExgPresetLive} so the preset bytes have exactly
   * one source (`EXG_PRESET_ARRAYS` in `../exg/presets.ts`). NOTE that, following
   * the Java driver, the EMG preset powers chip 2 down and so enables the chip-1
   * resolution flag ONLY (SensorEXG.setExgChannelBitsPerMode, :2162-2182); the
   * hardcoded version of this helper enabled both chips' 16-bit flags and
   * streamed two channels of powered-down noise.
   */
  async enableEMG16Bit(): Promise<void> {
    await this.applyExgPresetLive('emg', '16bit');
  }

  /**
   * Enable the ExG test signal in 16-bit mode (useful for verifying ExG hardware).
   * Thin wrapper over {@link applyExgPresetLive} — see {@link enableEMG16Bit}.
   */
  async enableEXGTestSignal16Bit(): Promise<void> {
    await this.applyExgPresetLive('test-signal', '16bit');
  }

  /**
   * Enable ECG in 16-bit mode on EXG1 & EXG2.
   * Thin wrapper over {@link applyExgPresetLive} — see {@link enableEMG16Bit}.
   */
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
  // Calibration dump over the radio
  // ---------------------------------------------------------------------------

  /**
   * Read the device's whole calibration dump (GET_CALIB_DUMP_COMMAND 0x9A →
   * `[0x99][len][offsetLo][offsetHi][data…]`), paged, and return both the raw
   * bytes and the parsed {@link CalibDump}.
   *
   * The dump is the device's own record of every per-sensor calibration it
   * holds — sensor id, range, when it was calibrated, and the 21-byte block
   * itself — which is more than {@link readCalibration} can learn from the
   * per-sensor GET commands: those return a block with no provenance, so a host
   * cannot tell a factory calibration from a default the firmware seeded.
   *
   * The dump's own length is the first thing read: the first two payload bytes
   * at offset 0 are a little-endian u16 and the total size is that value **+ 2**
   * (the length field is not counted in it), so this reads 128 bytes, takes the
   * total from the header, and pages the remainder. A length of 0 or one beyond
   * {@link MAX_CALIB_DUMP_BYTES} is rejected rather than paged after — an
   * unprovisioned or corrupt header would otherwise ask the host to walk 64 kB
   * of nothing.
   *
   * HARDWARE-VERIFY: unexercised against a real Shimmer3R. The chunked read
   * sequence is ported from the Java driver's `readMem(GET_CALIB_DUMP_COMMAND…)`
   * (ShimmerBluetooth.java:4450-4453) and matches the firmware handler, but the
   * round trip is unconfirmed — which is why {@link readCalibration} still
   * prefers the per-sensor commands for streaming calibration.
   */
  async readCalibDump(): Promise<{ bytes: Uint8Array; dump: CalibDump }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    const head = await this._readCalibDumpChunk(0, CALIB_DUMP_CHUNK_BYTES);
    if (head.length < 2) {
      throw new Error(`Calibration dump header too short (${head.length} bytes).`);
    }
    // +2: the u16 length field counts the bytes AFTER itself
    // (`ShimCalib_ramWrite`, Calibration/shimmer_calibration.c:346-349).
    const total = u16le(head, 0) + 2;
    if (total <= 2 || total > MAX_CALIB_DUMP_BYTES) {
      throw new Error(
        `Calibration dump reports an implausible length (${total} bytes); ` +
          `expected 3..${MAX_CALIB_DUMP_BYTES}. The device's calibration memory ` +
          'is probably unprovisioned.',
      );
    }
    const bytes = new Uint8Array(total);
    bytes.set(head.subarray(0, Math.min(head.length, total)), 0);
    for (let off = head.length; off < total; off += CALIB_DUMP_CHUNK_BYTES) {
      const len = Math.min(CALIB_DUMP_CHUNK_BYTES, total - off);
      const chunk = await this._readCalibDumpChunk(off, len);
      if (chunk.length < len) {
        throw new Error(
          `Calibration dump short read at offset ${off}: expected ${len} bytes, got ${chunk.length}`,
        );
      }
      bytes.set(chunk.subarray(0, len), off);
    }
    const dump = parseCalibDump(bytes);
    this._emitStatus(`Calibration dump: ${total}B, ${dump.records.length} record(s)`);
    return { bytes, dump };
  }

  /**
   * Write a calibration dump (SET_CALIB_DUMP_COMMAND 0x98, args
   * `[len][offsetLo][offsetHi][data…]`), chunked from offset 0, each chunk
   * resolving on its ACK, then — unless `opts.update` is `false` — apply it with
   * {@link updateCalibDump}.
   *
   * Writing must start at offset 0 and run forward: the firmware takes the
   * total length from the header bytes of the FIRST chunk and counts the
   * remainder in ("starting with offset > 2 is not accepted",
   * `Calibration/shimmer_calibration.c:343-346`), so an out-of-order write is
   * silently discarded — and discarded without a NACK, since the handler
   * ignores `ShimCalib_ramWrite`'s failure return. Chunk size follows the same
   * rule as {@link writeInfoMemBytes}: 64 over BLE, 128 over a byte stream.
   *
   * A dump written here is NOT the last word on the device's calibration: the
   * firmware regenerates its dump FROM the configuration bytes whenever InfoMem
   * page D (or, on a Shimmer3R, page C) is written
   * (`Comms/shimmer_bt_uart.c:1345-1360`), so a later
   * {@link writeInfoMemConfig} supersedes it. Write the dump after the
   * configuration, not before.
   *
   * Refuses while streaming; the firmware NACKs a SET while sensing.
   *
   * HARDWARE-VERIFY: unexercised against real hardware.
   */
  async writeCalibDump(
    bytes: Uint8Array,
    opts: { update?: boolean; chunkBytes?: number } = {},
  ): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (bytes.length < 3 || bytes.length > MAX_CALIB_DUMP_BYTES) {
      throw new Error(
        `Calibration dump must be 3..${MAX_CALIB_DUMP_BYTES} bytes, got ${bytes.length}.`,
      );
    }
    this._assertNotSensingForConfigWrite('Calibration dump write');
    const chunkBytes = this._infoMemChunkBytes(opts.chunkBytes);
    for (let off = 0; off < bytes.length; off += chunkBytes) {
      const chunk = bytes.subarray(off, Math.min(off + chunkBytes, bytes.length));
      const cmd = new Uint8Array(4 + chunk.length);
      cmd[0] = OPCODES.SET_CALIB_DUMP_COMMAND;
      cmd[1] = chunk.length & 0xff;
      cmd[2] = off & 0xff;
      cmd[3] = (off >> 8) & 0xff;
      cmd.set(chunk, 4);
      this._emitStatus(`SET_CALIB_DUMP ${chunk.length}B @ ${off} → waiting for ACK…`);
      await this._writeExpectingAck(cmd, 1500);
    }
    this._emitStatus(`Calibration dump written (${bytes.length}B in ${chunkBytes}B chunks)`);
    if (opts.update ?? true) await this.updateCalibDump();
  }

  /**
   * One GET_CALIB_DUMP round trip. The reply carries a 3-byte
   * `[len][offsetLo][offsetHi]` header before its payload — the firmware echoes
   * the request back — so the shared length-prefixed reader is told to skip
   * three rather than one.
   */
  private async _readCalibDumpChunk(offset: number, length: number): Promise<Uint8Array> {
    const cmd = new Uint8Array([
      OPCODES.GET_CALIB_DUMP_COMMAND,
      length & 0xff,
      offset & 0xff,
      (offset >> 8) & 0xff,
    ]);
    this._emitStatus(`GET_CALIB_DUMP ${length}B @ ${offset} → waiting for ACK then RSP…`);
    return this._readLengthPrefixedResponse(
      cmd,
      OPCODES.RSP_CALIB_DUMP_COMMAND,
      length,
      'Calibration dump read',
      3,
      1500,
      2000,
      offset,
    );
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

  /**
   * Stop streaming (STOP_STREAMING_COMMAND 0x20), best-effort: the command goes
   * out and the state is cleared without waiting for the ACK the firmware sends
   * back.
   *
   * Not waiting is deliberate. Stream packets keep arriving for hundreds of ms
   * after the stop, and the framed path routes a notification to its ACK branch
   * on the first byte alone — so with an ACK outstanding a residual frame that
   * happened to begin 0xFF would be taken for the ACK and its tail forwarded to
   * the control plane, which is how a stray 0xFE fabricates a NACK and a stray
   * 0x02 frames a bogus inquiry. A notification is not frame-aligned, which is
   * why the stream parser resyncs on a double preamble, so that first byte can
   * be anything. `Shimmer3Client.stopStreaming` answers the same problem the
   * long way, draining to quiescence before it re-enables the control plane;
   * over BLE, where a notification is already one whole message, simply not
   * waiting is enough — and it costs nothing against firmware that does not
   * ACK a stop mid-stream at all.
   *
   * The price is that the ACK is still in flight when the next command goes
   * out, and `_expectingAck` counts rather than queues, so it is spent on that
   * command. {@link withoutLeadingAck} is what keeps that from costing the
   * command its own reply — read it before making this wait for the ACK after
   * all.
   */
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

  /**
   * Stop streaming AND SD card logging (STOP_SDBT_COMMAND 0x97), best-effort
   * and without waiting for its ACK, for the reasons {@link stopStreaming}
   * gives.
   */
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

  /**
   * Which generation's channel table this client uses to decode a packet.
   *
   * Read from the cached DEVICE_VERSION_RESPONSE when the host has asked for it
   * ({@link readDeviceVersion}); `'shimmer3r'` otherwise, because that is what
   * this client is named for and what its default transport connects to.
   *
   * The default is not always harmless. This client also drives a classic
   * Shimmer3 over an RFCOMM byte stream (the two platforms share this command
   * set), and the two generations disagree about the width of the
   * pressure/temperature channels — a Shimmer3 sends 2 big-endian bytes of
   * temperature where a Shimmer3R sends 3 little-endian ones, and reverses the
   * order of the pair. So call `readDeviceVersion()` before `inquiry()` on any
   * link that might be a Shimmer3; `inquiry()` deliberately does not send that
   * command itself, to keep the schema rebuild after `setSensors()` a single
   * round trip. When the generation is assumed *and* the channel list contains a
   * channel that depends on it, the schema says so (`trusted === false`) and a
   * status message names the channels.
   */
  get generation(): ShimmerGeneration {
    return generationFromHardwareVersion(this._deviceVersionCache?.hardwareVersion) ?? 'shimmer3r';
  }

  /** True when {@link generation} is this SDK's default rather than the device's answer. */
  get generationIsAssumed(): boolean {
    return generationFromHardwareVersion(this._deviceVersionCache?.hardwareVersion) === null;
  }

  private _buildSchemaFromChannels(channelIds: number[], timestampFmt: TimestampFmt): StreamSchema {
    const schema = buildStreamSchema(channelIds, timestampFmt, {
      generation: this.generation,
      generationAssumed: this.generationIsAssumed,
      dataPreambleByte: 0x00,
      // Schema problems have to reach the host, not just the schema object: a
      // guessed width shifts every later channel in the frame, and the decode
      // fails silently rather than throwing.
      onProblem: (m) => this._emitStatus(`⚠️ ${m}`),
    });
    this.enabledSensors = schema.enabledSensors;
    return schema;
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
    /*
     * Nothing may be written while a factory test holds the link. The firmware's
     * main loop is blocked for the whole suite (`shimmer_taskList.c:164`), so a
     * command sent now is not merely unanswered — it sits in the RX buffer and is
     * acted on minutes later, and its ACK lands in the middle of somebody's
     * report. Refusing here is what makes the report trustworthy.
     *
     * {@link runFactoryTest} writes its own command through the transport
     * directly, so this guard cannot lock out the very command that arms it.
     */
    if (this._factoryTest) {
      throw new FactoryTestError(
        'busy',
        'A factory test is running, or its report is still draining — ' +
          'await whenFactoryTestIdle() before sending another command.',
      );
    }
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
        // A NACK is the firmware's answer, so stop waiting for one that is not
        // coming. Several commands are refused outright while the device is
        // sensing (`ShimBt_isCmdBlockedWhileSensing`), and "NACK received" says
        // that; "ACK timeout" a second and a half later reads as a dead link.
        // Only reachable while a command is in flight — this handler is
        // registered for exactly that window — so a stray 0xFE cannot fabricate
        // one, and stream bytes never reach the control fan-out at all.
        if (chunk[0] === OPCODES.NACK_COMMAND_PROCESSED) {
          clearTimeout(t);
          this._offTemp(handler);
          reject(new Error('NACK received'));
          return;
        }
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
        // The expected opcode first, so a reply is never mistaken for framing;
        // then the same message with a stray ACK stepped over. Resolving with
        // the stripped buffer is what lets every caller keep reading its reply
        // from offset 0.
        const msg = chunk[0] === expectedOpcode ? chunk : withoutLeadingAck(chunk);
        if (msg[0] === expectedOpcode) {
          clearTimeout(t);
          this._offTemp(handler);
          resolve(msg);
        }
      };
      this._onTemp(handler);
    });
  }

  /**
   * Await an instream response — one of the messages the firmware answers
   * behind the shared `[0x8A]` prefix, where the byte after it selects the
   * message rather than the leading opcode.
   *
   * @param subOpcode   The byte after 0x8A (STATUS_RESPONSE, VBATT_RESPONSE …).
   * @param payloadLen  Minimum payload the message must carry to count, so a
   *   truncated one is waited past rather than parsed. A *minimum*, not an
   *   exact length: a Shimmer3 sends one status byte where a Shimmer3R sends
   *   two, and a caller that has not yet asked which it is talking to must not
   *   time out on the shorter answer.
   */
  private _waitForInstreamResponse(
    subOpcode: number,
    payloadLen: number,
    timeoutMs = 1500,
  ): Promise<Uint8Array> {
    const matches = (c: Uint8Array): boolean =>
      c.length >= 2 + payloadLen && c[0] === OPCODES.INSTREAM_CMD_RESPONSE && c[1] === subOpcode;
    /** The instream message a chunk carries, past any stray ACK in front. */
    const message = (c: Uint8Array): Uint8Array =>
      c[0] === OPCODES.INSTREAM_CMD_RESPONSE ? c : withoutLeadingAck(c);

    // BLE packs [0xFF][0x8A][0x71]… into a single notification, so the reply may
    // already be sitting in the ACK's remainder — the same synchronous hand-over
    // `_waitForResponse` performs for a plain opcode. Without this the message
    // has been and gone by the time the waiter registers.
    const rem = this._lastAckRemainder;
    if (rem && matches(rem)) {
      this._lastAckRemainder = null;
      return Promise.resolve(rem);
    }

    return new Promise<Uint8Array>((resolve, reject) => {
      const t = setTimeout(() => {
        this._offTemp(handler);
        reject(new Error(`Instream response 0x${hex2(subOpcode)} timeout`));
      }, timeoutMs);

      const handler = (chunk: Uint8Array): void => {
        if (!chunk) return;
        const msg = message(chunk);
        if (!matches(msg)) return;
        clearTimeout(t);
        this._offTemp(handler);
        resolve(msg);
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

  // ---------------------------------------------------------------------------
  // Firmware version (feature gating)
  // ---------------------------------------------------------------------------

  private _fwVersionCache: { fwId: number; major: number; minor: number; patch: number } | null =
    null;
  private _deviceVersionCache: Shimmer3DeviceVersion | null = null;

  /**
   * Read (and cache) the hardware version via GET_DEVICE_VERSION_COMMAND
   * (0x3F → `[0x25][hw]`). 3 = Shimmer3, 10 = Shimmer3R.
   *
   * Worth asking even though this client is named for the Shimmer3R: the two
   * platforms share this firmware and this command set, so a Shimmer3 reached
   * over Classic Bluetooth answers here too — and answers some commands with
   * fewer bytes than a Shimmer3R does (see {@link getStatus}). Cached, so the
   * gating call sites can ask freely.
   */
  async readDeviceVersion(): Promise<Shimmer3DeviceVersion> {
    if (this._deviceVersionCache) return this._deviceVersionCache;
    if (!this._transport) throw new Error('Not connected (RX missing)');
    const cmd = new Uint8Array([OPCODES.GET_DEVICE_VERSION_COMMAND]);
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    const rsp =
      ackRemainder && ackRemainder[0] === OPCODES.DEVICE_VERSION_RESPONSE
        ? ackRemainder
        : await this._waitForResponse(OPCODES.DEVICE_VERSION_RESPONSE, 1500);
    if (rsp.length < 2) throw new Error('short DEVICE_VERSION_RESPONSE');
    this._deviceVersionCache = parseShimmer3DeviceVersionResponse(rsp);
    // A Shimmer3's firmware omits the usbPluggedIn status byte, so the framer
    // has to stop waiting for a byte that is never coming — and, worse, stop
    // swallowing the ACK that follows the status instead.
    this._statusPayloadBytes = this._deviceVersionCache.hardwareVersion === HW_ID.SHIMMER_3 ? 1 : 2;
    return this._deviceVersionCache;
  }

  // ---------------------------------------------------------------------------
  // Device status and battery
  // ---------------------------------------------------------------------------

  /**
   * Ask what the sensor is doing: docked, sensing, logging, streaming, SD card
   * present, RTC set (GET_STATUS_COMMAND 0x72 → `[0x8A][0x71][status0]…`).
   *
   * This is the only way to learn several of those. An inquiry reports the
   * *configuration*; only the status bytes say whether a recording is actually
   * running, whether the clock has been set since the sensor last lost power,
   * or whether the firmware failed to open its SD file.
   *
   * Call {@link readDeviceVersion} first when the platform is unknown: a
   * Shimmer3 answers with one status byte where a Shimmer3R sends two, and over
   * a byte stream the framer needs to know which before it can split the
   * message. Getting it wrong there consumes the ACK that follows.
   *
   * Calling it first also sharpens the failure mode here: with the platform
   * known, an answer shorter than that platform's status is a truncated message
   * and this rejects on timeout rather than returning a status whose
   * `usbPluggedIn` is `null`. While the platform is unknown the short answer is
   * still accepted, because it is indistinguishable from a Shimmer3's.
   */
  async getStatus(): Promise<Shimmer3DeviceStatus> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    // Claimed before the write, not after the ACK: the reply can arrive while
    // this method is still between awaits, and it must not be mistaken for an
    // unsolicited push in that window.
    this._statusReadsInFlight++;
    try {
      this._emitStatus('GET_STATUS → waiting for ACK then RSP…');
      const ackRemainder = await this._writeExpectingAck(
        new Uint8Array([OPCODES.GET_STATUS_COMMAND]),
        1500,
      );
      // Read once, so the ACK-remainder shortcut and the waiter that backs it
      // up agree on what counts as a whole message even if another caller
      // learns the platform mid-await.
      const need = this._minStatusPayloadBytes;
      const rsp =
        ackRemainder &&
        ackRemainder.length >= 2 + need &&
        ackRemainder[0] === OPCODES.INSTREAM_CMD_RESPONSE &&
        ackRemainder[1] === OPCODES.STATUS_RESPONSE
          ? ackRemainder
          : await this._waitForInstreamResponse(OPCODES.STATUS_RESPONSE, need, 1500);
      const status = parseShimmer3StatusBytes(rsp.subarray(2, 2 + this._statusPayloadBytes));
      this._emitStatus(
        `Status: docked=${status.docked} sensing=${status.sensing} ` +
          `logging=${status.sdLogging} streaming=${status.streaming} ` +
          `sdPresent=${status.sdPresent} rtcSet=${status.rtcSet}`,
      );
      return status;
    } finally {
      this._statusReadsInFlight--;
    }
  }

  /**
   * Read the battery ADC and charger state (GET_VBATT_COMMAND 0x95 →
   * `[0x8A][0x94][raw x3]`).
   *
   * The three payload bytes are the firmware's own `BattStatusRaw` union
   * (`Battery/shimmer_battery.h:60-74`): a little-endian 12-bit ADC reading
   * followed by the charger chip's STAT1/STAT2 bits. That is the same record the
   * dock UART carries, so this reuses {@link parseBatteryStatus} rather than
   * adding a second reading of the same bytes — including its voltage curve and
   * the percentage it declines to report when the reading is out of range.
   */
  async getBattery(): Promise<WiredBatteryStatus> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    this._emitStatus('GET_VBATT → waiting for ACK then RSP…');
    const ackRemainder = await this._writeExpectingAck(
      new Uint8Array([OPCODES.GET_VBATT_COMMAND]),
      1500,
    );
    const rsp =
      ackRemainder &&
      ackRemainder.length >= 5 &&
      ackRemainder[0] === OPCODES.INSTREAM_CMD_RESPONSE &&
      ackRemainder[1] === OPCODES.VBATT_RESPONSE
        ? ackRemainder
        : await this._waitForInstreamResponse(OPCODES.VBATT_RESPONSE, 3, 1500);
    const batt = parseBatteryStatus(rsp.subarray(2, 5));
    const pct = batt.percentage === null ? 'n/a' : `${batt.percentage.toFixed(1)}%`;
    this._emitStatus(
      `Battery: ${batt.voltage.toFixed(3)} V (${pct}), charger ${batt.chargingStatus}`,
    );
    return batt;
  }

  /** Read (and cache) the firmware version via GET_FW_VERSION_COMMAND. */
  async readFwVersion(): Promise<{ fwId: number; major: number; minor: number; patch: number }> {
    if (this._fwVersionCache) return this._fwVersionCache;
    if (!this._transport) throw new Error('Not connected (RX missing)');
    const cmd = new Uint8Array([OPCODES.GET_FW_VERSION_COMMAND]);
    const ackRemainder = await this._writeExpectingAck(cmd, 1500);
    const rsp =
      ackRemainder && ackRemainder[0] === OPCODES.FW_VERSION_RESPONSE
        ? ackRemainder
        : await this._waitForResponse(OPCODES.FW_VERSION_RESPONSE, 1500);
    if (rsp.length < 7) throw new Error('short FW_VERSION_RESPONSE');
    this._fwVersionCache = {
      fwId: rsp[1] | (rsp[2] << 8),
      major: rsp[3] | (rsp[4] << 8),
      minor: rsp[5],
      patch: rsp[6],
    };
    return this._fwVersionCache;
  }

  /**
   * True when the connected firmware serves the SD file-transfer commands
   * AND transfers them intact (LogAndStream_Shimmer3R >= v1.01.011).
   * v1.01.009 and v1.01.010 implement the protocol but ship every 512-byte
   * block shifted 3 bytes with a zero-padded tail — the firmware's sector DMA
   * landed below the misaligned payload buffer and the frame CRC was computed
   * after the fact, so the corruption arrives as valid frames the host cannot
   * detect. Those versions are therefore gated out. Firmware older than that
   * silently ignores unknown opcodes, so version gating is the only reliable
   * probe.
   */
  async supportsSdTransfer(): Promise<boolean> {
    try {
      const v = await this.readFwVersion();
      return v.major * 1_000_000 + v.minor * 1_000 + v.patch >= 1_001_011;
    } catch {
      return false;
    }
  }

  /**
   * Measure raw link throughput with the firmware's data-rate test
   * (SET_DATA_RATE_TEST): the device free-runs 5-byte counter packets as
   * fast as the link drains them and we count received bytes for
   * `durationMs`. This measures the pipe itself (BLE connection interval and
   * MTU, or RFCOMM/serial buffering) independent of the SD/file-transfer
   * protocol, so it gives an upper bound for transfer rates on a given
   * host/adapter/OS — and a direct BLE-vs-Classic-Bluetooth comparison.
   * The device must be idle (the firmware NACKs the test while sensing).
   */
  async runDataRateTest(
    durationMs = 5000,
    onProgress?: (bytesSoFar: number, elapsedMs: number) => void,
  ): Promise<{ bytesReceived: number; durationMs: number; kBps: number }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) throw new Error('Data-rate test unavailable while streaming');

    let counting = false;
    let bytes = 0;
    const counter = (chunk: Uint8Array): void => {
      if (counting) bytes += chunk.length;
    };
    this._onTemp(counter);
    try {
      await this._writeExpectingAck(new Uint8Array([OPCODES.SET_DATA_RATE_TEST, 1]), 2000);
      const startedAt = Date.now();
      counting = true;
      let elapsed = 0;
      while (elapsed < durationMs) {
        await new Promise((r) => setTimeout(r, Math.min(250, durationMs - elapsed)));
        elapsed = Date.now() - startedAt;
        onProgress?.(bytes, elapsed);
      }
      counting = false;
      const measuredMs = Date.now() - startedAt;
      return {
        bytesReceived: bytes,
        durationMs: measuredMs,
        kBps: measuredMs > 0 ? bytes / 1024 / (measuredMs / 1000) : 0,
      };
    } finally {
      this._offTemp(counter);
      try {
        await this._writeExpectingAck(new Uint8Array([OPCODES.SET_DATA_RATE_TEST, 0]), 2000);
      } catch {
        /* the stop ACK can be indistinguishable from residual test bytes */
      }
      // Drop any test bytes that were mistaken for stream data, or that are
      // still sitting in the re-framing accumulator on an unframed transport.
      this._rxBuf = new Uint8Array(0);
      this._ctrlBuf = new Uint8Array(0);
    }
  }

  // ---------------------------------------------------------------------------
  // Factory self-test (SET_FACTORY_TEST 0xA8) and the red-LED override
  // ---------------------------------------------------------------------------

  /**
   * What the factory-test runner is doing: `idle` when the link is free,
   * `running` while the report is being captured, `draining` while a cancelled
   * or timed-out report is still being swallowed.
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
   * Run the sensor's built-in factory self-test and return its report.
   *
   * `SET_FACTORY_TEST` (0xA8) with one type byte
   * (`Comms/shimmer_bt_uart.c:1285-1293`) makes the firmware ACK and then print
   * the same report it prints on the production line — as raw ASCII on this very
   * link, with no framing and no CRC (`Test/shimmer_test.c:22-61`). The
   * {@link FactoryTestCapture} owns those bytes for the duration; see its
   * docblock for the phases and the tail handoff.
   *
   * Three things about this command are unlike every other one here:
   * - **It cannot be stopped.** The firmware has no abort; its main loop is
   *   blocked for the whole suite (`shimmer_taskList.c:164`). `opts.signal`
   *   stops this client *listening*, and the link stays busy until the report
   *   ends — {@link whenFactoryTestIdle} is how a host waits that out.
   * - **Nothing else may be written meanwhile.** Every other command rejects
   *   with a {@link FactoryTestError} of reason `busy` until the capture is idle.
   * - **It is refused while sensing.** `ShimBt_isCmdBlockedWhileSensing`
   *   (`Comms/shimmer_bt_uart.c:2985`) NACKs it while streaming or logging, and
   *   also when SD sync is enabled.
   *
   * @param type 0 MAIN, 1 LEDS, 2 ICS, 3 LED_STATES (`Test/shimmer_test.h:21-27`).
   * @param opts see {@link FactoryTestRunOptions}; `timeoutMs` defaults to the
   *   type's own entry in `SHIMMER3_FACTORY_TEST_TYPES`.
   * @returns the report text, CRLF line endings intact.
   * @throws RangeError for a type the firmware would ACK and then print nothing
   *   for; {@link FactoryTestError} with reason `nack` (sensing), `busy`
   *   (another run), `no-response`, `timeout` or `disconnected`; or a
   *   `DOMException` named `AbortError` when `opts.signal` fires.
   *
   * HARDWARE-VERIFY: no real Shimmer3 or Shimmer3R has run this path yet.
   */
  async runFactoryTest(type: number, opts: FactoryTestRunOptions = {}): Promise<string> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    // Validated before anything is written, so an out-of-range type costs the
    // caller an exception rather than a minute of silence.
    const info = requireShimmer3FactoryTestType(type);
    if (this._factoryTest) {
      throw new FactoryTestError(
        'busy',
        'A factory test is already running, or its report is still draining — ' +
          'await whenFactoryTestIdle() first.',
      );
    }
    if (this._streaming) {
      throw new FactoryTestError(
        'nack',
        'The sensor is streaming, and the firmware refuses a factory self-test while it is. ' +
          'Stop the stream first.',
      );
    }
    /*
     * Nothing else may be mid-conversation. Once the capture is armed it owns
     * every inbound byte, so another command's response would be swallowed as
     * report text and its waiter would sit there until it timed out — and the
     * buffer flush below would take that command's partial response with it.
     * Both signals are needed: `_expectingAck` covers a command whose ACK has
     * not landed, and `_temps` covers one that has been acknowledged and is
     * still waiting for its payload (or an SD transfer, whose handler stays
     * attached for the whole transfer).
     */
    if (this._expectingAck > 0 || this._temps.size > 0) {
      throw new FactoryTestError(
        'busy',
        'Another command is still waiting for its response. A factory test takes over the whole ' +
          'link, so it cannot start until that one has finished.',
      );
    }
    if (opts.signal?.aborted) {
      throw new DOMException('Factory test aborted', 'AbortError');
    }

    /*
     * Preflight: ask what the sensor is doing so a refusal can say "it is
     * sensing" instead of arriving as a bare 0xFE two seconds later — the button
     * on the sensor can have started an SD recording this host knows nothing
     * about. Deliberately NOT fatal when the status read itself fails: an old or
     * busy firmware that will happily run the test must not be blocked by a
     * diagnostic.
     */
    if (opts.preflight ?? true) {
      try {
        const status = await this.getStatus();
        if (status.sensing) {
          throw new FactoryTestError(
            'nack',
            'The sensor is sensing — streaming, or recording to its SD card — and the firmware ' +
              'refuses a factory self-test while it is. Stop the stream or the SD recording first.',
          );
        }
      } catch (err) {
        if (err instanceof FactoryTestError) throw err;
        this._emitStatus(
          `Factory-test preflight status read failed (${(err as Error).message}); running anyway.`,
        );
      }
    }
    const transport = this._transport;
    if (!transport) throw new Error('Not connected (RX missing)');

    // Nothing left over from before may be mistaken for the first report line.
    this._rxBuf = new Uint8Array(0);
    this._ctrlBuf = new Uint8Array(0);

    const capture = new FactoryTestCapture(classifyLiteProtocolAck, {
      ...opts,
      timeoutMs: opts.timeoutMs ?? info.defaultTimeoutMs,
      onStateChange: (state) => {
        /* The release runs BEFORE the host is told, so a host that issues its
         * next command straight out of this callback is not refused by the busy
         * guard the run it was just told had ended. */
        if (state === 'idle') this._releaseFactoryTest();
        /* …and the host is told on a MICROTASK, not from inside `feed()`.
         * The capture is called from the notify handler, which has not yet
         * routed the tail bytes `feed()` just handed back — a late ACK, or a
         * status push glued to the TEST END banner. A host that sent its next
         * command straight out of a synchronous callback could have that
         * command's acknowledgement satisfied by the test's own leftovers.
         * Deferring by one microtask puts the callback after the routing and
         * before anything else, which is also where `whenFactoryTestIdle()`
         * already resolves. */
        queueMicrotask(() => {
          try {
            this.onFactoryTestStateChange?.(state);
          } catch (e) {
            this._log('onFactoryTestStateChange handler error', e);
          }
        });
      },
    });

    this._factoryTest = capture;
    capture.start();
    this._emitStatus(`SET_FACTORY_TEST ${info.name} → the sensor will print its report…`);
    try {
      // Straight to the transport: `_write` refuses everything while a capture
      // exists, and that guard must not lock out the command that arms it.
      await transport.write(buildSetFactoryTestCommand(info.value));
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
   * anything the report left in the accumulators. Called from the capture's own
   * `idle` transition, so it happens before the tail bytes it hands back are
   * routed through the framer.
   */
  private _releaseFactoryTest(): void {
    this._factoryTest = null;
    this._rxBuf = new Uint8Array(0);
    this._ctrlBuf = new Uint8Array(0);
    this._emitStatus('Factory test finished — the link is free again');
  }

  /**
   * Flip the firmware's red-LED override (`TOGGLE_LED_COMMAND` 0x06,
   * `Comms/shimmer_bt_uart.c:603, :910-914`).
   *
   * The command toggles `shimmerStatus.toggleLedRedCmd`, and while it is set the
   * LED manager holds the LOWER LED solid red (`LEDs/shimmer_leds.c:425-428`) —
   * above the SD-error and battery indications, below a button press. That makes
   * it the "which sensor is this one" aid.
   *
   * Two things to know: the flag is **never cleared by the firmware**, so it
   * survives a disconnect and stays lit until it is toggled again or the sensor
   * loses power; and it is readable back as status bit 7
   * (`ShimBt_assembleStatusBytes`, `:2920-2932`) — {@link Shimmer3DeviceStatus}
   * `redLedOn` — which is what {@link setRedLed} uses to make "on"/"off" mean
   * something.
   *
   * While streaming this writes without waiting for the ACK: every inbound byte
   * belongs to the data plane then, so the ACK would be consumed by the schema
   * parser and the wait would time out on a command the firmware did in fact run.
   *
   * HARDWARE-VERIFY: that the lower LED visibly lights, and that the flag really
   * does survive a disconnect, want confirming on a sensor.
   */
  async toggleLed(): Promise<void> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    const cmd = new Uint8Array([OPCODES.TOGGLE_LED_COMMAND]);
    if (this._streaming) {
      await this._write(cmd);
      this._emitStatus('TOGGLE_LED written (no ACK wait — streaming)');
      return;
    }
    await this._writeExpectingAck(cmd, 1500);
    this._emitStatus('TOGGLE_LED ACKed');
  }

  /**
   * Drive the red-LED override to a definite state rather than flipping it.
   *
   * The firmware offers only a toggle, so this is a read-modify-verify:
   * {@link getStatus} for the current bit, {@link toggleLed} only if it differs,
   * then a second read to confirm. Calling it twice with the same argument
   * writes nothing the second time.
   *
   * @returns the LED state read back from the sensor.
   * @throws when the sensor is streaming (the status reads are unavailable), or
   *   when the read-back does not match — which means something else moved the
   *   flag between the two reads, and silently reporting success would be worse
   *   than saying so.
   */
  async setRedLed(on: boolean): Promise<boolean> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) {
      throw new Error(
        'The red LED cannot be set while streaming: the state read it needs is lost in the ' +
          'stream data. Use toggleLed() if a blind flip will do.',
      );
    }
    const before = await this.getStatus();
    if (before.redLedOn === on) {
      this._emitStatus(`Red LED already ${on ? 'on' : 'off'}`);
      return on;
    }
    await this.toggleLed();
    const after = await this.getStatus();
    if (after.redLedOn !== on) {
      throw new Error(
        `Red LED did not follow: asked for ${on ? 'on' : 'off'}, the sensor reports ` +
          `${after.redLedOn ? 'on' : 'off'}.`,
      );
    }
    this._emitStatus(`Red LED ${on ? 'on' : 'off'}`);
    return after.redLedOn;
  }

  // ---------------------------------------------------------------------------
  // SD-card file transfer (FW >= v1.01.011; see supportsSdTransfer)
  //
  // A dedicated, self-resynchronising RX pipeline: while any SD operation is
  // active, a persistent temp handler accumulates notification chunks and
  // extracts length-delimited SD messages from them (multi-notification
  // reassembly). Unknown bytes are skipped one at a time so interleaved
  // traffic (e.g. unsolicited instream status responses) cannot jam it.
  // ---------------------------------------------------------------------------

  private _sdRx: Uint8Array = new Uint8Array(0);
  private _sdUsers = 0;
  private _sdHandlerAttached = false;
  private _sdExpect: { opcode: number; resolve: (body: Uint8Array) => void } | null = null;
  private _sdFrameListener: ((frame: SdDataFrame | SdStatusFrame) => void) | null = null;
  private _sdCrcErrorListener: (() => void) | null = null;
  private _sdKnownSession: number | null = null;

  private _sdAcquire(): void {
    this._sdUsers++;
    if (!this._sdHandlerAttached) {
      this._onTemp(this._sdChunkHandler);
      this._sdHandlerAttached = true;
    }
  }

  private _sdRelease(): void {
    this._sdUsers = Math.max(0, this._sdUsers - 1);
    if (this._sdUsers === 0 && this._sdHandlerAttached) {
      this._offTemp(this._sdChunkHandler);
      this._sdHandlerAttached = false;
      this._sdRx = new Uint8Array(0);
    }
  }

  private _sdChunkHandler = (chunk: Uint8Array): void => {
    // Lone ACKs are consumed by the command flow, not the SD pipeline
    if (chunk.length === 1 && chunk[0] === OPCODES.ACK_COMMAND_PROCESSED) return;
    this._sdRx = concatU8(this._sdRx, chunk);
    for (;;) {
      const r = tryExtractSdMessage(this._sdRx);
      if (r.crcError) {
        try {
          this._sdCrcErrorListener?.();
        } catch (e) {
          this._log('sd crc listener error', e);
        }
      }
      if (r.consumed === 0) break;
      this._sdRx = this._sdRx.slice(r.consumed);
      const m = r.msg;
      if (!m) continue;
      if (m.kind === 'oneshot') {
        if (this._sdExpect && m.opcode === this._sdExpect.opcode) {
          const e = this._sdExpect;
          this._sdExpect = null;
          e.resolve(m.body);
        }
      } else {
        try {
          this._sdFrameListener?.(m);
        } catch (e) {
          this._log('sd frame listener error', e);
        }
      }
    }
  };

  /**
   * Enforce the {@link supportsSdTransfer} gate on every SD entry point, so a
   * caller that skips the advisory check cannot pull silently-corrupted data
   * off a v1.01.009/.010 device. Must complete BEFORE the synchronous
   * single-slot checks (`_sdExpect`, `_sdFrameListener`): those are
   * check-then-set atomically only while no await sits between them.
   * (The first call costs one GET_FW_VERSION round trip; readFwVersion
   * caches it for the rest of the connection.)
   */
  private async _ensureSdTransferSupported(): Promise<void> {
    if (!(await this.supportsSdTransfer())) {
      throw new SdTransferError(
        'SD file transfer requires firmware v1.01.011 or later — v1.01.009/.010 corrupt transferred data',
        SD_STATUS.UNSUPPORTED_FW,
      );
    }
  }

  /** Send an SD command and await its reassembled one-shot response. */
  private async _sdCommand(
    cmd: Uint8Array,
    rspOpcode: number,
    timeoutMs = 5000,
  ): Promise<Uint8Array> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) {
      throw new SdTransferError('SD transfer is unavailable while streaming', SD_STATUS.BUSY);
    }
    await this._ensureSdTransferSupported();
    if (this._sdExpect) {
      // A shared expectation slot: concurrent SD commands would race on it,
      // so refuse deterministically — callers are expected to sequence
      throw new SdTransferError('another SD command is already in flight', SD_STATUS.BUSY);
    }
    this._sdAcquire();
    try {
      return await new Promise<Uint8Array>((resolve, reject) => {
        const t = setTimeout(() => {
          this._sdExpect = null;
          reject(new Error(`SD response 0x${rspOpcode.toString(16)} timeout`));
        }, timeoutMs);
        this._sdExpect = {
          opcode: rspOpcode,
          resolve: (b) => {
            clearTimeout(t);
            resolve(b);
          },
        };
        this._writeExpectingAck(cmd, timeoutMs)
          .then((ackRemainder) => {
            // When the ACK and the response share a notification the command
            // flow consumes the remainder — feed it back into the SD pipeline
            if (ackRemainder && ackRemainder.length) this._sdChunkHandler(ackRemainder);
          })
          .catch((e) => {
            clearTimeout(t);
            this._sdExpect = null;
            reject(e);
          });
      });
    } finally {
      this._sdRelease();
    }
  }

  /**
   * List a directory on the SD card, transparently following the firmware's
   * startIdx paging. Path example: `'data'` or
   * `'data/DefaultTrial_123/Shimmer_ABCD-000'`.
   */
  async sdListDir(path: string, opts: { maxEntriesPerPage?: number } = {}): Promise<SdDirEntry[]> {
    const entries: SdDirEntry[] = [];
    let startIdx = 0;
    for (;;) {
      const body = await this._sdCommand(
        buildListDirCmd(path, startIdx, opts.maxEntriesPerPage ?? SD_LIST_MAX_ENTRIES),
        SD_TRANSFER_OPCODES.LIST_DIR_RESPONSE,
      );
      const page = parseListDirRsp(body);
      if (page.status !== SD_STATUS.OK) {
        throw new SdTransferError(`list '${path}': ${sdStatusToString(page.status)}`, page.status);
      }
      entries.push(...page.entries);
      if (!page.hasMore) return entries;
      if (page.entries.length === 0) {
        throw new Error(`list '${path}': paging made no progress at index ${startIdx}`);
      }
      startIdx += page.entries.length;
    }
  }

  /** Stat one file or directory on the SD card. */
  async sdStatFile(path: string): Promise<SdFileStat> {
    const body = await this._sdCommand(buildStatCmd(path), SD_TRANSFER_OPCODES.FILE_STAT_RESPONSE);
    const { status, stat } = parseStatRsp(body);
    if (status !== SD_STATUS.OK) {
      throw new SdTransferError(`stat '${path}': ${sdStatusToString(status)}`, status);
    }
    return stat;
  }

  /** Query free/total space on the SD card (in KB). */
  async sdGetFreeSpace(): Promise<SdCardSpace> {
    // First call on a large FAT32 card can scan the FAT — allow extra time
    const body = await this._sdCommand(
      buildFreeSpaceCmd(),
      SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE,
      15000,
    );
    const { status, space } = parseFreeSpaceRsp(body);
    if (status !== SD_STATUS.OK) {
      throw new SdTransferError(`free space: ${sdStatusToString(status)}`, status);
    }
    return space;
  }

  /**
   * Delete one file (or empty directory) on the SD card. The firmware only
   * permits paths strictly under `data/`.
   */
  async sdDeletePath(path: string): Promise<void> {
    const body = await this._sdCommand(buildDeleteCmd(path), SD_TRANSFER_OPCODES.DELETE_RESPONSE);
    const { status } = parseDeleteRsp(body);
    if (status !== SD_STATUS.OK) {
      throw new SdTransferError(`delete '${path}': ${sdStatusToString(status)}`, status);
    }
  }

  /** Ask the firmware to abandon the in-flight read window, if any.
   * Deliberately NOT gated on {@link supportsSdTransfer}: it runs in cleanup
   * paths (abort signals, disconnects) where an extra version probe could
   * fail, and old firmware just ignores the unknown opcode. */
  async sdAbortTransfer(): Promise<void> {
    if (!this._transport) return;
    await this._writeExpectingAck(buildAbortCmd(), 2000);
  }

  /**
   * Read one window of a file. The firmware streams the window as CRC'd
   * blocks; `onBlock` is invoked for each verified block in order. Resolves
   * with the closing status frame. Rejects on stall, CRC failure or sequence
   * gap — the caller re-requests from its last good offset (the firmware is
   * stateless, so a fresh window is always a valid resume).
   */
  async sdReadFileWindow(
    path: string,
    offset: number,
    windowLen: number,
    opts: {
      blockPayloadLen?: number;
      stallTimeoutMs?: number;
      signal?: AbortSignal;
      onBlock?: (payload: Uint8Array, absOffset: number) => void;
    } = {},
  ): Promise<{ status: number; nextOffset: number; bytesReceived: number }> {
    if (!this._transport) throw new Error('Not connected (RX missing)');
    if (this._streaming) {
      throw new SdTransferError('SD transfer is unavailable while streaming', SD_STATUS.BUSY);
    }
    await this._ensureSdTransferSupported();
    if (this._sdFrameListener) {
      // The frame/CRC listeners are single-slot instance fields, so a second
      // overlapping window would hijack the first one's frames. Refuse
      // deterministically; the firmware serves one window at a time anyway.
      throw new SdTransferError('another SD read window is already in flight', SD_STATUS.BUSY);
    }
    const blockLen = opts.blockPayloadLen ?? SD_BLOCK_PAYLOAD_DEFAULT;
    const stallTimeoutMs = opts.stallTimeoutMs ?? 6000;

    this._sdAcquire();
    try {
      return await new Promise((resolve, reject) => {
        let session: number | null = null;
        let expectedSeq = 0;
        let bytesReceived = 0;
        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        let settled = false;

        const cleanup = (): void => {
          if (stallTimer) clearTimeout(stallTimer);
          this._sdFrameListener = null;
          this._sdCrcErrorListener = null;
          opts.signal?.removeEventListener('abort', onAbort);
        };
        const fail = (err: Error): void => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(err);
        };
        const succeed = (status: number, nextOffset: number): void => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ status, nextOffset, bytesReceived });
        };
        const kickStall = (): void => {
          if (stallTimer) clearTimeout(stallTimer);
          stallTimer = setTimeout(
            () => fail(new Error(`SD read stalled (no frames for ${stallTimeoutMs} ms)`)),
            stallTimeoutMs,
          );
        };
        const onAbort = (): void => {
          void this.sdAbortTransfer().catch(() => {});
          fail(new DOMException('SD read aborted', 'AbortError'));
        };

        this._sdCrcErrorListener = () => fail(new Error('SD data frame failed CRC check'));
        this._sdFrameListener = (frame) => {
          // Adopt the first session id that is not a leftover of the
          // previous window (late data frames or a SUPERSEDED/closing status
          // still draining from the firmware's TX ring). The tracker resets
          // on connect/disconnect; the residual 1-in-256 wrap collision
          // (new window randomly assigned the previous id) is recovered by
          // the stall watchdog + the caller's re-read retry, which advances
          // the firmware's session counter.
          if (session === null) {
            if (this._sdKnownSession !== null && frame.sessionId === this._sdKnownSession) return;
            session = frame.sessionId;
            this._sdKnownSession = frame.sessionId;
          }
          if (frame.sessionId !== session) return;
          kickStall();
          if (frame.kind === 'data') {
            if (frame.seq !== expectedSeq) {
              fail(new Error(`SD block sequence gap (expected ${expectedSeq}, got ${frame.seq})`));
              return;
            }
            expectedSeq++;
            try {
              opts.onBlock?.(frame.payload, offset + bytesReceived);
            } catch (e) {
              fail(e instanceof Error ? e : new Error(String(e)));
              return;
            }
            bytesReceived += frame.payload.length;
          } else {
            succeed(frame.status, frame.nextOffset);
          }
        };

        if (opts.signal) {
          if (opts.signal.aborted) {
            onAbort();
            return;
          }
          opts.signal.addEventListener('abort', onAbort, { once: true });
        }

        kickStall();
        this._writeExpectingAck(buildReadCmd(path, offset, windowLen, blockLen), 3000)
          .then((ackRemainder) => {
            // The ACK can coalesce with the first data frame in one notification
            if (ackRemainder && ackRemainder.length) this._sdChunkHandler(ackRemainder);
          })
          .catch((e) => fail(e instanceof Error ? e : new Error(String(e))));
      });
    } finally {
      this._sdRelease();
    }
  }
}
