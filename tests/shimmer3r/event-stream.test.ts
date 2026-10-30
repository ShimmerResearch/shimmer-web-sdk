/**
 * The event channel over Bluetooth (DEV-971): opting in, the status command,
 * and record frames arriving idle or between stream data packets.
 *
 * A frame is `[0x8A][0xBB][0x10][record][CRC-16 LE]` with a CRC of its own and
 * no link CRC on top, sent from the same transmit ring as the data packets
 * (log-and-stream-common `docs/SHIMMER3_BT_COMMUNICATION_PROTOCOL.md` §7.15).
 * Mid-stream it lands at a packet boundary, where a parser that knew only data
 * packets and bare replies would have slid over it a byte at a time, losing the
 * record and the packet in front of it.
 */
import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { BT_FEATURE, OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { versionReply } from './configFirmware.js';
import type { EventRecord } from '../../src/devices/events/record.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const NACK = OPCODES.NACK_COMMAND_PROCESSED;
const CHANNELS = [0x00, 0x01, 0x02]; // LN accel
const INQUIRY_BODY = [OPCODES.INQUIRY_RESPONSE, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, ...CHANNELS];
const TICKS_PER_FRAME = 640;

/** A packet as the firmware puts it on the wire: payload, then the link CRC. */
function wireFrame(ts: number, mode: CrcMode): Uint8Array {
  return appendCrc(
    new Uint8Array([0x00, ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, 1, 0, 2, 0, 3, 0]),
    mode,
  );
}

/** An event frame: a button edge at `ticks`, link sequence `seq`. Its own CRC, never the link's. */
function eventFrame(seq: number, ticks: number, down: boolean): Uint8Array {
  const rec = [0x01, 0x00, seq & 0xff, seq >> 8];
  let t = BigInt(ticks);
  for (let i = 0; i < 8; i++) {
    rec.push(Number(t & 0xffn));
    t >>= 8n;
  }
  rec.push(0x00, down ? 0x01 : 0x00, 0, 0);
  return appendCrc(
    new Uint8Array([0x8a, OPCODES.EVENT_RECORD_RESPONSE, 0x10, ...rec]),
    CRC_MODE.TWO_BYTE,
  );
}

const concat = (parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'classic SPP', framed: false },
] as const;
const MODES = [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const;
const CASES = LINKS.flatMap((link) => MODES.map((mode) => [link, mode] as const));
const label = (link: (typeof LINKS)[number], mode: CrcMode): string =>
  `${link.name}, ${['no CRC', '1-byte CRC', '2-byte CRC'][mode]}`;

/** A Shimmer3R with the event channel, or without it (`hasEventChannel: false`). */
async function device(
  link: (typeof LINKS)[number],
  mode: CrcMode,
  opts: { hasEventChannel?: boolean; streaming?: boolean } = {},
) {
  const t = new LoopbackTransport({ capabilities: { framed: link.framed } });
  const dev = {
    crc: CRC_MODE.OFF as CrcMode,
    streaming: false,
    optedIn: false,
    queued: [] as Uint8Array[],
  };
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    const reply = (msg: number[]): void => {
      const packet = appendCrc(new Uint8Array(msg), dev.crc);
      if (dev.streaming) dev.queued.push(packet);
      else setTimeout(() => tr.notify(packet), 0);
    };
    const version = versionReply(op);
    if (version) reply(version);
    else if (op === OPCODES.INQUIRY_COMMAND) reply([ACK, ...INQUIRY_BODY]);
    else if (op === OPCODES.SET_CRC_COMMAND) {
      dev.crc = bytes[1] as CrcMode;
      reply([ACK]);
    } else if (op === OPCODES.START_STREAMING_COMMAND) {
      reply([ACK]);
      dev.streaming = true;
    } else if (op === OPCODES.SET_FEATURE && bytes[1] === BT_FEATURE.EVENT_STREAM) {
      if (opts.hasEventChannel === false) reply([NACK]);
      else {
        dev.optedIn = bytes[2] !== 0;
        reply([ACK]);
      }
    } else if (op === OPCODES.GET_EVENT_CHANNEL_STATUS_COMMAND) {
      if (opts.hasEventChannel !== false) {
        reply([
          ACK,
          OPCODES.EVENT_CHANNEL_STATUS_RESPONSE,
          0x03,
          dev.optedIn ? 0x09 : 0x08,
          0x01,
          4,
          0,
          0,
          0,
          2,
          0,
        ]);
      }
    } else reply([ACK]);
  });

  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();
  if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);

  const records: EventRecord[] = [];
  client.onEventRecord = (r) => records.push(r);
  const frames: number[] = [];
  client.onStreamFrame = (oc) => {
    for (const f of oc.fields) if (f.kind === 'raw' && f.name === 'TIMESTAMP') frames.push(f.value);
  };
  if (opts.streaming) await client.startStreaming();

  let ts = 1000;
  const sent: number[] = [];
  return {
    client,
    t,
    dev,
    records,
    frames,
    sent,
    /** Send `n` packets, the queued replies and `between` in front of each. */
    pump(n: number, between: Uint8Array[] = [], chunk?: number): void {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(...dev.queued.splice(0));
        if (i > 0) parts.push(...between);
        parts.push(wireFrame(ts, dev.crc));
        sent.push(ts);
        ts += TICKS_PER_FRAME;
      }
      const all = concat(parts);
      if (!chunk) for (const p of parts) t.notify(p);
      else for (let at = 0; at < all.length; at += chunk) t.notify(all.slice(at, at + chunk));
    },
  };
}

describe('setEventStream / supportsEventChannel', () => {
  for (const link of LINKS) {
    it(`resolves true when the firmware ACKs feature 3 (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF);
      await expect(s.client.setEventStream(true)).resolves.toBe(true);
      expect(s.dev.optedIn).toBe(true);
      await expect(s.client.supportsEventChannel()).resolves.toBe(true);
      expect(s.dev.optedIn).toBe(false); // the probe opts out
    });

    it(`resolves false when the firmware NACKs it (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.OFF, { hasEventChannel: false });
      await expect(s.client.supportsEventChannel()).resolves.toBe(false);
    });
  }
});

describe('getEventChannelStatus', () => {
  for (const [link, mode] of CASES) {
    it(`decodes the 9-byte reply (${label(link, mode)})`, async () => {
      const s = await device(link, mode);
      await s.client.setEventStream(true);
      const st = await s.client.getEventChannelStatus();
      expect(st).toMatchObject({
        inputsEnabled: 3,
        streaming: true,
        ttlArmed: true,
        nextSeq: 4,
        linkLost: 2,
      });
    });
  }
});

describe('event frames while idle', () => {
  for (const link of LINKS) {
    it(`are delivered one by one and several to a notification (${link.name})`, async () => {
      const s = await device(link, CRC_MODE.TWO_BYTE);
      s.t.notify(eventFrame(0, 5000, false));
      s.t.notify(concat([eventFrame(1, 6000, true), eventFrame(2, 7000, false)]));
      await tick();
      expect(s.records.map((r) => [r.seq, r.ticks, r.buttonDown])).toEqual([
        [0, 5000n, false],
        [1, 6000n, true],
        [2, 7000n, false],
      ]);
    });
  }

  it('drops a frame whose CRC fails', async () => {
    const s = await device(LINKS[0], CRC_MODE.OFF);
    const bad = eventFrame(0, 5000, true);
    bad[8] ^= 0x40;
    s.t.notify(bad);
    await tick();
    expect(s.records).toHaveLength(0);
  });

  it('is not taken for the opt-in reply when it follows the ACK in one read (classic SPP)', async () => {
    const s = await device(LINKS[1], CRC_MODE.OFF);
    // The firmware answers the opt-in, then sends the initial state at once.
    s.t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_FEATURE) {
        setTimeout(() => tr.notify(concat([new Uint8Array([ACK]), eventFrame(0, 9000, false)])), 0);
      }
    });
    await expect(s.client.setEventStream(true)).resolves.toBe(true);
    await tick();
    expect(s.records.map((r) => r.ticks)).toEqual([9000n]);
  });
});

describe('event frames between stream packets', () => {
  for (const [link, mode] of CASES) {
    it(`are delivered, and every packet kept (${label(link, mode)})`, async () => {
      const s = await device(link, mode, { streaming: true });
      s.pump(3);
      s.pump(4, [eventFrame(7, 1234, true)]);
      s.pump(2);
      expect(s.records.map((r) => r.seq)).toEqual([7, 7, 7]);
      // Every packet but the last, which waits for the next to show where it ends
      expect(s.frames).toEqual(s.sent.slice(0, s.sent.length - 1));
      expect(s.client.crcFailures).toBe(0);
    });

    it(`survive arriving a few bytes at a time (${label(link, mode)})`, async () => {
      const s = await device(link, mode, { streaming: true });
      s.pump(3);
      s.pump(3, [eventFrame(1, 100, true), eventFrame(2, 200, false)], 5);
      s.pump(2);
      expect(s.records.map((r) => r.seq)).toEqual([1, 2, 1, 2]);
      expect(s.frames).toEqual(s.sent.slice(0, s.sent.length - 1));
    });
  }
});
