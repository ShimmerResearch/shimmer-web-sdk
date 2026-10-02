import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { CRC_MODE, appendCrc } from '../../src/devices/shimmer3r/crcMode.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

describe('Shimmer3RClient.runDataRateTest', () => {
  it('counts blasted bytes and stops the test afterwards', async () => {
    const t = new LoopbackTransport();
    let blast: ReturnType<typeof setInterval> | null = null;
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1) {
        setTimeout(() => tr.notify([ACK]), 0);
        let counterVal = 0;
        blast = setInterval(() => {
          // 20 x 5-byte [0xA5][u32 counter] packets per tick
          const chunk = new Uint8Array(100);
          for (let i = 0; i < 20; i++) {
            chunk[i * 5] = OPCODES.DATA_RATE_TEST_RESPONSE;
            new DataView(chunk.buffer).setUint32(i * 5 + 1, counterVal++, true);
          }
          tr.notify(chunk);
        }, 5);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 0) {
        if (blast) clearInterval(blast);
        blast = null;
        setTimeout(() => tr.notify([ACK]), 0);
      } else {
        setTimeout(() => tr.notify([ACK]), 0);
      }
    });

    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const progress: number[] = [];
    const res = await client.runDataRateTest(300, (b) => progress.push(b));
    expect(blast).toBeNull(); // stop command reached the "firmware"
    expect(res.bytesReceived).toBeGreaterThan(1000);
    expect(res.kBps).toBeGreaterThan(0);
    expect(res.durationMs).toBeGreaterThanOrEqual(300);
    expect(progress.length).toBeGreaterThan(0);
  });

  it('still measures the rate with a link CRC on (regression)', async () => {
    /* The data-rate test builds its own [0xA5][counter] batch and calls
       BtTransmit() directly, so the firmware appends NO link CRC to it
       (shimmer_bt_uart.c:2987). A host that verifies it anyway rejects every
       packet - which is exactly what broke the link-speed test when the CRC
       was first added: thousands of "CRC did not check out" discards and a
       measured rate of zero. */
    const t = new LoopbackTransport();
    let mode: 0 | 1 | 2 = 0;
    let blast: ReturnType<typeof setInterval> | null = null;
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      // ACKs are CRC'd; the test packets deliberately are not.
      const ack = () => setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK]), mode)), 0);
      if (cmd[0] === OPCODES.SET_CRC_COMMAND) {
        mode = cmd[1] as 0 | 1 | 2;
        ack();
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1) {
        ack();
        let counterVal = 0;
        blast = setInterval(() => {
          const chunk = new Uint8Array(100);
          for (let i = 0; i < 20; i++) {
            chunk[i * 5] = OPCODES.DATA_RATE_TEST_RESPONSE;
            new DataView(chunk.buffer).setUint32(i * 5 + 1, counterVal++, true);
          }
          tr.notify(chunk);
        }, 5);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 0) {
        if (blast) clearInterval(blast);
        blast = null;
        ack();
      } else {
        ack();
      }
    });

    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    const res = await client.runDataRateTest(300);
    expect(res.bytesReceived).toBeGreaterThan(1000);
    expect(res.kBps).toBeGreaterThan(0);
    // Nothing was discarded: these packets are exempt, not broken.
    expect(client.crcFailures).toBe(0);
  });
});

describe('Shimmer3RClient.runDataRateTest over BLE notifications', () => {
  /* BLE hands the host the module's notifications as they come, cut wherever
     the module cut them - not at packet boundaries. The test counter's high
     bytes are 0x00 for the first 16 million packets, so most notifications
     START with 0x00, the DATA_PACKET opcode. Before the fix such a chunk was
     taken for sensor data whenever a stream schema existed: it was handed to
     the stream aligner, which flooded "Frame timing does not match" (bench:
     ~130 times in a 5 s test) and could deliver test bytes to onStreamFrame
     as samples. With a link CRC on the client reframes even a framed link,
     so that case was never affected; its test below keeps it that way. A
     framed LoopbackTransport is a BLE notification stream. */
  const ACK_B = OPCODES.ACK_COMMAND_PROCESSED;
  // Inquiry for LN_ACCEL X/Y/Z + GYRO X/Y/Z at 51.2 Hz: a 16-byte frame schema.
  const INQUIRY = [
    OPCODES.INQUIRY_RESPONSE,
    0x80,
    0x02,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    6,
    1,
    0x00,
    0x01,
    0x02,
    0x0a,
    0x0b,
    0x0c,
  ];
  // Odd sizes, so packet boundaries drift through every notification offset.
  const NOTIFY_SIZES = [97, 101, 103, 107, 109, 113];

  function bleTestDevice(crcMode: 0 | 1 | 2 = 0): {
    t: LoopbackTransport;
    sentAfterAck: () => number;
  } {
    const t = new LoopbackTransport();
    let mode = crcMode;
    let blast: ReturnType<typeof setInterval> | null = null;
    let sent = 0;
    const ack = (tr: LoopbackTransport): void => {
      setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK_B]), mode)), 0);
    };
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK_B, ...INQUIRY]), mode)), 0);
      } else if (cmd[0] === OPCODES.SET_CRC_COMMAND) {
        mode = cmd[1] as 0 | 1 | 2;
        ack(tr);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1) {
        ack(tr);
        let counter = 0;
        let k = 0;
        let pending: number[] = [];
        blast = setInterval(() => {
          // The device's byte stream, re-cut into notification-sized pieces;
          // several per tick, since timers fire far less often than every 1 ms.
          for (let burst = 0; burst < 8; burst++) {
            while (pending.length < 600) {
              pending.push(
                OPCODES.DATA_RATE_TEST_RESPONSE,
                counter & 0xff,
                (counter >> 8) & 0xff,
                0,
                0,
              );
              counter++;
            }
            const n = NOTIFY_SIZES[k++ % NOTIFY_SIZES.length];
            const piece = pending.slice(0, n);
            pending = pending.slice(n);
            sent += piece.length;
            tr.notify(piece);
          }
        }, 1);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 0) {
        if (blast) clearInterval(blast);
        blast = null;
        ack(tr);
      } else {
        ack(tr);
      }
    });
    return { t, sentAfterAck: () => sent };
  }

  it('never takes test bytes for sensor data, and counts every one', async () => {
    const { t, sentAfterAck } = bleTestDevice();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    const info = await client.inquiry();
    expect(info.schema.frameBytes).toBe(16); // a stream schema exists, as in the app

    const frames: unknown[] = [];
    const status: string[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    client.onStatus = (m) => status.push(m);

    const res = await client.runDataRateTest(300);
    expect(sentAfterAck()).toBeGreaterThan(5000);
    expect(frames).toHaveLength(0);
    expect(status.filter((m) => /Frame timing/i.test(m))).toEqual([]);
    // Everything sent while the test was counting reached the counter.
    expect(res.bytesReceived).toBeGreaterThan(sentAfterAck() * 0.9);
  });

  it('does not CRC-check, or discard, test bytes with a link CRC on', async () => {
    const { t } = bleTestDevice();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    await client.inquiry();

    const status: string[] = [];
    client.onStatus = (m) => status.push(m);

    const res = await client.runDataRateTest(300);
    expect(res.bytesReceived).toBeGreaterThan(5000);
    expect(client.crcFailures).toBe(0);
    expect(status.filter((m) => /CRC did not check out/i.test(m))).toEqual([]);
  });

  it('leaves the stream path as it was once the test is over', async () => {
    // The isolation must end with the test: a sensor frame afterwards decodes.
    const { t } = bleTestDevice();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.inquiry();
    await client.runDataRateTest(100);

    const frames: unknown[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    const frame = (ts: number): number[] => [
      0x00,
      ts & 0xff,
      (ts >> 8) & 0xff,
      (ts >> 16) & 0xff,
      ...new Array(12).fill(0),
    ];
    t.notify([...frame(640), ...frame(1280), ...frame(1920)]);
    await new Promise((r) => setTimeout(r, 0));
    expect(frames.length).toBeGreaterThan(0);
  });
});

describe('Shimmer3RClient.runDataRateTest hands the link back cleanly (review findings)', () => {
  const ACK_B = OPCODES.ACK_COMMAND_PROCESSED;
  const TP = OPCODES.DATA_RATE_TEST_RESPONSE;
  // The same 16-byte LN_ACCEL + GYRO schema the BLE tests above use.
  const INQUIRY = [
    OPCODES.INQUIRY_RESPONSE,
    0x80,
    0x02,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    6,
    1,
    0x00,
    0x01,
    0x02,
    0x0a,
    0x0b,
    0x0c,
  ];
  const pkt = (c: number): number[] => [TP, c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, 0];
  const packets = (from: number, n: number): number[] =>
    Array.from({ length: n }, (_, k) => pkt(from + k)).flat();
  const frame = (ts: number): number[] => [
    0x00,
    ts & 0xff,
    (ts >> 8) & 0xff,
    (ts >> 16) & 0xff,
    ...new Array(12).fill(0),
  ];
  const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

  /**
   * A scripted device: ACKs everything, answers the inquiry, and on the test's
   * start and stop commands sends whatever the test case scripts.
   */
  function device(
    opts: {
      framed?: boolean;
      onStart?: (tr: LoopbackTransport) => void;
      onStop?: (tr: LoopbackTransport) => void;
    } = {},
  ): LoopbackTransport {
    const t = new LoopbackTransport(
      opts.framed === false ? { capabilities: { framed: false } } : {},
    );
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK_B, ...INQUIRY])), 0);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1 && opts.onStart) {
        opts.onStart(tr);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 0 && opts.onStop) {
        opts.onStop(tr);
      } else {
        setTimeout(() => tr.notify(new Uint8Array([ACK_B])), 0);
      }
    });
    return t;
  }

  function watch(client: Shimmer3RClient): {
    frames: unknown[];
    status: string[];
    pushes: unknown[];
  } {
    const seen = { frames: [] as unknown[], status: [] as string[], pushes: [] as unknown[] };
    client.onStreamFrame = (oc) => seen.frames.push(oc);
    client.onStatus = (m) => seen.status.push(m);
    client.onDeviceStatus = (s) => seen.pushes.push(s);
    return seen;
  }

  it('lets go of the link when it drops mid-test, so a reconnect is not diverted', async () => {
    /* The flag outlived the link: the reset on drop and on connect did not
       clear it, so after a reconnect the new link's notifications - stream
       data included - went to the old test until its timer ran out. */
    const old = device({
      onStart: (tr) => {
        setTimeout(() => tr.notify(new Uint8Array([ACK_B, ...packets(0, 20)])), 0);
      },
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(old);
    await client.inquiry();
    const test = client.runDataRateTest(5000);
    const outcome = test.then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    old.emitDisconnect(new Error('dropped'));

    const fresh = device();
    await client.connect(fresh);
    await client.inquiry();
    const seen = watch(client);
    fresh.notify([...frame(640), ...frame(1280), ...frame(1920)]);
    await tick();
    expect(seen.frames.length).toBeGreaterThan(0);
    expect(await outcome).toMatch(/link was reset/);
  });

  it("keeps a previous test's leftovers from the stream parser on a byte-stream link", async () => {
    /* On a reframed link a buffer starting with DATA_PACKET left the framer for
       the stream parser before _handleFramedChunk's guard was reached. Classic
       leftovers arrive mid-packet, so they can start with a 0x00 counter byte. */
    const leftovers = [0x00, 0x00, ...packets(0x4702, 30), ACK_B];
    const t = device({
      framed: false,
      onStart: (tr) => {
        setTimeout(() => tr.notify(new Uint8Array([...leftovers, ACK_B, ...packets(0, 40)])), 0);
      },
      onStop: (tr) => setTimeout(() => tr.notify(new Uint8Array([ACK_B])), 0),
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.inquiry();
    const seen = watch(client);
    await client.runDataRateTest(100);
    expect(seen.frames).toHaveLength(0);
    expect(seen.status.filter((m) => /Frame timing/i.test(m))).toEqual([]);
  });

  it('still diverts test packets behind a counter byte taken for the stop ACK', async () => {
    /* A notification can begin on a counter byte of 0xFF while the stop's ACK
       is awaited, and was taken for it: the link reopened, and the packets still
       on their way reached the stream parser (before the fix: 5 frames and two
       "Frame timing" warnings from this script). Its remainder, test bytes
       that happen to read as a status push, must not surface as one either. */
    const t = device({
      onStart: (tr) => {
        setTimeout(() => tr.notify(new Uint8Array([ACK_B, ...packets(0, 20)])), 0);
      },
      onStop: (tr) => {
        // ...A5 [FF 8A 71 24] 01 00: counter 0x24718AFF, cut so the
        // notification begins on its first byte, then more in flight
        setTimeout(() => tr.notify(new Uint8Array([0xff, 0x8a, 0x71, 0x24, 0x01, 0x00])), 0);
        // ~3 KB still in flight, as the bench saw after a stop: enough for
        // the stream aligner to lock onto, which a short tail is not
        setTimeout(() => {
          for (let k = 0; k < 30; k++)
            tr.notify(new Uint8Array([0, 0, ...packets(30 + 20 * k, 20)]));
        }, 30);
        setTimeout(() => tr.notify(new Uint8Array([ACK_B])), 60);
      },
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.inquiry();
    const seen = watch(client);
    await client.runDataRateTest(100);
    await tick(100);
    expect(seen.frames).toHaveLength(0);
    expect(seen.status.filter((m) => /Frame timing/i.test(m))).toEqual([]);
    expect(seen.pushes).toHaveLength(0);

    // And the stream path is back once the traffic has stopped.
    t.notify([...frame(640), ...frame(1280), ...frame(1920)]);
    await tick();
    expect(seen.frames.length).toBeGreaterThan(0);
  });
});

describe('Shimmer3RClient.runDataRateTest takes a stop ACK that ends the stream', () => {
  /* Stopping aborts the firmware's transfer in flight, so the stream usually
     ends part-way through a test packet and the ACK follows straight after. On
     a reframing link the ACK was then framed as that packet's next byte (bench,
     classic SPP: `a5 26 d4 00 ff`), and on BLE it can end a notification. The
     wait timed out every time: each classic speed test took 2 s longer than it
     needed to.

     The ACK is recognised only where the stream's structure rules out test
     data: the cut packet must match the counter predicted from the complete
     packet before it, and the data byte predicted at the candidate's position
     must not itself be 0xFF. */
  const ACK_B = OPCODES.ACK_COMMAND_PROCESSED;
  const TP = OPCODES.DATA_RATE_TEST_RESPONSE;
  const pkt = (c: number): number[] => [TP, c & 0xff, (c >> 8) & 0xff, (c >> 16) & 0xff, 0];
  const packets = (from: number, n: number): number[] =>
    Array.from({ length: n }, (_, k) => pkt(from + k)).flat();
  const FW = [OPCODES.FW_VERSION_RESPONSE, 3, 0, 1, 0, 1, 17];
  type Mode = 0 | 1 | 2;
  const ack = (mode: Mode): number[] => [...appendCrc(new Uint8Array([ACK_B]), mode)];

  /**
   * A device whose stop reply the test case scripts. ACKs and replies carry the
   * link CRC once one is set; test packets never do, as on the firmware.
   */
  function device(framed: boolean, stopReply: (mode: Mode) => number[] | null): LoopbackTransport {
    const t = new LoopbackTransport(framed ? {} : { capabilities: { framed: false } });
    let mode: Mode = 0;
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.SET_CRC_COMMAND) {
        mode = cmd[1] as Mode;
        setTimeout(() => tr.notify(new Uint8Array(ack(mode))), 0);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1) {
        setTimeout(() => tr.notify(new Uint8Array([...ack(mode), ...packets(0, 40)])), 0);
      } else if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 0) {
        const r = stopReply(mode);
        if (r) setTimeout(() => tr.notify(new Uint8Array(r)), 5);
      } else if (cmd[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK_B, ...FW]), mode)), 0);
      } else {
        setTimeout(() => tr.notify(new Uint8Array(ack(mode))), 0);
      }
    });
    return t;
  }

  async function timeTest(
    t: LoopbackTransport,
    crc: Mode = 0,
  ): Promise<{ overMs: number; fw: string }> {
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    if (crc) await client.setCrcMode(crc);
    const start = Date.now();
    await client.runDataRateTest(100);
    const overMs = Date.now() - start - 100;
    const v = await client.readFwVersion();
    return { overMs, fw: `${v.major}.${v.minor}.${v.patch}` };
  }

  // The last complete packet is counter 59, so the cut one is counter 60 (0x3C)
  const tail = packets(40, 20);

  it('on a byte-stream link, when the cut packet had 4 bytes (the bench case)', async () => {
    const r = await timeTest(device(false, () => [...tail, ...pkt(60).slice(0, 4), ACK_B]));
    expect(r.overMs).toBeLessThan(800);
    expect(r.fw).toBe('1.1.17');
  });

  it('on a byte-stream link, when the cut packet had 2 bytes', async () => {
    const r = await timeTest(device(false, () => [...tail, ...pkt(60).slice(0, 2), ACK_B]));
    expect(r.overMs).toBeLessThan(800);
    expect(r.fw).toBe('1.1.17');
  });

  it('when the stop ACK lands in the millisecond the stop went out', async () => {
    /* Review finding: the fast path wanted the stream's last chunk timed
       strictly after the stop, and Date.now() counts whole milliseconds, so an
       ACK arriving in the same one waited out the timeout. (The 5 ms the device
       here takes to reply hid that.) This clock moves only between the test's
       own ticks, and stands still from the stop until its reply has arrived. */
    let now = 1_000_000;
    let held = false;
    const clock = setInterval(() => {
      if (!held) now += 5;
    }, 5);
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const t = device(false, () => {
        held = true; // set as the stop is written, in the same tick
        setTimeout(() => (held = false), 20); // after the reply, due at 5 ms
        return [...tail, ...pkt(60).slice(0, 4), ACK_B];
      });
      const client = new Shimmer3RClient({ debug: false });
      await client.connect(t);
      const start = performance.now();
      await client.runDataRateTest(100);
      expect(performance.now() - start - 100).toBeLessThan(800);
      const v = await client.readFwVersion();
      expect(`${v.major}.${v.minor}.${v.patch}`).toBe('1.1.17');
    } finally {
      spy.mockRestore();
      clearInterval(clock);
    }
  });

  it('when a counter byte of 0xA5 could be misread as a packet start', async () => {
    /* Review finding, with its own example: counters 0x00FEA50E and 0x00FEA50F,
       then three bytes of 0x00FEA510 and the ACK. The tail ends
       `a5 0e a5 fe 00 a5 0f a5 fe 00 a5 10 a5 ff`. Read from the 0xA5 at index
       7, one "complete packet" predicts 0xFF at the candidate, and that used to
       reject the ACK before the true alignment, which predicts 0xFE, was
       tried. */
    const reply = [...packets(0xfea500, 16), ...pkt(0xfea510).slice(0, 3), ACK_B];
    const r = await timeTest(device(false, () => reply));
    expect(r.overMs).toBeLessThan(800);
    expect(r.fw).toBe('1.1.17');
  });

  it('reads the packet alignment right whatever bytes the counters carry', () => {
    /* The parser itself, over counters that put 0xA5 or 0xFF in each counter
       byte, carry across bytes, or both, every cut, and every CRC mode. With
       four complete packets before the cut, the ACK must be taken exactly
       where test data could not have put a 0xFF in its place. Where data
       could have, data and ACK are the same bytes, so this also checks that
       data is never taken for the ACK. */
    const client = new Shimmer3RClient({ debug: false }) as unknown as {
      _dataRateTestTail: number[];
      _crcMode: Mode;
      _dataRateStopAckEndsStream(): boolean;
    };
    const bases = [
      0x3c, 0xa1, 0xa4, 0xa5, 0xfb, 0xfe, 0x1ff, 0xa5fe, 0xa5ff, 0xffa1, 0xfea50c, 0xfea50f,
      0xa5a5a1, 0xa500fb, 0xa5fffe, 0xfffa5a,
    ];
    const wrong: string[] = [];
    for (const mode of [0, 1, 2] as Mode[]) {
      client._crcMode = mode;
      for (const base of bases) {
        for (let cut = 0; cut <= 4; cut++) {
          const cutPkt = pkt(base + 4);
          client._dataRateTestTail = [...packets(base, 4), ...cutPkt.slice(0, cut), ...ack(mode)];
          const expected = cut === 0 || cutPkt[cut] !== ACK_B;
          if (client._dataRateStopAckEndsStream() !== expected) {
            wrong.push(`counter 0x${(base + 4).toString(16)}, cut ${cut}, CRC ${mode}`);
          }
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it('on a packet boundary', async () => {
    const r = await timeTest(device(false, () => [...tail, ACK_B]));
    expect(r.overMs).toBeLessThan(800);
    expect(r.fw).toBe('1.1.17');
  });

  it('on BLE, when the ACK ends a notification', async () => {
    const r = await timeTest(device(true, () => [...tail, ...pkt(60).slice(0, 2), ACK_B]));
    expect(r.overMs).toBeLessThan(800);
    expect(r.fw).toBe('1.1.17');
  });

  it.each([
    ['one-byte', 1 as Mode],
    ['two-byte', 2 as Mode],
  ])('with a %s link CRC, when the ACK and its CRC follow a cut packet', async (_name, crc) => {
    /* Review finding: test packets carry no CRC but the ACK does, so the last
       raw byte is the ACK's CRC, not 0xFF. */
    const r = await timeTest(
      device(false, (mode) => [...tail, ...pkt(60).slice(0, 4), ...ack(mode)]),
      crc,
    );
    expect(r.overMs).toBeLessThan(800);
    expect(r.fw).toBe('1.1.17');
  });

  it('waits out the timeout when a cut packet ends in a counter byte of 0xFF and no ACK comes', async () => {
    /* Review finding: `a5 ff` is valid aborted data - counter 255's first byte
       is 0xFF - so a trailing 0xFF on its own is no ACK. */
    const r = await timeTest(device(false, () => [...packets(235, 20), ...pkt(255).slice(0, 2)]));
    expect(r.overMs).toBeGreaterThanOrEqual(1900);
    expect(r.fw).toBe('1.1.17');
  });

  it('waits out the timeout when data and ACK would look alike', async () => {
    /* The ACK lands where counter 255's first byte, 0xFF, would be: nothing in
       the stream can tell them apart, so the old behaviour stands. */
    const r = await timeTest(
      device(false, () => [...packets(235, 20), ...pkt(255).slice(0, 1), ACK_B]),
    );
    expect(r.overMs).toBeGreaterThanOrEqual(1900);
    expect(r.fw).toBe('1.1.17');
  });

  it('still waits out the timeout when no stop ACK comes', async () => {
    // e.g. a classic module holding its last frames back: the stream ends on
    // a whole packet and no ACK follows
    const r = await timeTest(device(false, () => [...tail]));
    expect(r.overMs).toBeGreaterThanOrEqual(1900);
    expect(r.fw).toBe('1.1.17');
  });
});
