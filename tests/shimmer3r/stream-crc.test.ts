import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { CRC_MODE } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { shimmerUartCrcCalc } from '../../src/devices/dock/crc.js';
import { appendCrc } from '../../src/devices/shimmer3r/crcMode.js';
import { SD_TRANSFER_OPCODES } from '../../src/devices/shimmer3r/sdTransfer/protocol.js';

// SET_CRC_COMMAND makes the firmware append 1 or 2 CRC bytes to every packet,
// so the frame ON THE WIRE grows while the schema's payload does not. These
// tests pin both halves: that the frame boundary follows the wire width, and
// that a corrupted frame is reported as corrupt rather than as whatever its
// bytes decode to.

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INQ_RSP = OPCODES.INQUIRY_RESPONSE;

const CHANNELS = [0x00, 0x01, 0x02, 0x0a, 0x0b, 0x0c]; // LN accel + gyro
const INQUIRY_BODY = [
  INQ_RSP,
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
const SAMPLE = { ax: 100, ay: -50, az: 16000, gx: 1, gy: -2, gz: 0 };

function payload(ts: number): number[] {
  const i16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  return [
    0x00,
    ts & 0xff,
    (ts >> 8) & 0xff,
    (ts >> 16) & 0xff,
    ...i16(SAMPLE.ax),
    ...i16(SAMPLE.ay),
    ...i16(SAMPLE.az),
    ...i16(SAMPLE.gx),
    ...i16(SAMPLE.gy),
    ...i16(SAMPLE.gz),
  ];
}

/** A frame as the firmware puts it on the wire: payload then CRC, LSB first. */
function wireFrame(ts: number, crcBytes: 0 | 1 | 2): number[] {
  const p = payload(ts);
  if (crcBytes === 0) return p;
  const [lsb, msb] = shimmerUartCrcCalc(new Uint8Array(p), p.length);
  return crcBytes === 1 ? [...p, lsb] : [...p, lsb, msb];
}

async function session(crcBytes: 0 | 1 | 2): Promise<{
  client: Shimmer3RClient;
  t: LoopbackTransport;
  frames: Array<{ crcOk: boolean | null; row: Record<string, number> }>;
}> {
  const t = new LoopbackTransport();
  /* Mirrors the firmware's own ordering: SET_CRC_COMMAND sets the mode while
     its arguments are processed (`shimmer_bt_uart.c:944`) and the ACK is
     composed afterwards from the NEW mode (`:2422`), so that ACK already
     carries a CRC. Everything after it does too. */
  let mode: 0 | 1 | 2 = 0;
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    const send = (msg: number[]) =>
      setTimeout(() => tr.notify(appendCrc(new Uint8Array(msg), mode as never)), 0);
    if (op === OPCODES.INQUIRY_COMMAND) send([ACK, ...INQUIRY_BODY]);
    else if (op === OPCODES.SET_CRC_COMMAND) {
      mode = bytes[1] as 0 | 1 | 2;
      send([ACK]);
    } else if (op === OPCODES.START_STREAMING_COMMAND) send([ACK]);
  });
  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();

  const frames: Array<{ crcOk: boolean | null; row: Record<string, number> }> = [];
  client.onStreamFrame = (oc) => {
    const row: Record<string, number> = {};
    for (const f of oc.fields) if (f.kind === 'raw') row[f.name] = f.value;
    frames.push({ crcOk: oc.crcOk, row });
  };

  if (crcBytes !== 0) await client.setCrcMode(crcBytes);
  await client.startStreaming();
  return { client, t, frames };
}

describe('Shimmer3R link CRC', () => {
  it('sends SET_CRC_COMMAND with the mode byte and records the width', async () => {
    const { client, t } = await session(0);
    await client.stopStreaming();
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_CRC_COMMAND);
    expect(cmd).toBeTruthy();
    expect(Array.from(cmd!.bytes)).toEqual([OPCODES.SET_CRC_COMMAND, 2]);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
  });

  it('rejects a mode the firmware would silently fall back to OFF for', async () => {
    const { client } = await session(0);
    // 3 is COMMS_CRC_MODE's sentinel (CRC_MAX_SUPPORTED_BYTES), not a mode.
    await expect(client.setCrcMode(3 as never)).rejects.toThrow(/CRC mode/);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  it('refuses to change the CRC width mid-stream, which would move every boundary', async () => {
    const { client } = await session(0);
    await expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow(/while streaming/);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  for (const crcBytes of [1, 2] as const) {
    it(`decodes frames and reports crcOk with a ${crcBytes}-byte CRC`, async () => {
      const { client, t, frames } = await session(crcBytes);

      const n = 20;
      for (let i = 0; i < n; i++) t.notify(wireFrame(1000 + i * TICKS_PER_FRAME, crcBytes));

      expect(frames.length).toBe(n - 1);
      for (const [i, f] of frames.entries()) {
        expect(f.crcOk).toBe(true);
        expect(f.row.TIMESTAMP).toBe(1000 + i * TICKS_PER_FRAME);
        // The frame boundary followed the WIRE width: had it used the payload
        // width, every channel after the first frame would be shifted.
        expect(f.row.LN_ACCEL_Z).toBe(SAMPLE.az);
        expect(f.row.GYRO_Z).toBe(SAMPLE.gz);
      }
      expect(client.crcFailures).toBe(0);
    });
  }

  it('flags a frame whose payload was corrupted in flight', async () => {
    const { client, t, frames } = await session(2);

    // Good, corrupted, good: one byte flipped AFTER the CRC was computed, which
    // is exactly what a link fault looks like.
    t.notify(wireFrame(1000, 2));
    const bad = wireFrame(1640, 2);
    bad[8] = (bad[8] ^ 0xff) & 0xff;
    t.notify(bad);
    t.notify(wireFrame(2280, 2));
    t.notify(wireFrame(2920, 2));

    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames[0].crcOk).toBe(true);
    expect(frames[1].crcOk).toBe(false);
    expect(frames[2].crcOk).toBe(true);
    expect(client.crcFailures).toBe(1);
    // Still delivered: dropping it would hide the corruption the CRC exists to
    // surface, and the caller can act on crcOk.
    expect(frames[1].row.TIMESTAMP).toBe(1640);
  });

  it('reports crcOk as null when the CRC is off, not as true', async () => {
    const { client, t, frames } = await session(0);
    for (let i = 0; i < 5; i++) t.notify(wireFrame(1000 + i * TICKS_PER_FRAME, 0));

    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) expect(f.crcOk).toBeNull();
    expect(client.crcFailures).toBe(0);
  });

  it('frames [ACK][response][CRC] as one packet over a byte stream', async () => {
    /* The firmware stages the ACK into the front of the same resPacket as the
       response and appends ONE CRC over both (shimmer_bt_uart.c:1844, :2422).
       A trailer added per message rather than per packet would consume the
       first bytes of the response as if they were the ACK's CRC - so this is
       the case that decides whether a CRC is safe to leave on over Classic
       Bluetooth. Dribbled a byte at a time, as an RFCOMM read arrives. */
    const t = new LoopbackTransport({ capabilities: { framed: false } });
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.SET_CRC_COMMAND) {
        setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK]), 0)), 0);
      } else if (op === OPCODES.INQUIRY_COMMAND) {
        /* One read carrying the whole packet, as an RFCOMM read does. Split
           across several notifies in the SAME task it would fail for a reason
           that has nothing to do with the CRC: the drain would emit the ACK,
           then emit the response before the awaiting continuation's microtask
           had registered a handler for it. Real reads each resolve in their
           own task, so that ordering does not arise. */
        const packet = appendCrc(new Uint8Array([ACK, ...INQUIRY_BODY]), CRC_MODE.TWO_BYTE);
        setTimeout(() => tr.notify(packet), 0);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    const info = await client.inquiry();
    expect(info.numChannels).toBe(6);
    expect(info.channelIds).toEqual(CHANNELS);
    expect(info.schema.enabledSensors).toBe(0xc0);
  });

  it('discards a control reply whose CRC does not check out', async () => {
    // Acting on bytes that are not what the firmware composed is worse than
    // losing them: the waiter times out and the caller retries, where a corrupt
    // reply could set a range or a name to something nobody asked for.
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.SET_CRC_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
      else if (op === OPCODES.INQUIRY_COMMAND) {
        const pkt = appendCrc(new Uint8Array([ACK, ...INQUIRY_BODY]), CRC_MODE.TWO_BYTE);
        pkt[5] = (pkt[5] ^ 0xff) & 0xff; // corrupted after the CRC was computed
        setTimeout(() => tr.notify(pkt), 0);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    await expect(client.inquiry()).rejects.toThrow();
    expect(client.crcFailures).toBeGreaterThan(0);
    // Nothing was adopted from the corrupt reply.
    expect(client.enabledSensors).toBe(0);
  });

  it('verifies a reply that spans several notifications', async () => {
    /* The reason a CRC routes a framed transport through the length-aware
       framer: a notification is not reliably one packet, and checking per
       notification would fail every response longer than one. A 6-byte InfoMem
       read plus its CRC, delivered in three notifications, has to reassemble
       and verify as one packet. */
    const payload = [0x26, 0x01, 0x14, 0x01, 0x85, 0xb8];
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.SET_CRC_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
      else if (op === OPCODES.GET_INFOMEM_COMMAND) {
        const pkt = appendCrc(
          new Uint8Array([ACK, OPCODES.INFOMEM_RESPONSE, payload.length, ...payload]),
          CRC_MODE.TWO_BYTE,
        );
        // Split at awkward offsets, each in its own task as a real read is.
        let at = 0;
        for (const n of [3, 4, 99]) {
          const part = pkt.slice(at, at + n);
          at += n;
          if (part.length) setTimeout(() => tr.notify(part), 0);
        }
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    const got = await client.readInfoMem(276, payload.length);
    expect(Array.from(got)).toEqual(payload);
    expect(client.crcFailures).toBe(0);
  });

  it('re-establishes the CRC on a reconnect, since the device does not keep it', async () => {
    const make = (): LoopbackTransport => {
      const t = new LoopbackTransport();
      t.setOnWrite((bytes, tr) => {
        if (bytes[0] === OPCODES.SET_CRC_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
      });
      return t;
    };
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(make());
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);

    await client.disconnect();
    expect(client.crcMode).toBe(CRC_MODE.OFF);

    // A host that asked once means it for the next link too.
    const second = make();
    await client.connect(second);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
    expect(second.writes.some((w) => w.bytes[0] === OPCODES.SET_CRC_COMMAND)).toBe(true);
  });

  it('does not re-attempt a mode the device refused', async () => {
    // The wish is recorded only once the device agrees, so a firmware that
    // NACKs SET_CRC is not asked again on every reconnect.
    const t = new LoopbackTransport(); // never answers SET_CRC
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await expect(client.setCrcMode(CRC_MODE.TWO_BYTE)).rejects.toThrow();
    await client.disconnect();

    const second = new LoopbackTransport();
    await client.connect(second);
    expect(second.writes.some((w) => w.bytes[0] === OPCODES.SET_CRC_COMMAND)).toBe(false);
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });

  it('DOES verify the one-shot SD replies, which the firmware CRCs like any response', async () => {
    /* The counterpart to the test below, and the reason it needed correcting.
       List-dir, stat, free-space and delete were exempt in this client, so a
       reply arriving on its own was neither stripped nor checked.

       Note the shape: a trailer, as the firmware sends, and NOTHING in front
       of it. That is deliberate, and it is also why the exemption never bit in
       practice — the firmware stages an ACK into the same packet for every one
       of these commands (`Comms/shimmer_bt_uart.c:1692-1698`), and the ACK
       branch of `_controlMessageLength` measures `[ACK][body][CRC]` as one
       packet without consulting the exempt set, so the CRC was verified on the
       real path either way. This test pins the set itself: it is the only one
       here that goes red when the four are exempt again. */
    const t = new LoopbackTransport();
    let mode: 0 | 1 | 2 = 0;
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_CRC_COMMAND) {
        mode = bytes[1] as 0 | 1 | 2;
        setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK]), mode)), 0);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    const reply = new Uint8Array([
      SD_TRANSFER_OPCODES.FREE_SPACE_RESPONSE,
      0,
      0,
      4,
      0,
      0,
      0,
      8,
      0,
      0,
    ]);
    t.notify(appendCrc(reply, CRC_MODE.TWO_BYTE));
    await new Promise((r) => setTimeout(r, 20));
    expect(client.crcFailures).toBe(0);

    // And a bad one is caught rather than acted on.
    const bad = appendCrc(reply, CRC_MODE.TWO_BYTE);
    bad[bad.length - 1] ^= 0xff;
    t.notify(bad);
    await new Promise((r) => setTimeout(r, 20));
    expect(client.crcFailures).toBe(1);
  });

  it('does not verify a CRC on message types the firmware never CRCs', async () => {
    /* `btCrcMode` is honoured in three places only: the command response path,
       the instream status push and the stream data packet. SD file transfer
       writes its FRAMES straight to the TX buffer (they carry their own block
       CRCs), the data-rate test bypasses the ring entirely, and SD sync uses a
       CRC of its own at a fixed width. Verifying any of them rejects every
       packet - which is how enabling a CRC broke the link-speed test.

       "Frames" is the word that matters, and this test used to get it wrong:
       it listed the SD FREE-SPACE RESPONSE among the exempt. That one is an
       ordinary command response, built inside `ShimBt_sendRsp`'s switch
       (`Comms/shimmer_bt_uart.c:2391-2394`) and CRC'd with everything else it
       composes (`:2421-2427`) — as are list-dir, stat and delete. Only the
       0x8A-prefixed transfer frames skip the link CRC, so one of those stands
       here in its place. */
    const t = new LoopbackTransport();
    let mode: 0 | 1 | 2 = 0;
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_CRC_COMMAND) {
        mode = bytes[1] as 0 | 1 | 2;
        setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK]), mode)), 0);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);

    // Each delivered with NO trailer, exactly as the firmware sends them.
    const exempt: Array<[string, number[]]> = [
      ['data-rate test', [OPCODES.DATA_RATE_TEST_RESPONSE, 1, 0, 0, 0]],
      // [0x8A][0xC6][sess][status][nextOffset u32][crc16] — a transfer frame,
      // carrying its own CRC-16 and no link CRC.
      [
        'SD transfer status frame',
        [0x8a, SD_TRANSFER_OPCODES.FILE_STATUS_RESPONSE, 1, 0, 0, 0, 0, 0, 0x9c, 0x2f],
      ],
      ['SD sync', [OPCODES.SD_SYNC_RESPONSE, 0, 0]],
    ];
    for (const [, msg] of exempt) t.notify(msg);
    await new Promise((r) => setTimeout(r, 20));

    expect(client.crcFailures).toBe(0);
  });

  it('clears the CRC width on disconnect, so a reconnect cannot assume it', async () => {
    const { client } = await session(0);
    await client.stopStreaming();
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);

    await client.disconnect();
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });
});

describe('a link that drops under us gives up the CRC mode', () => {
  /* Review finding. Only the explicit disconnect() cleared the CRC mode; an
     unexpected drop (_handleTransportDisconnect) left it set, and connect() did
     not clear it either despite the docblock claiming so. A consumer that
     reconnects the same client instance after onDisconnect - the common
     pattern - then framed its very first exchange expecting a trailer the
     power-cycled device was no longer appending. */

  /**
   * A transport that ACKs SET_CRC (applying the mode before the ACK, as the
   * firmware does) and records the client's CRC mode at its first write.
   */
  function crcAckTransport() {
    const t = new LoopbackTransport();
    const seen: { modeAtFirstWrite: number | null } = { modeAtFirstWrite: null };
    let mode: number = CRC_MODE.OFF;
    let first = true;
    const attach = (client: Shimmer3RClient) => {
      t.setOnWrite((bytes, tr) => {
        if (first) {
          seen.modeAtFirstWrite = client.crcMode;
          first = false;
        }
        if (bytes[0] === OPCODES.SET_CRC_COMMAND) {
          mode = bytes[1];
          setTimeout(() => tr.notify(appendCrc(new Uint8Array([ACK]), mode as never)), 0);
        }
      });
    };
    return { t, seen, attach };
  }

  it('clears the mode on an unexpected drop and re-establishes it on reconnect', async () => {
    const client = new Shimmer3RClient({ debug: false });
    const first = crcAckTransport();
    first.attach(client);
    await client.connect(first.t);
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);

    // The link goes, without disconnect() ever being called.
    first.t.emitDisconnect(new Error('link lost'));
    expect(client.crcMode).toBe(CRC_MODE.OFF);

    /* The standing request survives - that is its whole job - so the reconnect
       puts the width back. What matters is the ORDER: it must be off while the
       reconnect does its first read, or that read is framed expecting a trailer
       the device is not appending. */
    const second = crcAckTransport();
    second.attach(client);
    await client.connect(second.t);
    expect(second.seen.modeAtFirstWrite).toBe(CRC_MODE.OFF);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);
  });

  it('also clears the stream buffer, so stranded bytes are not parsed later', async () => {
    /* Same reset. A dropped link can leave a partial frame in the stream
       buffer; without clearing it those bytes would be prepended to the next
       session's stream and shift every frame boundary after them. */
    const client = new Shimmer3RClient({ debug: false });
    const first = crcAckTransport();
    first.attach(client);
    await client.connect(first.t);

    const buf = () => (client as unknown as { _rxBuf: Uint8Array })._rxBuf;
    (client as unknown as { _rxBuf: Uint8Array })._rxBuf = Uint8Array.from([0x00, 0x11, 0x22]);
    expect(buf()).toHaveLength(3);

    first.t.emitDisconnect();
    expect(buf()).toHaveLength(0);
  });
});
