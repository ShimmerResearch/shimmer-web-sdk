/**
 * Over-the-air firmware update of the Shimmer3R's Bluetooth module (DEV-1164).
 *
 * The Shimmer3R's radio is an Ezurio Vela IF820 (Infineon CYW20820) running
 * EZ-Serial. Its firmware cannot be reflashed by the Shimmer3R's own MCU: the
 * MCU is wired to the module's PUART, and the HCI UART that the module's
 * serial download mode needs reaches only test pads. What the module does
 * accept is Infineon's standard OTA firmware upgrade over BLE GATT — the
 * service `WsOtaUpgrade.exe` drives — so a host updates it directly over the
 * same BLE link the Shimmer3R is already connected on.
 *
 * Protocol (Infineon `wiced_bt_ota_firmware_upgrade`, as driven by Infineon's
 * own peer apps — `btsdk-peer-apps-ota`: Windows `WsOtaDownloader.cpp`, iOS
 * `UpgradeStateMachine.swift`). This is a clean implementation from that
 * description, not a port of their code:
 *
 * 1. Subscribe to the control point (notify / indicate).
 * 2. Control point ← `[PREPARE_DOWNLOAD]`; the module answers status `OK`.
 * 3. Control point ← `[DOWNLOAD, len u32 LE]`; status `OK`.
 * 4. Data characteristic ← the image, in chunks, each written with response.
 * 5. Control point ← `[VERIFY, crc32 u32 LE]` (CRC-32/IEEE of the whole image);
 *    status `OK` means the module has accepted the image. It then resets
 *    itself onto the new firmware, which drops the link.
 *
 * Every control-point answer is one status byte ({@link IF820_OTA_STATUS}).
 * Any non-`OK` answer aborts. The module only switches images after a good
 * VERIFY, so an update interrupted at any earlier point leaves the old
 * firmware running and the update can simply be run again.
 *
 * Like the Verisense DFU helpers this module does no DOM access: progress
 * goes through callbacks and the GATT objects are structurally typed, so
 * tests drive it with a fake.
 *
 * HARDWARE-VERIFY: written from the protocol as Infineon's peer apps drive
 * it and exercised only against a fake GATT server. Not yet run against a
 * Shimmer3R's IF820 — in particular, whether EZ-Serial exposes the OTA
 * service while CYSPP is in use, the chunk size Chrome's negotiated MTU
 * allows, and the module's behaviour after VERIFY (reset, BLE address kept).
 */

import { crc32 } from '../verisense/dfuSerial.js';

/** GATT UUIDs of the Infineon OTA firmware upgrade service. */
export const IF820_OTA = Object.freeze({
  /** The (unsigned-image) OTA firmware upgrade service. */
  SERVICE_UUID: 'ae5d1e47-5c13-43a0-8635-82ad38a1381f',
  /** The secure (signed-image) variant. Same characteristics and commands. */
  SECURE_SERVICE_UUID: 'c7261110-f425-447a-a1bd-9d7246768bd8',
  /** Control point: commands in, one-byte status notifications out. */
  CONTROL_POINT_UUID: 'a3dd50bf-f7a7-4e99-838e-570a086c661b',
  /** Image data, written in chunks during the transfer. */
  DATA_UUID: 'a2e86c7a-d961-4091-b74f-2409e72efe26',
} as const);

/** Both OTA service UUIDs, for a Web Bluetooth `optionalServices` list. The
 * service is not advertised, so it must be granted at `requestDevice` time
 * for the update to run on an existing connection without a second picker. */
export const IF820_OTA_SERVICE_UUIDS: readonly string[] = Object.freeze([
  IF820_OTA.SERVICE_UUID,
  IF820_OTA.SECURE_SERVICE_UUID,
]);

/** Control-point command opcodes. */
export const IF820_OTA_COMMAND = Object.freeze({
  PREPARE_DOWNLOAD: 1,
  DOWNLOAD: 2,
  VERIFY: 3,
  FINISH: 4,
  GET_STATUS: 5,
  CLEAR_STATUS: 6,
  ABORT: 7,
} as const);

/** Control-point status codes. */
export const IF820_OTA_STATUS = Object.freeze({
  OK: 0,
  UNSUPPORTED: 1,
  ILLEGAL: 2,
  VERIFICATION_FAILED: 3,
  INVALID_IMAGE: 4,
  INVALID_IMAGE_SIZE: 5,
  MORE_DATA: 6,
  INVALID_APP_ID: 7,
  INVALID_VERSION: 8,
  CONTINUE: 9,
} as const);

const STATUS_TEXT: Record<number, string> = {
  0: 'OK',
  1: 'unsupported command',
  2: 'illegal state',
  3: 'image verification failed',
  4: 'invalid image',
  5: 'invalid image size',
  6: 'more data',
  7: 'invalid application id',
  8: 'invalid version',
  9: 'continue',
};

/** Human-readable text for a control-point status byte. */
export function if820OtaStatusText(status: number): string {
  return STATUS_TEXT[status] ?? `unknown status 0x${status.toString(16).padStart(2, '0')}`;
}

/**
 * Data chunk size used first. 244 bytes fills one ATT write at the 247-byte
 * MTU desktop and mobile stacks usually negotiate, and is what Infineon's iOS
 * app uses. Web Bluetooth does not expose the MTU, so if the first chunk is
 * refused the update restarts at {@link IF820_OTA_MIN_CHUNK_SIZE}, which fits
 * the 23-byte default MTU every link supports.
 */
export const IF820_OTA_DEFAULT_CHUNK_SIZE = 244;
export const IF820_OTA_MIN_CHUNK_SIZE = 20;

/** Bound on each control-point command's status answer. */
export const IF820_OTA_RESPONSE_TIMEOUT_MS = 10000;
/** Bound on VERIFY, which has the module CRC the whole stored image. */
export const IF820_OTA_VERIFY_TIMEOUT_MS = 30000;

/**
 * Transient BLE-stack errors: the same wording the Verisense DFU flow treats
 * as retryable (Chrome-on-Windows reports most stack failures as
 * NotSupportedError "unknown reason"). A protocol refusal from the module is
 * never transient — retrying the same image gets the same answer.
 */
export const IF820_OTA_TRANSIENT_ERROR_REGEX =
  /unreachable|networkerror|gatt server|disconnected|no longer in range|connection|unknown reason|notsupportederror|timed out/i;

/** An OTA failure, with the module's status byte when it refused a command. */
export class If820OtaError extends Error {
  /** The control-point status byte, when the module answered with a refusal. */
  readonly status: number | null;
  /** True when retrying the update could succeed (link or stack trouble). */
  readonly transient: boolean;

  constructor(message: string, opts: { status?: number | null; transient?: boolean } = {}) {
    super(message);
    this.name = 'If820OtaError';
    this.status = opts.status ?? null;
    this.transient = opts.transient ?? false;
  }
}

/** True when an error from {@link runIf820OtaUpdate} is worth retrying. */
export function isIf820OtaTransientError(error: unknown): boolean {
  if (error instanceof If820OtaError) return error.transient;
  if (error instanceof Error && error.name === 'AbortError') return false;
  return IF820_OTA_TRANSIENT_ERROR_REGEX.test(String(error));
}

// ── Structural GATT types (what this module drives; a fake implements them) ──

export interface If820OtaCharacteristicLike {
  readonly value?: DataView | null;
  startNotifications(): Promise<unknown>;
  stopNotifications?(): Promise<unknown>;
  addEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  removeEventListener(type: 'characteristicvaluechanged', listener: (ev: Event) => void): void;
  writeValueWithResponse?(value: BufferSource): Promise<void>;
  writeValue?(value: BufferSource): Promise<void>;
}

export interface If820OtaServiceLike {
  getCharacteristic(uuid: string): Promise<If820OtaCharacteristicLike>;
}

export interface If820OtaGattServerLike {
  readonly connected: boolean;
  connect(): Promise<If820OtaGattServerLike>;
  getPrimaryService(uuid: string): Promise<If820OtaServiceLike>;
}

/** A `BluetoothDevice`, or anything carrying its `gatt` server. */
export interface If820OtaDeviceLike {
  readonly gatt?: If820OtaGattServerLike | null;
}

// ── Options, progress, result ──

/** Byte progress; the same field names as the Verisense DFU progress events,
 * so a host's progress UI can serve both. */
export interface If820OtaProgress {
  object: 'firmware';
  totalBytes: number;
  currentBytes: number;
}

export interface If820OtaOptions {
  /** User-facing progress text. */
  onStatus?: (message: string) => void;
  /** Byte-level transfer progress. */
  onProgress?: (progress: If820OtaProgress) => void;
  /** Diagnostic lines (protocol chatter; not for end users). */
  onLog?: (message: string) => void;
  /** Cancels the update. The module is sent ABORT and keeps its old firmware. */
  signal?: AbortSignal;
  /** First chunk size to try. Default {@link IF820_OTA_DEFAULT_CHUNK_SIZE}. */
  chunkSize?: number;
  /** Bound on each command's status answer. */
  responseTimeoutMs?: number;
  /** Bound on the VERIFY answer. */
  verifyTimeoutMs?: number;
}

export interface If820OtaResult {
  /** Image size sent. */
  bytes: number;
  /** CRC-32 sent with VERIFY. */
  crc32: number;
  /** Chunk size the transfer completed at. */
  chunkSize: number;
  /** Which service UUID the module exposed. */
  serviceUuid: string;
  durationMs: number;
}

// ── Implementation ──

/** Internal: the first data write failed at a chunk size above the minimum. */
class ChunkRefused extends Error {
  constructor(readonly inner: unknown) {
    super('first data chunk refused');
  }
}

function abortError(): Error {
  const err = new Error('Bluetooth module update cancelled');
  err.name = 'AbortError';
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/** Queue of control-point status bytes, with promise-based waits. */
class StatusQueue {
  private readonly _values: number[] = [];
  private _waiter: ((status: number) => void) | null = null;

  push(status: number): void {
    if (this._waiter) {
      const w = this._waiter;
      this._waiter = null;
      w(status);
    } else {
      this._values.push(status);
    }
  }

  clear(): void {
    this._values.length = 0;
  }

  /** Status bytes received without a waiter (e.g. during the transfer). */
  drain(): number[] {
    return this._values.splice(0, this._values.length);
  }

  next(timeoutMs: number, what: string, signal?: AbortSignal): Promise<number> {
    if (this._values.length) return Promise.resolve(this._values.shift()!);
    return new Promise<number>((resolve, reject) => {
      const onAbort = (): void => {
        cleanup();
        reject(abortError());
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new If820OtaError(`Bluetooth module did not answer ${what} (timed out)`, {
            transient: true,
          }),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this._waiter = null;
        signal?.removeEventListener('abort', onAbort);
      };
      this._waiter = (status) => {
        cleanup();
        resolve(status);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}

async function write(
  char: If820OtaCharacteristicLike,
  bytes: Uint8Array<ArrayBuffer>,
): Promise<void> {
  if (char.writeValueWithResponse) await char.writeValueWithResponse(bytes);
  else if (char.writeValue) await char.writeValue(bytes);
  else throw new If820OtaError('OTA characteristic is not writable');
}

function command(op: number, param?: number): Uint8Array<ArrayBuffer> {
  if (param === undefined) return new Uint8Array([op]);
  const out = new Uint8Array(5);
  out[0] = op;
  new DataView(out.buffer).setUint32(1, param >>> 0, true);
  return out;
}

function wrapGattError(e: unknown, what: string): unknown {
  if (e instanceof If820OtaError || (e instanceof Error && e.name === 'AbortError')) return e;
  const msg = e instanceof Error ? e.message || e.name : String(e);
  return new If820OtaError(`${what} failed: ${msg}`, {
    transient: IF820_OTA_TRANSIENT_ERROR_REGEX.test(`${(e as Error)?.name ?? ''} ${msg}`),
  });
}

async function resolveService(
  server: If820OtaGattServerLike,
  log: (m: string) => void,
): Promise<{ service: If820OtaServiceLike; uuid: string }> {
  let lastError: unknown = null;
  for (const uuid of IF820_OTA_SERVICE_UUIDS) {
    try {
      const service = await server.getPrimaryService(uuid);
      log(`OTA service ${uuid} found`);
      return { service, uuid };
    } catch (e) {
      lastError = e;
      log(`OTA service ${uuid} not available: ${String(e)}`);
    }
  }
  const msg = String(lastError ?? '');
  /* Web Bluetooth throws SecurityError when the service was not listed in
   * optionalServices at requestDevice time — the fix is on the host side, so
   * say so rather than "not found". */
  if (/securityerror|optionalservices|not allowed|blocklist/i.test(msg)) {
    throw new If820OtaError(
      'The Bluetooth module update service was not granted for this connection. ' +
        'Reconnect with the OTA service in optionalServices (IF820_OTA_SERVICE_UUIDS).',
    );
  }
  throw new If820OtaError(
    'This Bluetooth module does not expose the firmware update service.' + (msg ? ` (${msg})` : ''),
  );
}

/**
 * Update the IF820 module's firmware over BLE.
 *
 * `device` is the `BluetoothDevice` the Shimmer3R is connected as (or any
 * object with its `gatt` server); the update runs on that same connection,
 * which must have been opened with {@link IF820_OTA_SERVICE_UUIDS} in its
 * `optionalServices`. `image` is the module's `.ota.bin`.
 *
 * Resolves once the module has verified the image. The module then resets
 * onto the new firmware by itself, so expect the link to drop shortly after;
 * the Shimmer3R's MCU reads the module version only at its own boot, so arm
 * reboot-on-disconnect beforehand ({@link Shimmer3RClient.setRebootOnDisconnect})
 * for the new version to be reported after reconnecting.
 *
 * If the first data write is refused (an MTU too small for the default
 * chunk), the update is aborted and rerun once at
 * {@link IF820_OTA_MIN_CHUNK_SIZE}.
 */
export async function runIf820OtaUpdate(
  device: If820OtaDeviceLike,
  image: ArrayBuffer | Uint8Array,
  opts: If820OtaOptions = {},
): Promise<If820OtaResult> {
  /* A private copy: the image cannot change under the CRC mid-transfer, and
   * it is ArrayBuffer-backed, which the GATT write signature requires. */
  const bytes = new Uint8Array(image.byteLength);
  bytes.set(image instanceof Uint8Array ? image : new Uint8Array(image));
  const onStatus = opts.onStatus ?? ((): void => {});
  const log = opts.onLog ?? ((): void => {});
  const signal = opts.signal;
  const responseTimeoutMs = opts.responseTimeoutMs ?? IF820_OTA_RESPONSE_TIMEOUT_MS;
  const verifyTimeoutMs = opts.verifyTimeoutMs ?? IF820_OTA_VERIFY_TIMEOUT_MS;
  const firstChunk = Math.max(
    IF820_OTA_MIN_CHUNK_SIZE,
    Math.floor(opts.chunkSize ?? IF820_OTA_DEFAULT_CHUNK_SIZE),
  );

  if (bytes.length === 0) throw new If820OtaError('Firmware image is empty');
  throwIfAborted(signal);

  const started = Date.now();
  const server = device.gatt;
  if (!server) throw new If820OtaError('Device has no GATT server (not a BLE connection)');
  try {
    if (!server.connected) {
      onStatus('Connecting to the Bluetooth module…');
      await server.connect();
    }
  } catch (e) {
    throw wrapGattError(e, 'Connecting');
  }

  onStatus('Opening the Bluetooth module update service…');
  const { service, uuid: serviceUuid } = await resolveService(server, log);
  let control: If820OtaCharacteristicLike;
  let data: If820OtaCharacteristicLike;
  try {
    control = await service.getCharacteristic(IF820_OTA.CONTROL_POINT_UUID);
    data = await service.getCharacteristic(IF820_OTA.DATA_UUID);
  } catch (e) {
    throw wrapGattError(e, 'Opening the update characteristics');
  }

  const statuses = new StatusQueue();
  const onValue = (ev: Event): void => {
    const target = (ev.target ?? control) as If820OtaCharacteristicLike;
    const v = target.value;
    if (!v || v.byteLength === 0) return;
    const status = v.getUint8(0);
    log(`control point ← status ${status} (${if820OtaStatusText(status)})`);
    statuses.push(status);
  };
  control.addEventListener('characteristicvaluechanged', onValue);

  const send = async (op: number, param: number | undefined, what: string): Promise<void> => {
    log(`control point → ${what}`);
    try {
      await write(control, command(op, param));
    } catch (e) {
      throw wrapGattError(e, what);
    }
  };

  const expectOk = async (what: string, timeoutMs: number): Promise<void> => {
    const status = await statuses.next(timeoutMs, what, signal);
    if (status !== IF820_OTA_STATUS.OK) {
      throw new If820OtaError(`Bluetooth module refused ${what}: ${if820OtaStatusText(status)}`, {
        status,
      });
    }
  };

  const abortQuietly = async (): Promise<void> => {
    try {
      await write(control, command(IF820_OTA_COMMAND.ABORT));
      log('control point → ABORT');
    } catch {
      /* Best effort: the link may already be gone. Without a VERIFY the
       * module never switches images, so nothing depends on this landing. */
    }
  };

  /** One full pass at a given chunk size. Throws {@link ChunkRefused} when the
   * very first data write fails, so the caller can retry smaller. */
  const pass = async (chunkSize: number): Promise<number> => {
    statuses.clear();
    onStatus('Preparing the Bluetooth module for the update…');
    await send(IF820_OTA_COMMAND.PREPARE_DOWNLOAD, undefined, 'PREPARE_DOWNLOAD');
    await expectOk('PREPARE_DOWNLOAD', responseTimeoutMs);

    await send(IF820_OTA_COMMAND.DOWNLOAD, bytes.length, `DOWNLOAD (${bytes.length} bytes)`);
    await expectOk('DOWNLOAD', responseTimeoutMs);

    onStatus('Sending firmware to the Bluetooth module…');
    let crc = 0;
    let offset = 0;
    opts.onProgress?.({ object: 'firmware', totalBytes: bytes.length, currentBytes: 0 });
    while (offset < bytes.length) {
      throwIfAborted(signal);
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      try {
        await write(data, chunk);
      } catch (e) {
        if (offset === 0 && chunkSize > IF820_OTA_MIN_CHUNK_SIZE) throw new ChunkRefused(e);
        throw wrapGattError(e, `Writing firmware at offset ${offset}`);
      }
      crc = crc32(chunk, crc);
      offset += chunk.length;
      opts.onProgress?.({ object: 'firmware', totalBytes: bytes.length, currentBytes: offset });
      /* The module does not answer data writes on the control point, except
       * with flow-control hints (CONTINUE / MORE_DATA). Anything else mid
       * transfer is a refusal. */
      for (const status of statuses.drain()) {
        if (status !== IF820_OTA_STATUS.CONTINUE && status !== IF820_OTA_STATUS.MORE_DATA) {
          throw new If820OtaError(
            `Bluetooth module stopped the transfer at ${offset} bytes: ${if820OtaStatusText(status)}`,
            { status },
          );
        }
      }
    }

    onStatus('Verifying the firmware on the Bluetooth module…');
    await send(
      IF820_OTA_COMMAND.VERIFY,
      crc,
      `VERIFY (crc32 0x${crc.toString(16).padStart(8, '0')})`,
    );
    await expectOk('VERIFY', verifyTimeoutMs);
    return crc;
  };

  try {
    try {
      await control.startNotifications();
    } catch (e) {
      throw wrapGattError(e, 'Subscribing to the update control point');
    }

    let chunkSize = firstChunk;
    let crc: number;
    for (;;) {
      try {
        crc = await pass(chunkSize);
        break;
      } catch (e) {
        if (e instanceof ChunkRefused) {
          log(
            `first ${chunkSize}-byte data write refused (${String(e.inner)}); retrying at ${IF820_OTA_MIN_CHUNK_SIZE}`,
          );
          await abortQuietly();
          chunkSize = IF820_OTA_MIN_CHUNK_SIZE;
          continue;
        }
        throw e;
      }
    }

    onStatus('Bluetooth module firmware accepted; the module is restarting.');
    return {
      bytes: bytes.length,
      crc32: crc,
      chunkSize,
      serviceUuid,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    if (server.connected) await abortQuietly();
    throw e;
  } finally {
    control.removeEventListener('characteristicvaluechanged', onValue);
  }
}

// ── Version helpers ──

/**
 * Compare two dotted version strings numerically (`'1.4.16.16'` vs
 * `'1.4.18.18'`). Missing fields count as 0. Returns <0, 0 or >0.
 */
export function compareIf820Versions(a: string, b: string): number {
  const pa = a
    .replace(/^v/i, '')
    .split('.')
    .map((n) => Number(n) || 0);
  const pb = b
    .replace(/^v/i, '')
    .split('.')
    .map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * True when the module reported by `readBtModuleVersion()` is an IF820
 * (CYW20820) on an older firmware than `latest`. Anything else — another
 * module family, or a version that was not reported — is false: a host must
 * never offer this image to a module it cannot identify.
 */
export function isIf820UpdateAvailable(
  current: { family: string; version: string | null } | null | undefined,
  latest: string,
): boolean {
  if (!current || current.family !== 'cyw20820' || !current.version) return false;
  return compareIf820Versions(current.version, latest) < 0;
}
