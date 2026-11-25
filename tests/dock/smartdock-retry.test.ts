/**
 * A Base6 or Base15 can refuse commands at random (DEV-1550). On 24 Nov 2026 a
 * Base6 (`V,2,1,0,1,0`) answered most `SDC,NN$`, `SDP,NN$` and `SDD$` with an
 * `E` within 20 ms, and others not at all, through a power cycle. Sent again
 * every 2 s, each got through within 6 tries. Its firmware keeps only the last
 * UART byte received, so a byte that arrives while its main loop is busy is
 * lost (smartdock-firmware `CBase6/main.c` at 66532f8).
 *
 * So SmartDockClient sends a command up to 15 tries, 2 s after each try that
 * fails: the same Base6 later refused one select 8 times in a row, so 8 was
 * not enough. A try fails on an `E`, on no answer in time, or, for a slot change, on
 * an answer naming another slot (a slot, for `SDD$`), which may be a late
 * answer to an earlier command. An answer for what was asked that arrives
 * between tries is still taken. The call ends with one result.
 *
 * The base here answers each command at once, from a script; times are the
 * client's defaults (1 s for a query, 10 s for a slot change, 2 s between
 * tries, 1.5 s to settle), on fake timers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SmartDockClient } from '../../src/devices/dock/SmartDockClient.js';
import { SMARTDOCK_DEFAULTS } from '../../src/devices/dock/smartDockProtocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u8: Uint8Array): string => new TextDecoder().decode(u8);

const TRIES = SMARTDOCK_DEFAULTS.CMD_RETRY_ATTEMPTS;
const RETRY_MS = SMARTDOCK_DEFAULTS.CMD_RETRY_INTERVAL_MS;
const QUERY_MS = SMARTDOCK_DEFAULTS.RESPONSE_TIMEOUT_MS;
const SLOT_CHANGE_MS = SMARTDOCK_DEFAULTS.SLOT_CHANGE_TIMEOUT_MS;
const SETTLE_MS = SMARTDOCK_DEFAULTS.SLOT_CHANGEOVER_DELAY_MS;

/** A Base6 that answers each command at once, unless told otherwise for its next tries. */
class Base6 {
  readonly transport = new LoopbackTransport({ capabilities: { framed: false } });
  private readonly overrides: { prefix: string; left: number; answer: string }[] = [];

  constructor() {
    this.transport.setOnWrite((bytes, tr) => {
      const answer = this.answerTo(dec(bytes));
      // On a microtask, so at the same fake instant: a fake setTimeout(0)
      // would move the clock a millisecond per answer.
      if (answer) void Promise.resolve().then(() => tr.notify(enc(answer)));
    });
  }

  /** The next `tries` commands starting `prefix` are answered `answer`; '' for none. */
  then(prefix: string, tries: number, answer: string): this {
    this.overrides.push({ prefix, left: tries, answer });
    return this;
  }

  /** Every command starting `prefix` is answered `answer`; '' for none. */
  always(prefix: string, answer: string): this {
    return this.then(prefix, Number.POSITIVE_INFINITY, answer);
  }

  /** A line from the base, unasked. */
  says(line: string): void {
    this.transport.notify(enc(`${line}\r\n`));
  }

  /** The commands written, in order. */
  get sent(): string[] {
    return this.transport.writes.map((w) => dec(w.bytes));
  }

  sentCount(cmd: string): number {
    return this.sent.filter((c) => c === cmd).length;
  }

  private answerTo(cmd: string): string {
    const o = this.overrides.find((x) => cmd.startsWith(x.prefix) && x.left > 0);
    if (o) {
      o.left -= 1;
      return o.answer;
    }
    if (cmd === 'SDV$') return 'V,2,1,0,1,0\r\n';
    if (cmd === 'SDQ$') return 'Q,110100\r\n';
    if (cmd.startsWith('SDP,')) return `P,${cmd.slice(4, 6)}\r\n`;
    if (cmd.startsWith('SDC,')) return `C,${cmd.slice(4, 6)}\r\n`;
    if (cmd === 'SDD$') return 'D\r\n';
    return '';
  }
}

interface Rig {
  base: Base6;
  dock: SmartDockClient;
  status: string[];
}

async function rig(base = new Base6()): Promise<Rig> {
  const dock = new SmartDockClient({ debug: false, transport: base.transport });
  const status: string[] = [];
  dock.onStatus = (msg) => status.push(msg);
  await dock.connect();
  return { base, dock, status };
}

/** The statuses of tries that failed and were sent again, in order. */
const triesFailed = (status: string[]): string[] =>
  status.filter((s) => s.includes('; sending again in '));

/** Run `call` to its end on fake timers: its result, and the time it took. */
async function run<T>(
  call: () => Promise<T>,
): Promise<{ ok: boolean; value?: T; error?: Error; ms: number }> {
  const from = Date.now();
  const outcome = call().then(
    (value) => ({ ok: true, value }),
    (error: Error) => ({ ok: false, error }),
  );
  await vi.runAllTimersAsync();
  return { ...(await outcome), ms: Date.now() - from };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a command refused, then taken', () => {
  it('is sent every 2 s until it is', async () => {
    // The bench Base6: a slot change refused five times and taken on the sixth.
    const { base, dock, status } = await rig(new Base6().then('SDP,', 5, 'E\r\n'));
    const r = await run(() => dock.selectSlot(2));
    expect(r.ok).toBe(true);
    expect(base.sent).toEqual(Array(6).fill('SDP,02$'));
    expect(r.ms).toBe(5 * RETRY_MS + SETTLE_MS);
    expect(triesFailed(status)).toEqual(
      [1, 2, 3, 4, 5].map(
        (n) =>
          `SmartDock error response (select slot 2): refused (E), try ${n} of 15; ` +
          'sending again in 2000 ms',
      ),
    );
    expect(dock.activeSlot).toBe(2);
  });

  it('applies to a query and to SDD$ too', async () => {
    const { base, dock } = await rig(
      new Base6().then('SDQ$', 1, 'E\r\n').then('SDV$', 3, 'E\r\n').then('SDD$', 2, 'E\r\n'),
    );
    const occupancy = await run(() => dock.getSlotOccupancy());
    expect(occupancy.value?.filter((s) => s.occupied).map((s) => s.slot)).toEqual([1, 2, 4]);
    expect(base.sentCount('SDQ$')).toBe(2);

    const info = await run(() => dock.getDockInfo());
    expect(info.value?.hardwareType).toBe('base6');
    expect(base.sentCount('SDV$')).toBe(4);
    expect(info.ms).toBe(3 * RETRY_MS);

    const released = await run(() => dock.disconnectAllSlots());
    expect(released.ok).toBe(true);
    expect(base.sentCount('SDD$')).toBe(3);
    expect(dock.activeSlot).toBe(-1);
  });
});

describe('a command unanswered, then answered', () => {
  it('is sent again 2 s after each timeout, and the next answer completes it', async () => {
    const { base, dock, status } = await rig(new Base6().then('SDQ$', 2, ''));
    const r = await run(() => dock.getSlotOccupancy());
    expect(r.ok).toBe(true);
    expect(base.sentCount('SDQ$')).toBe(3);
    expect(r.ms).toBe(2 * (QUERY_MS + RETRY_MS));
    expect(triesFailed(status)).toEqual([
      'SmartDock response timeout (SDQ$): no answer within 1000 ms, try 1 of 15; sending again in 2000 ms',
      'SmartDock response timeout (SDQ$): no answer within 1000 ms, try 2 of 15; sending again in 2000 ms',
    ]);
  });

  it('waits a slot change’s 10 s on each try', async () => {
    const { base, dock } = await rig(new Base6().then('SDP,', 1, ''));
    const r = await run(() => dock.selectSlot(3));
    expect(r.ok).toBe(true);
    expect(base.sentCount('SDP,03$')).toBe(2);
    expect(r.ms).toBe(SLOT_CHANGE_MS + RETRY_MS + SETTLE_MS);
    expect(dock.activeSlot).toBe(3);
  });

  it('takes its answer late, between the tries, and does not send it again', async () => {
    const { base, dock } = await rig(new Base6().then('SDP,', 1, ''));
    const from = Date.now();
    const select = dock.selectSlot(2);
    await vi.advanceTimersByTimeAsync(SLOT_CHANGE_MS); // the first try times out
    await vi.advanceTimersByTimeAsync(600); // waiting to send again
    base.says('P,02');
    await vi.runAllTimersAsync();
    await expect(select).resolves.toBeUndefined();
    expect(base.sentCount('SDP,02$')).toBe(1);
    expect(Date.now() - from).toBe(SLOT_CHANGE_MS + 600 + SETTLE_MS);
    expect(dock.activeSlot).toBe(2);
  });
});

describe('a command refused on every try', () => {
  it('ends refused once, after the last of 15 tries', async () => {
    const { base, dock, status } = await rig(new Base6().always('SDQ$', 'E\r\n'));
    const r = await run(() => dock.getSlotOccupancy());
    expect(r.ok).toBe(false);
    expect(r.error?.message).toBe('SmartDock error response (SDQ$): refused (E), try 15 of 15');
    expect(base.sent).toEqual(Array(15).fill('SDQ$'));
    expect(r.ms).toBe(28_000); // 14 waits of 2 s
    expect(triesFailed(status)).toHaveLength(14);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves the active slot alone for a slot change, and keeps the link', async () => {
    const base = new Base6().then('SDP,', TRIES, 'E\r\n');
    const { dock } = await rig(base);
    const r = await run(() => dock.selectSlot(2));
    expect(r.error?.message).toMatch(/refused \(E\), try 15 of 15/);
    expect(base.sentCount('SDP,02$')).toBe(TRIES);
    expect(dock.activeSlot).toBe(-1);

    // The link is kept: the next command goes through.
    const next = await run(() => dock.getSlotOccupancy());
    expect(next.ok).toBe(true);
  });

  it('ends unanswered after 43 s for a query', async () => {
    const { base, dock } = await rig(new Base6().always('SDV$', ''));
    const r = await run(() => dock.getDockInfo());
    expect(r.error?.message).toBe(
      'SmartDock response timeout (SDV$): no answer within 1000 ms, try 15 of 15',
    );
    expect(base.sentCount('SDV$')).toBe(TRIES);
    expect(r.ms).toBe(43_000);
    expect(r.ms).toBe(TRIES * QUERY_MS + (TRIES - 1) * RETRY_MS);
  });

  it('ends unanswered after 178 s for a slot change', async () => {
    const { base, dock } = await rig(new Base6().always('SDP,', ''));
    const r = await run(() => dock.selectSlot(2));
    expect(r.error?.message).toBe(
      'SmartDock response timeout (select slot 2): no answer within 10000 ms, try 15 of 15',
    );
    expect(base.sentCount('SDP,02$')).toBe(TRIES);
    expect(r.ms).toBe(178_000);
    expect(r.ms).toBe(TRIES * SLOT_CHANGE_MS + (TRIES - 1) * RETRY_MS);
    expect(dock.activeSlot).toBe(-1);
  });
});

describe('an answer for another slot', () => {
  it('is not taken: it fails the try in flight, and the answer asked for is', async () => {
    // Slot 1 is selected. Its answer to an earlier try comes late, once slot 2
    // is asked for. It is not slot 2's, so it fails that try; slot 2's own
    // answer, before the next try is sent, is taken.
    const base = new Base6();
    const { dock, status } = await rig(base);
    await run(() => dock.selectSlot(1));
    expect(dock.activeSlot).toBe(1);

    base.then('SDP,02', 1, '');
    const from = Date.now();
    const select = dock.selectSlot(2);
    await vi.advanceTimersByTimeAsync(5);
    base.says('P,01');
    expect(triesFailed(status)).toEqual([
      'SmartDock select slot 2 failed: the base routes slot 1 ("P,01"), try 1 of 15 ' +
        '(DOCK_CMD_ERR_FAIL_SET); sending again in 2000 ms',
    ]);
    expect(dock.activeSlot).toBe(1); // unchanged
    await vi.advanceTimersByTimeAsync(1465);
    base.says('P,02');
    await vi.runAllTimersAsync();
    await expect(select).resolves.toBeUndefined();
    expect(Date.now() - from).toBe(1470 + SETTLE_MS);
    expect(base.sentCount('SDP,02$')).toBe(1); // not sent again
    expect(dock.activeSlot).toBe(2);
  });

  it('between tries, like an E, is dropped and changes nothing', async () => {
    const base = new Base6();
    const { dock } = await rig(base);
    await run(() => dock.selectSlot(2));

    base.then('SDP,04', 1, 'E\r\n');
    const select = dock.selectSlot(4);
    await vi.advanceTimersByTimeAsync(100); // refused; waiting to send again
    expect(base.sentCount('SDP,04$')).toBe(1);
    for (const stray of ['P,03', 'C,02', 'D', 'E']) base.says(stray);
    expect(dock.activeSlot).toBe(2);
    // The strays did not move the next try: it goes 2 s after the refusal.
    await vi.advanceTimersByTimeAsync(RETRY_MS - 100 - 1);
    expect(base.sentCount('SDP,04$')).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(base.sentCount('SDP,04$')).toBe(2);
    await vi.runAllTimersAsync();
    await expect(select).resolves.toBeUndefined();
    expect(base.sentCount('SDP,04$')).toBe(2);
    expect(dock.activeSlot).toBe(4);
  });

  it('on every try fails the call after the last, which is taken as what the base routes', async () => {
    for (const [answer, routed] of [
      ['P,09', 9],
      ['C,09', 9],
      ['D', -1],
    ] as const) {
      const base = new Base6();
      const { dock } = await rig(base);
      base.always('SDP,04', `${answer}\r\n`);
      const r = await run(() => dock.selectSlot(4));
      expect(r.error?.message).toMatch(/the base routes .*try 15 of 15 \(DOCK_CMD_ERR_FAIL_SET\)/);
      expect(base.sentCount('SDP,04$')).toBe(TRIES);
      expect(r.ms).toBe(14 * RETRY_MS);
      expect(dock.activeSlot).toBe(routed);
    }
  });

  it('for SDD$, a slot is another slot', async () => {
    const base = new Base6();
    const { dock } = await rig(base);
    await run(() => dock.selectSlot(3));
    base.then('SDD$', 2, 'P,03\r\n');
    const r = await run(() => dock.disconnectAllSlots());
    expect(r.ok).toBe(true);
    expect(base.sentCount('SDD$')).toBe(3);
    expect(dock.activeSlot).toBe(-1);

    base.always('SDD$', 'P,03\r\n');
    const stuck = await run(() => dock.disconnectAllSlots());
    expect(stuck.error?.message).toBe(
      'SmartDock SDD$ failed: the base routes slot 3 ("P,03"), try 15 of 15 (DOCK_CMD_ERR_FAIL_SET)',
    );
    expect(dock.activeSlot).toBe(3);
  });

  it('of a malformed kind ends the call at once', async () => {
    const base = new Base6().then('SDP,', 1, 'P,x4\r\n');
    const { dock } = await rig(base);
    const r = await run(() => dock.selectSlot(4));
    expect(r.error?.message).toMatch(/slot select failed: requested 4, got "P,x4"/);
    expect(base.sentCount('SDP,04$')).toBe(1);
  });
});

describe('the disconnect', () => {
  it('ends a command waiting to be sent again, and the call behind it, sending nothing', async () => {
    const base = new Base6().then('SDQ$', 1, 'E\r\n');
    const { dock } = await rig(base);
    const occupancy = dock.getSlotOccupancy().then(
      () => null,
      (e: Error) => e,
    );
    const info = dock.getDockInfo().then(
      () => null,
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(100); // refused; waiting to send again
    expect(base.sent).toEqual(['SDQ$']); // the second waits its turn
    await vi.advanceTimersByTimeAsync(400);
    base.transport.emitDisconnect();
    expect((await occupancy)?.message).toBe(
      'SmartDock command "SDQ$" not finished: the link was lost',
    );
    expect((await info)?.message).toBe('SmartDock link lost (SDV$): not sent');
    await vi.runAllTimersAsync();
    expect(base.sent).toEqual(['SDQ$']); // nothing sent again
    expect(vi.getTimerCount()).toBe(0);
  });

  it('by the host ends a command waiting to be sent again', async () => {
    const base = new Base6().then('SDP,', 1, 'E\r\n');
    const { dock } = await rig(base);
    const select = dock.selectSlot(5).then(
      () => null,
      (e: Error) => e,
    );
    await vi.advanceTimersByTimeAsync(100);
    await dock.disconnect();
    expect((await select)?.message).toBe(
      'SmartDock command "select slot 5" not finished: disconnected',
    );
    await vi.runAllTimersAsync();
    expect(base.sent).toEqual(['SDP,05$']);
  });

  it('is forgotten on the next connect', async () => {
    const base = new Base6();
    const { dock } = await rig(base);
    base.transport.emitDisconnect();
    await expect(dock.getSlotOccupancy()).rejects.toThrow(/link lost/);
    await dock.connect();
    const r = await run(() => dock.getSlotOccupancy());
    expect(r.ok).toBe(true);
  });
});
