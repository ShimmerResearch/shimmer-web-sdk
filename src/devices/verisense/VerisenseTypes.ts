import type { AsmCommand, AsmProperty } from './constants.js';
import type { SensorADC } from './sensors/SensorADC.js';
import type { SensorLIS2DW12 } from './sensors/SensorLIS2DW12.js';
import type { SensorLSM6DS3 } from './sensors/SensorLSM6DS3.js';
import type { SensorPPG } from './sensors/SensorPPG.js';

export type TransportKind = 'ble' | 'serial' | null;
export type DeviceMode = 'idle' | 'streaming' | 'command' | 'logged';

export interface SensorMap {
  1: SensorADC;
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
  blob?: Blob;
}

export interface VerisenseClientOptions {
  hardwareIdentifier?: string;
  stripStreamCrc?: boolean;
  verifyStreamCrc?: boolean;
  debug?: boolean;
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
  resolve: (v: VerisenseCommandResponse) => void;
  reject: (e: Error) => void;
}

export interface SyncSession {
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
  onProgress: ((info: LoggedTransferProgressInfo) => void) | null;
}