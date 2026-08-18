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
import {
  SD_XFER,
  SdTransferError,
  sdXferStatusToString,
  SD_BLOCK_PAYLOAD_DEFAULT,
  type SdDirEntry,
} from './protocol.js';

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
  signal?: AbortSignal;
  onProgress?: (p: SdTransferProgress) => void;
}

export interface SdTransferSummary {
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

  const summary: SdTransferSummary = {
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

  for (const file of tree.files) {
    throwIfAborted(opts.signal);
    const segments = file.path.split('/');
    const name = segments.pop() as string;

    try {
      const dir = await ensureDirectoryPath(destRoot, segments);
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
