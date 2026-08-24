/**
 * High-level SD-card download orchestration for the Shimmer3R.
 *
 * Walks the on-card tree with the client's SD commands, mirrors the directory
 * structure on the host via the File System Access API, and pulls each file
 * down in windows with resume-from-on-disk-size semantics — the same shape as
 * the field-proven Verisense `transferLoggedData` flow.
 */

import type { Shimmer3RClient } from '../Shimmer3RClient.js';
import { ensureDirectoryPath } from '../../verisense/protocolDataFlow.js';
import { toArrayBuffer } from '../../../core/arrayBuffer.js';
import { readSdLogMacAddress, SDLOG_MAC_HEADER_BYTES } from '../../sdlog/header.js';
import {
  SD_XFER,
  SdTransferError,
  sdXferStatusToString,
  SD_BLOCK_PAYLOAD_DEFAULT,
  type SdDirEntry,
} from './protocol.js';

/**
 * Where the downloaded files are placed under the destination folder.
 *
 * - `card` mirrors the on-card tree as-is:
 *   `data/<TrialName>_<ConfigTime>/<ShimmerName>-<NNN>/<file>`
 * - `consensysBackup` nests that same tree under the two levels Consensys
 *   expects inside its workspace `Backup` folder:
 *   `<import-stamp>/<MAC>/data/<TrialName>_<ConfigTime>/<ShimmerName>-<NNN>/<file>`
 *   so the download can be imported via
 *   *Application Settings -> Manage Data -> Import Data From Backup Directory*.
 *
 * Consensys keys the device level by MAC address (12 lowercase hex), not by
 * Shimmer name -- a tree filed under the name is silently not matched to a
 * device on import.
 */
export type SdDestinationLayout = 'card' | 'consensysBackup';

/** Device folder used when no MAC can be established at all. */
export const CONSENSYS_UNKNOWN_MAC = 'xxxxxxxxxxxx';

/**
 * Last-resort device folder for a session whose header MAC could not be read.
 *
 * Mirrors the desktop export tool: the four hex characters a Shimmer name
 * carries are the low two bytes of its MAC, so `Shimmer_5AA4-002` degrades to
 * `xxxxxxxx5aa4` -- enough for a human to spot and correct the folder by hand.
 */
export function consensysMacPlaceholder(sessionDir: string | undefined): string {
  const m = /Shimmer_([0-9A-Fa-f]{4})/.exec(sessionDir ?? '');
  return m ? `xxxxxxxx${m[1].toLowerCase()}` : CONSENSYS_UNKNOWN_MAC;
}

/**
 * Normalise a MAC to the 12-lowercase-hex form Consensys names folders with,
 * accepting the separator-carrying forms users paste (`E7:47:AA:7D:2F:31`).
 * Throws for anything that is not six hex bytes.
 */
export function normalizeConsensysMac(mac: string): string {
  const hex = mac.replace(/[^0-9a-fA-F]/g, '').toLowerCase();
  if (hex.length !== 12) {
    throw new Error(`deviceMac must be 12 hex characters (got '${mac}').`);
  }
  return hex;
}

/**
 * Format an import-time folder name as Consensys does: `yyyy-MM-dd_HH.mm.ss`
 * in local time (e.g. `2025-06-25_15.30.36`).
 */
export function formatSdImportStamp(date: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}` +
    `_${p(date.getHours())}.${p(date.getMinutes())}.${p(date.getSeconds())}`
  );
}

/**
 * Map a card directory chain to its Consensys Backup destination.
 *
 * `macAddress` is the device level Consensys matches on. {@link downloadSdTree}
 * resolves it per session folder from that session's own log header rather
 * than from the connected device, so a card moved between devices still files
 * each session under the device that recorded it.
 */
export function consensysBackupSegments(
  cardDirSegments: string[],
  importStamp: string,
  macAddress: string,
): string[] {
  return [importStamp, macAddress, ...cardDirSegments];
}

export interface SdRemoteFile {
  /** Full on-card path, e.g. `data/DefaultTrial_123/Shimmer_ABCD-000/000`. */
  path: string;
  size: number;
  mtime: Date | null;
}

export interface SdRemoteTree {
  /** Directories in discovery order (parents before children), full paths. */
  dirs: string[];
  files: SdRemoteFile[];
  totalBytes: number;
}

export interface SdTransferProgress {
  phase: 'enumerate' | 'download' | 'delete';
  /** On-card path of the file currently transferring (download phase). */
  currentFile?: string;
  fileBytesDone?: number;
  fileBytesTotal?: number;
  bytesDone: number;
  bytesTotal: number;
  filesDone: number;
  filesTotal: number;
  /** Rolling throughput estimate over the current file, in KB/s. */
  kbps?: number;
}

export interface DownloadSdTreeOptions {
  /** Root to walk on the card. @default 'data' */
  rootPath?: string;
  /** Bytes requested per SD_FILE_READ window. @default 131072 */
  windowLen?: number;
  /** Payload bytes per streamed block (64..1024). @default 512 */
  blockPayloadLen?: number;
  /** Resume partially-downloaded files from their on-disk size. @default true */
  resume?: boolean;
  /** Skip files whose on-disk size already matches the card. @default true */
  skipExisting?: boolean;
  /**
   * After a file downloads completely (size verified), delete it from the
   * card; session/trial directories that emptied out are removed afterwards.
   * @default false
   */
  deleteAfterVerify?: boolean;
  /** Windows retried per file before the file is marked failed. @default 3 */
  maxRetriesPerFile?: number;
  /** Per-window stall watchdog passed to sdReadFileWindow. @default 6000 */
  stallTimeoutMs?: number;
  /** Destination folder layout. @default 'card' */
  layout?: SdDestinationLayout;
  /**
   * Import-time folder name for `consensysBackup` (one per download run).
   * Defaults to the current local time via {@link formatSdImportStamp}.
   */
  importStamp?: string;
  /**
   * MAC address for the `consensysBackup` device folder, in any hex form.
   *
   * Set this only to override the per-session MAC read from each log header --
   * for example when the card is known to hold one device's data and the
   * headers are unreadable. Leave unset for the header-derived default, which
   * files correctly even when a card carries sessions from several devices.
   */
  deviceMac?: string;
  signal?: AbortSignal;
  onProgress?: (p: SdTransferProgress) => void;
}

export interface SdTransferSummary {
  /** Import folder used for `consensysBackup`; undefined for `card`. */
  importStamp?: string;
  /**
   * Device (MAC) folder chosen for each on-card session directory under
   * `consensysBackup`, keyed by the session's card path; empty for `card`.
   */
  deviceFolders?: Record<string, string>;
  filesDownloaded: number;
  filesSkipped: number;
  filesFailed: { path: string; error: string }[];
  bytesDownloaded: number;
  deletedFromCard: string[];
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('SD download aborted', 'AbortError');
}

/** Recursively enumerate the on-card tree below `rootPath` (depth-first). */
export async function enumerateSdTree(
  client: Shimmer3RClient,
  rootPath = 'data',
  opts: { signal?: AbortSignal; maxDepth?: number } = {},
): Promise<SdRemoteTree> {
  const dirs: string[] = [];
  const files: SdRemoteFile[] = [];
  const maxDepth = opts.maxDepth ?? 8;

  const walk = async (path: string, depth: number): Promise<void> => {
    throwIfAborted(opts.signal);
    if (depth > maxDepth) return;
    const entries: SdDirEntry[] = await client.sdListDir(path);
    for (const e of entries) {
      throwIfAborted(opts.signal);
      if (e.nameTruncated) continue; // cannot be addressed by path
      const childPath = `${path}/${e.name}`;
      if (e.isDir) {
        dirs.push(childPath);
        await walk(childPath, depth + 1);
      } else {
        files.push({ path: childPath, size: e.size, mtime: e.mtime });
      }
    }
  };

  await walk(rootPath, 0);
  return { dirs, files, totalBytes: files.reduce((n, f) => n + f.size, 0) };
}

/**
 * Download the card's `rootPath` tree into `destRoot`, recreating the on-card
 * directory structure. Re-running with the same destination resumes: complete
 * files are skipped and partial files continue from their on-disk size.
 */
export async function downloadSdTree(
  client: Shimmer3RClient,
  destRoot: FileSystemDirectoryHandle,
  opts: DownloadSdTreeOptions = {},
): Promise<SdTransferSummary> {
  const rootPath = opts.rootPath ?? 'data';
  const windowLen = opts.windowLen ?? 128 * 1024;
  const blockPayloadLen = opts.blockPayloadLen ?? SD_BLOCK_PAYLOAD_DEFAULT;
  const resume = opts.resume ?? true;
  const skipExisting = opts.skipExisting ?? true;
  const maxRetriesPerFile = opts.maxRetriesPerFile ?? 3;
  const layout = opts.layout ?? 'card';
  const importStamp = opts.importStamp ?? formatSdImportStamp();
  const consensys = layout === 'consensysBackup';
  // Validated up front so a malformed override fails before any card traffic
  const deviceMacOverride = opts.deviceMac ? normalizeConsensysMac(opts.deviceMac) : undefined;

  const summary: SdTransferSummary = {
    importStamp: consensys ? importStamp : undefined,
    deviceFolders: consensys ? {} : undefined,
    filesDownloaded: 0,
    filesSkipped: 0,
    filesFailed: [],
    bytesDownloaded: 0,
    deletedFromCard: [],
  };

  opts.onProgress?.({
    phase: 'enumerate',
    bytesDone: 0,
    bytesTotal: 0,
    filesDone: 0,
    filesTotal: 0,
  });
  const tree = await enumerateSdTree(client, rootPath, { signal: opts.signal });

  let bytesDone = 0;
  let filesDone = 0;
  const fullyDownloaded: string[] = [];

  const emit = (extra: Partial<SdTransferProgress> = {}): void => {
    opts.onProgress?.({
      phase: 'download',
      bytesDone,
      bytesTotal: tree.totalBytes,
      filesDone,
      filesTotal: tree.files.length,
      ...extra,
    });
  };

  /**
   * Read the head of an on-card file just far enough to recover its MAC.
   *
   * One short window per session directory, so the cost is negligible against
   * the session itself. A file too short or too damaged to yield a MAC is not
   * an error here -- the caller falls back to the name-derived placeholder.
   */
  const probeHeaderMac = async (filePath: string): Promise<string | null> => {
    const probeLen = Math.max(SDLOG_MAC_HEADER_BYTES, blockPayloadLen);
    const head = new Uint8Array(SDLOG_MAC_HEADER_BYTES);
    let filled = 0;
    try {
      await client.sdReadFileWindow(filePath, 0, probeLen, {
        blockPayloadLen,
        stallTimeoutMs: opts.stallTimeoutMs,
        signal: opts.signal,
        onBlock: (payload, absOffset) => {
          if (absOffset >= head.length) return;
          const slice = payload.subarray(0, head.length - absOffset);
          head.set(slice, absOffset);
          filled = Math.max(filled, absOffset + slice.length);
        },
      });
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      return null;
    }
    return readSdLogMacAddress(head.subarray(0, filled));
  };

  /** MAC folder per on-card session directory; one probe per directory. */
  const macByDir = new Map<string, string>();
  const deviceFolderFor = async (dirSegments: string[], filePath: string): Promise<string> => {
    const key = dirSegments.join('/');
    const cached = macByDir.get(key);
    if (cached !== undefined) return cached;
    const mac =
      deviceMacOverride ??
      (await probeHeaderMac(filePath)) ??
      consensysMacPlaceholder(dirSegments[dirSegments.length - 1]);
    macByDir.set(key, mac);
    if (summary.deviceFolders) summary.deviceFolders[key] = mac;
    return mac;
  };

  for (const file of tree.files) {
    throwIfAborted(opts.signal);
    const segments = file.path.split('/');
    const name = segments.pop() as string;

    try {
      const destSegments = consensys
        ? consensysBackupSegments(segments, importStamp, await deviceFolderFor(segments, file.path))
        : segments;
      const dir = await ensureDirectoryPath(destRoot, destSegments);
      const handle = await dir.getFileHandle(name, { create: true });
      const existingSize = (await handle.getFile()).size;

      if (skipExisting && existingSize === file.size) {
        summary.filesSkipped++;
        fullyDownloaded.push(file.path);
        bytesDone += file.size;
        filesDone++;
        emit({ currentFile: file.path, fileBytesDone: file.size, fileBytesTotal: file.size });
        continue;
      }

      const start = resume && existingSize < file.size ? existingSize : 0;
      const writable = await handle.createWritable({ keepExistingData: start > 0 });

      let offset = start;
      let retries = 0;
      const startedAt = Date.now();
      const startedFrom = start;

      try {
        while (offset < file.size) {
          throwIfAborted(opts.signal);
          // Ordered write chain, so block writes never interleave out of order
          let chain: Promise<unknown> = Promise.resolve();
          let chainError: Error | null = null;
          try {
            const res = await client.sdReadFileWindow(
              file.path,
              offset,
              Math.min(windowLen, file.size - offset),
              {
                blockPayloadLen,
                stallTimeoutMs: opts.stallTimeoutMs,
                signal: opts.signal,
                onBlock: (payload, absOffset) => {
                  // Positioned writes keep window retries idempotent: a
                  // half-received window that is re-requested simply
                  // overwrites the same byte range
                  chain = chain
                    .then(() =>
                      writable.write({
                        type: 'write',
                        position: absOffset,
                        data: toArrayBuffer(payload),
                      }),
                    )
                    .catch((e) => {
                      chainError = e instanceof Error ? e : new Error(String(e));
                    });
                },
              },
            );
            await chain;
            if (chainError) throw chainError;
            if (res.status !== SD_XFER.WINDOW_COMPLETE && res.status !== SD_XFER.EOF) {
              throw new SdTransferError(
                `read '${file.path}': ${sdXferStatusToString(res.status)}`,
                res.status,
              );
            }
            if (res.nextOffset <= offset) {
              throw new Error(`read '${file.path}': no progress at offset ${offset}`);
            }
            bytesDone += res.nextOffset - offset;
            summary.bytesDownloaded += res.nextOffset - offset;
            offset = res.nextOffset;
            retries = 0;

            const elapsedS = (Date.now() - startedAt) / 1000;
            emit({
              currentFile: file.path,
              fileBytesDone: offset,
              fileBytesTotal: file.size,
              kbps: elapsedS > 0 ? (offset - startedFrom) / 1024 / elapsedS : undefined,
            });
            if (res.status === SD_XFER.EOF) break; // card holds less than listed
          } catch (e) {
            await chain.catch(() => {});
            // In-band refusals (busy, SD lost, not found) are not retryable;
            // CRC / sequence-gap / stall errors are — from the same offset
            if (e instanceof SdTransferError || e instanceof DOMException) throw e;
            if (++retries > maxRetriesPerFile) throw e;
          }
        }
      } finally {
        await writable.close().catch(() => {});
      }

      const finalSize = (await handle.getFile()).size;
      if (finalSize >= file.size) {
        summary.filesDownloaded++;
        fullyDownloaded.push(file.path);
      } else {
        summary.filesFailed.push({
          path: file.path,
          error: `incomplete (${finalSize}/${file.size} bytes)`,
        });
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw e;
      summary.filesFailed.push({
        path: file.path,
        error: e instanceof Error ? e.message : String(e),
      });
    }
    filesDone++;
    emit();
  }

  if (opts.deleteAfterVerify && fullyDownloaded.length) {
    opts.onProgress?.({
      phase: 'delete',
      bytesDone,
      bytesTotal: tree.totalBytes,
      filesDone,
      filesTotal: tree.files.length,
    });
    summary.deletedFromCard = await deleteDownloadedFromCard(client, fullyDownloaded, tree.dirs, {
      signal: opts.signal,
    });
  }

  return summary;
}

/**
 * Delete verified files from the card (files first, then any directories that
 * emptied out, deepest first). Only paths under `data/` are accepted by the
 * firmware. Returns the paths actually deleted; failures are skipped.
 */
export async function deleteDownloadedFromCard(
  client: Shimmer3RClient,
  filePaths: string[],
  dirPaths: string[] = [],
  opts: { signal?: AbortSignal } = {},
): Promise<string[]> {
  const deleted: string[] = [];
  for (const p of filePaths) {
    throwIfAborted(opts.signal);
    try {
      await client.sdDeletePath(p);
      deleted.push(p);
    } catch {
      /* leave the file on the card; the caller can retry */
    }
  }
  // Deepest directories first so empty parents can follow
  const dirs = [...dirPaths].sort((a, b) => b.split('/').length - a.split('/').length);
  for (const d of dirs) {
    throwIfAborted(opts.signal);
    try {
      await client.sdDeletePath(d);
      deleted.push(d);
    } catch {
      /* non-empty (something was skipped or new) — leave it */
    }
  }
  return deleted;
}
