import { describe, it, expect } from 'vitest';
import {
  IF820_OTA,
  IF820_OTA_COMMAND,
  IF820_OTA_STATUS,
  IF820_OTA_DEFAULT_CHUNK_SIZE,
  IF820_OTA_MIN_CHUNK_SIZE,
  If820OtaError,
  runIf820OtaUpdate,
  isIf820OtaTransientError,
  if820OtaStatusText,
  compareIf820Versions,
  isIf820UpdateAvailable,
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
}

class FakeIf820 {
  readonly control: FakeChar;
  readonly data: FakeChar;
  readonly commands: number[][] = [];
  readonly dataWrites: number[] = [];
  received: number[] = [];
  expectedLength = 0;
  connected = true;
  private _writesSinceDownload = 0;

  constructor(readonly opts: FakeModuleOptions = {}) {
    this.control = new FakeChar((b) => this._onControl(b));
    this.data = new FakeChar((b) => this._onData(b));
  }

  get server(): If820OtaGattServerLike {
    const getPrimaryService = async (uuid: string) => {
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
        return server;
      },
    } as unknown as If820OtaGattServerLike;
    Object.defineProperty(server, 'connected', { get: () => this.connected });
    return server;
  }

  private _answer(status: number): void {
    setTimeout(() => this.control.notify([status]), 0);
  }

  private _onControl(bytes: Uint8Array): void {
    const cmd = Array.from(bytes);
    this.commands.push(cmd);
    const op = cmd[0];
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
        this._answer(ok ? IF820_OTA_STATUS.OK : IF820_OTA_STATUS.VERIFICATION_FAILED);
        break;
      }
      case IF820_OTA_COMMAND.ABORT:
        this.received = [];
        break;
      default:
        this._answer(IF820_OTA_STATUS.UNSUPPORTED);
    }
  }

  private _onData(bytes: Uint8Array): void {
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

  it('falls back to the minimum chunk when the first chunk is refused', async () => {
    const mod = new FakeIf820({ maxChunk: IF820_OTA_MIN_CHUNK_SIZE });
    const img = image(250);
    const result = await runIf820OtaUpdate({ gatt: mod.server }, img);
    expect(result.chunkSize).toBe(IF820_OTA_MIN_CHUNK_SIZE);
    expect(Uint8Array.from(mod.received)).toEqual(img);
    // first pass: PREPARE, DOWNLOAD, ABORT; second pass: PREPARE, DOWNLOAD, VERIFY
    expect(mod.commands.map((c) => c[0])).toEqual([
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
    const mod = new FakeIf820({ dropAtOffset: 488 });
    const err = await runIf820OtaUpdate({ gatt: mod.server }, image(1000)).catch((e) => e);
    expect(err).toBeInstanceOf(If820OtaError);
    expect(err.transient).toBe(true);
    expect(err.message).toMatch(/offset 488/);
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
});
