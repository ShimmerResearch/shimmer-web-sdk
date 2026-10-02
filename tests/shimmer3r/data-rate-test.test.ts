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
