/**
 * Reconnecting to a sensor whose link dropped, without asking the user to pick
 * it again (DEV-1483).
 *
 * The browser's pickers appear only when a page asks for a NEW device:
 * `navigator.bluetooth.requestDevice()` and `navigator.serial.requestPort()`.
 * A page that kept what it was given can reconnect with neither:
 *
 * - **BLE:** a transport built with the same `BluetoothDevice`
 *   (`WebBluetoothTransportOptions.device`) reconnects through
 *   `device.gatt.connect()`.
 * - **Classic Bluetooth:** a transport built with the same `SerialPort`
 *   (`WebSerialTransportOptions.port`) reopens it, which brings the
 *   RFCOMM link up again.
 *
 * Neither needs a user gesture, so a timer can drive them.
 *
 * This module is the policy around those calls:
 * - when to try, and how long to wait between tries ({@link reconnectDelayMs},
 *   {@link nextReconnectDelayMs});
 * - the loop that runs the tries ({@link startAutoReconnect});
 * - what to send once the link is back ({@link planStreamResume}).
 *
 * What a try IS belongs to the caller: build a fresh client on a fresh
 * transport around the device or port it kept, connect, and run whatever its
 * own connect sequence is.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/** When to try reconnecting, and when to stop. All times in milliseconds. */
export interface ReconnectPolicy {
  /**
   * Wait before the first try. A sensor that has just dropped the link takes a
   * moment to start advertising again (BLE) or to accept a new RFCOMM link.
   */
  initialDelayMs: number;
  /** Wait before the second try. Each later wait is this times {@link backoffFactor}. */
  retryDelayMs: number;
  /** How much longer each wait is than the one before. 1 keeps them all equal. */
  backoffFactor: number;
  /** The longest wait between tries. */
  maxDelayMs: number;
  /**
   * How long one try may take before it is abandoned. Required, not a nicety:
   * on Windows, `gatt.connect()` to a sensor out of range, or one whose bond
   * the PC holds stale, can stay pending forever (DEV-845).
   */
  attemptTimeoutMs: number;
  /**
   * After abandoning a try, how long to wait for it to finish unwinding before
   * the next one starts. A try that still holds the link would make the next
   * one fail with "already open".
   */
  settleMs: number;
  /** Stop after this many tries. `Infinity`: keep trying until cancelled. */
  maxAttempts: number;
  /**
   * Stop once this long has passed since the link dropped (the next try would
   * start later than this). `Infinity`: no limit.
   */
  maxDurationMs: number;
}

/**
 * The policy {@link startAutoReconnect} uses for anything not given.
 *
 * Tries at 1 s, then 2, 4, 8 and every 15 s after that, each allowed 30 s,
 * until cancelled. 30 s covers a Shimmer3R connect sequence over BLE, which
 * reads its configuration and calibration (a few seconds), and a Classic
 * Bluetooth port's own open timeout (15 s, `WebSerialTransportOptions.openTimeoutMs`).
 */
export const DEFAULT_RECONNECT_POLICY: Readonly<ReconnectPolicy> = Object.freeze({
  initialDelayMs: 1000,
  retryDelayMs: 2000,
  backoffFactor: 2,
  maxDelayMs: 15000,
  attemptTimeoutMs: 30000,
  settleMs: 5000,
  maxAttempts: Infinity,
  maxDurationMs: Infinity,
});

/** A non-negative finite number, else the default. */
function nonNegative(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** A positive limit, `Infinity` included; anything else means no limit. */
function limit(value: unknown): number {
  return typeof value === 'number' && value > 0 ? value : Infinity;
}

/**
 * A complete policy from a partial one.
 *
 * Each field not given, or given as something it cannot be, takes its value
 * from {@link DEFAULT_RECONNECT_POLICY}:
 * - the waits must be finite and not negative;
 * - `attemptTimeoutMs` must be finite and above 0;
 * - `backoffFactor` must be finite and at least 1, so waits never shrink;
 * - `maxAttempts` is rounded down, and must be at least 1;
 * - `maxAttempts` and `maxDurationMs` that are 0, negative or not numbers mean
 *   no limit.
 */
export function resolveReconnectPolicy(partial: Partial<ReconnectPolicy> = {}): ReconnectPolicy {
  const d = DEFAULT_RECONNECT_POLICY;
  const timeout = partial.attemptTimeoutMs;
  const factor = partial.backoffFactor;
  const attempts = limit(partial.maxAttempts);
  return {
    initialDelayMs: nonNegative(partial.initialDelayMs, d.initialDelayMs),
    retryDelayMs: nonNegative(partial.retryDelayMs, d.retryDelayMs),
    backoffFactor:
      typeof factor === 'number' && Number.isFinite(factor) && factor >= 1
        ? factor
        : d.backoffFactor,
    maxDelayMs: nonNegative(partial.maxDelayMs, d.maxDelayMs),
    attemptTimeoutMs:
      typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
        ? timeout
        : d.attemptTimeoutMs,
    settleMs: nonNegative(partial.settleMs, d.settleMs),
    maxAttempts: attempts === Infinity ? Infinity : Math.max(1, Math.floor(attempts)),
    maxDurationMs: limit(partial.maxDurationMs),
  };
}

/**
 * How long to wait before try `attempt` (1 for the first).
 *
 * The first waits {@link ReconnectPolicy.initialDelayMs}. Try n (n ≥ 2) waits
 * `retryDelayMs × backoffFactor^(n−2)`, rounded to the millisecond, and never
 * more than `maxDelayMs`. With the default policy: 1000, 2000, 4000, 8000,
 * 15000, 15000, …
 */
export function reconnectDelayMs(policy: ReconnectPolicy, attempt: number): number {
  if (!(attempt > 1)) return policy.initialDelayMs;
  const grown = policy.retryDelayMs * Math.pow(policy.backoffFactor, Math.floor(attempt) - 2);
  return Math.round(Math.min(policy.maxDelayMs, grown));
}

/**
 * After a try fails, how long to wait before the next, or `null` to give up.
 *
 * Gives up once `failedAttempts` reaches {@link ReconnectPolicy.maxAttempts},
 * or when the next try would start after {@link ReconnectPolicy.maxDurationMs}
 * (counted, like `elapsedMs`, from the drop).
 *
 * @param failedAttempts tries made so far, all of which failed
 * @param elapsedMs time since the link dropped
 */
export function nextReconnectDelayMs(
  policy: ReconnectPolicy,
  failedAttempts: number,
  elapsedMs: number,
): number | null {
  if (failedAttempts >= policy.maxAttempts) return null;
  const delay = reconnectDelayMs(policy, failedAttempts + 1);
  if (elapsedMs + delay > policy.maxDurationMs) return null;
  return delay;
}

// ---------------------------------------------------------------------------
// Resuming what was running
// ---------------------------------------------------------------------------

/** What the sensor was doing for the host when the link dropped. */
export interface ActivityAtDrop {
  /** Streaming to this host. */
  streaming: boolean;
  /** Logging to its SD card. */
  sdLogging: boolean;
}

/** What to send once the link is back. */
export type StreamResumeAction = 'none' | 'start-streaming' | 'start-streaming-and-logging';

/**
 * What to send to a Shimmer3 or Shimmer3R, once reconnected, to put back what
 * was running when the link dropped.
 *
 * The firmware's rule on a lost link (log-and-stream-common
 * `Comms/shimmer_bt_uart.c`, the "BT is disconnected" branch): it stops the
 * stream (`ShimTask_setStopStreaming`) and leaves an SD log running, because
 * `ShimSens_stopSensing` closes the log only when the log itself was told to
 * stop (`Sensing/shimmer_sensing.c`). So:
 *
 * | Before the drop | Status read after | Send |
 * |---|---|---|
 * | not streaming | anything | nothing |
 * | streaming | streaming | nothing: it never stopped |
 * | streaming, no log | not streaming | start streaming |
 * | streaming and logging | logging | start streaming: the log went on |
 * | streaming and logging | not logging | start streaming and logging: the log ended too, so the sensor restarted |
 * | streaming and logging | no status | start streaming |
 *
 * Only a stream is put back. A log that was running on its own goes on without
 * the link, and one that ended is not restarted: the sensor ended it for a
 * reason a host cannot see. Without a status, a second log is never started on
 * a guess; the host should say the log's state is unknown.
 *
 * Fields of `statusAfter` that are `null` or missing count as unknown. A
 * Verisense has no SD log in this sense: pass `sdLogging: false`.
 */
export function planStreamResume(
  before: ActivityAtDrop,
  statusAfter: { streaming?: boolean | null; sdLogging?: boolean | null } | null | undefined,
): StreamResumeAction {
  if (!before.streaming) return 'none';
  if (statusAfter?.streaming === true) return 'none';
  if (before.sdLogging && statusAfter?.sdLogging === false) return 'start-streaming-and-logging';
  return 'start-streaming';
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

/** What each try is given. */
export interface AutoReconnectAttempt {
  /** 1 for the first try. */
  attempt: number;
  /**
   * Aborted when the try is abandoned: it overran
   * {@link ReconnectPolicy.attemptTimeoutMs}, or the loop was cancelled.
   */
  signal: AbortSignal;
}

/** Why a try was abandoned. */
export type AutoReconnectAbandonReason = 'timeout' | 'cancelled';

/** Passed to {@link AutoReconnectOptions.abandon}. */
export interface AutoReconnectAbandoned {
  attempt: number;
  reason: AutoReconnectAbandonReason;
  /**
   * True when the abandoned try went on to succeed anyway: the link it opened
   * is one nobody is waiting for, so close it.
   */
  late: boolean;
}

/** Passed to {@link AutoReconnectOptions.onAttemptFailed}. */
export interface AutoReconnectFailure {
  attempt: number;
  error: unknown;
  /** The try overran its time and was abandoned. */
  timedOut: boolean;
  /** How long until the next try, or `null` when the loop is giving up. */
  nextDelayMs: number | null;
}

/** How a reconnect loop ended. */
export type AutoReconnectOutcome = 'connected' | 'cancelled' | 'gave-up';

/** What {@link AutoReconnectHandle.done} resolves to. */
export interface AutoReconnectResult {
  outcome: AutoReconnectOutcome;
  /** Tries started. */
  attempts: number;
  /** The last failed try's error, if any try failed. */
  lastError?: unknown;
  /** From the start of the loop to its end. */
  elapsedMs: number;
}

/** The clock the loop runs on. Tests pass their own. */
export interface AutoReconnectTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Milliseconds, monotonic. */
  now(): number;
}

/** Options for {@link startAutoReconnect}. */
export interface AutoReconnectOptions extends Partial<ReconnectPolicy> {
  /**
   * One try: connect, and resolve once the link is usable; reject, saying why,
   * if it is not. Should give up when `signal` aborts.
   */
  attempt(ctx: AutoReconnectAttempt): Promise<unknown>;
  /**
   * Release what an abandoned try holds: for BLE, `device.gatt.disconnect()`,
   * which makes a pending `gatt.connect()` reject; for a client, its
   * `disconnect()`. Called once when the try is abandoned, and again with
   * `late: true` if the try then succeeds anyway. A throw is ignored.
   */
  abandon?(info: AutoReconnectAbandoned): unknown;
  /** A try is starting. A throw is ignored. */
  onAttempt?(info: { attempt: number }): void;
  /** A try failed, and when the next one is due. A throw is ignored. */
  onAttemptFailed?(info: AutoReconnectFailure): void;
  /** Defaults to the global timers and `performance.now()` (else `Date.now()`). */
  timers?: AutoReconnectTimers;
}

/** A running reconnect loop. */
export interface AutoReconnectHandle {
  /** Resolves once, when the loop ends. Never rejects. */
  readonly done: Promise<AutoReconnectResult>;
  /**
   * Stop now. A try in progress is abandoned (`signal` aborted, `abandon`
   * called) without waiting for it, and `done` resolves `'cancelled'`. Does
   * nothing once the loop has ended.
   */
  cancel(): void;
  /** True until the loop ends. */
  readonly active: boolean;
  /** Tries started so far. */
  readonly attempts: number;
}

const defaultTimers: AutoReconnectTimers = {
  /* Looked up on every call rather than captured, so a test's fake timers,
     installed after this module loaded, are the ones used. */
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () =>
    typeof globalThis.performance?.now === 'function' ? globalThis.performance.now() : Date.now(),
};

/** An `Error` with a `name`, for the reasons a try is abandoned. */
function namedError(name: string, message: string): Error {
  const e = new Error(message);
  e.name = name;
  return e;
}

interface InFlight {
  attempt: number;
  controller: AbortController;
  promise: Promise<unknown>;
  abandoned: AutoReconnectAbandonReason | null;
  /** Ends the wait on this try at once; set while it is awaited. */
  interrupt: (() => void) | null;
}

/**
 * Start reconnecting: wait, try, wait longer, try again, until a try succeeds,
 * {@link AutoReconnectHandle.cancel} is called, or the policy runs out.
 *
 * Call it from the client's `onDisconnect`, which reports only a drop the
 * application did not ask for (see `BaseShimmerClient.onDisconnect`), so a
 * user's own Disconnect never starts it.
 *
 * Each try is abandoned if it overruns {@link ReconnectPolicy.attemptTimeoutMs}:
 * its signal aborts, {@link AutoReconnectOptions.abandon} is called, and once
 * the try has unwound (or {@link ReconnectPolicy.settleMs} has passed) the
 * loop moves on. A try that succeeds after being abandoned has opened a link
 * nobody wants, so `abandon` is called again with `late: true` to close it.
 *
 * The loop sends nothing to the sensor itself. Once `done` resolves
 * `'connected'`, put back what was running with {@link planStreamResume}.
 *
 * ```ts
 * const handle = startAutoReconnect({
 *   attempt: () => connectTo(keptDevice),   // no picker: the same BluetoothDevice
 *   abandon: () => keptDevice.gatt?.disconnect(),
 *   onAttemptFailed: ({ nextDelayMs }) => show(`retrying in ${nextDelayMs} ms`),
 * });
 * cancelButton.onclick = () => handle.cancel();
 * const { outcome } = await handle.done;
 * ```
 */
export function startAutoReconnect(options: AutoReconnectOptions): AutoReconnectHandle {
  const policy = resolveReconnectPolicy(options);
  const timers = options.timers ?? defaultTimers;
  const started = timers.now();

  let attempts = 0;
  let finished = false;
  let lastError: unknown;
  let inFlight: InFlight | null = null;
  /** Ends the current wait early; set while the loop is waiting. */
  let wake: (() => void) | null = null;

  let resolveDone!: (r: AutoReconnectResult) => void;
  const done = new Promise<AutoReconnectResult>((resolve) => {
    resolveDone = resolve;
  });

  const quietly = (fn: () => unknown): void => {
    try {
      const r = fn();
      // A handler that returns a rejected promise must not surface as an
      // unhandled rejection either.
      if (r && typeof (r as Promise<unknown>).catch === 'function') {
        (r as Promise<unknown>).catch(() => undefined);
      }
    } catch {
      /* the caller's handler; the loop goes on */
    }
  };

  function finish(outcome: AutoReconnectOutcome): void {
    if (finished) return;
    finished = true;
    wake?.();
    resolveDone({
      outcome,
      attempts,
      ...(lastError !== undefined ? { lastError } : {}),
      elapsedMs: timers.now() - started,
    });
  }

  /** Wait `ms`, or less if the loop ends meanwhile. */
  function wait(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      if (finished) {
        resolve();
        return;
      }
      const handle = timers.setTimeout(() => {
        wake = null;
        resolve();
      }, ms);
      wake = () => {
        timers.clearTimeout(handle);
        wake = null;
        resolve();
      };
    });
  }

  function abandon(entry: InFlight, reason: AutoReconnectAbandonReason): void {
    if (entry.abandoned) return;
    entry.abandoned = reason;
    try {
      entry.controller.abort(
        reason === 'timeout'
          ? namedError('TimeoutError', `reconnect attempt ${entry.attempt} timed out`)
          : namedError('AbortError', 'reconnect cancelled'),
      );
    } catch {
      /* an abort listener threw; the try is abandoned regardless */
    }
    quietly(() => options.abandon?.({ attempt: entry.attempt, reason, late: false }));
    entry.promise.then(
      () => quietly(() => options.abandon?.({ attempt: entry.attempt, reason, late: true })),
      () => undefined,
    );
  }

  type TryResult = { kind: 'ok' } | { kind: 'error'; error: unknown } | { kind: 'timeout' };

  async function runAttempt(n: number): Promise<TryResult> {
    const controller = new AbortController();
    let promise: Promise<unknown>;
    try {
      promise = Promise.resolve(options.attempt({ attempt: n, signal: controller.signal }));
    } catch (e) {
      promise = Promise.reject(e);
    }
    const entry: InFlight = { attempt: n, controller, promise, abandoned: null, interrupt: null };
    inFlight = entry;
    const result = await new Promise<TryResult | { kind: 'interrupted' }>((resolve) => {
      const timer = timers.setTimeout(() => resolve({ kind: 'timeout' }), policy.attemptTimeoutMs);
      entry.interrupt = () => {
        timers.clearTimeout(timer);
        resolve({ kind: 'interrupted' });
      };
      promise.then(
        () => {
          timers.clearTimeout(timer);
          resolve({ kind: 'ok' });
        },
        (error: unknown) => {
          timers.clearTimeout(timer);
          resolve({ kind: 'error', error });
        },
      );
    });
    entry.interrupt = null;
    inFlight = null;
    if (result.kind === 'interrupted') return { kind: 'error', error: undefined };
    if (result.kind === 'timeout') {
      abandon(entry, 'timeout');
      // Let the abandoned try unwind before the next one, or the next would
      // meet a link that is still held. Bounded: the premise is that it may
      // never settle.
      const settled = promise.then(
        () => undefined,
        () => undefined,
      );
      let settleTimer: unknown;
      await Promise.race([
        settled,
        new Promise<void>((resolve) => {
          settleTimer = timers.setTimeout(resolve, policy.settleMs);
          wake = () => {
            wake = null;
            resolve();
          };
        }),
      ]);
      timers.clearTimeout(settleTimer);
      wake = null;
    }
    return result;
  }

  void (async () => {
    await wait(reconnectDelayMs(policy, 1));
    for (;;) {
      if (finished) return;
      attempts += 1;
      const n = attempts;
      quietly(() => options.onAttempt?.({ attempt: n }));
      const result = await runAttempt(n);
      if (finished) return;
      if (result.kind === 'ok') {
        finish('connected');
        return;
      }
      const timedOut = result.kind === 'timeout';
      lastError = timedOut
        ? namedError(
            'TimeoutError',
            `reconnect attempt ${n} did not finish within ${policy.attemptTimeoutMs} ms`,
          )
        : result.error;
      const next = nextReconnectDelayMs(policy, n, timers.now() - started);
      quietly(() =>
        options.onAttemptFailed?.({ attempt: n, error: lastError, timedOut, nextDelayMs: next }),
      );
      if (next === null) {
        finish('gave-up');
        return;
      }
      await wait(next);
    }
  })().catch((e: unknown) => {
    lastError = e;
    finish('gave-up');
  });

  return {
    done,
    cancel(): void {
      if (finished) return;
      const entry = inFlight;
      if (entry) {
        abandon(entry, 'cancelled');
        entry.interrupt?.();
      }
      finish('cancelled');
    },
    get active(): boolean {
      return !finished;
    },
    get attempts(): number {
      return attempts;
    },
  };
}
