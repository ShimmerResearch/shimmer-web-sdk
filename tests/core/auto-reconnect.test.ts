import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_RECONNECT_POLICY,
  nextReconnectDelayMs,
  planStreamResume,
  reconnectDelayMs,
  resolveReconnectPolicy,
  startAutoReconnect,
  type AutoReconnectAbandoned,
  type AutoReconnectFailure,
  type AutoReconnectOptions,
  type AutoReconnectTimers,
} from '../../src/core/autoReconnect.js';

// The schedule and the resume rule are pure, and shimmer-host-core carries the
// same rules with the same vectors (its `reconnect` module). Change a vector
// here and the matching one there changes too.

describe('resolveReconnectPolicy', () => {
  it('fills every field from the defaults', () => {
    expect(resolveReconnectPolicy()).toEqual({
      initialDelayMs: 1000,
      retryDelayMs: 2000,
      backoffFactor: 2,
      maxDelayMs: 15000,
      attemptTimeoutMs: 30000,
      settleMs: 5000,
      maxAttempts: Infinity,
      maxDurationMs: Infinity,
    });
    expect(resolveReconnectPolicy()).toEqual(DEFAULT_RECONNECT_POLICY);
  });

  it('keeps valid values', () => {
    expect(
      resolveReconnectPolicy({
        initialDelayMs: 0,
        retryDelayMs: 500,
        backoffFactor: 1,
        maxDelayMs: 750,
        attemptTimeoutMs: 1,
        settleMs: 0,
        maxAttempts: 3,
        maxDurationMs: 60000,
      }),
    ).toEqual({
      initialDelayMs: 0,
      retryDelayMs: 500,
      backoffFactor: 1,
      maxDelayMs: 750,
      attemptTimeoutMs: 1,
      settleMs: 0,
      maxAttempts: 3,
      maxDurationMs: 60000,
    });
  });

  it('replaces values it cannot use', () => {
    const p = resolveReconnectPolicy({
      initialDelayMs: -1,
      retryDelayMs: NaN,
      backoffFactor: 0.5,
      maxDelayMs: Infinity,
      attemptTimeoutMs: 0,
      settleMs: -5,
    });
    expect(p.initialDelayMs).toBe(1000);
    expect(p.retryDelayMs).toBe(2000);
    expect(p.backoffFactor).toBe(2);
    expect(p.maxDelayMs).toBe(15000);
    expect(p.attemptTimeoutMs).toBe(30000);
    expect(p.settleMs).toBe(5000);
  });

  it('reads 0, negative or non-numeric limits as no limit, and rounds attempts down', () => {
    expect(resolveReconnectPolicy({ maxAttempts: 0 }).maxAttempts).toBe(Infinity);
    expect(resolveReconnectPolicy({ maxAttempts: -2 }).maxAttempts).toBe(Infinity);
    expect(resolveReconnectPolicy({ maxAttempts: 2.9 }).maxAttempts).toBe(2);
    expect(resolveReconnectPolicy({ maxAttempts: 0.5 }).maxAttempts).toBe(1);
    expect(resolveReconnectPolicy({ maxDurationMs: 0 }).maxDurationMs).toBe(Infinity);
    expect(resolveReconnectPolicy({ maxDurationMs: NaN }).maxDurationMs).toBe(Infinity);
  });
});

describe('reconnectDelayMs', () => {
  it('waits 1, 2, 4, 8, then 15 s at most, with the default policy', () => {
    const p = resolveReconnectPolicy();
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => reconnectDelayMs(p, n))).toEqual([
      1000, 2000, 4000, 8000, 15000, 15000, 15000,
    ]);
  });

  it('keeps every wait after the first equal with a factor of 1', () => {
    const p = resolveReconnectPolicy({ initialDelayMs: 0, retryDelayMs: 3000, backoffFactor: 1 });
    expect([1, 2, 3, 4].map((n) => reconnectDelayMs(p, n))).toEqual([0, 3000, 3000, 3000]);
  });

  it('rounds to the millisecond', () => {
    const p = resolveReconnectPolicy({ retryDelayMs: 1000, backoffFactor: 1.5, maxDelayMs: 1e9 });
    expect([2, 3, 4, 5].map((n) => reconnectDelayMs(p, n))).toEqual([1000, 1500, 2250, 3375]);
    expect(reconnectDelayMs(p, 6)).toBe(5063); // 5062.5
  });

  it('treats attempt 0 or below as the first', () => {
    const p = resolveReconnectPolicy();
    expect(reconnectDelayMs(p, 0)).toBe(1000);
    expect(reconnectDelayMs(p, -3)).toBe(1000);
  });
});

describe('nextReconnectDelayMs', () => {
  it('keeps going with no limits', () => {
    const p = resolveReconnectPolicy();
    expect(nextReconnectDelayMs(p, 1, 0)).toBe(2000);
    expect(nextReconnectDelayMs(p, 100, 1e9)).toBe(15000);
  });

  it('gives up once maxAttempts tries have failed', () => {
    const p = resolveReconnectPolicy({ maxAttempts: 3 });
    expect(nextReconnectDelayMs(p, 2, 0)).toBe(4000);
    expect(nextReconnectDelayMs(p, 3, 0)).toBeNull();
  });

  it('gives up when the next try would start after maxDurationMs', () => {
    const p = resolveReconnectPolicy({ maxDurationMs: 10000 });
    expect(nextReconnectDelayMs(p, 1, 8000)).toBe(2000); // starts at exactly 10 s
    expect(nextReconnectDelayMs(p, 1, 8001)).toBeNull();
  });
});

describe('planStreamResume', () => {
  const idle = { streaming: false, sdLogging: false };
  const streaming = { streaming: true, sdLogging: false };
  const both = { streaming: true, sdLogging: true };
  const logOnly = { streaming: false, sdLogging: true };

  it('puts nothing back when nothing was streaming', () => {
    expect(planStreamResume(idle, null)).toBe('none');
    expect(planStreamResume(logOnly, { streaming: false, sdLogging: false })).toBe('none');
    expect(planStreamResume(logOnly, { streaming: false, sdLogging: true })).toBe('none');
  });

  it('sends nothing to a sensor that is still streaming', () => {
    expect(planStreamResume(streaming, { streaming: true, sdLogging: false })).toBe('none');
    expect(planStreamResume(both, { streaming: true, sdLogging: true })).toBe('none');
  });

  it('restarts a stream that had no log', () => {
    expect(planStreamResume(streaming, { streaming: false, sdLogging: false })).toBe(
      'start-streaming',
    );
    expect(planStreamResume(streaming, null)).toBe('start-streaming');
  });

  it('restarts only the stream when the log went on through the drop', () => {
    expect(planStreamResume(both, { streaming: false, sdLogging: true })).toBe('start-streaming');
  });

  it('restarts both when the log ended too', () => {
    expect(planStreamResume(both, { streaming: false, sdLogging: false })).toBe(
      'start-streaming-and-logging',
    );
  });

  it('never starts a second log on a guess', () => {
    expect(planStreamResume(both, null)).toBe('start-streaming');
    expect(planStreamResume(both, undefined)).toBe('start-streaming');
    expect(planStreamResume(both, { streaming: false, sdLogging: null })).toBe('start-streaming');
    expect(planStreamResume(both, {})).toBe('start-streaming');
  });
});

describe('startAutoReconnect', () => {
  const timers: AutoReconnectTimers = {
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    now: () => Date.now(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A try that never settles unless its signal aborts it. */
  const hangs = (honourSignal: boolean) => (ctx: { signal: AbortSignal }) =>
    new Promise<void>((_resolve, reject) => {
      if (honourSignal) ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
    });

  function start(opts: Partial<AutoReconnectOptions> & Pick<AutoReconnectOptions, 'attempt'>) {
    return startAutoReconnect({ timers, ...opts });
  }

  it('connects on the first try, after the initial wait', async () => {
    const attempt = vi.fn(async (_ctx: { attempt: number }) => undefined);
    const h = start({ attempt });
    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).not.toHaveBeenCalled();
    expect(h.active).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(attempt.mock.calls[0]![0]).toMatchObject({ attempt: 1 });
    const r = await h.done;
    expect(r).toEqual({ outcome: 'connected', attempts: 1, elapsedMs: 1000 });
    expect(h.active).toBe(false);
  });

  it('waits longer after each failure, up to the cap', async () => {
    const at: number[] = [];
    let n = 0;
    const failures: AutoReconnectFailure[] = [];
    const h = start({
      attempt: async () => {
        at.push(Date.now());
        if (++n < 6) throw new Error(`no ${n}`);
      },
      onAttemptFailed: (f) => failures.push(f),
    });
    await vi.advanceTimersByTimeAsync(60000);
    const r = await h.done;
    // 1 s, then +2, +4, +8, +15 (capped from 16), +15
    expect(at).toEqual([1000, 3000, 7000, 15000, 30000, 45000]);
    expect(r.outcome).toBe('connected');
    expect(r.attempts).toBe(6);
    expect(String(r.lastError)).toContain('no 5');
    expect(failures.map((f) => f.nextDelayMs)).toEqual([2000, 4000, 8000, 15000, 15000]);
    expect(failures.every((f) => !f.timedOut)).toBe(true);
  });

  it('counts a try that throws synchronously as a failure', async () => {
    let n = 0;
    const h = start({
      attempt: () => {
        if (++n === 1) throw new Error('sync');
        return Promise.resolve();
      },
    });
    await vi.advanceTimersByTimeAsync(3000);
    const r = await h.done;
    expect(r.outcome).toBe('connected');
    expect(r.attempts).toBe(2);
    expect((r.lastError as Error).message).toBe('sync');
  });

  it('abandons a try that overruns, aborting its signal, and moves on', async () => {
    const abandoned: AutoReconnectAbandoned[] = [];
    const signals: AbortSignal[] = [];
    const at: number[] = [];
    let n = 0;
    const failures: AutoReconnectFailure[] = [];
    const h = start({
      attemptTimeoutMs: 10000,
      attempt: (ctx) => {
        at.push(Date.now());
        signals.push(ctx.signal);
        return ++n === 1 ? hangs(true)(ctx) : Promise.resolve();
      },
      abandon: (a) => abandoned.push(a),
      onAttemptFailed: (f) => failures.push(f),
    });
    await vi.advanceTimersByTimeAsync(20000);
    const r = await h.done;
    expect(r.outcome).toBe('connected');
    // The first try was abandoned at 11 s and rejected at once on its signal,
    // so the next came 2 s later rather than after the full settle time.
    expect(at).toEqual([1000, 13000]);
    expect(signals[0]!.aborted).toBe(true);
    expect((signals[0]!.reason as Error).name).toBe('TimeoutError');
    expect(signals[1]!.aborted).toBe(false);
    expect(abandoned).toEqual([{ attempt: 1, reason: 'timeout', late: false }]);
    expect(failures).toHaveLength(1);
    expect(failures[0]!.timedOut).toBe(true);
    expect((failures[0]!.error as Error).name).toBe('TimeoutError');
  });

  it('waits up to settleMs for an abandoned try that ignores its signal', async () => {
    const at: number[] = [];
    let n = 0;
    const h = start({
      attemptTimeoutMs: 10000,
      settleMs: 5000,
      attempt: (ctx) => {
        at.push(Date.now());
        return ++n === 1 ? hangs(false)(ctx) : Promise.resolve();
      },
    });
    await vi.advanceTimersByTimeAsync(30000);
    await h.done;
    // abandoned at 11 s, settle 5 s, then the 2 s wait
    expect(at).toEqual([1000, 18000]);
  });

  it('asks for a late success to be closed', async () => {
    const abandoned: AutoReconnectAbandoned[] = [];
    let release!: () => void;
    let n = 0;
    const h = start({
      attemptTimeoutMs: 10000,
      settleMs: 1000,
      maxAttempts: 1,
      attempt: () =>
        ++n === 1
          ? new Promise<void>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(),
      abandon: (a) => abandoned.push(a),
    });
    await vi.advanceTimersByTimeAsync(11000);
    expect(abandoned).toEqual([{ attempt: 1, reason: 'timeout', late: false }]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(abandoned).toEqual([
      { attempt: 1, reason: 'timeout', late: false },
      { attempt: 1, reason: 'timeout', late: true },
    ]);
    const r = await h.done;
    // The late success does not count: the loop had already moved on.
    expect(r.outcome).toBe('gave-up');
  });

  it('cancels during the initial wait without trying', async () => {
    const attempt = vi.fn(async () => undefined);
    const h = start({ attempt });
    await vi.advanceTimersByTimeAsync(500);
    h.cancel();
    const r = await h.done;
    expect(r).toEqual({ outcome: 'cancelled', attempts: 0, elapsedMs: 500 });
    await vi.advanceTimersByTimeAsync(10000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('cancels a try in progress at once, and asks for it to be released', async () => {
    const abandoned: AutoReconnectAbandoned[] = [];
    let signal!: AbortSignal;
    let release!: () => void;
    const h = start({
      attempt: (ctx) => {
        signal = ctx.signal;
        return new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      abandon: (a) => abandoned.push(a),
    });
    await vi.advanceTimersByTimeAsync(1500);
    h.cancel();
    expect(signal.aborted).toBe(true);
    expect((signal.reason as Error).name).toBe('AbortError');
    expect(abandoned).toEqual([{ attempt: 1, reason: 'cancelled', late: false }]);
    const r = await h.done;
    expect(r.outcome).toBe('cancelled');
    expect(r.attempts).toBe(1);
    // It connects anyway: that link is to be closed, and the outcome stands.
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(abandoned.at(-1)).toEqual({ attempt: 1, reason: 'cancelled', late: true });
    expect((await h.done).outcome).toBe('cancelled');
  });

  it('cancels during the wait after a failure', async () => {
    const attempt = vi.fn(async () => {
      throw new Error('out of range');
    });
    const h = start({ attempt });
    await vi.advanceTimersByTimeAsync(2000);
    expect(attempt).toHaveBeenCalledTimes(1);
    h.cancel();
    const r = await h.done;
    expect(r.outcome).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(60000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('cancels while an abandoned try is settling', async () => {
    const attempt = vi.fn(hangs(false));
    const h = start({ attemptTimeoutMs: 1000, settleMs: 60000, attempt });
    await vi.advanceTimersByTimeAsync(3000);
    h.cancel();
    expect((await h.done).outcome).toBe('cancelled');
    await vi.advanceTimersByTimeAsync(120000);
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it('does nothing when cancelled after it ended', async () => {
    const h = start({ attempt: async () => undefined });
    await vi.advanceTimersByTimeAsync(1000);
    expect((await h.done).outcome).toBe('connected');
    h.cancel();
    expect((await h.done).outcome).toBe('connected');
  });

  it('gives up after maxAttempts, with the last error', async () => {
    const failures: AutoReconnectFailure[] = [];
    const h = start({
      maxAttempts: 3,
      attempt: async () => {
        throw new Error('NetworkError: Failed to open serial port.');
      },
      onAttemptFailed: (f) => failures.push(f),
    });
    await vi.advanceTimersByTimeAsync(60000);
    const r = await h.done;
    expect(r.outcome).toBe('gave-up');
    expect(r.attempts).toBe(3);
    expect(String(r.lastError)).toContain('Failed to open serial port');
    expect(failures.map((f) => f.nextDelayMs)).toEqual([2000, 4000, null]);
  });

  it('gives up once the next try would start after maxDurationMs', async () => {
    const at: number[] = [];
    const h = start({
      maxDurationMs: 8000,
      attempt: async () => {
        at.push(Date.now());
        throw new Error('no');
      },
    });
    await vi.advanceTimersByTimeAsync(60000);
    const r = await h.done;
    // 1 s, 3 s, 7 s; the next would be at 15 s
    expect(at).toEqual([1000, 3000, 7000]);
    expect(r.outcome).toBe('gave-up');
    expect(r.elapsedMs).toBe(7000);
  });

  it('keeps going when a handler throws', async () => {
    let n = 0;
    const h = start({
      attempt: async () => {
        if (++n < 3) throw new Error('no');
      },
      onAttempt: () => {
        throw new Error('handler bug');
      },
      onAttemptFailed: () => {
        throw new Error('handler bug');
      },
      abandon: () => Promise.reject(new Error('handler bug')),
    });
    await vi.advanceTimersByTimeAsync(10000);
    const r = await h.done;
    expect(r.outcome).toBe('connected');
    expect(r.attempts).toBe(3);
  });

  it('reports attempts while it runs', async () => {
    const seen: number[] = [];
    const h = start({
      attempt: async () => {
        throw new Error('no');
      },
      onAttempt: ({ attempt }) => seen.push(attempt),
      maxAttempts: 2,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(seen).toEqual([1, 2]);
    expect((await h.done).outcome).toBe('gave-up');
  });

  it('runs on the global timers when none are given', async () => {
    const h = startAutoReconnect({ attempt: async () => undefined, initialDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(0);
    expect((await h.done).outcome).toBe('connected');
  });
});
