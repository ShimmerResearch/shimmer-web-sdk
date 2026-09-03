/**
 * `Shimmer3RClient.runFactoryTest` over both transport shapes.
 *
 * The report is raw ASCII with no framing, so every case here is really the
 * same question asked from a different angle: do those bytes reach the caller
 * whole, and do they stay out of the control-plane framer while they do.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { FactoryTestError } from '../../src/devices/factoryTest/capture.js';
import {
  SHIMMER3_FACTORY_TEST_TYPE,
  SHIMMER3_FACTORY_TEST_TYPES,
} from '../../src/devices/shimmer3r/factoryTest.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const NACK = OPCODES.NACK_COMMAND_PROCESSED;

const START_BANNER =
  '//**************************** TEST START ' + '************************************//\r\n';
const END_BANNER =
  '//***************************** TEST END ' + '*************************************//\r\n';

/** A short but structurally real Shimmer3R report. */
const REPORT =
  START_BANNER +
  'Firmware version: v1.01.012\r\n' +
  'MCU:\r\n' +
  ' - S3R_TEST_0007 - PASS: VRef = 3301mV (3200-3400mV)\r\n' +
  '\r\nOverall Result = PASS\r\n' +
  END_BANNER;

const bytesOf = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** A status response, the thing most likely to be glued after TEST END. */
const STATUS_PUSH = new Uint8Array([
  OPCODES.INSTREAM_CMD_RESPONSE,
  OPCODES.STATUS_RESPONSE,
  0x00,
  0x00,
]);

/**
 * A connected client whose "firmware" answers SET_FACTORY_TEST with `answer`,
 * delivered either whole (framed, as BLE does) or in `dribble`-byte pieces
 * (unframed, the worst a serial port presents).
 */
async function connected(opts: {
  framed: boolean;
  dribble?: number;
  answer?: (cmd: Uint8Array) => Uint8Array | null;
}) {
  const t = new LoopbackTransport({ capabilities: { framed: opts.framed } });
  const dribble = opts.dribble ?? 3;
  const send = (u8: Uint8Array) => {
    if (opts.framed) {
      t.notify(u8);
      return;
    }
    for (let off = 0; off < u8.length; off += dribble) t.notify(u8.slice(off, off + dribble));
  };
  t.setOnWrite((raw) => {
    const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (cmd[0] === OPCODES.SET_FACTORY_TEST) {
      const answer = opts.answer ? opts.answer(cmd) : cat(new Uint8Array([ACK]), bytesOf(REPORT));
      if (answer) setTimeout(() => send(answer), 0);
      return;
    }
    if (cmd[0] === OPCODES.GET_STATUS_COMMAND) {
      // `[ACK][0x8A][0x71][s0][s1]` — idle, nothing sensing.
      setTimeout(() => t.notify(cat(new Uint8Array([ACK]), STATUS_PUSH)), 0);
      return;
    }
    setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
  });
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  return { t, client, send };
}

afterEach(() => {
  vi.useRealTimers();
});

describe.each([
  { framed: true, label: 'framed (BLE)' },
  { framed: false, label: 'unframed (serial, 3-byte reads)' },
])('runFactoryTest — $label', ({ framed }) => {
  it('sends the command with its type byte and returns the whole report', async () => {
    const { t, client } = await connected({ framed });
    const text = await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false });
    expect(text).toBe(REPORT);
    const sent = t.writes.map((w) => Array.from(w.bytes));
    expect(sent).toContainEqual([OPCODES.SET_FACTORY_TEST, 0]);
    expect(client.factoryTestState).toBe('idle');
  });

  it('accepts the ACK and the first report bytes in one chunk', async () => {
    // The whole point: over BLE the module packs them into one notification.
    const { client } = await connected({ framed });
    const text = await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.ICS, {
      preflight: false,
    });
    expect(text.startsWith(START_BANNER)).toBe(true);
  });

  it('keeps report text out of the control-plane framer', async () => {
    /* A report line starts with "/" = 0x2F, which the framer would read as a
       FW_VERSION_RESPONSE and then wait forever for its payload. If any of it
       reached the framer, the very next command would time out. */
    const { client } = await connected({ framed });
    await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false });
    await expect(client.setInternalExpPower(1)).resolves.toBeTruthy();
  });

  it('reports a NACK as a refusal that names why', async () => {
    const { client } = await connected({
      framed,
      answer: () => new Uint8Array([NACK]),
    });
    await expect(
      client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false }),
    ).rejects.toMatchObject({ reason: 'nack' });
    // …and the client is usable straight afterwards.
    expect(client.factoryTestState).toBe('idle');
    await expect(client.setInternalExpPower(0)).resolves.toBeTruthy();
  });

  it('hands back bytes glued after the TEST END banner', async () => {
    const { client } = await connected({
      framed,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(REPORT), STATUS_PUSH),
    });
    const seen: unknown[] = [];
    client.onDeviceStatus = (s) => seen.push(s);
    const text = await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false });
    expect(text).toBe(REPORT);
    await new Promise((r) => setTimeout(r, 10));
    expect(seen).toHaveLength(1);
  });
});

describe('runFactoryTest — refusals and state', () => {
  it('refuses a type the firmware would silently ignore, writing nothing', async () => {
    const { t, client } = await connected({ framed: true });
    const before = t.writes.length;
    await expect(client.runFactoryTest(4, { preflight: false })).rejects.toBeInstanceOf(RangeError);
    expect(t.writes.length).toBe(before);
  });

  it('refuses a second run while one is in flight', async () => {
    const { client } = await connected({
      framed: true,
      // Answer the ACK but stall before TEST END, so the first run stays open.
      answer: () => cat(new Uint8Array([ACK]), bytesOf(START_BANNER)),
    });
    const first = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LEDS, {
      preflight: false,
      timeoutMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(
      client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false }),
    ).rejects.toMatchObject({ reason: 'busy' });
    await expect(first).rejects.toMatchObject({ reason: 'timeout' });
    await client.whenFactoryTestIdle();
  });

  it('refuses every other command while the link is held', async () => {
    const { client } = await connected({
      framed: true,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(START_BANNER)),
    });
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LEDS, {
      preflight: false,
      timeoutMs: 1000,
    });
    await new Promise((r) => setTimeout(r, 20));
    await expect(client.setSamplingRate(51.2)).rejects.toMatchObject({
      reason: 'busy',
    });
    await expect(run).rejects.toMatchObject({ reason: 'timeout' });
    await client.whenFactoryTestIdle();
  });

  it('walks running → draining → idle when it is cancelled', async () => {
    const { client } = await connected({
      framed: true,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(START_BANNER)),
    });
    const states: string[] = [];
    client.onFactoryTestStateChange = (s) => states.push(s);
    const ctl = new AbortController();
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LED_STATES, {
      preflight: false,
      signal: ctl.signal,
      drainIdleMs: 30,
    });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    // The sensor is still printing: the link is NOT free yet.
    expect(client.factoryTestState).toBe('draining');
    await client.whenFactoryTestIdle();
    expect(client.factoryTestState).toBe('idle');
    expect(states).toEqual(['running', 'draining', 'idle']);
  });

  it('finishes a drain when the report does arrive, and frees the link', async () => {
    let notify: ((u8: Uint8Array) => void) | null = null;
    const t = new LoopbackTransport({ capabilities: { framed: true } });
    t.setOnWrite((raw) => {
      const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (cmd[0] === OPCODES.SET_FACTORY_TEST) {
        setTimeout(() => t.notify(cat(new Uint8Array([ACK]), bytesOf(START_BANNER))), 0);
        notify = (u8) => t.notify(u8);
        return;
      }
      setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    const ctl = new AbortController();
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LEDS, {
      preflight: false,
      signal: ctl.signal,
      drainIdleMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(client.factoryTestState).toBe('draining');
    notify!(bytesOf(END_BANNER));
    await client.whenFactoryTestIdle();
    expect(client.factoryTestState).toBe('idle');
    await expect(client.setInternalExpPower(1)).resolves.toBeTruthy();
  });

  it('refuses to start while streaming, before anything is written', async () => {
    const { t, client } = await connected({ framed: true });
    (client as unknown as { _streaming: boolean })._streaming = true;
    const before = t.writes.length;
    await expect(
      client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false }),
    ).rejects.toMatchObject({ reason: 'nack' });
    expect(t.writes.length).toBe(before);
  });

  it('refuses when the preflight status says the sensor is sensing', async () => {
    const t = new LoopbackTransport({ capabilities: { framed: true } });
    t.setOnWrite((raw) => {
      const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (cmd[0] === OPCODES.GET_STATUS_COMMAND) {
        // bit 1 = sensing: an SD recording somebody started with the button.
        setTimeout(
          () =>
            t.notify(
              new Uint8Array([
                ACK,
                OPCODES.INSTREAM_CMD_RESPONSE,
                OPCODES.STATUS_RESPONSE,
                0x02,
                0x00,
              ]),
            ),
          0,
        );
        return;
      }
      setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    const before = t.writes.filter((w) => w.bytes[0] === OPCODES.SET_FACTORY_TEST).length;
    await expect(client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)).rejects.toMatchObject({
      reason: 'nack',
    });
    expect(t.writes.filter((w) => w.bytes[0] === OPCODES.SET_FACTORY_TEST).length).toBe(before);
  });

  it('runs anyway when the preflight status read itself fails', async () => {
    const { client } = await connected({
      framed: true,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(REPORT)),
    });
    // A firmware that cannot answer GET_STATUS may still run the test; a
    // diagnostic must not veto the thing it was diagnosing.
    const spy = vi
      .spyOn(client, 'getStatus')
      .mockRejectedValue(new Error('no status on this build'));
    await expect(client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)).resolves.toBe(REPORT);
    spy.mockRestore();
  });

  it('fails an in-flight run when the link drops', async () => {
    const { t, client } = await connected({
      framed: true,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(START_BANNER)),
    });
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, {
      preflight: false,
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 20));
    t.emitDisconnect(new Error('gone'));
    await expect(run).rejects.toMatchObject({ reason: 'disconnected' });
    expect(client.factoryTestState).toBe('idle');
  });

  it('reports progress by chunk and by line', async () => {
    const { client } = await connected({ framed: true });
    const chunks: string[] = [];
    const lines: string[] = [];
    await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, {
      preflight: false,
      onChunk: (c) => chunks.push(c),
      onLine: (l) => lines.push(l),
    });
    expect(chunks.join('')).toBe(REPORT);
    expect(lines).toContain(' - S3R_TEST_0007 - PASS: VRef = 3301mV (3200-3400mV)');
    expect(lines.some((l) => l.includes('Overall Result = PASS'))).toBe(true);
  });

  it('gives up on its own after the timeout, then drains', async () => {
    const { client } = await connected({
      framed: true,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(START_BANNER)),
    });
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LEDS, {
      preflight: false,
      timeoutMs: 1000,
      drainIdleMs: 20,
    });
    await expect(run).rejects.toMatchObject({ reason: 'timeout' });
    await client.whenFactoryTestIdle();
    expect(client.factoryTestState).toBe('idle');
  });

  it('resolves a report that never prints TEST END once the link falls silent', async () => {
    vi.useFakeTimers();
    const { client } = await connected({
      framed: true,
      answer: () => cat(new Uint8Array([ACK]), bytesOf(START_BANNER + 'MCU:\r\n')),
    });
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, {
      preflight: false,
      completionIdleMs: 100,
      timeoutMs: 120_000,
    });
    // The floor is 10 s regardless of what was asked for: a suite between two
    // LED steps is silent for 2 s at a time and must not be cut short.
    await vi.advanceTimersByTimeAsync(9000);
    const early = vi.fn();
    void run.then(early);
    await vi.advanceTimersByTimeAsync(0);
    expect(early).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    await expect(run).resolves.toContain('MCU:');
    vi.useRealTimers();
  });
});

describe('SHIMMER3_FACTORY_TEST_TYPES', () => {
  it('matches the firmware enum, in order', () => {
    expect(SHIMMER3_FACTORY_TEST_TYPES.map((t) => [t.value, t.name])).toEqual([
      [0, 'MAIN'],
      [1, 'LEDS'],
      [2, 'ICS'],
      [3, 'LED_STATES'],
    ]);
  });

  it('marks the two suites that print no overall verdict', () => {
    const overall = Object.fromEntries(
      SHIMMER3_FACTORY_TEST_TYPES.map((t) => [t.name, t.hasOverall]),
    );
    expect(overall).toEqual({
      MAIN: true,
      LEDS: false,
      ICS: true,
      LED_STATES: false,
    });
  });

  it('allows more time than each suite is expected to need', () => {
    for (const t of SHIMMER3_FACTORY_TEST_TYPES) {
      expect(t.expectedDurationMs).toBeGreaterThan(0);
      expect(t.defaultTimeoutMs).toBeGreaterThan(t.expectedDurationMs);
    }
  });
});

describe('FactoryTestError', () => {
  it('carries a machine-readable reason', () => {
    const err = new FactoryTestError('timeout', 'nope');
    expect(err).toBeInstanceOf(Error);
    expect(err.reason).toBe('timeout');
  });
});
