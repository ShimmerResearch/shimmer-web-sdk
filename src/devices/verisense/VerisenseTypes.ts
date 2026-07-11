import type { AsmCommand, AsmProperty } from './constants.js';
import type { ShimmerTransport } from '../../core/transport/types.js';
import type { VerisenseBleLinkDebugPayload } from './protocol.js';
import type { SensorADC } from './sensors/SensorADC.js';
import type { SensorLIS2DW12 } from './sensors/SensorLIS2DW12.js';
import type { SensorLSM6DS3 } from './sensors/SensorLSM6DS3.js';
import type { SensorLSM6DSV } from './sensors/SensorLSM6DSV.js';
import type { SensorPPG } from './sensors/SensorPPG.js';
import type { SensorVD6283 } from './sensors/SensorVD6283.js';
import type { SensorMAX32674 } from './sensors/SensorMAX32674.js';
import type { SensorMLX90632 } from './sensors/SensorMLX90632.js';

export type TransportKind = 'ble' | 'serial' | null;
export type DeviceMode = 'idle' | 'streaming' | 'command' | 'logged';

export interface SensorMap {
  1: SensorADC;
  2: SensorLIS2DW12;
  3: SensorLSM6DS3;
  4: SensorPPG;
  6: SensorLSM6DSV;
  7: SensorVD6283;
  8: SensorMAX32674;
  9: SensorMLX90632;
}

export interface StreamPacket {
  sensorId: number;
  tick_u24: number;
  decoded: unknown[] | null;
  rawPayload: Uint8Array;
  crcOk: boolean | null;
}

export interface LoggedTransferProgressInfo {
  payloadIndex: number;
  bytesWritten: number;
  crcOk: boolean;
}

export interface TransferLoggedDataOptions {
  fileHandle?: FileSystemFileHandle | null;
  timeoutMs?: number;
  maxNack?: number;
  maxCrcNack?: number;
  onProgress?: ((info: LoggedTransferProgressInfo) => void) | null;
}

export interface TransferLoggedDataResult {
  ok: boolean;
  bytesWritten: number;
  payloadIndex?: number;
  blob?: Blob;
}

export interface RunHardwareTestReportOptions {
  timeoutMs?: number;
  marker?: string;
  endMarker?: string;
  completionIdleMs?: number;
  factoryTestType?: number;
  signal?: AbortSignal | null;
  onChunk?: ((chunk: string, aggregate: string) => void) | null;
}

export interface VerisenseClientOptions {
  hardwareIdentifier?: string;
  /**
   * Streaming frames carry a 2-byte CRC-16 trailer. When `true` (default) the
   * trailer is used to lock onto frame boundaries — the parser accepts a frame
   * only when its CRC validates, so a flaky link that drops bytes recovers
   * cleanly instead of emitting misaligned packets — and is then stripped before
   * decoding. Set to `false` only for legacy firmware that streams without a CRC
   * trailer (falls back to length-only framing).
   */
  stripStreamCrc?: boolean;
  debug?: boolean;
  /**
   * Inject a transport (byte pipe) instead of the default web ones. Lets
   * non-browser runtimes (React Native, Bluetooth Classic) or tests drive the
   * client. When omitted, `connect()` builds a Web Bluetooth transport and
   * `connectSerial()` a Web Serial transport, so browser usage is unchanged.
   */
  transport?: ShimmerTransport;
}

export interface BleThroughputTestOptions {
  /** How long the device should saturate the link, in milliseconds. Clamped to [100, 60000]. Default 5000. */
  durationMs?: number;
  /**
   * Finish the measurement once no data has been received for this many
   * milliseconds (the device falls silent when the blast ends). Default 600.
   */
  idleMs?: number;
  /** Overall safety timeout, in milliseconds. Defaults to `durationMs + 5000`. */
  timeoutMs?: number;
  /** Abort the test early. */
  signal?: AbortSignal | null;
  /** Called on every received chunk with the running result so far. */
  onProgress?: ((partial: BleThroughputTestResult) => void) | null;
}

export interface BleThroughputTestResult {
  /** Total bytes received from the device during the measurement window. */
  bytesReceived: number;
  /** Number of BLE notification chunks received. */
  packetsReceived: number;
  /** Duration requested of the device, in milliseconds. */
  durationRequestedMs: number;
  /** Measured window from first to last received byte, in milliseconds. */
  elapsedMs: number;
  /** Received goodput in bytes per second. */
  throughputBytesPerSec: number;
  /** Received goodput in kilobytes per second (bytes/sec ÷ 1000). */
  throughputKBps: number;
  /** Received goodput in kilobits per second (bytes/sec × 8 ÷ 1000). */
  throughputKbps: number;
}

export type VerisenseConnectRetryReason =
  'request-timeout' | 'gatt-disconnected' | 'unexpected-response-property';

export interface VerisenseConnectWithRetryOptions {
  device?: BluetoothDevice | null;
  filters?: BluetoothLEScanFilter[];
  optionalServices?: BluetoothServiceUUID[];
  bootstrapTimeoutMs?: number;
  pairingBootstrapTimeoutMs?: number;
  maxRetries?: number;
  retrySettleMs?: number;
  retryOnUnexpectedProperty?: boolean;
  onRetry?: ((info: VerisenseConnectRetryInfo) => void) | null;
}

export interface VerisenseConnectRetryInfo {
  attempt: number;
  maxRetries: number;
  bootstrapTimeoutMs: number;
  nextBootstrapTimeoutMs?: number;
  reason: VerisenseConnectRetryReason;
  error: string;
}

export interface VerisenseCommandResponse {
  header: number;
  command: AsmCommand;
  property: AsmProperty;
  payload: Uint8Array;
}

export interface PendingCommandRequest {
  expectedProperty: AsmProperty;
  acceptedCommands: ReadonlySet<AsmCommand>;
  acceptedProperties?: ReadonlySet<AsmProperty>;
  resolve: (v: VerisenseCommandResponse) => void;
  reject: (e: Error) => void;
}

export interface SyncSession {
  receiving: boolean;
  lastReply: string;
  emptyAckCount: number;
  nackCount: number;
  nackCrcCount: number;
  maxNack: number;
  maxCrcNack: number;
  lastRxAt: number;
  timeoutMs: number;
  bytesWritten: number;
  lastPayloadIndex: number;
  resolve: (v: { ok: boolean; bytesWritten: number; payloadIndex: number }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setInterval> | null;
  writable: FileSystemWritableFileStream | null;
  chunks: Uint8Array[];
  onProgress: ((info: LoggedTransferProgressInfo) => void) | null;
}

export type BleLinkAutoOptimizeStopReason =
  'stabilized' | 'timeout' | 'aborted' | 'unsupported' | 'not-ble';

export interface BleLinkAutoOptimizeOptions {
  pollIntervalMs?: number;
  stableReadCount?: number;
  maxDurationMs?: number;
  settleMode?: 'target-and-stability' | 'stability';
  minSettleTimeMs?: number;
  forceOptimizeAttempts?: number;
  targetConnectionIntervalUnits?: number;
  targetPhy?: number;
  minDataLength?: number;
  signal?: AbortSignal | null;
  onSample?: ((sample: BleLinkAutoOptimizeSample) => void) | null;
}

export interface BleLinkAutoOptimizeSample {
  source: 'read' | 'optimize';
  iteration: number;
  stableCount: number;
  parsed: VerisenseBleLinkDebugPayload;
  signature: string;
  optimizedEnough: boolean;
}

export interface BleLinkAutoOptimizeResult {
  reason: BleLinkAutoOptimizeStopReason;
  iterations: number;
  optimizeAttempts: number;
  stableCount: number;
  lastParsed: VerisenseBleLinkDebugPayload | null;
  durationMs: number;
}
