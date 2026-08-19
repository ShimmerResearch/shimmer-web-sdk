import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import {
  SD_TRANSFER_OPCODES as OP,
  SD_STATUS,
  SD_XFER,
  SD_ATTR_DIR,
  SdTransferError,
  sdCrc16,
  encodeSdPath,
  fatDateTimeToDate,
  buildReadCmd,
  parseListDirRsp,
  tryExtractSdMessage,
} from '../../src/devices/shimmer3r/sdTransfer/protocol.js';
import {
  downloadSdTree,
  enumerateSdTree,
  formatSdImportStamp,
  consensysBackupSegments,
  CONSENSYS_UNKNOWN_DEVICE,
} from '../../src/devices/shimmer3r/sdTransfer/Shimmer3RSdTransfer.js';

const ACK = 0xff;
const INSTREAM = 0x8a;

// ---------------------------------------------------------------------------
// Wire-format helpers (mirror the firmware frame layout)
// ---------------------------------------------------------------------------

function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

function makeDataFrame(sessionId: number, seq: number, payload: Uint8Array): Uint8Array {
  const head = [
    INSTREAM,
    OP.FILE_DATA_RESPONSE,
    sessionId,
    ...u16le(seq),
    ...u16le(payload.length),
  ];
  const frame = new Uint8Array(head.length + payload.length + 2);
  frame.set(head, 0);
  frame.set(payload, head.length);
  const crc = sdCrc16(frame, head.length + payload.length);
  frame.set(u16le(crc), head.length + payload.length);
  return frame;
}

function makeStatusFrame(sessionId: number, status: number, nextOffset: number): Uint8Array {
  const body = [INSTREAM, OP.FILE_STATUS_RESPONSE, sessionId, status, ...u32le(nextOffset)];
  const frame = new Uint8Array(10);
  frame.set(body, 0);
  frame.set(u16le(sdCrc16(frame, 8)), 8);
  return frame;
}

interface ListEntrySpec {
  name: string;
  isDir: boolean;
  size: number;
  fdate?: number;
  ftime?: number;
}

function makeListRsp(
  status: number,
  startIdx: number,
  entries: ListEntrySpec[],
  hasMore: boolean,
): Uint8Array {
  const body: number[] = [];
  for (const e of entries) {
    body.push(
      e.isDir ? SD_ATTR_DIR : 0,
      ...u32le(e.size),
      ...u16le(e.fdate ?? 0),
      ...u16le(e.ftime ?? 0),
    );
    body.push(e.name.length, ...Array.from(encodeSdPath(e.name)));
  }
  return new Uint8Array([
    OP.LIST_DIR_RESPONSE,
    status,
    ...u16le(startIdx),
    ...u16le(body.length),
    entries.length,
    hasMore ? 1 : 0,
    ...body,
  ]);
}

/** Deliver each chunk in its own macrotask, mirroring real notifications. */
function scheduleChunks(t: LoopbackTransport, chunks: Array<number[] | Uint8Array>): void {
  for (const c of chunks) setTimeout(() => t.notify(c), 0);
}

/** Split a byte sequence into fixed-size notification chunks. */
function fragment(bytes: Uint8Array, size: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// CRC — known-answer vectors from the firmware's CRC self-test
// (log-and-stream-common/CRC/shimmer_crc.c testCrcDriver: CRC bytes are
// appended low-first, so [..,0xAA,0x48] == 0x48AA)
// ---------------------------------------------------------------------------

describe('sdCrc16 (Shimmer CRC, init 0xB0CA)', () => {
  it('matches the firmware self-test vectors', () => {
    expect(sdCrc16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toBe(0x48aa);
    expect(sdCrc16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))).toBe(0x2a5d);
    expect(sdCrc16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBe(0x8b17);
    expect(sdCrc16(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]))).toBe(0x794e);
  });
});

// ---------------------------------------------------------------------------
// Codecs
// ---------------------------------------------------------------------------

describe('sdTransfer codecs', () => {
  it('encodeSdPath enforces 1..96 ASCII bytes', () => {
    expect(() => encodeSdPath('')).toThrow(SdTransferError);
    expect(encodeSdPath('a'.repeat(96)).length).toBe(96);
    expect(() => encodeSdPath('a'.repeat(97))).toThrow(SdTransferError);
    expect(() => encodeSdPath('data/tríal')).toThrow(SdTransferError);
  });

  it('buildReadCmd lays out offset/window/block/path little-endian', () => {
    const cmd = buildReadCmd('data/t/000', 0x01020304, 0x00020000, 512);
    expect(cmd[0]).toBe(OP.FILE_READ_COMMAND);
    expect(Array.from(cmd.slice(1, 5))).toEqual([0x04, 0x03, 0x02, 0x01]);
    expect(Array.from(cmd.slice(5, 9))).toEqual([0x00, 0x00, 0x02, 0x00]);
    expect(Array.from(cmd.slice(9, 11))).toEqual([0x00, 0x02]);
    expect(cmd[11]).toBe(10);
    expect(cmd.length).toBe(12 + 10);
  });

  it('list response round-trips through parseListDirRsp', () => {
    const rsp = makeListRsp(
      SD_STATUS.OK,
      2,
      [
        { name: 'Trial_123', isDir: true, size: 0 },
        {
          name: '000',
          isDir: false,
          size: 4096,
          fdate: (46 << 9) | (8 << 5) | 18,
          ftime: (13 << 11) | (37 << 5),
        },
      ],
      true,
    );
    const page = parseListDirRsp(rsp);
    expect(page.status).toBe(SD_STATUS.OK);
    expect(page.startIdx).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.entries).toHaveLength(2);
    expect(page.entries[0]).toMatchObject({ name: 'Trial_123', isDir: true });
    expect(page.entries[1]).toMatchObject({ name: '000', isDir: false, size: 4096 });
    expect(page.entries[1].mtime?.getFullYear()).toBe(2026);
  });

  it('fatDateTimeToDate returns null for unset timestamps', () => {
    expect(fatDateTimeToDate(0, 0)).toBeNull();
    expect(fatDateTimeToDate((44 << 9) | (1 << 5) | 1, 0)?.getFullYear()).toBe(2024);
  });
});

// ---------------------------------------------------------------------------
// Incremental extractor
// ---------------------------------------------------------------------------

describe('tryExtractSdMessage', () => {
  it('extracts a data frame and reports needs-more on partial input', () => {
    const frame = makeDataFrame(3, 7, new Uint8Array([9, 8, 7, 6]));
    for (let n = 1; n < frame.length; n++) {
      expect(tryExtractSdMessage(frame.slice(0, n)).consumed).toBe(0);
    }
    const r = tryExtractSdMessage(frame);
    expect(r.consumed).toBe(frame.length);
    expect(r.msg).toMatchObject({ kind: 'data', sessionId: 3, seq: 7 });
    expect(Array.from((r.msg as { payload: Uint8Array }).payload)).toEqual([9, 8, 7, 6]);
  });

  it('resynchronises on a corrupted frame and flags the CRC error', () => {
    const frame = makeDataFrame(1, 0, new Uint8Array([1, 2, 3]));
    frame[frame.length - 1] ^= 0xff;
    const r = tryExtractSdMessage(frame);
    expect(r.consumed).toBe(1);
    expect(r.crcError).toBe(true);
  });

  it('skips foreign instream responses one byte at a time', () => {
    // Unsolicited instream status response: [0x8A][0x71][2 status bytes]
    const foreign = new Uint8Array([INSTREAM, 0x71, 0x20, 0x00]);
    const r = tryExtractSdMessage(foreign);
    expect(r.consumed).toBe(1);
    expect(r.msg).toBeUndefined();
  });

  it('extracts status frames', () => {
    const r = tryExtractSdMessage(makeStatusFrame(5, SD_XFER.EOF, 12345));
    expect(r.msg).toMatchObject({
      kind: 'status',
      sessionId: 5,
      status: SD_XFER.EOF,
      nextOffset: 12345,
    });
  });
});

// ---------------------------------------------------------------------------
// In-memory firmware simulator over LoopbackTransport
// ---------------------------------------------------------------------------

type VNode = { kind: 'dir'; children: Map<string, VNode> } | { kind: 'file'; data: Uint8Array };

class VirtualCard {
  root: VNode = { kind: 'dir', children: new Map() };

  addFile(path: string, data: Uint8Array): void {
    const segs = path.split('/');
    const name = segs.pop() as string;
    let dir = this.root;
    for (const s of segs) {
      if (dir.kind !== 'dir') throw new Error('not a dir');
      if (!dir.children.has(s)) dir.children.set(s, { kind: 'dir', children: new Map() });
      dir = dir.children.get(s) as VNode;
    }
    if (dir.kind !== 'dir') throw new Error('not a dir');
    dir.children.set(name, { kind: 'file', data });
  }

  lookup(path: string): VNode | null {
    let node = this.root;
    for (const s of path.split('/')) {
      if (node.kind !== 'dir') return null;
      const next = node.children.get(s);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  delete(path: string): number {
    if (!path.startsWith('data/')) return SD_STATUS.BAD_ARGS;
    const segs = path.split('/');
    const name = segs.pop() as string;
    const parent = this.lookup(segs.join('/'));
    if (!parent || parent.kind !== 'dir' || !parent.children.has(name)) return 4; // FR_NO_FILE
    const node = parent.children.get(name) as VNode;
    if (node.kind === 'dir' && node.children.size > 0) return 7; // FR_DENIED
    parent.children.delete(name);
    return SD_STATUS.OK;
  }
}

interface SimOptions {
  /** Notification chunk size — small values exercise reassembly. */
  chunkSize?: number;
  maxEntriesPerPage?: number;
  /** Corrupt the CRC of the given (sessionId-agnostic) block seq once. */
  corruptSeqOnce?: number;
  /** Drop the given block seq once (sequence-gap test). */
  dropSeqOnce?: number;
}

/** Scripted Shimmer3R firmware: answers SD-transfer commands from a VirtualCard. */
function attachFwSim(t: LoopbackTransport, card: VirtualCard, opts: SimOptions = {}) {
  const state = { session: 0, reads: [] as { path: string; offset: number; windowLen: number }[] };
  let corruptArmed = opts.corruptSeqOnce !== undefined;
  let dropArmed = opts.dropSeqOnce !== undefined;

  const send = (bytes: Uint8Array | number[]): void => {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    scheduleChunks(t, opts.chunkSize ? fragment(u8, opts.chunkSize) : [u8]);
  };

  t.setOnWrite((bytes) => {
    const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const pathFrom = (lenIdx: number): string =>
      String.fromCharCode(...cmd.slice(lenIdx + 1, lenIdx + 1 + cmd[lenIdx]));

    switch (cmd[0]) {
      case 0x2e: {
        // GET_FW_VERSION → LogAndStream (3), v1.01.009
        send([ACK, 0x2f, 3, 0, 1, 0, 1, 9]);
        return;
      }
      case OP.LIST_DIR_COMMAND: {
        const startIdx = cmd[1] | (cmd[2] << 8);
        const maxEntries = Math.min(cmd[3], opts.maxEntriesPerPage ?? 16);
        const node = card.lookup(pathFrom(4));
        if (!node || node.kind !== 'dir') {
          send(new Uint8Array([ACK, ...makeListRsp(5, startIdx, [], false)])); // FR_NO_PATH
          return;
        }
        const all = Array.from(node.children.entries()).map(([name, n]) => ({
          name,
          isDir: n.kind === 'dir',
          size: n.kind === 'file' ? n.data.length : 0,
        }));
        const slice = all.slice(startIdx, startIdx + maxEntries);
        const hasMore = startIdx + slice.length < all.length;
        send(new Uint8Array([ACK, ...makeListRsp(SD_STATUS.OK, startIdx, slice, hasMore)]));
        return;
      }
      case OP.FILE_STAT_COMMAND: {
        const node = card.lookup(pathFrom(1));
        const size = node?.kind === 'file' ? node.data.length : 0;
        const status = node ? SD_STATUS.OK : 4; // FR_NO_FILE
        send([
          ACK,
          OP.FILE_STAT_RESPONSE,
          status,
          ...u32le(size),
          0,
          0,
          0,
          0,
          node?.kind === 'dir' ? SD_ATTR_DIR : 0,
        ]);
        return;
      }
      case OP.FREE_SPACE_COMMAND: {
        send([ACK, OP.FREE_SPACE_RESPONSE, SD_STATUS.OK, ...u32le(1024), ...u32le(2048)]);
        return;
      }
      case OP.DELETE_COMMAND: {
        send([ACK, OP.DELETE_RESPONSE, card.delete(pathFrom(1))]);
        return;
      }
      case OP.FILE_READ_COMMAND: {
        const offset = cmd[1] | (cmd[2] << 8) | (cmd[3] << 16) | (cmd[4] << 24);
        const windowLen = cmd[5] | (cmd[6] << 8) | (cmd[7] << 16) | (cmd[8] << 24);
        const blockLen = cmd[9] | (cmd[10] << 8);
        const path = pathFrom(11);
        state.session = (state.session + 1) & 0xff;
        state.reads.push({ path, offset, windowLen });
        const sid = state.session;
        const node = card.lookup(path);
        if (!node || node.kind !== 'file') {
          send(new Uint8Array([ACK]));
          send(makeStatusFrame(sid, SD_XFER.NOT_FOUND, offset));
          return;
        }
        const chunks: Uint8Array[] = [new Uint8Array([ACK])];
        const end = Math.min(offset + windowLen, node.data.length);
        let pos = offset;
        let seq = 0;
        while (pos < end) {
          const len = Math.min(blockLen, end - pos);
          let frame = makeDataFrame(sid, seq, node.data.slice(pos, pos + len));
          if (corruptArmed && seq === opts.corruptSeqOnce) {
            frame = frame.slice();
            frame[frame.length - 1] ^= 0xff;
            corruptArmed = false;
          }
          if (dropArmed && seq === opts.dropSeqOnce) {
            dropArmed = false;
          } else {
            chunks.push(frame);
          }
          pos += len;
          seq++;
        }
        const eof = end >= node.data.length && offset + windowLen > node.data.length;
        chunks.push(makeStatusFrame(sid, eof ? SD_XFER.EOF : SD_XFER.WINDOW_COMPLETE, pos));
        for (const c of chunks) {
          if (opts.chunkSize) scheduleChunks(t, fragment(c, opts.chunkSize));
          else scheduleChunks(t, [c]);
        }
        return;
      }
      case OP.TRANSFER_ABORT_COMMAND: {
        send([ACK]);
        return;
      }
      default:
        send([ACK]);
    }
  });

  return state;
}

async function makeClient(card: VirtualCard, opts: SimOptions = {}) {
  const t = new LoopbackTransport();
  const sim = attachFwSim(t, card, opts);
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  return { client, sim, t };
}

function asciiBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = i & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// In-memory File System Access mocks
// ---------------------------------------------------------------------------

class MemFile {
  data = new Uint8Array(0);

  async getFile(): Promise<File> {
    return { size: this.data.length } as unknown as File;
  }

  async createWritable(opts: { keepExistingData?: boolean } = {}) {
    if (!opts.keepExistingData) this.data = new Uint8Array(0);
    let pos = 0;
    const writeAt = (u8: Uint8Array, at: number): void => {
      if (at + u8.length > this.data.length) {
        const grown = new Uint8Array(at + u8.length);
        grown.set(this.data);
        this.data = grown;
      }
      this.data.set(u8, at);
      pos = at + u8.length;
    };
    return {
      seek: async (offset: number) => {
        pos = offset;
      },
      write: async (
        chunk: ArrayBuffer | { type: 'write'; position: number; data: ArrayBuffer },
      ) => {
        if (chunk instanceof ArrayBuffer) writeAt(new Uint8Array(chunk), pos);
        else writeAt(new Uint8Array(chunk.data), chunk.position);
      },
      close: async () => {},
    };
  }
}

class MemDir {
  dirs = new Map<string, MemDir>();
  files = new Map<string, MemFile>();

  async getDirectoryHandle(name: string, opts: { create?: boolean } = {}): Promise<MemDir> {
    if (!this.dirs.has(name)) {
      if (!opts.create) throw new DOMException('not found', 'NotFoundError');
      this.dirs.set(name, new MemDir());
    }
    return this.dirs.get(name) as MemDir;
  }

  async getFileHandle(name: string, opts: { create?: boolean } = {}): Promise<MemFile> {
    if (!this.files.has(name)) {
      if (!opts.create) throw new DOMException('not found', 'NotFoundError');
      this.files.set(name, new MemFile());
    }
    return this.files.get(name) as MemFile;
  }

  atPath(path: string): MemDir | undefined {
    return path.split('/').reduce<MemDir | undefined>((d, s) => d?.dirs.get(s), this);
  }
}

// ---------------------------------------------------------------------------
// Client-level tests
// ---------------------------------------------------------------------------

function makeCard(): VirtualCard {
  const card = new VirtualCard();
  card.addFile('data/Trial_1/Shim-000/000', asciiBytes(1200));
  card.addFile('data/Trial_1/Shim-000/001', asciiBytes(300));
  card.addFile('data/Trial_1/Shim-001/000', asciiBytes(64));
  return card;
}

describe('Shimmer3RClient SD commands over LoopbackTransport', () => {
  it('supportsSdTransfer gates on FW version', async () => {
    const { client } = await makeClient(makeCard());
    await expect(client.supportsSdTransfer()).resolves.toBe(true);
  });

  it('sdListDir reassembles responses fragmented into 20-byte notifications', async () => {
    const { client } = await makeClient(makeCard(), { chunkSize: 20 });
    const entries = await client.sdListDir('data/Trial_1');
    expect(entries.map((e) => e.name).sort()).toEqual(['Shim-000', 'Shim-001']);
    expect(entries.every((e) => e.isDir)).toBe(true);
  });

  it('sdListDir follows multi-page listings', async () => {
    const { client } = await makeClient(makeCard(), { maxEntriesPerPage: 1 });
    const entries = await client.sdListDir('data/Trial_1/Shim-000');
    expect(entries.map((e) => e.name).sort()).toEqual(['000', '001']);
  });

  it('sdStatFile surfaces in-band error statuses as SdTransferError', async () => {
    const { client } = await makeClient(makeCard());
    await expect(client.sdStatFile('data/nope')).rejects.toThrow(SdTransferError);
  });

  it('sdGetFreeSpace parses the free/total pair', async () => {
    const { client } = await makeClient(makeCard());
    await expect(client.sdGetFreeSpace()).resolves.toEqual({ freeKB: 1024, totalKB: 2048 });
  });

  it('sdReadFileWindow streams ordered verified blocks and resolves on the status frame', async () => {
    const { client } = await makeClient(makeCard(), { chunkSize: 33 });
    const got: number[] = [];
    const res = await client.sdReadFileWindow('data/Trial_1/Shim-000/000', 0, 1200, {
      blockPayloadLen: 256,
      onBlock: (p, absOffset) => {
        expect(absOffset).toBe(got.length);
        got.push(...Array.from(p));
      },
    });
    expect(res.status).toBe(SD_XFER.WINDOW_COMPLETE);
    expect(res.nextOffset).toBe(1200);
    expect(res.bytesReceived).toBe(1200);
    expect(new Uint8Array(got)).toEqual(asciiBytes(1200));
  });

  it('sdReadFileWindow rejects on a CRC-corrupted block', async () => {
    const { client } = await makeClient(makeCard(), { corruptSeqOnce: 1 });
    await expect(
      client.sdReadFileWindow('data/Trial_1/Shim-000/000', 0, 1200, {
        blockPayloadLen: 256,
        stallTimeoutMs: 500,
      }),
    ).rejects.toThrow(/CRC|stall|sequence/);
  });

  it('sdReadFileWindow rejects on a sequence gap', async () => {
    const { client } = await makeClient(makeCard(), { dropSeqOnce: 1 });
    await expect(
      client.sdReadFileWindow('data/Trial_1/Shim-000/000', 0, 1200, { blockPayloadLen: 256 }),
    ).rejects.toThrow(/sequence gap/);
  });

  it('refuses overlapping SD commands and read windows instead of racing shared state', async () => {
    const card = makeCard();
    const { client } = await makeClient(card);

    // A read window is in flight (frames arrive on timers), so a second
    // window and a one-shot command must both be refused, not silently
    // hijack the first window's frame/expectation slots.
    const inFlight = client.sdReadFileWindow('data/Trial_1/Shim-000/000', 0, 1200, {
      blockPayloadLen: 128,
    });

    await expect(
      client.sdReadFileWindow('data/Trial_1/Shim-000/001', 0, 300, { blockPayloadLen: 128 }),
    ).rejects.toThrow(SdTransferError);

    // The first window still completes correctly and in full
    const res = await inFlight;
    expect(res.bytesReceived).toBe(1200);

    // Two concurrent one-shot commands: the second is refused
    const listing = client.sdListDir('data/Trial_1');
    await expect(client.sdStatFile('data/Trial_1/Shim-000/000')).rejects.toThrow(SdTransferError);
    expect((await listing).length).toBe(2);
  });

  it('ignores stale frames from the previous session', async () => {
    const { client, t } = await makeClient(makeCard());
    // Prime the known-session tracker with a first window
    await client.sdReadFileWindow('data/Trial_1/Shim-001/000', 0, 64, { blockPayloadLen: 64 });
    // Inject a stale SUPERSEDED status frame for that same session right
    // before the next window's frames — it must be skipped, not adopted
    const staleSession = 1;
    setTimeout(() => t.notify(makeStatusFrame(staleSession, SD_XFER.SUPERSEDED, 0)), 0);
    const res = await client.sdReadFileWindow('data/Trial_1/Shim-001/000', 0, 64, {
      blockPayloadLen: 64,
    });
    expect(res.status).toBe(SD_XFER.WINDOW_COMPLETE);
    expect(res.bytesReceived).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator tests
// ---------------------------------------------------------------------------

describe('downloadSdTree', () => {
  it('recreates the on-card tree and downloads byte-identical files', async () => {
    const card = makeCard();
    const { client } = await makeClient(card, { chunkSize: 40 });
    const dest = new MemDir();

    const tree = await enumerateSdTree(client, 'data');
    expect(tree.files.map((f) => f.path).sort()).toEqual([
      'data/Trial_1/Shim-000/000',
      'data/Trial_1/Shim-000/001',
      'data/Trial_1/Shim-001/000',
    ]);
    expect(tree.totalBytes).toBe(1200 + 300 + 64);

    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {
      windowLen: 512,
      blockPayloadLen: 128,
    });
    expect(summary.filesDownloaded).toBe(3);
    expect(summary.filesFailed).toEqual([]);
    expect(summary.bytesDownloaded).toBe(1200 + 300 + 64);

    const f000 = dest.atPath('data/Trial_1/Shim-000')?.files.get('000');
    expect(f000?.data).toEqual(asciiBytes(1200));
    const f001 = dest.atPath('data/Trial_1/Shim-000')?.files.get('001');
    expect(f001?.data).toEqual(asciiBytes(300));
  });

  it('resumes a partial file from its on-disk size', async () => {
    const card = makeCard();
    const { client, sim } = await makeClient(card);
    const dest = new MemDir();

    // Pre-seed the first 400 bytes of Shim-000/000
    const dir = await (
      await (
        await dest.getDirectoryHandle('data', { create: true })
      ).getDirectoryHandle('Trial_1', { create: true })
    ).getDirectoryHandle('Shim-000', { create: true });
    const pre = await dir.getFileHandle('000', { create: true });
    pre.data = asciiBytes(1200).slice(0, 400);

    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {
      windowLen: 4096,
    });
    expect(summary.filesDownloaded).toBe(3);
    const firstReadOfFile = sim.reads.find((r) => r.path === 'data/Trial_1/Shim-000/000');
    expect(firstReadOfFile?.offset).toBe(400);
    expect(dest.atPath('data/Trial_1/Shim-000')?.files.get('000')?.data).toEqual(asciiBytes(1200));
  });

  it('skips files that are already complete on disk', async () => {
    const card = makeCard();
    const { client, sim } = await makeClient(card);
    const dest = new MemDir();
    await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {});
    sim.reads.length = 0;
    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {});
    expect(summary.filesSkipped).toBe(3);
    expect(summary.filesDownloaded).toBe(0);
    expect(sim.reads).toEqual([]);
  });

  it('deleteAfterVerify removes files then emptied directories, deepest first', async () => {
    const card = makeCard();
    const { client } = await makeClient(card);
    const dest = new MemDir();
    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {
      deleteAfterVerify: true,
    });
    expect(summary.filesDownloaded).toBe(3);
    expect(summary.deletedFromCard).toContain('data/Trial_1/Shim-000/000');
    expect(summary.deletedFromCard).toContain('data/Trial_1/Shim-000');
    expect(summary.deletedFromCard).toContain('data/Trial_1');
    // Deepest-first: session dir deleted before its parent trial dir
    expect(summary.deletedFromCard.indexOf('data/Trial_1/Shim-000')).toBeLessThan(
      summary.deletedFromCard.indexOf('data/Trial_1'),
    );
    // Card now only holds the (undeletable) data root
    const dataNode = card.lookup('data');
    expect(dataNode?.kind === 'dir' && dataNode.children.size).toBe(0);
  });

  it('retries a window after an injected CRC error and still completes', async () => {
    const card = makeCard();
    const { client } = await makeClient(card, { corruptSeqOnce: 2 });
    const dest = new MemDir();
    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {
      windowLen: 4096,
      stallTimeoutMs: 300,
    });
    expect(summary.filesFailed).toEqual([]);
    expect(dest.atPath('data/Trial_1/Shim-000')?.files.get('000')?.data).toEqual(asciiBytes(1200));
  });
});

// ---------------------------------------------------------------------------
// Consensys Backup layout
// ---------------------------------------------------------------------------

describe('Consensys Backup layout', () => {
  it('formats the import stamp the way Consensys names its import folders', () => {
    // 2025-06-25 15:30:36 local — matches the observed
    // Shimmer_Workspace/Backup/2025-06-25_15.30.36 folder
    expect(formatSdImportStamp(new Date(2025, 5, 25, 15, 30, 36))).toBe('2025-06-25_15.30.36');
    expect(formatSdImportStamp(new Date(2025, 0, 2, 3, 4, 5))).toBe('2025-01-02_03.04.05');
  });

  it('nests the card tree under <stamp>/<ShimmerName>, taking the name from the session folder', () => {
    expect(
      consensysBackupSegments(
        ['data', 'sync_1750856068', 'Shimmer_5AA4-002'],
        '2025-06-25_15.30.36',
      ),
    ).toEqual([
      '2025-06-25_15.30.36',
      'Shimmer_5AA4',
      'data',
      'sync_1750856068',
      'Shimmer_5AA4-002',
    ]);
  });

  it('falls back to a placeholder device folder when the session folder is not <Name>-<NNN>', () => {
    expect(consensysBackupSegments(['data', 'oddly_named'], 'S')).toEqual([
      'S',
      CONSENSYS_UNKNOWN_DEVICE,
      'data',
      'oddly_named',
    ]);
  });

  it('downloads into a Consensys-importable tree and reports the import stamp', async () => {
    const card = new VirtualCard();
    card.addFile('data/sync_1750856068/Shimmer_5AA4-002/000', asciiBytes(700));
    card.addFile('data/sync_1750856068/Shimmer_5AA4-002/001', asciiBytes(120));
    const { client } = await makeClient(card);
    const dest = new MemDir();

    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {
      layout: 'consensysBackup',
      importStamp: '2025-06-25_15.30.36',
      windowLen: 4096,
    });

    expect(summary.filesDownloaded).toBe(2);
    expect(summary.importStamp).toBe('2025-06-25_15.30.36');

    // Backup/<stamp>/<ShimmerName>/data/<trial>/<session>/<file>
    const sessionDir = dest.atPath(
      '2025-06-25_15.30.36/Shimmer_5AA4/data/sync_1750856068/Shimmer_5AA4-002',
    );
    expect(sessionDir).toBeDefined();
    expect(sessionDir?.files.get('000')?.data).toEqual(asciiBytes(700));
    expect(sessionDir?.files.get('001')?.data).toEqual(asciiBytes(120));

    // The raw card mirror must NOT be created at the destination root
    expect(dest.dirs.has('data')).toBe(false);
  });

  it('files sessions from two devices on one card under their own name folders', async () => {
    const card = new VirtualCard();
    card.addFile('data/sync_1750856068/Shimmer_5AA4-000/000', asciiBytes(64));
    card.addFile('data/sync_1750856068/Shimmer_BEEF-001/000', asciiBytes(64));
    const { client } = await makeClient(card);
    const dest = new MemDir();

    await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {
      layout: 'consensysBackup',
      importStamp: 'STAMP',
    });

    expect(Array.from(dest.atPath('STAMP')?.dirs.keys() ?? []).sort()).toEqual([
      'Shimmer_5AA4',
      'Shimmer_BEEF',
    ]);
  });

  it('still mirrors the card layout by default', async () => {
    const { client } = await makeClient(makeCard());
    const dest = new MemDir();
    const summary = await downloadSdTree(client, dest as unknown as FileSystemDirectoryHandle, {});
    expect(summary.importStamp).toBeUndefined();
    expect(dest.dirs.has('data')).toBe(true);
  });
});
