import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  FactoryTestCapture,
  FactoryTestError,
  FACTORY_TEST_ACK_TIMEOUT_MS,
  FACTORY_TEST_IDLE_FLOOR_MS,
  FACTORY_TEST_DRAIN_IDLE_MS,
  FACTORY_TEST_NACK_MESSAGE,
  type AckVerdict,
  type FactoryTestState,
} from '../../src/devices/factoryTest/capture.js';

// The firmware's own envelope (Test/shimmer_test.c:22-61): `//` + 28 `*` +
// " TEST START " + 36 `*` + `//`, and 29/37 either side of " TEST END ".
const START_BANNER = `//${'*'.repeat(28)} TEST START ${'*'.repeat(36)}//`;
const END_BANNER = `//${'*'.repeat(29)} TEST END ${'*'.repeat(37)}//`;

const ACK = 0xff;
const NACK = 0xfe;

/** The LiteProtocol classifier's shape, kept local so this suite tests the capture only. */
function classify(buf: Uint8Array): AckVerdict {
  if (buf.length === 0) return { kind: 'need-more' };
  if (buf[0] === ACK) return { kind: 'ack', consumed: 1 };
  if (buf[0] === NACK) return { kind: 'nack', consumed: 1 };
  return { kind: 'text' };
}

function bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

function u8(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe('FactoryTestCapture', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // The ACK phase
  // -------------------------------------------------------------------------

  it('resolves the report when the ACK and the text arrive in separate chunks', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    expect(cap.state).toBe('running');

    expect(cap.feed(u8(ACK))).toBeNull();
    expect(cap.feed(bytes(`${START_BANNER}\r\n`))).toBeNull();
    expect(cap.feed(bytes(`${END_BANNER}\r\n`))).toBeNull();

    await expect(cap.result).resolves.toBe(`${START_BANNER}\r\n${END_BANNER}\r\n`);
    await expect(cap.idle).resolves.toBeUndefined();
    expect(cap.state).toBe('idle');
  });

  it('classifies the ACK on the head of the SAME chunk that carries the first text', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    // The expected BLE case: one notification carrying [0xFF] then report bytes.
    expect(cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)))).toBeNull();
    cap.feed(bytes(`${END_BANNER}\r\n`));
    await expect(cap.result).resolves.toContain('TEST START');
    await expect(cap.result).resolves.toContain('TEST END');
  });

  it('swallows a stale second ACK instead of transcribing it into the report', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(u8(ACK));
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));
    cap.feed(bytes(`${END_BANNER}\r\n`));
    const text = await cap.result;
    expect(text).toBe(`${START_BANNER}\r\n${END_BANNER}\r\n`);
    expect(text).not.toContain('ÿ');
  });

  it('accumulates a dribbled classifier verdict without clearing the ACK deadline', async () => {
    // A classifier that needs three bytes before it can tell — the dock's shape.
    const needThree = (buf: Uint8Array): AckVerdict => {
      if (buf.length < 3) return { kind: 'need-more' };
      return buf[0] === 0x24 ? { kind: 'ack', consumed: 3 } : { kind: 'text' };
    };
    const cap = new FactoryTestCapture(needThree);
    cap.start();
    expect(cap.feed(u8(0x24))).toBeNull();
    expect(cap.feed(u8(0x01))).toBeNull();
    expect(cap.state).toBe('running');
    cap.feed(concat(u8(0xff), bytes(`${START_BANNER}\r\n${END_BANNER}\r\n`)));
    await expect(cap.result).resolves.toContain('TEST END');
  });

  it('steps over bytes the classifier says to ignore', async () => {
    const withNoise = (buf: Uint8Array): AckVerdict => {
      if (buf.length === 0) return { kind: 'need-more' };
      if (buf[0] === 0x00) return { kind: 'ignore', consumed: 1 };
      return classify(buf);
    };
    const cap = new FactoryTestCapture(withNoise);
    cap.start();
    cap.feed(concat(u8(0x00, 0x00, ACK), bytes(`${START_BANNER}\r\n${END_BANNER}\r\n`)));
    await expect(cap.result).resolves.toBe(`${START_BANNER}\r\n${END_BANNER}\r\n`);
  });

  it('rejects a NACK with the refusal message and hands back the bytes after it', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    const rest = cap.feed(u8(NACK, 0x8a, 0x71, 0x00, 0x00));
    expect(rest).toEqual(u8(0x8a, 0x71, 0x00, 0x00));

    await expect(cap.result).rejects.toThrow(FactoryTestError);
    await cap.result.catch((err: FactoryTestError) => {
      expect(err.reason).toBe('nack');
      expect(err.message).toContain(FACTORY_TEST_NACK_MESSAGE);
      expect(err.message).toMatch(/stop streaming or sd logging/i);
    });
    // No drain: a refused command leaves the link free immediately.
    expect(cap.state).toBe('idle');
    await expect(cap.idle).resolves.toBeUndefined();
  });

  it('fails with no-response when nothing at all arrives inside the ACK window', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_ACK_TIMEOUT_MS - 1);
    expect(cap.state).toBe('running');
    await vi.advanceTimersByTimeAsync(2);
    await cap.result.catch((err: FactoryTestError) => {
      expect(err.reason).toBe('no-response');
    });
    await expect(cap.result).rejects.toThrow(FactoryTestError);
    expect(cap.state).toBe('idle');
  });

  it('does not fail with no-response once text has started arriving', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_ACK_TIMEOUT_MS + 100);
    expect(cap.state).toBe('running');
  });

  // -------------------------------------------------------------------------
  // The text phase
  // -------------------------------------------------------------------------

  it('keeps TAB/CR/LF and printable ASCII, counting everything else as noise', async () => {
    const noise: number[] = [];
    const cap = new FactoryTestCapture(classify, { onNoise: (n) => noise.push(n) });
    cap.start();
    cap.feed(u8(ACK));
    cap.feed(concat(bytes('\tA'), u8(0x00, 0x01, 0x7f, 0x80), bytes('B\r\n')));
    cap.feed(bytes(`${START_BANNER}\r\n${END_BANNER}\r\n`));
    const text = await cap.result;
    expect(text.startsWith('\tAB\r\n')).toBe(true);
    expect(noise).toEqual([4]);
  });

  it('reports a line per LF with the CR stripped, and a chunk per feed', async () => {
    const lines: string[] = [];
    const chunks: string[] = [];
    const cap = new FactoryTestCapture(classify, {
      onLine: (l) => lines.push(l),
      onChunk: (c, agg) => chunks.push(`${c}|${agg.length}`),
    });
    cap.start();
    cap.feed(u8(ACK));
    cap.feed(bytes(`${START_BANNER}\r\nMCU:\r\n`));
    cap.feed(bytes(` - S3R_TEST_0007 - PASS\r\n${END_BANNER}\r\n`));
    await cap.result;
    expect(lines).toEqual([START_BANNER, 'MCU:', ' - S3R_TEST_0007 - PASS', END_BANNER]);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].startsWith(`${START_BANNER}\r\nMCU:\r\n|`)).toBe(true);
  });

  it('sees a banner split across feeds', async () => {
    const cap = new FactoryTestCapture(classify, { completionIdleMs: 0 });
    cap.start();
    cap.feed(u8(ACK));
    cap.feed(bytes(START_BANNER.slice(0, 35)));
    cap.feed(bytes(`${START_BANNER.slice(35)}\r\n`));
    // TEST START was only complete across the two feeds; the idle timer is armed.
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_IDLE_FLOOR_MS + 10);
    await expect(cap.result).resolves.toBe(`${START_BANNER}\r\n`);
  });

  it('finishes on post-TEST START silence, floored at ten seconds', async () => {
    const cap = new FactoryTestCapture(classify, { completionIdleMs: 500 });
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\nBattery:\r\n`)));
    // The requested 500 ms is ignored — the floor is what governs.
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_IDLE_FLOOR_MS - 100);
    expect(cap.state).toBe('running');
    await vi.advanceTimersByTimeAsync(200);
    // An incomplete report resolves; it is not an error.
    await expect(cap.result).resolves.toBe(`${START_BANNER}\r\nBattery:\r\n`);
    expect(cap.state).toBe('idle');
  });

  it('re-arms the idle timer on every chunk', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(FACTORY_TEST_IDLE_FLOOR_MS - 500);
      cap.feed(bytes(`\t-> Idle...\r\n`));
      expect(cap.state).toBe('running');
    }
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_IDLE_FLOOR_MS + 10);
    expect(cap.state).toBe('idle');
  });

  it('does not arm the idle timer before TEST START', async () => {
    const cap = new FactoryTestCapture(classify, { timeoutMs: 60_000 });
    cap.start();
    cap.feed(concat(u8(ACK), bytes('preamble with no banner\r\n')));
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_IDLE_FLOOR_MS + 5_000);
    expect(cap.state).toBe('running');
  });

  it('resolves synchronously on the TEST END line and hands back what followed it', async () => {
    let resolved: string | null = null;
    const cap = new FactoryTestCapture(classify);
    void cap.result.then((t) => {
      resolved = t;
    });
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));
    // A deferred status push glued onto the banner: [0x8A][0x71][s0][s1].
    const tail = cap.feed(concat(bytes(`${END_BANNER}\r\n`), u8(0x8a, 0x71, 0x21, 0x00)));
    expect(cap.state).toBe('idle'); // synchronous, before any microtask ran
    expect(resolved).toBeNull(); // the promise callback is still queued
    expect(tail).toEqual(u8(0x8a, 0x71, 0x21, 0x00));
    await expect(cap.result).resolves.toBe(`${START_BANNER}\r\n${END_BANNER}\r\n`);
  });

  it('hands the whole chunk back once it is idle', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n${END_BANNER}\r\n`)));
    await cap.result;
    expect(cap.feed(u8(0x8a, 0x71))).toEqual(u8(0x8a, 0x71));
  });

  it('resolves a report with no Overall line, as the LED suites print', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(
      concat(
        u8(ACK),
        bytes(
          `${START_BANNER}\r\nLED test (S3R_TEST_0027):\r\n - All LEDs off\r\n${END_BANNER}\r\n`,
        ),
      ),
    );
    const text = await cap.result;
    expect(text).not.toContain('Overall Result');
    expect(text).toContain('All LEDs off');
  });

  // -------------------------------------------------------------------------
  // Timeout, abort and the drain
  // -------------------------------------------------------------------------

  it('rejects on timeout, then drains until the report ends', async () => {
    const states: FactoryTestState[] = [];
    const cap = new FactoryTestCapture(classify, {
      timeoutMs: 5_000,
      onStateChange: (s) => states.push(s),
    });
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));

    await vi.advanceTimersByTimeAsync(5_100);
    await cap.result.catch((err: FactoryTestError) => expect(err.reason).toBe('timeout'));
    expect(cap.state).toBe('draining');

    // The sensor keeps printing; those bytes are swallowed, not returned.
    expect(cap.feed(bytes('Battery:\r\n - PASS\r\n'))).toBeNull();
    expect(cap.state).toBe('draining');

    const tail = cap.feed(concat(bytes(`${END_BANNER}\r\n`), u8(0x8a)));
    expect(tail).toEqual(u8(0x8a));
    expect(cap.state).toBe('idle');
    await expect(cap.idle).resolves.toBeUndefined();
    expect(states).toEqual(['running', 'draining', 'idle']);
  });

  it('ends the drain after drainIdleMs of silence', async () => {
    // timeoutMs is also the drain's hard cap, so it must exceed the idle window
    // for that window to be what releases the link.
    const cap = new FactoryTestCapture(classify, { timeoutMs: 30_000 });
    cap.start();
    cap.feed(u8(ACK));
    await vi.advanceTimersByTimeAsync(30_100);
    await expect(cap.result).rejects.toThrow(FactoryTestError);
    expect(cap.state).toBe('draining');

    cap.feed(bytes('still printing\r\n'));
    await vi.advanceTimersByTimeAsync(FACTORY_TEST_DRAIN_IDLE_MS - 100);
    expect(cap.state).toBe('draining');
    await vi.advanceTimersByTimeAsync(200);
    expect(cap.state).toBe('idle');
  });

  it('ends the drain at the hard cap even when bytes keep arriving', async () => {
    const cap = new FactoryTestCapture(classify, { timeoutMs: 5_000, drainIdleMs: 1_000 });
    cap.start();
    cap.feed(u8(ACK));
    await vi.advanceTimersByTimeAsync(5_100);
    for (let i = 0; i < 20; i++) {
      cap.feed(bytes('chatter\r\n'));
      await vi.advanceTimersByTimeAsync(500);
    }
    // 10 s of chatter at 500 ms intervals never lets the 1 s idle timer fire, so
    // only the hard cap (= timeoutMs) can release the link.
    expect(cap.state).toBe('idle');
  });

  it('aborts with a DOMException named AbortError and then drains', async () => {
    const controller = new AbortController();
    const cap = new FactoryTestCapture(classify, { timeoutMs: 30_000, signal: controller.signal });
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));

    controller.abort();
    await cap.result.catch((err: Error) => {
      expect(err.name).toBe('AbortError');
      expect(err.message).toBe('Factory test aborted');
    });
    expect(cap.state).toBe('draining');
    cap.feed(bytes(`${END_BANNER}\r\n`));
    expect(cap.state).toBe('idle');
  });

  it('refuses to start on an already-aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    const cap = new FactoryTestCapture(classify, { signal: controller.signal });
    cap.start();
    await expect(cap.result).rejects.toThrow(/aborted/i);
    expect(cap.state).toBe('draining');
  });

  it('fail() rejects and releases the link at once, with no drain', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));
    cap.fail(new FactoryTestError('disconnected', 'The link dropped during the self-test.'));
    expect(cap.state).toBe('idle');
    await cap.result.catch((err: FactoryTestError) => expect(err.reason).toBe('disconnected'));
    await expect(cap.result).rejects.toThrow(FactoryTestError);
    await expect(cap.idle).resolves.toBeUndefined();
  });

  it('settles idle even when it fails before start()', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.fail(new FactoryTestError('disconnected', 'gone'));
    await expect(cap.result).rejects.toThrow('gone');
    await expect(cap.idle).resolves.toBeUndefined();
  });

  it('settles once — a later fail() cannot displace the resolved report', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n${END_BANNER}\r\n`)));
    cap.fail(new FactoryTestError('disconnected', 'too late'));
    await expect(cap.result).resolves.toContain('TEST END');
  });

  // -------------------------------------------------------------------------
  // Robustness
  // -------------------------------------------------------------------------

  it('survives a throwing onChunk, onLine, onNoise and onStateChange', async () => {
    const boom = (): never => {
      throw new Error('callback blew up');
    };
    const cap = new FactoryTestCapture(classify, {
      onChunk: boom,
      onLine: boom,
      onNoise: boom,
      onStateChange: boom,
      onIdle: boom,
    });
    expect(() => cap.start()).not.toThrow();
    expect(() =>
      cap.feed(concat(u8(ACK, 0x00), bytes(`${START_BANNER}\r\n${END_BANNER}\r\n`))),
    ).not.toThrow();
    await expect(cap.result).resolves.toContain('TEST END');
  });

  it('never throws out of feed(), even on a classifier that throws', () => {
    const cap = new FactoryTestCapture(() => {
      throw new Error('classifier blew up');
    });
    cap.start();
    expect(() => cap.feed(u8(ACK))).not.toThrow();
    expect(cap.feed(u8(ACK))).toBeNull();
  });

  it('ignores an empty feed and a feed before start()', () => {
    const cap = new FactoryTestCapture(classify);
    expect(cap.feed(new Uint8Array(0))).toBeNull();
    // Before start() the capture is idle, so bytes belong to the caller.
    expect(cap.feed(u8(0x01))).toEqual(u8(0x01));
  });

  it('start() is idempotent', async () => {
    const states: FactoryTestState[] = [];
    const cap = new FactoryTestCapture(classify, { onStateChange: (s) => states.push(s) });
    cap.start();
    cap.start();
    expect(states).toEqual(['running']);
    cap.fail(new FactoryTestError('disconnected', 'x'));
    await expect(cap.result).rejects.toThrow();
    expect(states).toEqual(['running', 'idle']);
  });

  it('exposes the aggregate as it grows', async () => {
    const cap = new FactoryTestCapture(classify);
    cap.start();
    cap.feed(concat(u8(ACK), bytes(`${START_BANNER}\r\n`)));
    expect(cap.aggregate).toBe(`${START_BANNER}\r\n`);
    cap.feed(bytes(`${END_BANNER}\r\n`));
    await expect(cap.result).resolves.toBe(cap.aggregate);
  });
});

describe('FactoryTestCapture.fail() while draining', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('frees the link at once instead of waiting the drain out', async () => {
    /* Draining exists only to keep a still-arriving report away from the
       framer. On a link that has gone there is nothing left to arrive, so
       serving out the drain would hold a caller in "busy" for the rest of the
       budget -- over a minute for the LED-state suite -- after the sensor
       stopped being reachable. */
    const states: string[] = [];
    const cap = new FactoryTestCapture(classify, {
      timeoutMs: 30_000,
      onStateChange: (s) => states.push(s),
    });
    cap.start();
    cap.feed(u8(ACK));
    await vi.advanceTimersByTimeAsync(30_100);
    await expect(cap.result).rejects.toThrow(FactoryTestError);
    expect(cap.state).toBe('draining');

    cap.fail(new FactoryTestError('disconnected', 'link dropped'));
    expect(cap.state).toBe('idle');
    await expect(cap.idle).resolves.toBeUndefined();
    expect(states).toEqual(['running', 'draining', 'idle']);
    // No timer left that could fire a second transition later.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(cap.state).toBe('idle');
    expect(states).toEqual(['running', 'draining', 'idle']);
  });

  it('still rejects a run that had not settled yet', async () => {
    const cap = new FactoryTestCapture(classify, { timeoutMs: 30_000 });
    cap.start();
    cap.feed(u8(ACK));
    cap.fail(new FactoryTestError('disconnected', 'link dropped'));
    await expect(cap.result).rejects.toMatchObject({ reason: 'disconnected' });
    expect(cap.state).toBe('idle');
  });
});
