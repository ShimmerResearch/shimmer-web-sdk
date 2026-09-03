/**
 * Transport-agnostic capture state machine for a Shimmer factory self-test.
 *
 * The firmware answers `SET_FACTORY_TEST` with a generic ACK first
 * (log-and-stream-common `Comms/shimmer_bt_uart.c:1618` — TASK_BT_RESPOND
 * outranks TASK_FACTORY_TEST) and only then runs the suite
 * (`shimmer_taskList.c:164`), printing the report as **raw ASCII on the same
 * link, with no framing and no CRC** — one write per line via
 * `ShimBt_writeToTxBufAndSend(str, len, SHIMMER_CMD)`
 * (`Test/shimmer_test.c:22-61` builds the envelope). There is no abort command:
 * once the suite starts, the firmware's main loop is blocked until it prints its
 * `TEST END` banner, so a host that gives up must keep swallowing bytes rather
 * than hand them to a framer that would resync through them one at a time.
 *
 * That is what this class is: the byte-level half of the runner, with no
 * knowledge of BLE, serial or the dock UART. A client supplies an
 * {@link AckClassifier} for its own link's ACK/NACK encoding and then simply
 * feeds it every inbound chunk; what comes back is whatever was NOT report
 * traffic, which the client routes as usual.
 *
 * Phases are `ack → text → done`:
 *  - **ack** — the classifier runs on the head of each chunk until it reaches a
 *    verdict. It runs on the head of the SAME chunk that carries text, because
 *    over BLE the ACK and the report's first bytes arrive in ONE notification.
 *  - **text** — printable bytes are kept (TAB/CR/LF and 0x20–0x7E), everything
 *    else is counted as noise and dropped. `TEST START` arms an idle timer that
 *    RESOLVES: an incomplete report is a short report, not an error. The
 *    `TEST END` line resolves synchronously and hands back the bytes after it —
 *    a deferred status push or a late ACK glued to the banner belongs to the
 *    client, not to the report.
 *  - **draining** — entered on timeout or abort, never on success. The result
 *    promise has already rejected; bytes keep being swallowed until the report
 *    ends, the link falls silent, or the hard cap expires.
 *
 * HARDWARE-VERIFY: that the ACK and the report's first bytes really do share one
 * BLE notification, and that a `[0x8A][0x71]` status push can arrive glued to
 * the `TEST END` banner, are the two shapes this class is built around; both are
 * reasoned from the firmware's single-buffer TX path and have not yet been
 * observed on a real Shimmer3/3R.
 */

/** What the capture is doing right now. */
export type FactoryTestState = 'idle' | 'running' | 'draining';

/** Why a factory-test run failed. */
export type FactoryTestFailureReason =
  /** The firmware refused the command (it is sensing, or SD sync is enabled). */
  | 'nack'
  /** Nothing at all came back within {@link FACTORY_TEST_ACK_TIMEOUT_MS}. */
  | 'no-response'
  /** No `TEST END` within the overall timeout. */
  | 'timeout'
  /** Another factory test is running, or its report is still draining. */
  | 'busy'
  /** The link dropped mid-test. */
  | 'disconnected';

/** An error raised by the factory-test runner, tagged with a machine-readable reason. */
export class FactoryTestError extends Error {
  readonly reason: FactoryTestFailureReason;

  constructor(reason: FactoryTestFailureReason, message: string) {
    super(message);
    this.name = 'FactoryTestError';
    this.reason = reason;
  }
}

/**
 * What an {@link AckClassifier} makes of the head of the buffer it was given.
 *
 * `consumed` is how many bytes the verdict accounts for; the rest of the buffer
 * is report text (after `ack`) or the caller's traffic (after `nack`).
 */
export type AckVerdict =
  /** Not enough bytes yet to tell — keep accumulating. */
  | { kind: 'need-more' }
  /** The command was accepted; the report follows. */
  | { kind: 'ack'; consumed: number; detail?: string }
  /** The command was refused. */
  | { kind: 'nack'; consumed: number; detail?: string }
  /** Link noise to step over (a CRC-failed packet, a resync byte). */
  | { kind: 'ignore'; consumed: number; detail?: string }
  /** No ACK is coming — this is already report text. */
  | { kind: 'text' };

/**
 * Decide what the head of `buf` is. Called with the accumulated, unconsumed
 * bytes; must not mutate them.
 */
export type AckClassifier = (buf: Uint8Array) => AckVerdict;

/**
 * The refusal message the runner raises when the firmware NACKs the command.
 *
 * `ShimBt_isCmdBlockedWhileSensing` (`Comms/shimmer_bt_uart.c:2985`) refuses
 * `SET_FACTORY_TEST` outright while the device is sensing — streaming, or
 * logging to the SD card from its own button — and the same NACK comes back
 * when SD sync is enabled.
 */
export const FACTORY_TEST_NACK_MESSAGE =
  'The sensor refused the factory self-test because it is sensing. ' +
  'Stop streaming or SD logging first, or disable SD sync.';

/**
 * How long the runner waits for the firmware's generic ACK — or for the first
 * report byte, since over one link those can arrive together — before deciding
 * the command never landed.
 */
export const FACTORY_TEST_ACK_TIMEOUT_MS = 2000;

/**
 * Floor for the post-`TEST START` idle timer. A slow section of the suite (the
 * LED walk-through steps every 5 s) must not look like a finished report, so a
 * caller cannot ask for a shorter completion idle than this.
 */
export const FACTORY_TEST_IDLE_FLOOR_MS = 10_000;

/** Default silence, while draining, after which the report is assumed over. */
export const FACTORY_TEST_DRAIN_IDLE_MS = 10_000;

/** Sentinels from the report envelope (`Test/shimmer_test.c:22-61`). */
const TEST_START_SENTINEL = 'TEST START';
const TEST_END_SENTINEL = 'TEST END';

/** Options shared by every client's `runFactoryTest`. */
export interface FactoryTestRunOptions {
  /**
   * Overall budget from the write to the `TEST END` line. Defaults to the
   * per-type value in `SHIMMER3_FACTORY_TEST_TYPES`. On expiry the result
   * rejects with reason `timeout` and the capture starts draining.
   */
  timeoutMs?: number;
  /**
   * Silence after `TEST START` that ends the report successfully. Floored at
   * {@link FACTORY_TEST_IDLE_FLOOR_MS}.
   */
  completionIdleMs?: number;
  /** Silence that ends the post-failure drain. Defaults to {@link FACTORY_TEST_DRAIN_IDLE_MS}. */
  drainIdleMs?: number;
  /**
   * Ask the sensor what it is doing before writing the command, so a refusal is
   * reported as "it is sensing" rather than as a bare NACK. Default `true`. A
   * status read that itself fails never aborts the run.
   */
  preflight?: boolean;
  /** Abort the wait (the sensor keeps printing — see the class docblock). */
  signal?: AbortSignal | null;
  /** Called once per fed chunk with that chunk's text and the aggregate so far. */
  onChunk?: (chunk: string, aggregate: string) => void;
  /** Called per completed line, with the trailing CR/LF stripped. */
  onLine?: (line: string) => void;
  /** Called when non-printable bytes were dropped from a chunk. */
  onNoise?: (droppedBytes: number) => void;
}

/** {@link FactoryTestCapture} construction options. */
export interface FactoryTestCaptureOptions extends FactoryTestRunOptions {
  /** Fired synchronously on every state transition. */
  onStateChange?: (state: FactoryTestState) => void;
  /** Fired synchronously when the capture reaches `idle`, before {@link FactoryTestCapture.idle} settles. */
  onIdle?: () => void;
}

/** Bytes the report grammar allows: TAB, LF, CR and printable ASCII. */
function isReportByte(b: number): boolean {
  return b === 0x09 || b === 0x0a || b === 0x0d || (b >= 0x20 && b <= 0x7e);
}

/**
 * The capture state machine. One instance per run: it resolves or rejects
 * exactly once, then reaches `idle` and is finished with.
 */
export class FactoryTestCapture {
  /** The report text. Rejects with a {@link FactoryTestError} (or an `AbortError`). */
  readonly result: Promise<string>;
  /**
   * Resolves when the link is free again — after the report ends, or after the
   * post-failure drain. NEVER rejects, so a caller can always `await` it.
   */
  readonly idle: Promise<void>;

  private readonly _classify: AckClassifier;
  private readonly _opts: FactoryTestCaptureOptions;
  private readonly _timeoutMs: number;
  private readonly _idleMs: number;
  private readonly _drainIdleMs: number;

  private _resolve!: (text: string) => void;
  private _reject!: (err: Error) => void;
  private _resolveIdle!: () => void;

  private _state: FactoryTestState = 'idle';
  private _started = false;
  private _settled = false;
  private _idleDone = false;
  private _phase: 'ack' | 'text' = 'ack';

  /** Bytes the classifier has not reached a verdict on yet. */
  private _ackBuf: Uint8Array = new Uint8Array(0);
  private _aggregate = '';
  private _line = '';
  private _sawStart = false;

  private _ackTimer: ReturnType<typeof setTimeout> | null = null;
  private _timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private _idleTimer: ReturnType<typeof setTimeout> | null = null;
  private _drainTimer: ReturnType<typeof setTimeout> | null = null;
  private _drainCapTimer: ReturnType<typeof setTimeout> | null = null;
  private _signal: AbortSignal | null = null;
  private _onAbort: (() => void) | null = null;

  constructor(classify: AckClassifier, opts: FactoryTestCaptureOptions = {}) {
    this._classify = classify;
    this._opts = opts;
    this._timeoutMs = Math.max(1000, Math.trunc(opts.timeoutMs ?? 120_000));
    this._idleMs = Math.max(FACTORY_TEST_IDLE_FLOOR_MS, Math.trunc(opts.completionIdleMs ?? 0));
    this._drainIdleMs = Math.max(1000, Math.trunc(opts.drainIdleMs ?? FACTORY_TEST_DRAIN_IDLE_MS));

    this.result = new Promise<string>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
    /* A run that fails before anyone awaits `result` — a NACK raised inside the
     * client's own `runFactoryTest`, say — would otherwise surface as an
     * unhandled rejection and, in a browser, as a console error the application
     * never asked for. The no-op marks it handled; the caller's own `await`
     * still sees the rejection. */
    void this.result.catch(() => {});
    this.idle = new Promise<void>((resolve) => {
      this._resolveIdle = resolve;
    });
  }

  /** What the capture is doing right now. */
  get state(): FactoryTestState {
    return this._state;
  }

  /** The report text captured so far. */
  get aggregate(): string {
    return this._aggregate;
  }

  /**
   * Arm the capture: start the ACK and overall timers and wire the abort signal.
   * Call this BEFORE writing the command, so an implausibly fast reply cannot
   * arrive before there is anything to receive it.
   */
  start(): void {
    if (this._started) return;
    this._started = true;
    this._setState('running');

    this._ackTimer = setTimeout(() => {
      this._failNow(
        new FactoryTestError(
          'no-response',
          `The sensor did not answer the factory-test command within ${FACTORY_TEST_ACK_TIMEOUT_MS} ms.`,
        ),
      );
    }, FACTORY_TEST_ACK_TIMEOUT_MS);

    this._timeoutTimer = setTimeout(() => {
      this._failThenDrain(
        new FactoryTestError(
          'timeout',
          `No TEST END line within ${this._timeoutMs} ms. The sensor may still be printing its report.`,
        ),
      );
    }, this._timeoutMs);

    const signal = this._opts.signal ?? null;
    if (signal) {
      if (signal.aborted) {
        this._failThenDrain(this._abortError());
        return;
      }
      this._signal = signal;
      this._onAbort = () => this._failThenDrain(this._abortError());
      try {
        signal.addEventListener('abort', this._onAbort, { once: true });
      } catch {
        this._onAbort = null;
        this._signal = null;
      }
    }
  }

  /**
   * Hand the capture one inbound chunk.
   *
   * @returns the bytes that are NOT report traffic — everything after a NACK
   *   packet, everything after the `TEST END` line, or the whole chunk once the
   *   capture is idle — or `null` when the chunk was consumed entirely. Never
   *   throws: an inbound chunk must never be able to break the client's notify
   *   handler.
   */
  feed(bytes: Uint8Array): Uint8Array | null {
    try {
      if (!bytes || bytes.length === 0) return null;
      if (this._state === 'idle') return bytes;
      if (this._state === 'draining') return this._feedDraining(bytes);
      return this._phase === 'ack' ? this._feedAck(bytes) : this._feedText(bytes);
    } catch {
      /* An internal fault must not propagate into the transport's notify
       * callback, where it would take the whole RX path down with it. */
      return null;
    }
  }

  /**
   * Abandon the capture immediately with `err`, with NO drain — for a link that
   * has gone away, where there is nothing left to swallow.
   *
   * Forces the link free even from `draining`. Draining exists only to keep a
   * still-arriving report away from the framer; on a closed transport nothing
   * more can arrive, so waiting out the drain timers would hold a caller in
   * "busy" for up to the whole timeout budget after the sensor stopped being
   * reachable — a minute or more for the LED-state suite. The result promise
   * has already rejected by then, so `err` is only used when it has not.
   */
  fail(err: Error): void {
    if (this._settled) {
      this._goIdle();
      return;
    }
    this._failNow(err);
  }

  // -------------------------------------------------------------------------
  // Phases
  // -------------------------------------------------------------------------

  private _feedAck(bytes: Uint8Array): Uint8Array | null {
    let buf = this._ackBuf.length ? concat(this._ackBuf, bytes) : bytes;
    this._ackBuf = new Uint8Array(0);

    for (;;) {
      if (buf.length === 0) return null;
      const verdict = this._classify(buf);

      if (verdict.kind === 'need-more') {
        // Deliberately NOT clearing the ACK timer: a dribbled packet that never
        // completes is indistinguishable from silence.
        this._ackBuf = new Uint8Array(buf);
        return null;
      }

      if (verdict.kind === 'ignore') {
        buf = buf.subarray(Math.max(1, verdict.consumed));
        continue;
      }

      this._clearAckTimer();

      if (verdict.kind === 'nack') {
        const rest = buf.subarray(Math.max(0, verdict.consumed));
        const detail = verdict.detail ? ` (${verdict.detail})` : '';
        this._failNow(new FactoryTestError('nack', `${FACTORY_TEST_NACK_MESSAGE}${detail}`));
        return rest.length ? new Uint8Array(rest) : null;
      }

      if (verdict.kind === 'ack') {
        this._phase = 'text';
        return this._feedText(buf.subarray(Math.max(0, verdict.consumed)));
      }

      // 'text' — the firmware is already printing; there is no ACK to wait for.
      this._phase = 'text';
      return this._feedText(buf);
    }
  }

  private _feedText(bytes: Uint8Array): Uint8Array | null {
    let buf = bytes;
    /* A second ACK after the first is a stale one — the firmware's ACK for an
     * earlier command that crossed this one on the link — and must not be
     * transcribed into the report as noise. */
    for (;;) {
      if (buf.length === 0) break;
      const verdict = this._classify(buf);
      if (verdict.kind !== 'ack' || verdict.consumed <= 0) break;
      buf = buf.subarray(verdict.consumed);
    }
    if (buf.length === 0) {
      this._armIdleTimer();
      return null;
    }

    const scan = this._scan(buf, true);
    if (scan.noise > 0) this._safe(() => this._opts.onNoise?.(scan.noise));
    if (scan.text) this._safe(() => this._opts.onChunk?.(scan.text, this._aggregate));
    for (const line of scan.lines) this._safe(() => this._opts.onLine?.(line));

    if (scan.endIndex >= 0) {
      const tail = buf.subarray(scan.endIndex);
      this._finish();
      return tail.length ? new Uint8Array(tail) : null;
    }

    this._armIdleTimer();
    return null;
  }

  /**
   * Post-failure drain: the result promise has already settled, so nothing here
   * is reported. The bytes are swallowed only to keep them out of the client's
   * framer until the firmware's report is over.
   */
  private _feedDraining(bytes: Uint8Array): Uint8Array | null {
    const scan = this._scan(bytes, false);
    if (scan.endIndex >= 0) {
      const tail = bytes.subarray(scan.endIndex);
      this._goIdle();
      return tail.length ? new Uint8Array(tail) : null;
    }
    this._armDrainTimer();
    return null;
  }

  /**
   * Walk `bytes`, keeping the report grammar's characters and counting the rest.
   *
   * `endIndex` is the offset ONE PAST the newline that ends the `TEST END` line,
   * expressed in the RAW input's own indices — that exactness is the whole point
   * of scanning byte by byte, because the tail handed back to the client may
   * contain the very bytes the filter would otherwise have dropped.
   */
  private _scan(
    bytes: Uint8Array,
    accumulate: boolean,
  ): { text: string; lines: string[]; noise: number; endIndex: number } {
    let text = '';
    const lines: string[] = [];
    let noise = 0;

    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i];
      if (!isReportByte(b)) {
        noise++;
        continue;
      }
      const ch = String.fromCharCode(b);
      /* Only the caller that will USE the text builds it. A drain reads
         nothing but the sentinel out of `_line`, and it can run for the length
         of the suite -- over a minute for the LED-state walk -- so appending
         every byte to a string nobody reads is a per-byte allocation for
         nothing. */
      if (accumulate) text += ch;
      this._line += ch;
      if (b !== 0x0a) continue;

      const line = this._line.replace(/\r?\n$/, '');
      this._line = '';
      if (accumulate) lines.push(line);
      if (!this._sawStart && line.includes(TEST_START_SENTINEL)) this._sawStart = true;
      if (line.includes(TEST_END_SENTINEL)) {
        if (accumulate) this._aggregate += text;
        return { text, lines, noise, endIndex: i + 1 };
      }
    }

    if (accumulate) {
      this._aggregate += text;
      if (!this._sawStart && this._aggregate.includes(TEST_START_SENTINEL)) this._sawStart = true;
    }
    return { text, lines, noise, endIndex: -1 };
  }

  // -------------------------------------------------------------------------
  // Settlement
  // -------------------------------------------------------------------------

  /** The report ended cleanly (TEST END, or a post-TEST START silence). */
  private _finish(): void {
    if (this._settled) return;
    this._settled = true;
    const text = this._aggregate;
    this._goIdle();
    this._resolve(text);
  }

  /** Reject and release the link at once — no drain. */
  private _failNow(err: Error): void {
    if (this._settled) return;
    this._settled = true;
    this._goIdle();
    this._reject(err);
  }

  /**
   * Reject, then keep swallowing: the firmware has no abort command, so after a
   * timeout or a user cancel the report is still coming and the link is not free
   * until it ends (`Test/shimmer_test.c:22-61`; the main loop is blocked for the
   * whole suite).
   */
  private _failThenDrain(err: Error): void {
    if (this._settled) return;
    this._settled = true;
    this._clearAckTimer();
    this._clearTimer('_timeoutTimer');
    this._clearTimer('_idleTimer');
    this._detachAbort();
    this._setState('draining');
    this._armDrainTimer();
    this._drainCapTimer = setTimeout(() => this._goIdle(), this._timeoutMs);
    this._reject(err);
  }

  private _goIdle(): void {
    this._clearAckTimer();
    this._clearTimer('_timeoutTimer');
    this._clearTimer('_idleTimer');
    this._clearTimer('_drainTimer');
    this._clearTimer('_drainCapTimer');
    this._detachAbort();
    /* Guarded by its own flag rather than by the state, because a capture that
     * fails before `start()` never left `idle` and must still settle its
     * `idle` promise — a caller awaiting `whenFactoryTestIdle()` would
     * otherwise wait forever. */
    if (this._idleDone) return;
    this._idleDone = true;
    this._setState('idle');
    this._safe(() => this._opts.onIdle?.());
    this._resolveIdle();
  }

  private _setState(next: FactoryTestState): void {
    if (this._state === next) return;
    this._state = next;
    this._safe(() => this._opts.onStateChange?.(next));
  }

  // -------------------------------------------------------------------------
  // Timers
  // -------------------------------------------------------------------------

  /**
   * Re-arm the completion timer. Only `TEST START` arms it: before the banner
   * the sensor may simply be slow, and resolving then would return a report that
   * never began.
   */
  private _armIdleTimer(): void {
    if (!this._sawStart || this._settled) return;
    this._clearTimer('_idleTimer');
    this._idleTimer = setTimeout(() => this._finish(), this._idleMs);
  }

  private _armDrainTimer(): void {
    this._clearTimer('_drainTimer');
    this._drainTimer = setTimeout(() => this._goIdle(), this._drainIdleMs);
  }

  private _clearAckTimer(): void {
    this._clearTimer('_ackTimer');
  }

  private _clearTimer(
    key: '_ackTimer' | '_timeoutTimer' | '_idleTimer' | '_drainTimer' | '_drainCapTimer',
  ): void {
    const t = this[key];
    if (t !== null) {
      clearTimeout(t);
      this[key] = null;
    }
  }

  private _detachAbort(): void {
    if (this._signal && this._onAbort) {
      try {
        this._signal.removeEventListener('abort', this._onAbort);
      } catch {
        /* ignore */
      }
    }
    this._signal = null;
    this._onAbort = null;
  }

  private _abortError(): Error {
    /* A DOMException named AbortError, so `err.name === 'AbortError'` works the
     * same way it does for fetch and every other abortable web API. */
    if (typeof DOMException === 'function') {
      return new DOMException('Factory test aborted', 'AbortError');
    }
    const err = new Error('Factory test aborted');
    err.name = 'AbortError';
    return err;
  }

  /** Run a user callback; a throw from one must never derail the capture. */
  private _safe(fn: () => void): void {
    try {
      fn();
    } catch {
      /* ignore callback errors */
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
