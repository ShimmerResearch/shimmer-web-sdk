import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { NEED_MORE, RESYNC } from '../../src/core/framing.js';
import {
  shimmer3rControlMessageLength,
  SHIMMER3R_INQ_CHANNELS_OFFSET,
} from '../../src/devices/shimmer3r/streamFraming.js';
import {
  SD_TRANSFER_OPCODES as OP,
  SD_INSTREAM_BYTE,
  sdCrc16,
} from '../../src/devices/shimmer3r/sdTransfer/protocol.js';

// Shimmer3R over an UNFRAMED transport: Web Serial, whether the port is USB CDC
// or the virtual COM port Windows/macOS expose for a Shimmer paired over classic
// Bluetooth (RFCOMM/SPP). BLE hands the client one message per notification;
// a byte stream does not, so the client re-frames. These tests pin the framer
// and then the control-plane flows that depend on it.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xff
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xfe
const FWVER = OPCODES.FW_VERSION_RESPONSE; // 0x2f

/** LogAndStream v1.01.009 — the SD-transfer feature gate. */
const FW_RSP = [FWVER, 3, 0, 1, 0, 1, 9];
const FW_PARSED = { fwId: 3, major: 1, minor: 1, patch: 9 };

function u16le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff];
}
function u32le(v: number): number[] {
  return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >> 24) & 0xff];
}

/** [0x8A][0xC6][sessionId][status][nextOffset u32][crc16] — 10 bytes. */
function makeStatusFrame(sessionId: number, status: number, nextOffset: number): Uint8Array {
  const frame = new Uint8Array(10);
  frame.set(
    [SD_INSTREAM_BYTE, OP.FILE_STATUS_RESPONSE, sessionId, status, ...u32le(nextOffset)],
    0,
  );
  frame.set(u16le(sdCrc16(frame, 8)), 8);
  return frame;
}

// ---------------------------------------------------------------------------
// The framer
// ---------------------------------------------------------------------------

describe('shimmer3rControlMessageLength', () => {
  const len = (bytes: number[]): number => shimmer3rControlMessageLength(new Uint8Array(bytes));

  it('treats ACK and NACK as one-byte messages', () => {
    expect(len([ACK])).toBe(1);
    expect(len([NACK])).toBe(1);
  });

  it('reports NEED_MORE for an empty buffer and for a truncated response', () => {
    expect(len([])).toBe(NEED_MORE);
    expect(len([FWVER, 3, 0])).toBe(NEED_MORE);
  });

  it('spans a complete fixed-width response and ignores trailing bytes', () => {
    expect(len(FW_RSP)).toBe(7);
    expect(len([...FW_RSP, ACK, ACK])).toBe(7);
  });

  it('sizes the data-rate test packet at the firmware DATA_RATE_TEST_PACKET_SIZE', () => {
    // log-and-stream-common: `#define DATA_RATE_TEST_PACKET_SIZE 5U` — header
    // byte + uint32 counter.
    expect(len([OPCODES.DATA_RATE_TEST_RESPONSE, 1, 2, 3, 4])).toBe(5);
  });

  it('resyncs on an opcode it cannot frame', () => {
    expect(len([0x77, 1, 2, 3])).toBe(RESYNC);
  });

  it('does not frame DATA_PACKET — stream length comes from the schema', () => {
    expect(len([OPCODES.DATA_PACKET, 1, 2, 3])).toBe(RESYNC);
  });

  describe('INQUIRY_RESPONSE (Shimmer3R 7-byte config word)', () => {
    // [0x02][adc u16][cfg0..cfg6][numCh][bufSize][channels…] — numCh at [10].
    const inq = (numCh: number, channels: number[]): number[] => [
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
      numCh,
      1,
      ...channels,
    ];

    it('spans 12 + numChannels', () => {
      expect(len(inq(3, [0x0a, 0x0b, 0x0c]))).toBe(SHIMMER3R_INQ_CHANNELS_OFFSET + 3);
      expect(SHIMMER3R_INQ_CHANNELS_OFFSET).toBe(12);
    });

    it('needs the numChannels byte before it can size the message', () => {
      expect(len(inq(3, []).slice(0, 10))).toBe(NEED_MORE);
    });

    it('needs the channel bytes too', () => {
      expect(len(inq(3, [0x0a]))).toBe(NEED_MORE);
    });

    it('resyncs rather than swallow control traffic on an implausible channel count', () => {
      // A stray 0x02 stream byte whose "numChannels" is garbage would otherwise
      // eat up to 255 bytes of real traffic, ACKs included.
      expect(len(inq(200, []))).toBe(RESYNC);
    });
  });

  it('sizes a variable-length daughter-card memory response from its length byte', () => {
    const body = new Array(8).fill(0xab);
    expect(len([OPCODES.DAUGHTER_CARD_MEM_RESPONSE, 8, ...body])).toBe(10);
    expect(len([OPCODES.DAUGHTER_CARD_MEM_RESPONSE, 8, 0xab])).toBe(NEED_MORE);
    // The firmware caps a read at 128 bytes, so anything larger is garbage.
    expect(len([OPCODES.DAUGHTER_CARD_MEM_RESPONSE, 200])).toBe(RESYNC);
  });

  it('delegates SD frames and one-shot responses to sdMessageSpan', () => {
    const status = Array.from(makeStatusFrame(1, 0, 0));
    expect(len(status)).toBe(10);
    expect(len(status.slice(0, 6))).toBe(NEED_MORE);
    // one-shot: [0xCB][status]
    expect(len([OP.DELETE_RESPONSE, 0])).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// The client over a byte stream
// ---------------------------------------------------------------------------

/** A transport that reports itself as an unframed byte stream. */
function newStream(): LoopbackTransport {
  return new LoopbackTransport({
    capabilities: { framed: false },
    deviceName: 'Shimmer3R-SPP',
  });
}

async function connectedStream(
  reply: (bytes: Uint8Array, tr: LoopbackTransport) => void,
): Promise<{ t: LoopbackTransport; client: Shimmer3RClient }> {
  const t = newStream();
  t.setOnWrite((bytes, tr) =>
    reply(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), tr),
  );
  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

/** Deliver bytes one per macrotask — the worst-case serial dribble. */
function dribble(tr: LoopbackTransport, bytes: number[]): void {
  bytes.forEach((b, i) => setTimeout(() => tr.notify([b]), i));
}

describe('Shimmer3RClient control plane over a byte stream', () => {
  it('reads a response dribbled one byte at a time', async () => {
    const { client } = await connectedStream((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) dribble(tr, [ACK, ...FW_RSP]);
    });
    await expect(client.readFwVersion()).resolves.toEqual(FW_PARSED);
  });

  it('reads a response coalesced with its ACK in one read', async () => {
    const { client } = await connectedStream((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, ...FW_RSP]), 0);
    });
    await expect(client.readFwVersion()).resolves.toEqual(FW_PARSED);
  });

  it('reads a response that arrives in its own read, after the ACK', async () => {
    const { client } = await connectedStream((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify([ACK]), 0);
        setTimeout(() => tr.notify(FW_RSP), 1);
      }
    });
    await expect(client.readFwVersion()).resolves.toEqual(FW_PARSED);
  });

  it('keeps a third message that shares the read with an ACK and a response', async () => {
    // [ACK][FW_VERSION_RESPONSE][SD status frame] in one read. The framed path
    // would hand the whole tail over as the ACK remainder and lose the SD frame;
    // re-framing coalesces only the ACK with the message directly after it.
    const sd = makeStatusFrame(1, 0, 0);
    const { client, t } = await connectedStream((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, ...FW_RSP, ...sd]), 0);
    });

    const seen: Uint8Array[] = [];
    // The re-framing boundary has no public surface, so tap the client's
    // internal message fan-out directly — that set IS the boundary under test.
    const internals = client as unknown as { _temps: Set<(c: Uint8Array) => void> };
    const spy = (c: Uint8Array): void => void seen.push(c);
    internals._temps.add(spy);

    await expect(client.readFwVersion()).resolves.toEqual(FW_PARSED);
    internals._temps.delete(spy);
    expect(t.connected).toBe(true);

    // The ACK+response arrived as one message; the SD frame survived as its own.
    const sdSeen = seen.find((c) => c[0] === SD_INSTREAM_BYTE);
    expect(sdSeen).toBeTruthy();
    expect(Array.from(sdSeen as Uint8Array)).toEqual(Array.from(sd));
  });

  it('resynchronises past unframeable bytes instead of jamming', async () => {
    const { client } = await connectedStream((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        // 0x77 is not a response this client frames — it must be stepped over
        // one byte at a time rather than swallowing what follows.
        setTimeout(() => tr.notify([0x77, 0x77, ACK, ...FW_RSP]), 0);
      }
    });
    await expect(client.readFwVersion()).resolves.toEqual(FW_PARSED);
  });

  it('counts every data-rate test byte when packets straddle reads', async () => {
    const PKT = [OPCODES.DATA_RATE_TEST_RESPONSE, 0, 0, 0, 0];
    const PACKETS = 40;
    const { client } = await connectedStream((bytes, tr) => {
      if (bytes[0] !== OPCODES.SET_DATA_RATE_TEST) return;
      setTimeout(() => tr.notify([ACK]), 0);
      if (bytes[1] !== 1) return;
      // 200 bytes of test packets delivered in 3-byte reads: every read but the
      // first splits a packet.
      const stream: number[] = [];
      for (let i = 0; i < PACKETS; i++) stream.push(...PKT);
      for (let i = 0; i < stream.length; i += 3) {
        const slice = stream.slice(i, i + 3);
        setTimeout(() => tr.notify(slice), 1);
      }
    });

    const res = await client.runDataRateTest(60);
    expect(res.bytesReceived).toBe(PACKETS * PKT.length);
    expect(res.kBps).toBeGreaterThan(0);
  });

  it('leaves the BLE path untouched: a framed transport still gets raw chunks', async () => {
    // Same scripted reply, framed transport: the client must take the original
    // code path, where one notification is one message.
    const t = new LoopbackTransport({ deviceName: 'Shimmer3R-BLE' });
    t.setOnWrite((bytes, tr) => {
      const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (b[0] === OPCODES.GET_FW_VERSION_COMMAND) setTimeout(() => tr.notify([ACK, ...FW_RSP]), 0);
    });
    const client = new Shimmer3RClient({ debug: false, transport: t });
    await client.connect();
    await expect(client.readFwVersion()).resolves.toEqual(FW_PARSED);
  });
});
