/**
 * File System Access API stand-ins for the CSV recorder tests: a writable
 * stream that records what reached it, and a directory that hands them out.
 */

/** A FileSystemWritableFileStream stand-in: records what reached it. */
export class FakeWritable {
  chunks: Uint8Array[] = [];
  writes = 0;
  closed = false;
  aborted = false;
  /** Throw on the write with this (0-based) index, and every one after. */
  failWriteAt: number | null = null;
  failClose = false;

  async write(data: Uint8Array): Promise<void> {
    if (this.failWriteAt !== null && this.writes >= this.failWriteAt) {
      throw new Error('disk full');
    }
    this.writes++;
    this.chunks.push(data.slice());
  }
  async close(): Promise<void> {
    if (this.failClose) throw new Error('close refused');
    this.closed = true;
  }
  async abort(): Promise<void> {
    this.aborted = true;
  }
  text(): string {
    return this.chunks.map((c) => new TextDecoder().decode(c)).join('');
  }
  lines(): string[] {
    return this.text().split('\r\n').slice(0, -1);
  }
}

/** A FileSystemDirectoryHandle stand-in. */
export class FakeDirectory {
  readonly dirs = new Map<string, FakeDirectory>();
  readonly files = new Map<string, FakeWritable>();
  /** Called for each new file, so a test can arm a failure on it. */
  onNewFile: ((name: string, w: FakeWritable) => void) | null = null;

  constructor(readonly name = 'root') {}

  async getDirectoryHandle(name: string, _opts?: { create?: boolean }): Promise<FakeDirectory> {
    let d = this.dirs.get(name);
    if (!d) this.dirs.set(name, (d = new FakeDirectory(name)));
    d.onNewFile = this.onNewFile;
    return d;
  }

  async getFileHandle(name: string, _opts?: { create?: boolean }) {
    return {
      name,
      createWritable: async () => {
        const w = new FakeWritable();
        this.files.set(name, w);
        this.onNewFile?.(name, w);
        return w;
      },
    };
  }
}

export async function blobText(blob: Blob): Promise<string> {
  return new TextDecoder().decode(await blob.arrayBuffer());
}
