/**
 * `WiredShimmerClient.runFactoryTest` — the same report over the dock UART,
 * where the ACK is a CRC-checked packet rather than a single byte and the
 * report text follows it on the same byte stream.
 */
import { describe, it, expect } from 'vitest';
import { WiredShimmerClient } from '../../src/devices/dock/WiredShimmerClient.js';
import {
  UART_PACKET_CMD,
  UART_PACKET_HEADER,
  UART_COMPONENT,
} from '../../src/devices/dock/constants.js';
import {
  buildUartPacket,
  classifyFactoryTestAckPacket,
  parseUartPacket,
} from '../../src/devices/dock/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { SHIMMER3_FACTORY_TEST_TYPE } from '../../src/devices/shimmer3r/factoryTest.js';

const START_BANNER =
  '//**************************** TEST START ' + '************************************//\r\n';
const END_BANNER =
  '//***************************** TEST END ' + '*************************************//\r\n';
const REPORT =
  START_BANNER +
  'Firmware version: v1.01.012\r\n' +
  'SPI:\r\n' +
  '- FAIL: ADS1292R test will not work from dock\r\n' +
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

const ackPacket = () => buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE);
const badCmdPacket = () => buildUartPacket(UART_PACKET_CMD.BAD_CMD_RESPONSE);

async function connected(opts: {
  answer?: (cmd: Uint8Array) => Uint8Array | null;
  dribble?: number;
}) {
  const t = new LoopbackTransport();
  const send = (u8: Uint8Array) => {
    const n = opts.dribble ?? 0;
    if (!n) {
      t.notify(u8);
      return;
    }
    for (let off = 0; off < u8.length; off += n) t.notify(u8.slice(off, off + n));
  };
  t.setOnWrite((raw) => {
    const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    // A WRITE to the TEST component is the factory-test request.
    if (
      cmd[0] === UART_PACKET_HEADER &&
      cmd[1] === UART_PACKET_CMD.WRITE &&
      cmd[3] === UART_COMPONENT.TEST
    ) {
      const answer = opts.answer ? opts.answer(cmd) : cat(ackPacket(), bytesOf(REPORT));
      if (answer) setTimeout(() => send(answer), 0);
      return;
    }
    setTimeout(() => t.notify(ackPacket()), 0);
  });
  const client = new WiredShimmerClient();
  await client.connect(t);
  return { t, client };
}

describe('WiredShimmerClient.runFactoryTest', () => {
  it('asks the TEST component for the chosen type, with a valid CRC and no payload', async () => {
    const { t, client } = await connected({});
    await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.ICS);
    const req = t.writes
      .map((w) => w.bytes)
      .find((b) => b[0] === UART_PACKET_HEADER && b[1] === UART_PACKET_CMD.WRITE)!;
    const parsed = parseUartPacket(req);
    expect(parsed.crcOk).toBe(true);
    expect(parsed.component).toBe(UART_COMPONENT.TEST);
    expect(parsed.property).toBe(SHIMMER3_FACTORY_TEST_TYPE.ICS);
    expect(Array.from(parsed.payload)).toEqual([]);
  });

  it('returns the report that follows the ACK packet', async () => {
    const { client } = await connected({});
    await expect(client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)).resolves.toBe(REPORT);
    expect(client.factoryTestState).toBe('idle');
  });

  it('accepts the ACK packet and the report in one read', async () => {
    const { client } = await connected({
      answer: () => cat(ackPacket(), bytesOf(REPORT)),
    });
    await expect(client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)).resolves.toBe(REPORT);
  });

  it('reassembles an ACK packet delivered a byte at a time', async () => {
    const { client } = await connected({ dribble: 1 });
    await expect(client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)).resolves.toBe(REPORT);
  });

  it('reports BAD_CMD as a refusal', async () => {
    const { client } = await connected({ answer: () => badCmdPacket() });
    await expect(client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)).rejects.toMatchObject({
      reason: 'nack',
    });
    expect(client.factoryTestState).toBe('idle');
  });

  it('refuses a type the firmware would answer BAD_CMD for, writing nothing', async () => {
    const { t, client } = await connected({});
    const before = t.writes.length;
    await expect(client.runFactoryTest(9)).rejects.toBeInstanceOf(RangeError);
    expect(t.writes.length).toBe(before);
  });

  it('holds the command queue: a command issued mid-test lands after the report', async () => {
    const order: string[] = [];
    const { client } = await connected({
      answer: () => cat(ackPacket(), bytesOf(REPORT)),
    });
    const run = client
      .runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN)
      .then(() => order.push('report'));
    const other = client
      .setConfig(
        { component: 0x02, property: 0x00, permission: 'READ_WRITE', name: 'ENABLE' },
        new Uint8Array([1]),
      )
      .then(() => order.push('command'));
    await Promise.all([run, other]);
    expect(order).toEqual(['report', 'command']);
  });

  it('keeps the packet parser away from the report text', async () => {
    const { client } = await connected({});
    await client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN);
    // The link still works: nothing of the report was left in the accumulator.
    await expect(
      client.setConfig(
        { component: 0x02, property: 0x00, permission: 'READ_WRITE', name: 'ENABLE' },
        new Uint8Array([1]),
      ),
    ).resolves.toBeUndefined();
  });

  it('holds the queue through the drain, so a cancelled run cannot strand the next command', async () => {
    /* The caller's rejection and the link being free are different moments.
       A command that started in between would have its response swallowed as
       report text and hang until its own timeout. */
    const { t, client } = await connected({
      answer: () => cat(ackPacket(), bytesOf(START_BANNER)),
    });
    const ctl = new AbortController();
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.LEDS, {
      signal: ctl.signal,
      drainIdleMs: 300,
    });
    await new Promise((r) => setTimeout(r, 20));
    ctl.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    // The caller knows at once; the sensor does not.
    expect(client.factoryTestState).toBe('draining');

    let ran = false;
    const next = client
      .setConfig(
        { component: 0x02, property: 0x00, permission: 'READ_WRITE', name: 'ENABLE' },
        new Uint8Array([1]),
      )
      .then(() => {
        ran = true;
      });
    await new Promise((r) => setTimeout(r, 50));
    // Still queued: the link is not free, so it has not been sent.
    expect(ran).toBe(false);
    expect(t.writes.some((w) => w.bytes[1] === UART_PACKET_CMD.WRITE && w.bytes[3] === 0x02)).toBe(
      false,
    );

    await client.whenFactoryTestIdle();
    await next;
    expect(ran).toBe(true);
  });

  it('fails an in-flight run when the dock link drops', async () => {
    const { t, client } = await connected({
      answer: () => cat(ackPacket(), bytesOf(START_BANNER)),
    });
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, {
      timeoutMs: 5000,
    });
    await new Promise((r) => setTimeout(r, 20));
    t.emitDisconnect(new Error('unplugged'));
    await expect(run).rejects.toMatchObject({ reason: 'disconnected' });
    expect(client.factoryTestState).toBe('idle');
  });
});

describe('classifyFactoryTestAckPacket', () => {
  it('waits for a packet it cannot size yet', () => {
    expect(classifyFactoryTestAckPacket(new Uint8Array(0))).toEqual({
      kind: 'need-more',
    });
    expect(classifyFactoryTestAckPacket(new Uint8Array([UART_PACKET_HEADER]))).toEqual({
      kind: 'need-more',
    });
    expect(classifyFactoryTestAckPacket(ackPacket().subarray(0, 3))).toEqual({ kind: 'need-more' });
  });

  it('reads an ACK packet as the acknowledgement', () => {
    expect(classifyFactoryTestAckPacket(ackPacket())).toEqual({
      kind: 'ack',
      consumed: ackPacket().length,
    });
  });

  it('reads a BAD_* packet as a refusal, with the reason', () => {
    const v = classifyFactoryTestAckPacket(badCmdPacket());
    expect(v.kind).toBe('nack');
    expect((v as { detail: string }).detail).toMatch(/./);
  });

  it('treats anything that is not a packet header as report text', () => {
    expect(classifyFactoryTestAckPacket(bytesOf('//*** TEST'))).toEqual({
      kind: 'text',
    });
  });

  it('resyncs past a header with an unknown command byte', () => {
    /* Line noise, not the start of a report: dropping a byte keeps the search
       for the acknowledgement alive, where calling it text would fold the real
       ACK packet into the report. */
    expect(
      classifyFactoryTestAckPacket(new Uint8Array([UART_PACKET_HEADER, 0x55, 0x00, 0x00])),
    ).toEqual({ kind: 'ignore', consumed: 1 });
  });

  it('finds the acknowledgement behind a repeated header byte', () => {
    /* `$` is not a command byte, so the head is unsizeable — resyncing past it
       reaches the real packet, where calling it text would have swallowed it. */
    const noisy = new Uint8Array([UART_PACKET_HEADER, ...ackPacket()]);
    let at = 0;
    let verdict = classifyFactoryTestAckPacket(noisy.subarray(at));
    while (verdict.kind === 'ignore') {
      at += verdict.consumed;
      verdict = classifyFactoryTestAckPacket(noisy.subarray(at));
    }
    expect(verdict).toEqual({ kind: 'ack', consumed: ackPacket().length });
  });

  it('skips one byte of a CRC-corrupt packet rather than calling it text', () => {
    /* The report has not started yet; one bad byte must not turn the rest of a
       legitimate packet into report content. */
    const bad = ackPacket();
    bad[bad.length - 1] ^= 0xff;
    expect(classifyFactoryTestAckPacket(bad)).toEqual({
      kind: 'ignore',
      consumed: 1,
    });
  });
});
