import { describe, it, expect } from 'vitest';
import {
  IF820_OTA,
  IF820_OTA_COMMAND,
  IF820_OTA_STATUS,
  IF820_OTA_DEFAULT_CHUNK_SIZE,
  IF820_OTA_FAST_CHUNK_SIZE,
  IF820_OTA_SAFE_CHUNK_SIZE,
  IF820_OTA_MIN_CHUNK_SIZE,
  If820OtaError,
  runIf820OtaUpdate,
  isIf820OtaTransientError,
  if820OtaStatusText,
  compareIf820Versions,
  isIf820UpdateAvailable,
  if820OtaSensorSupport,
  IF820_OTA_MIN_SENSOR_FIRMWARE,
  type If820OtaCharacteristicLike,
  type If820OtaGattServerLike,
  type If820OtaProgress,
} from '../../src/devices/shimmer3r/if820Ota.js';
import { crc32 } from '../../src/devices/verisense/dfuSerial.js';
import { parseBluetoothModuleVersion } from '../../src/devices/identity.js';

type Listener = (ev: Event) => void;

class FakeChar implements If820OtaCharacteristicLike {
  value: DataView | null = null;
  notifying = false;
  private readonly _listeners = new Set<Listener>();
  constructor(private readonly _onWrite: (bytes: Uint8Array) => void | Promise<void>) {}

  async startNotifications(): Promise<unknown> {
    this.notifying = true;
    return this;
  }
  addEventListener(_type: 'characteristicvaluechanged', l: Listener): void {
    this._listeners.add(l);
  }
  removeEventListener(_type: 'characteristicvaluechanged', l: Listener): void {
    this._listeners.delete(l);
  }
  get listenerCount(): number {
    return this._listeners.size;
  }
  async writeValueWithResponse(value: BufferSource): Promise<void> {
    const bytes =
      value instanceof Uint8Array
        ? new Uint8Array(value)
        : new Uint8Array(value instanceof ArrayBuffer ? value : (value as ArrayBufferView).buffer);
    await this._onWrite(bytes);
  }
  notify(bytes: number[]): void {
    this.value = new DataView(Uint8Array.from(bytes).buffer);
    for (const l of this._listeners) l({ target: this } as unknown as Event);
  }
}

interface FakeModuleOptions {
  /** Largest data write the "MTU" accepts. */
  maxChunk?: number;
  /** Only the secure service is exposed. */
  secureOnly?: boolean;
  /** No OTA service at all. */
  noService?: boolean;
  /** getPrimaryService throws a SecurityError (not in optionalServices). */
  notGranted?: boolean;
  /** Status to answer PREPARE_DOWNLOAD with. */
  prepareStatus?: number;
  /** Corrupt one received byte so VERIFY fails. */
  corrupt?: boolean;
  /** Never answer this command. */
  silentOn?: number;
  /** Send a status mid-transfer after this many data writes. */
  midTransferStatus?: { afterWrites: number; status: number };
  /** Fail the data write at this offset with a link error. */
  dropAtOffset?: number;
  /** Never answer a data write longer than this - the stalled-link case
   * (a 340 µs airtime limit on the real module). Cleared by a reconnect only
   * if `stallClearsOnReconnect`. */
  stallAbove?: number;
  stallClearsOnReconnect?: boolean;
  /** Never answer the data write at this offset or any after it - a link
   * that stalls mid transfer. */
  stallAtOffset?: number;
  /** getPrimaryService fails as the link goes down under it. */
  dropOnServiceLookup?: boolean;
  /** Never complete the control-point write of this command. */
  hangWriteOf?: number;
  /** Answer VERIFY only after this long. */
  verifyDelayMs?: number;
  /** Notify these flow-control statuses as VERIFY arrives, ahead of its
   * answer - as hints sent for the last data write but delivered late. */
  lateStatusesAfterLastWrite?: number[];
}

class FakeIf820 {
  readonly control: FakeChar;
  readonly data: FakeChar;
  readonly commands: number[][] = [];
  readonly dataWrites: number[] = [];
  received: number[] = [];
  expectedLength = 0;
  connected = true;
  connects = 0;
  disconnects = 0;
  private _writesSinceDownload = 0;

  constructor(readonly opts: FakeModuleOptions = {}) {
    this.control = new FakeChar((b) => this._onControl(b));
    this.data = new FakeChar((b) => this._onData(b));
  }

  get server(): If820OtaGattServerLike {
    const getPrimaryService = async (uuid: string) => {
      if (this.opts.dropOnServiceLookup) {
        this.connected = false;
        const e = new Error('GATT Server is disconnected. Cannot retrieve services.');
        e.name = 'NetworkError';
        throw e;
      }
      if (this.opts.notGranted) {
        const e = new Error(
          `Origin is not allowed to access the service. Tip: Add the service UUID to 'optionalServices'`,
        );
        e.name = 'SecurityError';
        throw e;
      }
      const exposed: string[] = this.opts.noService
        ? []
        : this.opts.secureOnly
          ? [IF820_OTA.SECURE_SERVICE_UUID]
          : [IF820_OTA.SERVICE_UUID];
      if (!exposed.includes(uuid)) {
        const e = new Error('No Services matching UUID found in Device.');
        e.name = 'NotFoundError';
        throw e;
      }
      return {
        getCharacteristic: async (c: string) => {
          if (c === IF820_OTA.CONTROL_POINT_UUID) return this.control;
          if (c === IF820_OTA.DATA_UUID) return this.data;
          throw new Error('no such characteristic');
        },
      };
    };
    const server = {
      getPrimaryService,
      connect: async () => {
        this.connected = true;
        this.connects++;
        if (this.opts.stallClearsOnReconnect) this.opts.stallAbove = undefined;
        return server;
      },
      disconnect: () => {
        this.connected = false;
        this.disconnects++;
      },
    } as unknown as If820OtaGattServerLike;
    Object.defineProperty(server, 'connected', { get: () => this.connected });
    return server;
  }

  private _answer(status: number): void {
    setTimeout(() => this.control.notify([status]), 0);
  }

  private _onControl(bytes: Uint8Array): void | Promise<void> {
    const cmd = Array.from(bytes);
    this.commands.push(cmd);
    const op = cmd[0];
    if (op === this.opts.hangWriteOf) return new Promise<void>(() => {});
    if (op === IF820_OTA_COMMAND.VERIFY) {
      for (const late of this.opts.lateStatusesAfterLastWrite ?? []) this.control.notify([late]);
    }
    if (op === this.opts.silentOn) return;
    const param = bytes.length >= 5 ? new DataView(bytes.buffer).getUint32(1, true) : undefined;
    switch (op) {
      case IF820_OTA_COMMAND.PREPARE_DOWNLOAD:
        this.received = [];
        this._answer(this.opts.prepareStatus ?? IF820_OTA_STATUS.OK);
        break;
      case IF820_OTA_COMMAND.DOWNLOAD:
        this.expectedLength = param!;
        this._writesSinceDownload = 0;
        this._answer(IF820_OTA_STATUS.OK);
        break;
      case IF820_OTA_COMMAND.VERIFY: {
        const got = Uint8Array.from(this.received);
        if (this.opts.corrupt && got.length) got[0] ^= 0xff;
        const ok = got.length === this.expectedLength && crc32(got) === param;
        const status = ok ? IF820_OTA_STATUS.OK : IF820_OTA_STATUS.VERIFICATION_FAILED;
        if (this.opts.verifyDelayMs) {
          setTimeout(() => this.control.notify([status]), this.opts.verifyDelayMs);
        } else {
          this._answer(status);
        }
        break;
      }
      case IF820_OTA_COMMAND.ABORT:
        this.received = [];
        break;
      default:
        this._answer(IF820_OTA_STATUS.UNSUPPORTED);
    }
  }

  private _onData(bytes: Uint8Array): void | Promise<void> {
    if (this.opts.stallAbove !== undefined && bytes.length > this.opts.stallAbove) {
      return new Promise<void>(() => {});
    }
    if (this.opts.stallAtOffset !== undefined && this.received.length >= this.opts.stallAtOffset) {
      return new Promise<void>(() => {});
    }
    if (this.opts.dropAtOffset !== undefined && this.received.length >= this.opts.dropAtOffset) {
      this.connected = false;
      const e = new Error('GATT Server is disconnected. Cannot perform GATT operations.');
      e.name = 'NetworkError';
      throw e;
    }
    if (this.opts.maxChunk !== undefined && bytes.length > this.opts.maxChunk) {
      const e = new Error('GATT operation failed for unknown reason.');
      e.name = 'NotSupportedError';
      throw e;
    }
    this.dataWrites.push(bytes.length);
    this.received.push(...bytes);
    this._writesSinceDownload++;
    const mid = this.opts.midTransferStatus;
    if (mid && this._writesSinceDownload === mid.afterWrites) this.control.notify([mid.status]);
  }
}

function image(n: number): Uint8Array {
  return Uint8Array.from({ length: n }, (_, i) => (i * 7 + 3) & 0xff);
}

describe('runIf820OtaUpdate', () => {
  it('prepares, downloads in chunks, and verifies with the image CRC', async () => {
    const mod = new FakeIf820();
    const img = image(1000);
    const progress: If820OtaProgress[] = [];
    const result = await runIf820OtaUpdate({ gatt: mod.server }, img, {
      onProgress: (p) => progress.push(p),
    });

    expect(mod.commands[0]).toEqual([IF820_OTA_COMMAND.PREPARE_DOWNLOAD]);
    expect(mod.commands[1]).toEqual([IF820_OTA_COMMAND.DOWNLOAD, 0xe8, 0x03, 0x00, 0x00]);
    const verify = mod.commands[2];
    expect(verify[0]).toBe(IF820_OTA_COMMAND.VERIFY);
    expect(new DataView(Uint8Array.from(verify).buffer).getUint32(1, true)).toBe(crc32(img));
    expect(mod.commands).toHaveLength(3);

    expect(Uint8Array.from(mod.received)).toEqual(img);
    expect(mod.dataWrites.every((n) => n <= IF820_OTA_DEFAULT_CHUNK_SIZE)).toBe(true);
    expect(mod.control.notifying).toBe(true);
    expect(mod.control.listenerCount).toBe(0);

    expect(result).toMatchObject({
      bytes: 1000,
      crc32: crc32(img),
      chunkSize: IF820_OTA_DEFAULT_CHUNK_SIZE,
      serviceUuid: IF820_OTA.SERVICE_UUID,
    });
    expect(progress[0]).toEqual({ object: 'firmware', totalBytes: 1000, currentBytes: 0 });
    expect(progress.at(-1)).toEqual({ object: 'firmware', totalBytes: 1000, currentBytes: 1000 });
  });

  it('accepts an ArrayBuffer image', async () => {
    const mod = new FakeIf820();
    const img = image(300);
    await runIf820OtaUpdate({ gatt: mod.server }, img.buffer as ArrayBuffer);
    expect(Uint8Array.from(mod.received)).toEqual(img);
  });

  it('starts at 512-byte chunks', async () => {
    const mod = new FakeIf820();
    const result = await runIf820OtaUpdate({ gatt: mod.server }, image(1300));
    expect(result.chunkSize).toBe(IF820_OTA_FAST_CHUNK_SIZE);
    expect(mod.dataWrites).toEqual([512, 512, 276]);
  });

  it('falls back to 63 on the same link when a large first write is refused', async () => {
    const mod = new FakeIf820({ maxChunk: IF820_OTA_SAFE_CHUNK_SIZE });
    const img = image(1000);
    const retries: unknown[] = [];
    const result = await runIf820OtaUpdate({ gatt: mod.server }, img, {
      onRetry: (r) => retries.push(r),
    });
    expect(result.chunkSize).toBe(IF820_OTA_SAFE_CHUNK_SIZE);
    expect(Uint8Array.from(mod.received)).toEqual(img);
    expect(retries).toEqual([{ fromChunkSize: 512, toChunkSize: 63, reconnecting: false }]);
    expect(mod.disconnects).toBe(0);
    expect(mod.commands.map((c) => c[0])).toEqual([
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.ABORT,
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.VERIFY,
    ]);
  });

  it('drops a stalled link, reconnects and finishes at 63 bytes', async () => {
    // The module never answers a write that does not fit one radio packet.
    const mod = new FakeIf820({ stallAbove: IF820_OTA_SAFE_CHUNK_SIZE });
    const img = image(1000);
    const retries: unknown[] = [];
    const result = await runIf820OtaUpdate({ gatt: mod.server }, img, {
      firstWriteTimeoutMs: 30,
      reconnectDelayMs: 5,
      onRetry: (r) => retries.push(r),
    });
    expect(result.chunkSize).toBe(IF820_OTA_SAFE_CHUNK_SIZE);
    expect(Uint8Array.from(mod.received)).toEqual(img);
    expect(retries).toEqual([{ fromChunkSize: 512, toChunkSize: 63, reconnecting: true }]);
    expect(mod.disconnects).toBe(1);
    expect(mod.connects).toBe(1);
    expect(mod.commands.map((c) => c[0])).toEqual([
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.VERIFY,
    ]);
  });

  it('gives up with a transient error when the stalled link will not come back', async () => {
    const mod = new FakeIf820({ stallAbove: IF820_OTA_SAFE_CHUNK_SIZE });
    const server = mod.server;
    (server as unknown as { connect: () => Promise<never> }).connect = async () => {
      throw new Error('GATT Server is disconnected. Cannot perform GATT operations.');
    };
    const err = await runIf820OtaUpdate({ gatt: server }, image(500), {
      firstWriteTimeoutMs: 20,
      reconnectDelayMs: 1,
      reconnectAttempts: 2,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/Could not reconnect/);
  });

  it('falls back to the minimum chunk when the first chunk is refused', async () => {
    const mod = new FakeIf820({ maxChunk: IF820_OTA_MIN_CHUNK_SIZE });
    const img = image(250);
    const result = await runIf820OtaUpdate({ gatt: mod.server }, img);
    expect(result.chunkSize).toBe(IF820_OTA_MIN_CHUNK_SIZE);
    expect(Uint8Array.from(mod.received)).toEqual(img);
    // 512 refused, then 63 refused, then 20 completes - each on the same link
    expect(mod.commands.map((c) => c[0])).toEqual([
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.ABORT,
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.ABORT,
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.VERIFY,
    ]);
  });

  it('uses the secure service when only that one is exposed', async () => {
    const mod = new FakeIf820({ secureOnly: true });
    const result = await runIf820OtaUpdate({ gatt: mod.server }, image(50));
    expect(result.serviceUuid).toBe(IF820_OTA.SECURE_SERVICE_UUID);
  });

  it('explains a service that was not granted in optionalServices', async () => {
    const mod = new FakeIf820({ notGranted: true });
    await expect(runIf820OtaUpdate({ gatt: mod.server }, image(50))).rejects.toThrow(
      /not granted.*optionalServices/,
    );
  });

  it('reports a module without the update service', async () => {
    const mod = new FakeIf820({ noService: true });
    await expect(runIf820OtaUpdate({ gatt: mod.server }, image(50))).rejects.toThrow(
      /does not expose the firmware update service/,
    );
  });

  it('fails with the status when the module refuses PREPARE_DOWNLOAD', async () => {
    const mod = new FakeIf820({ prepareStatus: IF820_OTA_STATUS.ILLEGAL });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(50)).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.status).toBe(IF820_OTA_STATUS.ILLEGAL);
    expect(err.transient).toBe(false);
    expect(err.message).toMatch(/illegal state/);
    expect(mod.commands.at(-1)).toEqual([IF820_OTA_COMMAND.ABORT]);
  });

  it('fails when the module rejects the image at VERIFY', async () => {
    const mod = new FakeIf820({ corrupt: true });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(500)).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.status).toBe(IF820_OTA_STATUS.VERIFICATION_FAILED);
    expect(isIf820OtaTransientError(err)).toBe(false);
  });

  it('stops on a refusal arriving mid-transfer but tolerates CONTINUE', async () => {
    const ok = new FakeIf820({
      midTransferStatus: { afterWrites: 2, status: IF820_OTA_STATUS.CONTINUE },
    });
    await runIf820OtaUpdate({ gatt: ok.server }, image(1000));

    const bad = new FakeIf820({
      midTransferStatus: { afterWrites: 2, status: IF820_OTA_STATUS.INVALID_IMAGE },
    });
    const err = await runIf820OtaUpdate({ gatt: bad.server }, image(1000)).catch((e) => e);
    expect(err.status).toBe(IF820_OTA_STATUS.INVALID_IMAGE);
    expect(bad.commands.some((c) => c[0] === IF820_OTA_COMMAND.VERIFY)).toBe(false);
  });

  it('classifies a link drop mid-transfer as transient and skips ABORT on a dead link', async () => {
    const mod = new FakeIf820({ dropAtOffset: 504 });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(1000), {
      chunkSize: IF820_OTA_SAFE_CHUNK_SIZE,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/offset 504/);
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.ABORT)).toBe(false);
  });

  it('times out a command the module never answers', async () => {
    const mod = new FakeIf820({ silentOn: IF820_OTA_COMMAND.DOWNLOAD });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(50), {
      responseTimeoutMs: 20,
    }).catch((e) => e);
    expect(err.message).toMatch(/did not answer DOWNLOAD/);
    expect(err.transient).toBe(true);
  });

  it('cancels via AbortSignal and sends ABORT', async () => {
    const mod = new FakeIf820();
    const ctrl = new AbortController();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(2000), {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.currentBytes > 500) ctrl.abort();
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(isIf820OtaTransientError(err)).toBe(false);
    expect(mod.commands.at(-1)).toEqual([IF820_OTA_COMMAND.ABORT]);
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.VERIFY)).toBe(false);
  });

  it('reports cancellation, not a timeout, when aborted while a command write is in flight', async () => {
    const mod = new FakeIf820({ silentOn: IF820_OTA_COMMAND.DOWNLOAD });
    const ctrl = new AbortController();
    const started = Date.now();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(50), {
      signal: ctrl.signal,
      responseTimeoutMs: 5000,
      onLog: (line) => {
        if (line.startsWith('control point → DOWNLOAD')) ctrl.abort();
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('rejects a chunkSize that is not a finite positive number', async () => {
    for (const chunkSize of [NaN, Infinity, 0, -5]) {
      const mod = new FakeIf820();
      await expect(
        runIf820OtaUpdate({ gatt: mod.server }, image(10), { chunkSize }),
      ).rejects.toThrow(/Invalid chunkSize/);
      expect(mod.commands).toEqual([]);
    }
  });

  it('cancels at once during a stalled first write, dropping the stalled link', async () => {
    const mod = new FakeIf820({ stallAbove: 63 });
    const ctrl = new AbortController();
    const started = Date.now();
    const run = runIf820OtaUpdate({ gatt: mod.server }, image(2000), {
      signal: ctrl.signal,
      firstWriteTimeoutMs: 10_000,
    }).catch((e) => e);
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    const err = await run;
    expect(err.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mod.disconnects).toBe(1);
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.VERIFY)).toBe(false);
  });

  it('re-opens a stalled link through the reconnect hook when one is given', async () => {
    const mod = new FakeIf820({ stallAbove: 63, stallClearsOnReconnect: true });
    const server = mod.server;
    let hookCalls = 0;
    const result = await runIf820OtaUpdate({ gatt: server }, image(2000), {
      firstWriteTimeoutMs: 50,
      reconnectDelayMs: 1,
      reconnect: async () => {
        hookCalls++;
        await server.connect();
      },
    });
    expect(hookCalls).toBe(1);
    expect(mod.connects).toBe(1);
    expect(result.chunkSize).toBe(IF820_OTA_SAFE_CHUNK_SIZE);
  });

  it('cancels at once during a fallback reconnect that never completes', async () => {
    const mod = new FakeIf820({ stallAbove: 63 });
    const ctrl = new AbortController();
    const started = Date.now();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(2000), {
      signal: ctrl.signal,
      firstWriteTimeoutMs: 50,
      reconnectDelayMs: 1,
      reconnect: () => {
        setTimeout(() => ctrl.abort(), 20);
        return new Promise<void>(() => {});
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('gives up on a reconnect attempt that never completes and tries again', async () => {
    const mod = new FakeIf820({ stallAbove: 63, stallClearsOnReconnect: true });
    const server = mod.server;
    let calls = 0;
    const result = await runIf820OtaUpdate({ gatt: server }, image(2000), {
      firstWriteTimeoutMs: 50,
      reconnectDelayMs: 1,
      responseTimeoutMs: 100,
      reconnect: async () => {
        calls++;
        if (calls === 1) return new Promise<void>(() => {});
        await server.connect();
      },
    });
    expect(calls).toBe(2);
    expect(result.chunkSize).toBe(IF820_OTA_SAFE_CHUNK_SIZE);
  });

  it('cancels at once during the wait before a fallback reconnect', async () => {
    const mod = new FakeIf820({ stallAbove: 63 });
    const ctrl = new AbortController();
    const started = Date.now();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(2000), {
      signal: ctrl.signal,
      firstWriteTimeoutMs: 50,
      reconnectDelayMs: 10_000,
      onRetry: () => setTimeout(() => ctrl.abort(), 20),
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(mod.connects).toBe(0);
  });

  it('does not take a late CONTINUE / MORE_DATA for the answer to VERIFY', async () => {
    const mod = new FakeIf820({
      lateStatusesAfterLastWrite: [IF820_OTA_STATUS.CONTINUE, IF820_OTA_STATUS.MORE_DATA],
    });
    const lines: string[] = [];
    const result = await runIf820OtaUpdate({ gatt: mod.server }, image(1000), {
      onLog: (l) => lines.push(l),
    });
    expect(result.bytes).toBe(1000);
    expect(mod.commands.map((c) => c[0])).toEqual([
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.VERIFY,
    ]);
    expect(lines.filter((l) => /skipping a late/.test(l))).toHaveLength(2);
  });

  it('times out a control-point write that hangs, drops the link, and calls it transient', async () => {
    const mod = new FakeIf820({ hangWriteOf: IF820_OTA_COMMAND.DOWNLOAD });
    const started = Date.now();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(100), {
      responseTimeoutMs: 100,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/did not accept DOWNLOAD/);
    expect(mod.disconnects).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('cancels at once during a control-point write that hangs', async () => {
    const mod = new FakeIf820({ hangWriteOf: IF820_OTA_COMMAND.DOWNLOAD });
    const ctrl = new AbortController();
    const started = Date.now();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(100), {
      signal: ctrl.signal,
      onLog: (line) => {
        if (line.startsWith('control point → DOWNLOAD')) setTimeout(() => ctrl.abort(), 20);
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(mod.disconnects).toBe(1);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('runs to completion when cancelled after VERIFY was written', async () => {
    const mod = new FakeIf820({ verifyDelayMs: 100 });
    const ctrl = new AbortController();
    const result = await runIf820OtaUpdate({ gatt: mod.server }, image(1000), {
      signal: ctrl.signal,
      onLog: (line) => {
        if (line.startsWith('control point → VERIFY')) setTimeout(() => ctrl.abort(), 20);
      },
    });
    expect(result.bytes).toBe(1000);
    expect(mod.commands.at(-1)?.[0]).toBe(IF820_OTA_COMMAND.VERIFY);
  });

  it('after VERIFY, sends no ABORT and says the module may have taken the image', async () => {
    const mod = new FakeIf820({ silentOn: IF820_OTA_COMMAND.VERIFY });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(100), {
      verifyTimeoutMs: 50,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/did not answer VERIFY.*may already have accepted/);
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.ABORT)).toBe(false);
  });

  it('never sends VERIFY when cancelled from the Verifying status callback', async () => {
    const mod = new FakeIf820();
    const ctrl = new AbortController();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(1000), {
      signal: ctrl.signal,
      onStatus: (m) => {
        if (/^Verifying/.test(m)) ctrl.abort();
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.VERIFY)).toBe(false);
  });

  it('never sends VERIFY when cancelled from the last progress callback', async () => {
    const mod = new FakeIf820();
    const ctrl = new AbortController();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(1000), {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.totalBytes > 0 && p.currentBytes >= p.totalBytes) ctrl.abort();
      },
    }).catch((e) => e);
    expect(err.name).toBe('AbortError');
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.VERIFY)).toBe(false);
    expect(mod.commands.at(-1)).toEqual([IF820_OTA_COMMAND.ABORT]);
  });

  it('refuses a second update through another wrapper of the same GATT server', async () => {
    const mod = new FakeIf820();
    const server = mod.server;
    const first = runIf820OtaUpdate({ gatt: server }, image(2000));
    await expect(runIf820OtaUpdate({ gatt: server }, image(2000))).rejects.toThrow(
      /already running/,
    );
    await expect(first).resolves.toMatchObject({ bytes: 2000 });
  });

  it('times out a data write that stalls mid transfer, drops the link, and calls it transient', async () => {
    const mod = new FakeIf820({ stallAtOffset: 1024 });
    const started = Date.now();
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(4000), {
      responseTimeoutMs: 100,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/offset 1024 .*timed out/);
    expect(mod.disconnects).toBe(1);
    expect(mod.commands.some((c) => c[0] === IF820_OTA_COMMAND.VERIFY)).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('cancels at once during a write that stalls mid transfer', async () => {
    const mod = new FakeIf820({ stallAtOffset: 1024 });
    const ctrl = new AbortController();
    const run = runIf820OtaUpdate({ gatt: mod.server }, image(4000), {
      signal: ctrl.signal,
      onProgress: (p) => {
        if (p.currentBytes >= 1024) setTimeout(() => ctrl.abort(), 20);
      },
    }).catch((e) => e);
    const err = await run;
    expect(err.name).toBe('AbortError');
    expect(mod.disconnects).toBe(1);
  });

  it('keeps a link that drops during the service lookup transient', async () => {
    const mod = new FakeIf820({ dropOnServiceLookup: true });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(10)).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).not.toMatch(/does not expose/);
  });

  it('refuses a second update on the same device while one is running', async () => {
    const mod = new FakeIf820();
    const device = { gatt: mod.server };
    const first = runIf820OtaUpdate(device, image(2000));
    await expect(runIf820OtaUpdate(device, image(2000))).rejects.toThrow(/already running/);
    await expect(first).resolves.toMatchObject({ bytes: 2000 });
    expect(mod.commands.map((c) => c[0])).toEqual([
      IF820_OTA_COMMAND.PREPARE_DOWNLOAD,
      IF820_OTA_COMMAND.DOWNLOAD,
      IF820_OTA_COMMAND.VERIFY,
    ]);
    // Released once the first one settles, failed or not.
    await expect(runIf820OtaUpdate(device, image(10))).resolves.toBeDefined();
  });

  it('connects a GATT server that is not connected', async () => {
    const mod = new FakeIf820();
    mod.connected = false;
    await runIf820OtaUpdate({ gatt: mod.server }, image(10));
    expect(mod.connected).toBe(true);
  });

  it('rejects an empty image and a device without GATT', async () => {
    await expect(
      runIf820OtaUpdate({ gatt: new FakeIf820().server }, new Uint8Array(0)),
    ).rejects.toThrow(/empty/);
    await expect(runIf820OtaUpdate({}, image(10))).rejects.toThrow(/not a BLE connection/);
  });
});

describe('IF820 OTA helpers', () => {
  it('names status bytes', () => {
    expect(if820OtaStatusText(IF820_OTA_STATUS.OK)).toBe('OK');
    expect(if820OtaStatusText(0x42)).toBe('unknown status 0x42');
  });

  it('compares dotted versions numerically', () => {
    expect(compareIf820Versions('1.4.16.16', '1.4.18.18')).toBeLessThan(0);
    expect(compareIf820Versions('v1.4.18.18', '1.4.18.18')).toBe(0);
    expect(compareIf820Versions('1.4.18.18', '1.4.9.9')).toBeGreaterThan(0);
    expect(compareIf820Versions('1.4', '1.4.0.0')).toBe(0);
  });

  it('offers the update only to an older IF820', () => {
    const old = parseBluetoothModuleVersion(
      'CYW20820 app=v01.04.16.16, stack=0x00000000, protocol=0x0103, hardware=0x00',
    );
    const same = parseBluetoothModuleVersion(
      'CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0103, hardware=0x00',
    );
    expect(isIf820UpdateAvailable(old, '1.4.18.18')).toBe(true);
    expect(isIf820UpdateAvailable(same, '1.4.18.18')).toBe(false);
    expect(isIf820UpdateAvailable(parseBluetoothModuleVersion('RN4678 V1.23'), '9.9.9.9')).toBe(
      false,
    );
    expect(isIf820UpdateAvailable(parseBluetoothModuleVersion(''), '1.4.18.18')).toBe(false);
    expect(isIf820UpdateAvailable(null, '1.4.18.18')).toBe(false);
  });
});

describe('if820OtaSensorSupport', () => {
  const s3r = (major: number, minor: number, internal: number, firmwareId = 3) => ({
    hardwareVersion: 10,
    firmwareId,
    major,
    minor,
    internal,
  });

  it('allows a Shimmer3R on LogAndStream v1.01.022 or later', () => {
    expect(IF820_OTA_MIN_SENSOR_FIRMWARE).toEqual({ major: 1, minor: 1, internal: 22 });
    expect(if820OtaSensorSupport(s3r(1, 1, 22))).toEqual({ supported: true });
    expect(if820OtaSensorSupport(s3r(1, 1, 30))).toEqual({ supported: true });
    expect(if820OtaSensorSupport(s3r(1, 2, 0))).toEqual({ supported: true });
    expect(if820OtaSensorSupport(s3r(2, 0, 0))).toEqual({ supported: true });
  });

  it('refuses older firmware, other firmware, other hardware and unknowns', () => {
    expect(if820OtaSensorSupport(s3r(1, 1, 21))).toMatchObject({
      supported: false,
      reason: 'firmware-too-old',
      message: expect.stringMatching(/LogAndStream v1\.01\.022 or later/),
    });
    expect(if820OtaSensorSupport(s3r(1, 0, 99))).toMatchObject({ reason: 'firmware-too-old' });
    expect(if820OtaSensorSupport(s3r(1, 1, 30, 1))).toMatchObject({ reason: 'not-logandstream' });
    expect(if820OtaSensorSupport({ ...s3r(1, 1, 30), hardwareVersion: 3 })).toMatchObject({
      reason: 'not-shimmer3r',
    });
    expect(if820OtaSensorSupport({ ...s3r(1, 1, 30), internal: null })).toMatchObject({
      reason: 'unknown',
    });
    expect(if820OtaSensorSupport(null)).toMatchObject({ reason: 'unknown' });
  });
});

describe('Shimmer3RClient IF820 update hooks', () => {
  it('requests the OTA services alongside the Shimmer3R service', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { SHIMMER3R_DEFAULTS } = await import('../../src/devices/shimmer3r/constants.js');
    const client = new Shimmer3RClient({
      optionalServices: ['battery_service', IF820_OTA.SERVICE_UUID],
    });
    expect(client.requestedOptionalServices()).toEqual([
      SHIMMER3R_DEFAULTS.SERVICE_UUID,
      IF820_OTA.SERVICE_UUID,
      IF820_OTA.SECURE_SERVICE_UUID,
      'battery_service',
    ]);
  });

  it('refuses the update when not connected or not over Web Bluetooth', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { LoopbackTransport } = await import('../../src/core/transport/LoopbackTransport.js');
    const client = new Shimmer3RClient();
    await expect(client.updateBtModuleFirmware(image(10))).rejects.toThrow(/Not connected/);

    const t = new LoopbackTransport();
    (client as unknown as { _transport: unknown })._transport = t;
    await expect(client.updateBtModuleFirmware(image(10))).rejects.toThrow(/BLE \(Web Bluetooth\)/);
  });

  it('refuses the update on a sensor that is not a Shimmer3R on v1.01.022 or later', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { WebBluetoothTransport } =
      await import('../../src/core/transport/WebBluetoothTransport.js');
    const mod = new FakeIf820();
    const t = Object.create(WebBluetoothTransport.prototype) as { device: unknown };
    Object.defineProperty(t, 'device', { value: { gatt: mod.server } });
    const client = new Shimmer3RClient();
    const c = client as unknown as {
      _transport: unknown;
      readDeviceVersion: () => Promise<{ hardwareVersion: number }>;
      readFwVersion: () => Promise<{ fwId: number; major: number; minor: number; patch: number }>;
    };
    c._transport = t;
    let fw = { fwId: 3, major: 1, minor: 1, patch: 21 };
    let hw = 10;
    c.readDeviceVersion = async () => ({ hardwareVersion: hw });
    c.readFwVersion = async () => fw;

    await expect(client.updateBtModuleFirmware(image(10))).rejects.toThrow(
      /needs LogAndStream v1\.01\.022 or later/,
    );
    hw = 3;
    fw = { fwId: 3, major: 1, minor: 1, patch: 30 };
    await expect(client.updateBtModuleFirmware(image(10))).rejects.toThrow(
      /Shimmer3R sensors only/,
    );
    expect(mod.commands).toEqual([]);

    hw = 10;
    await expect(client.updateBtModuleFirmware(image(10))).resolves.toMatchObject({ bytes: 10 });
  });

  it('refuses a second update call before it reads anything from the sensor', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { WebBluetoothTransport } =
      await import('../../src/core/transport/WebBluetoothTransport.js');
    const mod = new FakeIf820();
    const t = Object.create(WebBluetoothTransport.prototype) as { device: unknown };
    Object.defineProperty(t, 'device', { value: { gatt: mod.server } });
    const client = new Shimmer3RClient();
    const c = client as unknown as {
      _transport: unknown;
      readDeviceVersion: () => Promise<{ hardwareVersion: number }>;
      readFwVersion: () => Promise<{ fwId: number; major: number; minor: number; patch: number }>;
    };
    c._transport = t;
    let reads = 0;
    c.readDeviceVersion = async () => {
      reads++;
      await new Promise((r) => setTimeout(r, 20));
      return { hardwareVersion: 10 };
    };
    c.readFwVersion = async () => ({ fwId: 3, major: 1, minor: 1, patch: 22 });

    const first = client.updateBtModuleFirmware(image(500));
    await expect(client.updateBtModuleFirmware(image(500))).rejects.toThrow(/already running/);
    expect(reads).toBe(1);
    await expect(first).resolves.toMatchObject({ bytes: 500 });
    // Released afterwards, success or not.
    await expect(client.updateBtModuleFirmware(image(10))).resolves.toBeDefined();
  });

  it('refuses to start streaming while its module update runs', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { WebBluetoothTransport } =
      await import('../../src/core/transport/WebBluetoothTransport.js');
    const mod = new FakeIf820();
    const t = Object.create(WebBluetoothTransport.prototype) as { device: unknown };
    Object.defineProperty(t, 'device', { value: { gatt: mod.server } });
    const client = new Shimmer3RClient();
    const c = client as unknown as {
      _transport: unknown;
      readDeviceVersion: () => Promise<{ hardwareVersion: number }>;
      readFwVersion: () => Promise<{ fwId: number; major: number; minor: number; patch: number }>;
    };
    c._transport = t;
    c.readDeviceVersion = async () => {
      await new Promise((r) => setTimeout(r, 20));
      return { hardwareVersion: 10 };
    };
    c.readFwVersion = async () => ({ fwId: 3, major: 1, minor: 1, patch: 22 });

    const update = client.updateBtModuleFirmware(image(500));
    await expect(client.startStreaming()).rejects.toThrow(/while the Bluetooth module firmware/);
    await expect(client.startStreamingAndLogging()).rejects.toThrow(
      /while the Bluetooth module firmware/,
    );
    await expect(update).resolves.toMatchObject({ bytes: 500 });
  });

  it('refuses the update while a stream start is still waiting for its ACK', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { WebBluetoothTransport } =
      await import('../../src/core/transport/WebBluetoothTransport.js');
    const mod = new FakeIf820();
    const t = Object.create(WebBluetoothTransport.prototype) as { device: unknown };
    Object.defineProperty(t, 'device', { value: { gatt: mod.server } });
    const client = new Shimmer3RClient();
    const c = client as unknown as {
      _transport: unknown;
      _startStreaming: () => Promise<void>;
    };
    c._transport = t;
    let release!: () => void;
    c._startStreaming = () => new Promise<void>((r) => (release = r));

    const starting = client.startStreaming();
    await expect(client.updateBtModuleFirmware(image(10))).rejects.toThrow(/Stop streaming/);
    expect(mod.commands).toEqual([]);
    release();
    await starting;
  });

  it('reconnects through its own transport when the update falls back', async () => {
    const { Shimmer3RClient } = await import('../../src/devices/shimmer3r/Shimmer3RClient.js');
    const { WebBluetoothTransport } =
      await import('../../src/core/transport/WebBluetoothTransport.js');
    const mod = new FakeIf820({ stallAbove: 63, stallClearsOnReconnect: true });
    const server = mod.server;
    const t = Object.create(WebBluetoothTransport.prototype) as { device: unknown };
    Object.defineProperty(t, 'device', { value: { gatt: server } });
    const client = new Shimmer3RClient();
    const c = client as unknown as {
      _transport: unknown;
      readDeviceVersion: () => Promise<{ hardwareVersion: number }>;
      readFwVersion: () => Promise<{ fwId: number; major: number; minor: number; patch: number }>;
      connect: (transport?: unknown) => Promise<void>;
    };
    c._transport = t;
    c.readDeviceVersion = async () => ({ hardwareVersion: 10 });
    c.readFwVersion = async () => ({ fwId: 3, major: 1, minor: 1, patch: 22 });
    const reconnectedWith: unknown[] = [];
    c.connect = async (transport?: unknown) => {
      reconnectedWith.push(transport);
      await server.connect();
    };

    const result = await client.updateBtModuleFirmware(image(2000), {
      firstWriteTimeoutMs: 50,
      reconnectDelayMs: 1,
    });
    expect(reconnectedWith).toEqual([t]);
    expect(result.chunkSize).toBe(IF820_OTA_SAFE_CHUNK_SIZE);
  });
});
