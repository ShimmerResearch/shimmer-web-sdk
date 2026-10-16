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
 * Bench-checked on a Shimmer3R (2026-10-11, from a Python BLE host running
 * this same sequence): EZ-Serial exposes the OTA service alongside CYSPP,
 * PREPARE / DOWNLOAD / data / VERIFY are accepted, the module resets onto
 * the new image and keeps its BLE address. The module may come back on
 * different UART settings, so the Shimmer3R MCU must reboot afterwards to
 * re-provision it - but only once the module has finished switching images
 * (see {@link Shimmer3RClient.updateBtModuleFirmware}).
 *
 * HARDWARE-VERIFY: the normal path has run end to end on a Shimmer3R from
 * Chrome on Windows (v1.4.16.16 to v1.4.18.18, on a link that took 512-byte
 * writes). The stall fallback has not: dropping a link whose first write goes
 * unanswered, reconnecting and carrying on at 63 bytes has run only against a
 * scripted device here, and as the same logic from a Python host on the bench.
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
 * Data chunk sizes, tried in this order.
 *
 * How large a write the Shimmer3R's IF820 takes depends on the link, not the
 * MTU (Windows HCI traces, 2026-10-11, all on the 2M PHY with a 517-byte MTU):
 * the radios agree a maximum packet airtime, and the module stalls - no ATT
 * response, then a supervision timeout - on any write that does not fit one
 * radio packet.
 *
 * - **2120 µs** (251-byte packets): 512-byte writes are accepted, about 43 ms
 *   each, so a 100 KB image takes ~8 s. Seen after a power-on of the module.
 * - **340 µs** (~70-byte packets on an encrypted 2M link): the largest write
 *   that fits is 63 bytes (+4 L2CAP +3 ATT), ~23 ms each, ~30 s per image. Seen
 *   after the module had only been soft-reset.
 *
 * Web Bluetooth exposes neither the airtime nor the MTU, so the update starts
 * at {@link IF820_OTA_FAST_CHUNK_SIZE} and, if that first write is not
 * answered within {@link IF820_OTA_FIRST_WRITE_TIMEOUT_MS}, drops the stalled
 * link itself, reconnects to the same device and starts again at
 * {@link IF820_OTA_SAFE_CHUNK_SIZE}. {@link IF820_OTA_MIN_CHUNK_SIZE} fits the
 * 23-byte default MTU every link supports, and is the last resort.
 */
export const IF820_OTA_FAST_CHUNK_SIZE = 512;
export const IF820_OTA_SAFE_CHUNK_SIZE = 63;
export const IF820_OTA_MIN_CHUNK_SIZE = 20;
/** The first chunk size tried when `chunkSize` is not given. */
export const IF820_OTA_DEFAULT_CHUNK_SIZE = IF820_OTA_FAST_CHUNK_SIZE;

/** How long the first data write may go unanswered before the link is
 * treated as stalled. An accepted 512-byte write answers in ~45 ms. */
export const IF820_OTA_FIRST_WRITE_TIMEOUT_MS = 4000;
/** Reconnect attempts, and the pause before each, after dropping a stalled
 * link to retry smaller. */
export const IF820_OTA_RECONNECT_ATTEMPTS = 5;
export const IF820_OTA_RECONNECT_DELAY_MS = 2000;

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
  disconnect?(): void;
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
  /**
   * Cancels the update. The module is sent ABORT and keeps its old firmware.
   * Honoured up to the moment VERIFY is written; after that the module may
   * already be switching images, so the update runs to its end and a cancel
   * then has no effect.
   */
  signal?: AbortSignal;
  /** First chunk size to try. Default {@link IF820_OTA_DEFAULT_CHUNK_SIZE}. */
  chunkSize?: number;
  /**
   * Called when the first data write is refused or stalls and the update is
   * about to start again at a smaller chunk. `reconnecting` is true when the
   * link is being dropped and re-opened to do so: a host sees that as a
   * disconnect, which is part of the update and not the end of it. See
   * `reconnect` for a host whose own transport is on the link.
   */
  onRetry?: (info: { fromChunkSize: number; toChunkSize: number; reconnecting: boolean }) => void;
  /** Bound on the first data write. */
  firstWriteTimeoutMs?: number;
  /** Reconnect attempts after dropping a stalled link. Each is bounded by
   * `responseTimeoutMs` and ends at once on a cancel. */
  reconnectAttempts?: number;
  /** Pause before each reconnect attempt. */
  reconnectDelayMs?: number;
  /**
   * Re-opens the link after a stalled first write is dropped, in place of
   * `gatt.connect()`. A host whose own transport is on this link passes one
   * that reconnects that transport, so its characteristics, notifications and
   * protocol state are rebuilt as well, not just the update's;
   * {@link Shimmer3RClient.updateBtModuleFirmware} does. The update then
   * re-opens its own characteristics on the new connection.
   */
  reconnect?: () => Promise<void>;
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

/** Internal: the first data write failed at a chunk size above the minimum.
 * `stalled` means it went unanswered, so the link is wedged and has to be
 * dropped and re-opened before anything else can be sent. */
class ChunkRefused extends Error {
  constructor(
    readonly inner: unknown,
    readonly stalled: boolean,
  ) {
    super('first data chunk refused');
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `p`, unless `timeoutMs` passes first (rejects with `onTimeout()`) or the
 * signal is cancelled (rejects with AbortError). `p`'s own late result is
 * ignored.
 */
function settleWithin<T>(
  p: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onTimeout: () => unknown,
): Promise<T> {
  p.catch(() => {});
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const done = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const onAbort = (): void => {
      done();
      reject(abortError());
    };
    const timer = setTimeout(() => {
      done();
      reject(onTimeout());
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        done();
        resolve(v);
      },
      (e: unknown) => {
        done();
        reject(e);
      },
    );
  });
}

/** {@link sleep}, cut short by a cancel, which then rejects with AbortError. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
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
    /* An abort that landed while a write was in flight has already fired, so
     * the listener below would never see it. */
    if (signal?.aborted) return Promise.reject(abortError());
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
  /** False once the caller has given up on this discovery: stop issuing
   * lookups on the link. */
  stillWanted: () => boolean = () => true,
): Promise<{ service: If820OtaServiceLike; uuid: string }> {
  let lastError: unknown = null;
  for (const uuid of IF820_OTA_SERVICE_UUIDS) {
    if (!stillWanted()) throw abortError();
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
  /* The link failing under the lookup is not a module without the service:
   * keep it transient, so the host can retry. */
  if (!server.connected || (lastError as Error)?.name === 'NetworkError') {
    throw wrapGattError(lastError, 'Opening the Bluetooth module update service');
  }
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
 * onto the new firmware by itself, so expect the link to drop shortly after.
 * Do NOT arm the Shimmer3R's reboot-on-disconnect for it: rebooting the MCU
 * on that drop cuts the module's power while it is still switching images,
 * and it comes back on the old one (see
 * {@link Shimmer3RClient.updateBtModuleFirmware}).
 *
 * Starts at {@link IF820_OTA_FAST_CHUNK_SIZE}. If the first data write is
 * refused, the update is aborted and rerun at the next size down; if it goes
 * unanswered (the link has stalled), the link is dropped and re-opened to the
 * same device first - see {@link IF820_OTA_DEFAULT_CHUNK_SIZE} for why, and
 * `onRetry` for telling the host.
 *
 * One update at a time per device: a second call for a device whose update is
 * still running is refused before it touches the module. Two runs would share
 * the control point, each hearing the other's status bytes, and interleave
 * their writes into the one image buffer the module has.
 */
export async function runIf820OtaUpdate(
  device: If820OtaDeviceLike,
  image: ArrayBuffer | Uint8Array,
  opts: If820OtaOptions = {},
): Promise<If820OtaResult> {
  const release = acquireIf820OtaDeviceLease(device);
  const abandoned: Promise<unknown>[] = [];
  try {
    return await runUpdate(device, image, opts, (p) => abandoned.push(p));
  } finally {
    /* A connect or reconnect the update gave up on cannot be stopped, and may
     * still change the link after this returns; the device stays leased
     * until it settles, so no other update starts on a link it is changing. */
    if (abandoned.length) {
      void Promise.allSettled(abandoned).then(release);
    } else {
      release();
    }
  }
}

/**
 * Take the one-update-per-device lease, or throw if an update already holds
 * it; returns its release. Keyed by the GATT server, not the object passed
 * in: two `{ gatt }` wrappers around one device are still one device.
 *
 * Package-internal: {@link Shimmer3RClient.updateBtModuleFirmware} takes it
 * before its own pre-update reads, so another client or a direct
 * {@link runIf820OtaUpdate} on the same device is refused before any link
 * traffic, and then runs the update under it with
 * {@link runIf820OtaUpdateUnderLease}.
 * @internal
 */
export function acquireIf820OtaDeviceLease(device: If820OtaDeviceLike): () => void {
  const key: object = device.gatt ?? device;
  if (updatesInFlight.has(key)) {
    throw new If820OtaError('A Bluetooth module update is already running on this device');
  }
  updatesInFlight.add(key);
  let held = true;
  return () => {
    if (!held) return;
    held = false;
    updatesInFlight.delete(key);
  };
}

/**
 * {@link runIf820OtaUpdate} for a caller that already holds the device's
 * lease from {@link acquireIf820OtaDeviceLease} (and releases it).
 * @internal
 */
export function runIf820OtaUpdateUnderLease(
  device: If820OtaDeviceLike,
  image: ArrayBuffer | Uint8Array,
  opts: If820OtaOptions = {},
  /** Told of link work the update gave up on that may still be running; the
   * caller keeps the lease until it settles. */
  onAbandoned?: (work: Promise<unknown>) => void,
): Promise<If820OtaResult> {
  return runUpdate(device, image, opts, onAbandoned);
}

/** How long a cancelled first write may take to settle before the link is
 * treated as stalled and dropped. A healthy write settles in tens of ms. */
const IF820_OTA_ABORT_GRACE_MS = 500;

/** Devices with an update running, for {@link runIf820OtaUpdate}'s guard. */
const updatesInFlight = new WeakSet<object>();

async function runUpdate(
  device: If820OtaDeviceLike,
  image: ArrayBuffer | Uint8Array,
  opts: If820OtaOptions,
  /** Told of link work given up on that may still be running. */
  onAbandoned: (work: Promise<unknown>) => void = () => {},
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
  const firstWriteTimeoutMs = opts.firstWriteTimeoutMs ?? IF820_OTA_FIRST_WRITE_TIMEOUT_MS;
  const reconnectAttempts = opts.reconnectAttempts ?? IF820_OTA_RECONNECT_ATTEMPTS;
  const reconnectDelayMs = opts.reconnectDelayMs ?? IF820_OTA_RECONNECT_DELAY_MS;
  if (opts.chunkSize !== undefined && (!Number.isFinite(opts.chunkSize) || opts.chunkSize <= 0)) {
    throw new If820OtaError(`Invalid chunkSize: ${opts.chunkSize}`);
  }
  const firstChunk = Math.max(
    IF820_OTA_MIN_CHUNK_SIZE,
    Math.floor(opts.chunkSize ?? IF820_OTA_DEFAULT_CHUNK_SIZE),
  );
  /* The sizes to try, largest first: the requested one, then the safe and
   * minimum sizes below it. */
  const ladder = [
    ...new Set([firstChunk, IF820_OTA_SAFE_CHUNK_SIZE, IF820_OTA_MIN_CHUNK_SIZE]),
  ].filter((n) => n <= firstChunk);

  if (bytes.length === 0) throw new If820OtaError('Firmware image is empty');
  throwIfAborted(signal);

  const started = Date.now();
  const server = device.gatt;
  if (!server) throw new If820OtaError('Device has no GATT server (not a BLE connection)');
  try {
    if (!server.connected) {
      onStatus('Connecting to the Bluetooth module…');
      /* Bounded and cancellable like every later step: a connect the stack
       * never settles must not hold the update forever. */
      const connecting = server.connect();
      await settleWithin(connecting, responseTimeoutMs, signal, () => {
        return new If820OtaError('Connecting timed out', { transient: true });
      }).catch((e: unknown) => {
        onAbandoned(connecting);
        throw e;
      });
    }
  } catch (e) {
    throw wrapGattError(e, 'Connecting');
  }

  const statuses = new StatusQueue();
  const onValue = (ev: Event): void => {
    const target = (ev.target ?? control) as If820OtaCharacteristicLike | undefined;
    const v = target?.value;
    if (!v || v.byteLength === 0) return;
    const status = v.getUint8(0);
    log(`control point ← status ${status} (${if820OtaStatusText(status)})`);
    statuses.push(status);
  };

  let serviceUuid = '';
  let control: If820OtaCharacteristicLike | undefined;
  let data: If820OtaCharacteristicLike | undefined;

  /** Resolve the service and characteristics on the current connection and
   * subscribe to the control point. Run again after a reconnect, which hands
   * out new GATT objects. */
  const open = async (generation?: number): Promise<void> => {
    /* Discovery runs into locals and is committed to the session only at the
     * end, and only while this attempt is still current: a reconnect attempt
     * given up on (see reopen) may still be part-way through it when a later
     * one starts, and must not leave its handles or listener behind. */
    const current = (): boolean => generation === undefined || generation === reopenGeneration;
    const resolved = await resolveService(server, log, current);
    if (!current()) return;
    let ctrl: If820OtaCharacteristicLike;
    let dat: If820OtaCharacteristicLike;
    try {
      ctrl = await resolved.service.getCharacteristic(IF820_OTA.CONTROL_POINT_UUID);
      dat = await resolved.service.getCharacteristic(IF820_OTA.DATA_UUID);
    } catch (e) {
      throw wrapGattError(e, 'Opening the update characteristics');
    }
    if (!current()) return;
    /* The listener goes on only once the subscription has started, and only
     * for the current attempt: a startNotifications() that never settles is
     * abandoned by its caller's timeout, and must leave nothing attached.
     * Nothing arrives on the control point before a command is sent, so no
     * status is missed by subscribing first. */
    try {
      await ctrl.startNotifications();
    } catch (e) {
      throw wrapGattError(e, 'Subscribing to the update control point');
    }
    if (!current()) return;
    if (control && control !== ctrl) {
      control.removeEventListener('characteristicvaluechanged', onValue);
    }
    ctrl.addEventListener('characteristicvaluechanged', onValue);
    control = ctrl;
    data = dat;
    serviceUuid = resolved.uuid;
  };

  /** Bumped per reconnect attempt and whenever one is given up on; an
   * attempt whose number is no longer current never calls open(). */
  let reopenGeneration = 0;

  /** Drop a stalled link and open a fresh one to the same device. */
  const reopen = async (): Promise<void> => {
    if (server.connected) {
      log('dropping the stalled link');
      try {
        server.disconnect?.();
      } catch {
        /* already going */
      }
    }
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= reconnectAttempts; attempt++) {
      throwIfAborted(signal);
      await sleepUnlessAborted(reconnectDelayMs, signal);
      onStatus(
        `Reconnecting to the Bluetooth module (attempt ${attempt} of ${reconnectAttempts})…`,
      );
      /* Each attempt is bounded and cancellable: a connect that never settles
       * must not hold the update forever, nor outlast a cancel. An attempt
       * given up on is invalidated by its generation, so a connect that
       * completes late never goes on to open() - which would swap the control
       * point and its listener out from under a later attempt, or under an
       * update that has already ended. */
      const generation = ++reopenGeneration;
      const reopened = (async (): Promise<void> => {
        if (opts.reconnect) await opts.reconnect();
        else await server.connect();
        if (generation !== reopenGeneration) return;
        await open(generation);
      })();
      try {
        await settleWithin(reopened, responseTimeoutMs, signal, () => {
          return new If820OtaError('Reconnecting timed out', { transient: true });
        });
        return;
      } catch (e) {
        reopenGeneration++;
        onAbandoned(reopened);
        if ((e as Error)?.name === 'AbortError') throw e;
        lastError = e;
        log(`reconnect attempt ${attempt} failed: ${String(e)}`);
      }
    }
    throw new If820OtaError(
      `Could not reconnect to the Bluetooth module to retry the update: ${String(lastError)}`,
      { transient: true },
    );
  };

  const send = async (
    op: number,
    param: number | undefined,
    what: string,
    cancellable = true,
  ): Promise<void> => {
    /* Before the write is even started: a callback just before this one
     * (onStatus('Verifying…') among them) may have cancelled, and a VERIFY
     * once written lets the module switch images. */
    throwIfAborted(signal);
    log(`control point → ${what}`);
    /* Again after log(): onLog is the caller's code and may itself cancel. */
    throwIfAborted(signal);
    /* From here the command is on its way; for VERIFY that is the commit. */
    if (op === IF820_OTA_COMMAND.VERIFY) verifySent = true;
    /* Bounded and cancellable like the data writes: a control-point write
     * that hangs on a failing link would otherwise never reach the response
     * wait, where the timeout and the cancel apply. (awaitWrite is declared
     * below; send only runs once the whole update is set up.) */
    try {
      await awaitWrite(
        write(control!, command(op, param)),
        responseTimeoutMs,
        () =>
          new If820OtaError(`Bluetooth module did not accept ${what} (timed out)`, {
            transient: true,
          }),
        true,
        cancellable,
      );
    } catch (e) {
      throw wrapGattError(e, what);
    }
  };

  const expectOk = async (what: string, timeoutMs: number, cancellable = true): Promise<void> => {
    /* A transfer's flow-control hints (CONTINUE / MORE_DATA) arrive as their
     * own notifications, so one can land after the last data write has
     * resolved and sit in the queue ahead of the command's answer. They are
     * never a command's answer: skip them, within the same deadline. */
    const deadline = Date.now() + timeoutMs;
    let status: number;
    for (;;) {
      try {
        status = await statuses.next(
          Math.max(1, deadline - Date.now()),
          what,
          cancellable ? signal : undefined,
        );
      } catch (e) {
        if ((e as Error)?.name !== 'AbortError') answerTimedOut = true;
        throw e;
      }
      if (status !== IF820_OTA_STATUS.CONTINUE && status !== IF820_OTA_STATUS.MORE_DATA) break;
      log(`skipping a late ${if820OtaStatusText(status)} while waiting for ${what}`);
    }
    if (status !== IF820_OTA_STATUS.OK) {
      throw new If820OtaError(`Bluetooth module refused ${what}: ${if820OtaStatusText(status)}`, {
        status,
      });
    }
  };

  const abortQuietly = async (): Promise<void> => {
    if (!control) return;
    try {
      const sent = write(control, command(IF820_OTA_COMMAND.ABORT));
      sent.catch(() => {});
      const landed = await Promise.race([
        sent.then(() => true),
        sleep(IF820_OTA_ABORT_GRACE_MS).then(() => false),
      ]);
      if (landed) {
        log('control point → ABORT');
      } else {
        /* An ABORT that is not even accepted means a stalled link: drop it,
         * and keep the device leased until the write settles. */
        onAbandoned(sent);
        if (server.connected) {
          log('ABORT went unanswered; dropping the link');
          try {
            server.disconnect?.();
          } catch {
            /* already going */
          }
        }
      }
    } catch {
      /* Best effort: the link may already be gone. Without a VERIFY the
       * module never switches images, so nothing depends on this landing. */
    }
  };

  /**
   * Wait for a data write, bounded by `timeoutMs` and by a cancel. A cancel is
   * honoured at once; a write still pending {@link IF820_OTA_ABORT_GRACE_MS}
   * after it is a stalled link, which would also hold up the ABORT queued
   * behind it, so the link is dropped (the module drops it by supervision
   * timeout anyway). With `dropOnTimeout` a write that times out drops the
   * link the same way. No VERIFY has been sent either way, so the module
   * keeps its current image.
   */
  const awaitWrite = async (
    attempt: Promise<void>,
    timeoutMs: number,
    onTimeout: () => unknown,
    dropOnTimeout: boolean,
    cancellable = true,
  ): Promise<void> => {
    const sig = cancellable ? signal : undefined;
    /* Whatever an abandoned write eventually settles with, it is no longer
     * anyone's concern, and must not surface as an unhandled rejection. */
    attempt.catch(() => {});
    const dropStalled = (why: string): void => {
      if (!server.connected) return;
      log(`${why}; dropping the link`);
      try {
        server.disconnect?.();
      } catch {
        /* already going */
      }
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        reject(onTimeout());
      }, timeoutMs);
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(abortError());
      if (sig?.aborted) onAbort();
      else sig?.addEventListener('abort', onAbort, { once: true });
    });
    try {
      await Promise.race([attempt, timeout, aborted]);
    } catch (e) {
      if (sig?.aborted) {
        const settled = await Promise.race([
          attempt.then(
            () => true,
            () => true,
          ),
          sleep(IF820_OTA_ABORT_GRACE_MS).then(() => false),
        ]);
        if (!settled) {
          onAbandoned(attempt);
          dropStalled('cancelled during a stalled write');
        }
        throw abortError();
      }
      if (timedOut) onAbandoned(attempt);
      if (timedOut && dropOnTimeout) dropStalled('a data write went unanswered');
      throw e;
    } finally {
      clearTimeout(timer);
      if (onAbort) sig?.removeEventListener('abort', onAbort);
    }
  };

  /** The first data write, bounded: on a stalled link it is never answered.
   * HARDWARE-VERIFY: this timeout and the reconnect that follows have not yet
   * run under Web Bluetooth on a real stalled link (see the module note). */
  const firstWrite = async (chunk: Uint8Array<ArrayBuffer>): Promise<void> => {
    try {
      await awaitWrite(
        write(data!, chunk),
        firstWriteTimeoutMs,
        () => new ChunkRefused('no answer', true),
        false,
      );
    } catch (e) {
      if (e instanceof ChunkRefused || (e as Error)?.name === 'AbortError') throw e;
      /* Refused outright. A rejection that comes with the link gone is a stall
       * the stack noticed first. */
      throw new ChunkRefused(e, !server.connected);
    }
  };

  /** Set when a command's answer timed out: see the failure path. */
  let answerTimedOut = false;

  /** Set once VERIFY is about to be written: from there the update can no
   * longer be cancelled, and is not ABORTed on failure. */
  let verifySent = false;

  /** One full pass at a given chunk size. Throws {@link ChunkRefused} when the
   * very first data write fails, so the caller can retry smaller. */
  const pass = async (chunkSize: number, canRetry: boolean): Promise<number> => {
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
      if (offset === 0 && canRetry) {
        await firstWrite(chunk);
      } else {
        const at = offset;
        try {
          await awaitWrite(
            write(data!, chunk),
            responseTimeoutMs,
            () =>
              new If820OtaError(
                `Bluetooth module did not accept the firmware write at offset ${at} (timed out)`,
                { transient: true },
              ),
            true,
          );
        } catch (e) {
          throw wrapGattError(e, `Writing firmware at offset ${at}`);
        }
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

    /* VERIFY is the commit: the module switches images once it passes. A
     * cancel that landed during the last chunk (onProgress included) must
     * stop it here. */
    throwIfAborted(signal);
    onStatus('Verifying the firmware on the Bluetooth module…');
    /* VERIFY is the commit. A cancel is honoured up to the moment it is
     * written (send checks first); from then on the module may already be
     * switching images, which an ABORT cannot undo, so the write and its
     * answer run to completion or to their timeouts, never to a cancel. */
    throwIfAborted(signal);
    await send(
      IF820_OTA_COMMAND.VERIFY,
      crc,
      `VERIFY (crc32 0x${crc.toString(16).padStart(8, '0')})`,
      false,
    );
    await expectOk('VERIFY', verifyTimeoutMs, false);
    return crc;
  };

  try {
    onStatus('Opening the Bluetooth module update service…');
    {
      /* Discovery and the subscription, bounded and cancellable; a discovery
       * given up on is invalidated by its generation, so it can never commit
       * its handles late (see open). */
      const generation = ++reopenGeneration;
      const opening = open(generation);
      try {
        await settleWithin(opening, responseTimeoutMs, signal, () => {
          return new If820OtaError('Opening the update service timed out', { transient: true });
        });
      } catch (e) {
        reopenGeneration++;
        /* Still discovering or subscribing on the link: the device stays
         * leased until it settles, as for a reconnect attempt. */
        onAbandoned(opening);
        throw e;
      }
    }

    let step = 0;
    let crc: number;
    for (;;) {
      const chunkSize = ladder[step];
      const canRetry = step < ladder.length - 1;
      try {
        crc = await pass(chunkSize, canRetry);
        break;
      } catch (e) {
        if (!(e instanceof ChunkRefused)) throw e;
        const next = ladder[step + 1];
        log(
          `first ${chunkSize}-byte data write ${e.stalled ? 'went unanswered' : 'was refused'}` +
            ` (${String(e.inner)}); retrying at ${next}`,
        );
        opts.onRetry?.({ fromChunkSize: chunkSize, toChunkSize: next, reconnecting: e.stalled });
        if (e.stalled) {
          onStatus('The link stalled on large writes; reconnecting to continue with smaller ones…');
          await reopen();
        } else {
          await abortQuietly();
        }
        step++;
      }
    }

    onStatus('Bluetooth module firmware accepted; the module is restarting.');
    return {
      bytes: bytes.length,
      crc32: crc,
      chunkSize: ladder[step],
      serviceUuid,
      durationMs: Date.now() - started,
    };
  } catch (e) {
    /* A command whose answer timed out may still be answered late, and on a
     * link left up that answer would reach whatever update runs next on it.
     * So a timed-out answer leaves the link dropped (after the best-effort
     * ABORT), and nothing from this update can be read as the next one's. */
    const dropStaleLink = (): void => {
      if (!answerTimedOut || !server.connected) return;
      log('a command answer timed out; dropping the link so no late answer reaches a later update');
      try {
        server.disconnect?.();
      } catch {
        /* already going */
      }
    };
    if (verifySent) {
      dropStaleLink();
      /* An ABORT cannot undo a VERIFY the module accepted, so none is sent,
       * and the failure says the new image may be running anyway. */
      if (e instanceof If820OtaError && e.status === null) {
        throw new If820OtaError(
          `${e.message}. The module may already have accepted the new firmware: ` +
            'reconnect and read its version.',
          { transient: e.transient },
        );
      }
      throw e;
    }
    if (server.connected) await abortQuietly();
    dropStaleLink();
    throw e;
  } finally {
    /* A reconnect still in flight resumes nothing once the update has ended. */
    reopenGeneration++;
    control?.removeEventListener('characteristicvaluechanged', onValue);
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

// ── Which sensors may be updated ──

/**
 * The first Shimmer3R LogAndStream release the module update is offered on:
 * v1.01.022. It is the first to recover by itself once the module restarts on
 * its new image (it reboots the MCU, which re-reads the module version), and
 * the first to repair the SPP MTU an update leaves broken on v1.4.18.x, which
 * otherwise runs the classic link at a fraction of its speed. Older firmware
 * keeps reporting the old module version until it is power-cycled.
 */
export const IF820_OTA_MIN_SENSOR_FIRMWARE = Object.freeze({ major: 1, minor: 1, internal: 22 });

/** Hardware version of a Shimmer3R, as GET_DEVICE_VERSION reports it. */
const HW_ID_SHIMMER_3R = 10;
/** Firmware identifier of LogAndStream, as GET_FW_VERSION reports it. */
const FW_ID_LOGANDSTREAM = 3;

/** What {@link if820OtaSensorSupport} needs to know about the sensor. */
export interface If820OtaSensorIdentity {
  /** GET_DEVICE_VERSION's hardware version (10 = Shimmer3R). */
  hardwareVersion: number | null | undefined;
  /** GET_FW_VERSION's firmware identifier (3 = LogAndStream). */
  firmwareId: number | null | undefined;
  major: number | null | undefined;
  minor: number | null | undefined;
  /** The third field, e.g. 22 in v1.01.022. */
  internal: number | null | undefined;
}

export type If820OtaSensorSupport =
  | { supported: true }
  | {
      supported: false;
      reason: 'unknown' | 'not-shimmer3r' | 'not-logandstream' | 'firmware-too-old';
      /** One sentence a host can show as it is. */
      message: string;
    };

/**
 * Whether this sensor may have its Bluetooth module updated: a Shimmer3R
 * running LogAndStream {@link IF820_OTA_MIN_SENSOR_FIRMWARE} or later. A
 * sensor whose versions were not read is not supported - a host must never
 * offer the update to a sensor it cannot identify.
 */
export function if820OtaSensorSupport(
  sensor: If820OtaSensorIdentity | null | undefined,
): If820OtaSensorSupport {
  const min = IF820_OTA_MIN_SENSOR_FIRMWARE;
  const minText = `LogAndStream v${min.major}.${String(min.minor).padStart(2, '0')}.${String(min.internal).padStart(3, '0')}`;
  if (
    !sensor ||
    sensor.hardwareVersion == null ||
    sensor.firmwareId == null ||
    sensor.major == null ||
    sensor.minor == null ||
    sensor.internal == null
  ) {
    return {
      supported: false,
      reason: 'unknown',
      message: "The sensor's hardware and firmware versions could not be read.",
    };
  }
  if (sensor.hardwareVersion !== HW_ID_SHIMMER_3R) {
    return {
      supported: false,
      reason: 'not-shimmer3r',
      message: 'The Bluetooth module update is for Shimmer3R sensors only.',
    };
  }
  if (sensor.firmwareId !== FW_ID_LOGANDSTREAM) {
    return {
      supported: false,
      reason: 'not-logandstream',
      message: `The Bluetooth module update needs ${minText} or later on the sensor.`,
    };
  }
  const have = [sensor.major, sensor.minor, sensor.internal];
  const need = [min.major, min.minor, min.internal];
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) {
      if (have[i] > need[i]) break;
      return {
        supported: false,
        reason: 'firmware-too-old',
        message: `The Bluetooth module update needs ${minText} or later on the sensor.`,
      };
    }
  }
  return { supported: true };
}
