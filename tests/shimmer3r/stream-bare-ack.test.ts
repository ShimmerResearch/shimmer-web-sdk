/**
 * A bare ACK or NACK that arrives while streaming.
 *
 * The firmware queues every reply into the same transmit ring as the data
 * packets, so a command sent mid-stream is answered at a packet boundary
 * (log-and-stream-common `docs/SHIMMER3_BT_COMMUNICATION_PROTOCOL.md` §6.3). A
 * SET has nothing to report, so its reply is the ACK alone, and with a link
 * CRC on, the firmware appends a CRC over that one byte (`ShimBt_sendRsp`,
 * `Comms/shimmer_bt_uart.c`): `FF F4 65`, or `FF F4` with a 1-byte CRC. A
 * refusal is `FE C5 56`, or `FE C5`.
 *
 * With a CRC on, every byte goes through the byte-stream framer, BLE included,
 * and while streaming the framer hands every byte to the schema parser. That
 * parser knew only data packets, so it threw away the packet in front of the
 * reply, then dropped the reply as junk: a command sent mid-stream failed with
 * "ACK timeout" although the device had run it. A byte stream with no CRC
 * (Web Serial) lost a bare `FF` the same way, and a NACK never reached its
 * command over any link, BLE with no CRC included.
 */
import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { versionReply } from './configFirmware.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE
const ACK_PREFIX = OPCODES.SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE;

const CHANNELS = [0x00, 0x01, 0x02, 0x0a, 0x0b, 0x0c]; // LN accel + gyro
const INQUIRY_BODY = [
  OPCODES.INQUIRY_RESPONSE,
  0x80,
  0x02, // 640 ticks -> 51.2 Hz
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  CHANNELS.length,
  1,
  ...CHANNELS,
];
const TICKS_PER_FRAME = 640;

interface Sample {
  ax: number;
  ay: number;
  az: number;
  gx: number;
  gy: number;
  gz: number;
}
const SAMPLE: Sample = { ax: 100, ay: -50, az: 16000, gx: 1, gy: -2, gz: 0 };

/** A packet as the firmware puts it on the wire: payload, then the CRC. */
function wireFrame(ts: number, mode: CrcMode, s: Sample = SAMPLE): Uint8Array {
  const i16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  return appendCrc(
    new Uint8Array([
      0x00,
      ts & 0xff,
      (ts >> 8) & 0xff,
      (ts >> 16) & 0xff,
      ...i16(s.ax),
      ...i16(s.ay),
      ...i16(s.az),
      ...i16(s.gx),
      ...i16(s.gy),
      ...i16(s.gz),
    ]),
    mode,
  );
}

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'classic SPP', framed: false },
] as const;
type Link = (typeof LINKS)[number];
const SPP = LINKS[1];

const MODES = [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const;
const label = (link: Link, mode: CrcMode): string =>
  `${link.name}, ${['no CRC', '1-byte CRC', '2-byte CRC'][mode]}`;

/**
 * Every link and CRC mode. BLE with no CRC is the one link whose bytes do not
 * pass through the byte-stream framer, and it is kept for that reason: a bare
 * ACK that a command is waiting for already worked there, and has to go on
 * working.
 */
const CASES = LINKS.flatMap((link) => MODES.map((mode) => [link, mode] as const));
/** The cases that reach the schema parser through the byte-stream framer. */
const REFRAMED = CASES.filter(([link, mode]) => !link.framed || mode !== CRC_MODE.OFF);

interface Frame {
  ts: number;
  crcOk: boolean | null;
  az: number;
  gz: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Let the client's write settle and its ACK wait arm, as a real link would. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/**
 * A Shimmer3R that is streaming, and the client talking to it.
 *
 * Every reply carries the CRC in force when it is composed, as the firmware's
 * does. A reply to a command sent mid-stream is queued, and goes out at the
 * next packet boundary when the test {@link pump}s, which is where the
 * firmware's transmit ring puts it. SET_SAMPLING_RATE is refused while
 * streaming, as `ShimBt_isCmdBlockedWhileSensing` refuses it.
 */
async function streamingDevice(link: Link, mode: CrcMode) {
  const t = new LoopbackTransport({ capabilities: { framed: link.framed } });
  const device = {
    crc: CRC_MODE.OFF as CrcMode,
    streaming: false,
    /** Replies waiting for the next packet boundary. */
    queued: [] as Uint8Array[],
    /** Opcodes this device never answers. */
    silent: new Set<number>(),
  };
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    if (device.silent.has(op)) return;
    const reply = (msg: number[]): void => {
      const packet = appendCrc(new Uint8Array(msg), device.crc);
      if (device.streaming) device.queued.push(packet);
      else setTimeout(() => tr.notify(packet), 0);
    };
    const version = versionReply(op);
    if (version) reply(version);
    else if (op === OPCODES.INQUIRY_COMMAND) reply([ACK, ...INQUIRY_BODY]);
    else if (op === ACK_PREFIX) reply([ACK]);
    else if (op === OPCODES.SET_CRC_COMMAND) {
      device.crc = bytes[1] as CrcMode;
      reply([ACK]);
    } else if (op === OPCODES.START_STREAMING_COMMAND) {
      reply([ACK]);
      device.streaming = true;
    } else if (op === OPCODES.SET_SAMPLING_RATE_COMMAND && device.streaming) {
      reply([NACK]);
    } else {
      reply([ACK]);
    }
  });

  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();
  if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);
  await client.startStreaming();

  const frames: Frame[] = [];
  client.onStreamFrame = (oc) => {
    const raw: Record<string, number> = {};
    for (const f of oc.fields) if (f.kind === 'raw') raw[f.name] = f.value;
    frames.push({ ts: raw.TIMESTAMP, crcOk: oc.crcOk, az: raw.LN_ACCEL_Z, gz: raw.GYRO_Z });
  };

  /** Timestamps of every packet sent, in order. */
  const sent: number[] = [];
  let ts = 1000;

  const deliver = (parts: Uint8Array[], chunk?: number): void => {
    if (!chunk) {
      for (const p of parts) t.notify(p);
      return;
    }
    const all = concat(parts);
    for (let at = 0; at < all.length; at += chunk) t.notify(all.slice(at, at + chunk));
  };

  return {
    client,
    t,
    device,
    frames,
    sent,
    /**
     * Send `n` packets, each behind whatever replies were queued before it.
     * One notification per message, or `chunk` bytes per notification.
     */
    pump(n: number, chunk?: number, sample: Sample = SAMPLE): void {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(...device.queued.splice(0));
        parts.push(wireFrame(ts, device.crc, sample));
        sent.push(ts);
        ts += TICKS_PER_FRAME;
      }
      deliver(parts, chunk);
    },
    /**
     * Send one packet, changed by `mutate` after its CRC was computed, as a
     * link fault changes it. Replies stay queued.
     */
    packet(mutate: (bytes: Uint8Array) => void = () => undefined): void {
      const bytes = wireFrame(ts, device.crc);
      mutate(bytes);
      t.notify(bytes);
      sent.push(ts);
      ts += TICKS_PER_FRAME;
    },
    /** Send the queued replies, with no packet behind them yet. */
    flush(): void {
      deliver(device.queued.splice(0));
    },
    /** Queue a reply that no command asked for. */
    inject(msg: number[]): void {
      device.queued.push(appendCrc(new Uint8Array(msg), device.crc));
    },
  };
}

type Session = Awaited<ReturnType<typeof streamingDevice>>;

/**
 * Every packet sent arrived, in order and intact, except the last: the parser
 * holds a packet until it sees where the next one starts.
 */
function expectEveryPacket(s: Session, mode: CrcMode, upTo = s.sent.length - 1): void {
  expect(s.frames.map((f) => f.ts)).toEqual(s.sent.slice(0, upTo));
  for (const f of s.frames) {
    expect(f.crcOk).toBe(mode === CRC_MODE.OFF ? null : true);
    // Decoded from the right bytes: a packet boundary moved by a reply byte
    // would shift every channel.
    expect(f.az).toBe(SAMPLE.az);
    expect(f.gz).toBe(SAMPLE.gz);
  }
  expect(s.client.crcFailures).toBe(0);
}

const expectingAck = (client: Shimmer3RClient): number =>
  (client as unknown as { _expectingAck: number })._expectingAck;

describe('the bare-reply CRC', () => {
  it('is F4 65 after an ACK and C5 56 after a NACK', () => {
    // The bytes the parser has to recognise between packets; computed by the
    // same function the firmware double and the verifier use.
    expect(Array.from(appendCrc(new Uint8Array([ACK]), CRC_MODE.TWO_BYTE))).toEqual([
      0xff, 0xf4, 0x65,
    ]);
    expect(Array.from(appendCrc(new Uint8Array([NACK]), CRC_MODE.TWO_BYTE))).toEqual([
      0xfe, 0xc5, 0x56,
    ]);
  });
});

describe('a bare reply between two stream packets', () => {
  for (const [link, mode] of CASES) {
    it(`keeps the packet in front of an ACK nobody is waiting for (${label(link, mode)})`, async () => {
      /* toggleLed() is one way to get here: it writes without waiting while
         streaming, and the firmware ACKs it anyway. */
      const s = await streamingDevice(link, mode);
      s.pump(3);
      s.inject([ACK]);
      s.pump(3);

      expectEveryPacket(s, mode);
    });

    it(`setRtcTime resolves on its ACK, and the packet in front of it is kept (${label(link, mode)})`, async () => {
      const s = await streamingDevice(link, mode);
      s.pump(3);
      expect(s.client.timelineState.source).toBe('host');

      const done = s.client.setRtcTime(1754820000123);
      await tick();
      expect(s.device.queued).toHaveLength(1);
      s.pump(3);

      await expect(done).resolves.toBeUndefined();
      // The write stepped the clock the samples are timed by, so the anchor
      // taken when the stream started is void. This line never ran before:
      // setRtcTime threw first.
      expect(s.client.timelineState.source).toBeNull();
      expect(expectingAck(s.client)).toBe(0);
      expectEveryPacket(s, mode);
    });

    it(`a refused command rejects with its NACK, not an ACK timeout (${label(link, mode)})`, async () => {
      // SET_SAMPLING_RATE is on the firmware's blocked-while-sensing list.
      const s = await streamingDevice(link, mode);
      s.pump(3);

      const done = s.client.setSamplingRate(102.4);
      await tick();
      s.pump(3);

      await expect(done).rejects.toThrow(/NACK/);
      expect(expectingAck(s.client)).toBe(0);
      expectEveryPacket(s, mode);
    });

    it(`takes a reply behind the first packet, before the parser has locked on (${label(link, mode)})`, async () => {
      /* No boundary is known yet, so a CRC on the reply is not enough: the
         packet after it has to be found, and its timestamp has to fit. */
      const s = await streamingDevice(link, mode);
      s.pump(1);

      const done = s.client.setRtcTime(1754820000123);
      await tick();
      s.pump(3);

      await expect(done).resolves.toBeUndefined();
      expectEveryPacket(s, mode);
    });

    it(`takes two replies at the same boundary (${label(link, mode)})`, async () => {
      // An unwaited toggleLed and a setRtcTime, answered back to back.
      const s = await streamingDevice(link, mode);
      s.pump(3);

      await s.client.toggleLed();
      const done = s.client.setRtcTime(1754820000123);
      await tick();
      expect(s.device.queued).toHaveLength(2);
      s.pump(3);

      await expect(done).resolves.toBeUndefined();
      expect(expectingAck(s.client)).toBe(0);
      expectEveryPacket(s, mode);
    });
  }

  for (const [link, mode] of REFRAMED) {
    for (const chunk of [1, 2, 5]) {
      it(`reassembles a reply split across reads, ${chunk} byte(s) at a time (${label(link, mode)})`, async () => {
        const s = await streamingDevice(link, mode);
        s.pump(3, chunk);

        const done = s.client.setRtcTime(1754820000123);
        await tick();
        s.pump(4, chunk);

        await expect(done).resolves.toBeUndefined();
        expectEveryPacket(s, mode);
      });
    }
  }

  for (const link of LINKS) {
    for (const mode of [CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const) {
      it(`takes a reply whose CRC checks out without waiting for the next packet (${label(link, mode)})`, async () => {
        /* A sampling interval can be a second long, and an ACK held until the
           next packet starts would then eat most of a command's timeout. The
           reply's own CRC already says where it ends. */
        const s = await streamingDevice(link, mode);
        s.pump(3);

        const done = s.client.setRtcTime(1754820000123);
        await tick();
        s.flush();

        await expect(done).resolves.toBeUndefined();
        // And the packet in front of it is out too, though nothing follows it.
        expectEveryPacket(s, mode, s.sent.length);
      });

      it(`keeps a corrupted packet in front of a reply, flagged as any other is (${label(link, mode)})`, async () => {
        /* The reply's own CRC places the boundary, so the packet's failed CRC
           is the packet's problem: it is delivered with crcOk false, as one
           followed by another packet is, and the reply is still taken. */
        const s = await streamingDevice(link, mode);
        s.pump(2);
        s.packet((bytes) => {
          bytes[8] ^= 0xff;
        });

        const done = s.client.setRtcTime(1754820000123);
        await tick();
        s.pump(2);

        await expect(done).resolves.toBeUndefined();
        expect(s.frames.map((f) => f.ts)).toEqual(s.sent.slice(0, -1));
        expect(s.frames.map((f) => f.crcOk)).toEqual([true, true, false, true]);
        expect(s.client.crcFailures).toBe(1);
      });
    }
  }
});

describe('bytes that only look like a reply', () => {
  it('are not taken for one inside a packet', async () => {
    /* Payload bytes spelling a bare ACK and its CRC, mid-packet. Replies are
       looked for only where a packet ends, so these decode as samples. */
    const tricky: Sample = { ...SAMPLE, ax: 0xf4ff - 0x10000, ay: 0x0065 };
    const s = await streamingDevice(SPP, CRC_MODE.TWO_BYTE);
    s.device.silent.add(OPCODES.SET_RWC_COMMAND);

    vi.useFakeTimers();
    try {
      const done = s.client.setRtcTime(1754820000123);
      const settled = expect(done).rejects.toThrow(/ACK timeout/);
      await vi.advanceTimersByTimeAsync(0);
      s.pump(6, undefined, tricky);
      await vi.advanceTimersByTimeAsync(1600);
      await settled;
    } finally {
      vi.useRealTimers();
    }
    expect(s.frames.map((f) => f.ts)).toEqual(s.sent.slice(0, -1));
    expect(s.client.crcFailures).toBe(0);
  });

  it('with no CRC, a lone FF is an ACK only if the packet after it fits the stream', async () => {
    /* Nothing on a bare FF says it is an ACK and not a slip in the stream,
       such as a byte lost from the packet in front of it, so the packet behind
       it has to carry the next timestamp. Here it does not. */
    const s = await streamingDevice(SPP, CRC_MODE.OFF);
    s.device.silent.add(OPCODES.SET_RWC_COMMAND);
    s.pump(3);

    vi.useFakeTimers();
    try {
      const done = s.client.setRtcTime(1754820000123);
      const settled = expect(done).rejects.toThrow(/ACK timeout/);
      await vi.advanceTimersByTimeAsync(0);
      s.t.notify([ACK]);
      s.t.notify(wireFrame(5_000_000, CRC_MODE.OFF));
      s.pump(3);
      await vi.advanceTimersByTimeAsync(1600);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });

  it('are not taken for one before the parser has found a packet boundary', async () => {
    /* A verified `FF F4 65` at the head of a stream the parser has not locked
       on to yet could be anything; a waiting command must not be resolved by
       it. */
    const s = await streamingDevice(SPP, CRC_MODE.TWO_BYTE);
    s.device.silent.add(OPCODES.SET_RWC_COMMAND);

    vi.useFakeTimers();
    try {
      const done = s.client.setRtcTime(1754820000123);
      const settled = expect(done).rejects.toThrow(/ACK timeout/);
      await vi.advanceTimersByTimeAsync(0);
      // Half a packet of junk with an ACK and its CRC at the end, then packets.
      s.t.notify([0x12, 0x00, 0x34, 0xff, 0xf4, 0x65]);
      s.pump(4);
      await vi.advanceTimersByTimeAsync(1600);
      await settled;
    } finally {
      vi.useRealTimers();
    }
  });
});
