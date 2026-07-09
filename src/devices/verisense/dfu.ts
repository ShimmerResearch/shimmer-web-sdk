/**
 * Verisense Nordic Secure-DFU flow helpers (DEV-845).
 *
 * The byte transport is Nordic's `web-bluetooth-dfu` library (`SecureDfu` +
 * `SecureDfuPackage`, vendored by consuming apps); this module owns everything
 * learned about running that library reliably against Verisense sensors over
 * desktop Chrome/Edge Web Bluetooth:
 *
 * - classification of transient BLE-stack errors vs DFU protocol errors
 * - a fix for the library's swallowed-rejection hang in `sendOperation`
 * - bounded + retried `setDfuMode` (with a full GATT reset between attempts)
 * - the two-phase combined-package update (SoftDevice/bootloader then
 *   application), including resume of an interrupted combined update
 * - the bootloader device-picker filter and packet-pacing defaults
 *
 * The library objects are injected (structurally typed), so this module has no
 * build-time dependency on the vendored scripts. All user-visible progress is
 * reported through an `onStatus` callback; no DOM access happens here.
 */

/**
 * Transient connection/BLE-stack errors worth retrying. "unknown reason"
 * (NotSupportedError) is Chrome-on-Windows' generic wrapper for any GATT
 * operation the OS stack fails without an ATT error code (DEV-845) —
 * typically a startNotifications/write right after a (re)connect, or a
 * link being torn down mid-encryption. Recoverable on retry; DFU protocol
 * errors (wrong image, version too low, ...) never match.
 */
export const VERISENSE_DFU_TRANSIENT_ERROR_REGEX =
  /unreachable|networkerror|gatt server|disconnected|no longer in range|connection|unknown reason|notsupportederror/i;

/** Total attempts (first try + retries) for the DFU connection-retry helpers. */
export const VERISENSE_DFU_CONNECT_ATTEMPTS = 3;

/** Delay between DFU connection retries, letting the device finish rebooting. */
export const VERISENSE_DFU_RETRY_DELAY_MS = 2000;

/** Time allowed for the base image's post-install reboot back into the bootloader. */
export const VERISENSE_DFU_REBOOT_DELAY_MS = 3000;

/** Bound on `setDfuMode` (connect + notifications + one write): the happy path
 * completes in seconds, so a hit means a genuine stall — including the vendored
 * library's swallowed-rejection case that {@link patchSecureDfuSendOperation}
 * and {@link promiseWithTimeout} exist to catch. */
export const VERISENSE_DFU_SET_MODE_TIMEOUT_MS = 30000;

/**
 * Per-packet pacing for the firmware transfer, in ms. The packet
 * characteristic is written without response; over Web Bluetooth, Chrome
 * drops packets if it outruns the device, so at 0 ms the first pass can fail
 * object CRC validation and the library silently retries the WHOLE transfer
 * at ~10 ms (the pass that succeeds). Pacing at 10 ms makes the first pass
 * succeed outright. Pass 0 ("fast") for full speed on a known-clean link.
 * (nRF Connect sidesteps this via a wired connectivity dongle rather than
 * the OS BLE stack.)
 */
export const VERISENSE_DFU_RELIABLE_PACKET_DELAY_MS = 10;
export const VERISENSE_DFU_FAST_PACKET_DELAY_MS = 0;

/**
 * The Verisense bootloader advertises as "Verisense-BL..."; app-mode sensors
 * ("Verisense-..." without the -BL) are deliberately excluded from DFU device
 * pickers to keep them unambiguous. The DFU service UUID is not advertised in
 * app mode, so it cannot be used to widen the filter; it still needs to be
 * granted via `optionalServices` for the GATT connection.
 */
export const VERISENSE_DFU_BOOTLOADER_NAME_PREFIX = 'Verisense-BL';

/**
 * The library's routine object-retransmission notices (e.g. "object failed to
 * validate"). Over Web Bluetooth, firmware packets are written without
 * response and Chrome can drop one if it outruns the device; that makes a
 * 4 KB object's CRC mismatch, so the library transparently re-creates and
 * re-sends that object. The transfer still completes correctly (every object
 * is CRC-checked before Execute, and the bootloader CRC/signature-checks the
 * whole image), so these are non-issues that only alarm users. Real failures
 * still surface via the promise rejection paths.
 */
export const VERISENSE_DFU_ROUTINE_LOG_REGEX = /validat|crc|mismatch|retr|re-?send|re-?creat/i;

/** True for library log messages that are routine retransmission noise and
 * should not be surfaced to end users (see {@link VERISENSE_DFU_ROUTINE_LOG_REGEX}). */
export function isRoutineVerisenseDfuLogMessage(message: string): boolean {
  return VERISENSE_DFU_ROUTINE_LOG_REGEX.test(String(message ?? ''));
}

/** "attempt N of M" wording for retry status lines. The retry helpers count
 * attempts DOWN (remaining, including the one that just failed), so the
 * attempt about to start is total - remaining + 2. */
export function verisenseDfuAttemptLabel(
  attemptsRemaining: number,
  totalAttempts = VERISENSE_DFU_CONNECT_ATTEMPTS,
): string {
  return `attempt ${totalAttempts - attemptsRemaining + 2} of ${totalAttempts}`;
}

/** A firmware image entry from a Nordic DFU package (`SecureDfuPackage`). */
export interface VerisenseDfuImage {
  type?: string;
  initFile?: string;
  imageFile?: string;
  initData: ArrayBuffer;
  imageData: ArrayBuffer;
}

/** Structural view of Nordic's `SecureDfuPackage` (base = SoftDevice /
 * bootloader / both; app = application image). */
export interface VerisenseDfuPackage {
  getBaseImage(): Promise<VerisenseDfuImage | null | undefined>;
  getAppImage(): Promise<VerisenseDfuImage | null | undefined>;
}

/** Structural view of the `SecureDfu` instance methods this module drives. */
export interface SecureDfuLike {
  /** Resolves with the device when it is already in bootloader mode, or
   * null/undefined after the buttonless reboot command has been sent. */
  setDfuMode(device: BluetoothDevice): Promise<BluetoothDevice | null | undefined>;
  update(device: BluetoothDevice, init: ArrayBuffer, image: ArrayBuffer): Promise<unknown>;
}

interface SecureDfuSendOperationInternals {
  notifyFns: Record<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  >;
  log(message: unknown): void;
  delayPromise(ms: number): Promise<unknown>;
}

type SecureDfuSendOperation = (
  this: SecureDfuSendOperationInternals,
  characteristic: { writeValue(value: BufferSource): Promise<unknown> },
  operation: ArrayLike<number>,
  buffer?: ArrayBuffer,
) => Promise<unknown>;

/**
 * Fix the swallowed-rejection hang in `web-bluetooth-dfu` v1.2.1 (DEV-845):
 * upstream `SecureDfu.sendOperation` retries a failed control-point write once
 * after 500 ms, but if the retry ALSO fails the rejection is dropped and the
 * returned promise never settles — the transfer hangs forever. This replaces
 * the method with the same logic as upstream, plus: a second write failure
 * rejects the pending operation.
 *
 * Call once per page load with the vendored `SecureDfu` constructor before
 * creating instances. Safe to call repeatedly (idempotent).
 */
export function patchSecureDfuSendOperation(SecureDfuCtor: {
  prototype: SecureDfuSendOperationInternals & { sendOperation: SecureDfuSendOperation };
}): void {
  const patched: SecureDfuSendOperation = function (characteristic, operation, buffer) {
    return new Promise((resolve, reject) => {
      let size = operation.length;
      if (buffer) size += buffer.byteLength;
      const value = new Uint8Array(size);
      value.set(operation);
      if (buffer) value.set(new Uint8Array(buffer), operation.length);
      this.notifyFns[operation[0]] = { resolve, reject };
      characteristic
        .writeValue(value)
        .catch((error: unknown) => {
          this.log(error);
          return this.delayPromise(500).then(() => characteristic.writeValue(value));
        })
        .catch((error: unknown) => {
          delete this.notifyFns[operation[0]];
          reject(error);
        });
    });
  };
  SecureDfuCtor.prototype.sendOperation = patched;
}

/** How a DFU-flow error should be presented / handled. */
export type VerisenseDfuErrorCategory = 'device-disconnected' | 'stack-operation-failed';

export interface VerisenseDfuErrorInfo {
  /** Known Bluetooth-stack failure signature, or null for anything else
   * (including genuine DFU protocol errors, which pass through untouched). */
  category: VerisenseDfuErrorCategory | null;
  /** Plain-language, platform-neutral description for the category, or null.
   * Apps typically append their own platform-specific remediation hint (e.g.
   * "remove the sensor in Windows Bluetooth settings, then retry"). */
  friendlyMessage: string | null;
  /** True when the error matches {@link VERISENSE_DFU_TRANSIENT_ERROR_REGEX}
   * and is worth retrying. */
  transient: boolean;
  /** DOMException/Error name when available, else "GATT error". */
  name: string;
  rawMessage: string;
}

/**
 * Classify known Bluetooth-stack failures seen during Verisense DFU (DEV-845).
 * Two signatures of the same Windows pairing/GATT-cache failure loop:
 * "unknown reason" (NotSupportedError) is the stack failing an operation on a
 * live link, and "GATT Server is disconnected" (NetworkError) is the sensor
 * tearing the link down mid-operation — on units without the firmware fix,
 * typically its ~400 ms security request colliding with a stale pairing key.
 * Unrecognised errors return `category: null` so their raw text passes
 * through unchanged.
 */
export function classifyVerisenseDfuError(error: unknown): VerisenseDfuErrorInfo {
  const rawMessage = String(error);
  const name =
    error && typeof error === 'object' && 'name' in error && typeof error.name === 'string'
      ? error.name
      : 'GATT error';
  let category: VerisenseDfuErrorCategory | null = null;
  let friendlyMessage: string | null = null;
  if (/gatt server is disconnected/i.test(rawMessage)) {
    category = 'device-disconnected';
    friendlyMessage = 'The sensor disconnected before the operation could complete';
  } else if (/unknown reason|notsupportederror/i.test(rawMessage)) {
    category = 'stack-operation-failed';
    friendlyMessage = 'The Bluetooth stack failed the operation unexpectedly';
  }
  return {
    category,
    friendlyMessage,
    transient: VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(rawMessage),
    name,
    rawMessage,
  };
}

/**
 * Reject a promise that hasn't settled within `ms`. Used to guard
 * `SecureDfu.setDfuMode()`: the library builds its buttonless branch as
 * `new Promise((resolve, reject) => { startNotifications().then(
 * ...sendOperation...).then(resolve) })` with NO `.catch(reject)`, so if
 * startNotifications() or the button-command write fails the promise never
 * settles. (The {@link patchSecureDfuSendOperation} override makes that write
 * reject rather than hang, which this same missing catch would swallow.)
 * The timeout message deliberately includes "connection" so it matches
 * {@link VERISENSE_DFU_TRANSIENT_ERROR_REGEX} and drives the retry helpers.
 * Kept as a timeout rather than re-implementing setDfuMode so the buttonless
 * reboot logic isn't duplicated, and so it defends against any stall cause.
 */
export function promiseWithTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms (connection may have stalled)`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A bundled firmware name must be a plain `.zip` filename — no path
 * separators or traversal — so a malformed/hostile manifest can't make an app
 * fetch outside its firmware folder. */
export function isSafeFirmwareArchiveName(name: unknown): name is string {
  return typeof name === 'string' && /^[^/\\]+\.zip$/i.test(name) && !name.includes('..');
}

/**
 * `navigator.bluetooth.requestDevice()` options for picking a Verisense
 * bootloader (replaces the DFU library's `acceptAllDevices`; see
 * {@link VERISENSE_DFU_BOOTLOADER_NAME_PREFIX} for why name-prefix only).
 * Pass the vendored library's `SecureDfu.SERVICE_UUID`.
 */
export function buildVerisenseDfuRequestDeviceOptions(dfuServiceUuid: string | number): {
  filters: { namePrefix: string }[];
  optionalServices: (string | number)[];
} {
  return {
    filters: [{ namePrefix: VERISENSE_DFU_BOOTLOADER_NAME_PREFIX }],
    optionalServices: [dfuServiceUuid],
  };
}

export interface VerisenseDfuRetryInfo {
  stage: 'set-dfu-mode' | 'update';
  /** Attempts left including the retry about to run. */
  attemptsRemaining: number;
  /** Ready-made "attempt N of M" wording for status lines. */
  attemptLabel: string;
  error: unknown;
}

export interface VerisenseDfuFlowOptions {
  /** Total attempts for connection-level retries (default
   * {@link VERISENSE_DFU_CONNECT_ATTEMPTS}). */
  attempts?: number;
  /** Delay between retries (default {@link VERISENSE_DFU_RETRY_DELAY_MS}). */
  retryDelayMs?: number;
  /** Bound on setDfuMode (default {@link VERISENSE_DFU_SET_MODE_TIMEOUT_MS}). */
  setDfuModeTimeoutMs?: number;
  /** Wait after the base image installs, for the reboot back into the
   * bootloader (default {@link VERISENSE_DFU_REBOOT_DELAY_MS}). */
  rebootDelayMs?: number;
  /** User-facing progress text (the same strings the Verisense console shows). */
  onStatus?: (message: string) => void;
  /** Called before each connection-level retry; protocol errors never retry. */
  onRetry?: (info: VerisenseDfuRetryInfo) => void;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Normalize an `attempts` option to a finite integer >= 1 so the retry
 * loops keep their documented "total attempts" semantics for 0/negative/NaN
 * inputs. */
function normalizeAttempts(attempts: number | undefined): number {
  const v = Number(attempts ?? VERISENSE_DFU_CONNECT_ATTEMPTS);
  return Number.isFinite(v) ? Math.max(1, Math.trunc(v)) : VERISENSE_DFU_CONNECT_ATTEMPTS;
}

/**
 * `SecureDfu.update()` with retries on connection-level errors. Combined
 * (SoftDevice+bootloader+application) packages transfer in two parts with a
 * device reset in between; the reconnect for part 2 can fail while the device
 * is still rebooting, so transient errors retry after a settle delay. DFU
 * protocol errors are not retried.
 */
export async function updateVerisenseDfuImageWithRetry(
  dfu: SecureDfuLike,
  device: BluetoothDevice,
  image: VerisenseDfuImage,
  options: VerisenseDfuFlowOptions = {},
): Promise<void> {
  const totalAttempts = normalizeAttempts(options.attempts);
  const retryDelayMs = options.retryDelayMs ?? VERISENSE_DFU_RETRY_DELAY_MS;
  for (let attemptsRemaining = totalAttempts; ; attemptsRemaining--) {
    try {
      await dfu.update(device, image.initData, image.imageData);
      return;
    } catch (error) {
      const transient = VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(String(error));
      if (attemptsRemaining <= 1 || !transient) throw error;
      const attemptLabel = verisenseDfuAttemptLabel(attemptsRemaining, totalAttempts);
      options.onRetry?.({ stage: 'update', attemptsRemaining, attemptLabel, error });
      options.onStatus?.(`Reconnecting to bootloader (${attemptLabel})...`);
      await delay(retryDelayMs);
    }
  }
}

/**
 * `SecureDfu.setDfuMode()` bounded by a timeout and retried on transient
 * errors (DEV-845). setDfuMode (connect + find the buttonless characteristic
 * + startNotifications + write) is where Windows' BLE stack intermittently
 * fails with "GATT operation failed for unknown reason", typically on the
 * first GATT operation after a connect that follows a disconnect. Before each
 * retry the GATT connection is fully torn down so the next attempt starts
 * from a clean link. Protocol errors (e.g. "Unsupported device") are not
 * retried. Resolves like setDfuMode: the device when it is already in
 * bootloader mode, or null after the buttonless reboot command has been sent.
 */
export async function setVerisenseDfuModeWithRetry(
  dfu: SecureDfuLike,
  device: BluetoothDevice,
  options: VerisenseDfuFlowOptions = {},
): Promise<BluetoothDevice | null> {
  const totalAttempts = normalizeAttempts(options.attempts);
  const retryDelayMs = options.retryDelayMs ?? VERISENSE_DFU_RETRY_DELAY_MS;
  const timeoutMs = options.setDfuModeTimeoutMs ?? VERISENSE_DFU_SET_MODE_TIMEOUT_MS;
  for (let attemptsRemaining = totalAttempts; ; attemptsRemaining--) {
    try {
      const result = await promiseWithTimeout(dfu.setDfuMode(device), timeoutMs, 'Enter DFU mode');
      return result ?? null;
    } catch (error) {
      const transient = VERISENSE_DFU_TRANSIENT_ERROR_REGEX.test(String(error));
      if (attemptsRemaining <= 1 || !transient) throw error;
      const attemptLabel = verisenseDfuAttemptLabel(attemptsRemaining, totalAttempts);
      options.onRetry?.({ stage: 'set-dfu-mode', attemptsRemaining, attemptLabel, error });
      options.onStatus?.(`Connection hiccup - retrying (${attemptLabel})...`);
      // Full connection-state reset so the retry starts from a clean link.
      if (device.gatt?.connected) {
        device.gatt.disconnect();
      }
      await delay(retryDelayMs);
    }
  }
}

/**
 * Run a full Verisense DFU transfer from a loaded Nordic DFU package: base
 * image (SoftDevice/bootloader) first when present, then the application
 * image. Resumes interrupted combined updates: a bootloader only installs
 * once per version number, so if a previous (interrupted) attempt already
 * installed this base image the target rejects it with a firmware-version
 * error — that is swallowed and the flow continues to the application image.
 *
 * Progress text is reported via `options.onStatus`; transfer byte progress
 * comes from the `SecureDfu` instance's own "progress" events, which the app
 * subscribes to directly. Rejects with the raw library error on failure (run
 * it through {@link classifyVerisenseDfuError} for display).
 */
export async function runVerisenseDfuUpdate(
  dfu: SecureDfuLike,
  device: BluetoothDevice,
  dfuPackage: VerisenseDfuPackage,
  options: VerisenseDfuFlowOptions = {},
): Promise<void> {
  const rebootDelayMs = options.rebootDelayMs ?? VERISENSE_DFU_REBOOT_DELAY_MS;
  const baseImage = await dfuPackage.getBaseImage();
  if (baseImage) {
    options.onStatus?.(`Updating ${baseImage.type}: ${baseImage.imageFile}...`);
    try {
      await dfu.update(device, baseImage.initData, baseImage.imageData);
      // The base image resets the target on completion; give it time to
      // reboot back into the bootloader before part 2.
      options.onStatus?.('SoftDevice/bootloader installed - device rebooting...');
      await delay(rebootDelayMs);
    } catch (error) {
      if (!/firmware version is too low/i.test(String(error))) throw error;
      options.onStatus?.(
        'SoftDevice/bootloader already up to date - continuing with application...',
      );
    }
  }
  const appImage = await dfuPackage.getAppImage();
  if (appImage) {
    options.onStatus?.(`Updating ${appImage.type}: ${appImage.imageFile}...`);
    await updateVerisenseDfuImageWithRetry(dfu, device, appImage, options);
  }
}
