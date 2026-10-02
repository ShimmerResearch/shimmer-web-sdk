import { describe, it, expect } from 'vitest';
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
