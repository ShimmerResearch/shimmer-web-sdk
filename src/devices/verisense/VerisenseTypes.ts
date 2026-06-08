import type { AsmCommand, AsmProperty } from './constants.js';
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
  stripStreamCrc?: boolean;
  verifyStreamCrc?: boolean;
  debug?: boolean;
}

export type VerisenseConnectRetryReason =
  | 'request-timeout'
  | 'gatt-disconnected'
  | 'unexpected-response-property';

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
  | 'stabilized'
  | 'timeout'
  | 'aborted'
  | 'unsupported'
  | 'not-ble';

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
