import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { msToRtcBytesLE } from '../../src/devices/dock/protocol.js';

// GET/SET_RWC over a scripted in-memory transport — pins the ACK-first flow,
// the ACK-remainder piggyback handling, the opcode-framed-only response policy,
// and the tick encoding (shared with the dock path's msToRtcBytesLE).

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

function scheduleChunks(t: LoopbackTransport, chunks: Array<number[] | Uint8Array>): void {
  for (const c of chunks) setTimeout(() => t.notify(c), 0);
}

/** 8 LSB-first bytes for a bigint tick count. */
function ticksLE(ticks: bigint): number[] {
  const out: number[] = [];
  let v = ticks;
  for (let i = 0; i < 8; i++) {
    out.push(Number(v & 0xffn));
    v >>= 8n;
  }
  return out;
}

const TICKS = 0x0102030405060708n;

describe('Shimmer3RClient RWC over LoopbackTransport', () => {
  it('getRtcTime: ACK then opcode-framed response in a separate chunk', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_RWC_COMMAND) {
        scheduleChunks(tr, [[ACK], [OPCODES.RWC_RESPONSE, ...ticksLE(TICKS)]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const { ticks, unixMs } = await client.getRtcTime();
    expect(ticks).toBe(TICKS);
    expect(unixMs).toBeCloseTo(Number(TICKS) / 32.768, 3);
  });

  it('getRtcTime: opcode-framed response piggybacked on the ACK chunk', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_RWC_COMMAND) {
        scheduleChunks(tr, [[ACK, OPCODES.RWC_RESPONSE, ...ticksLE(TICKS)]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const { ticks } = await client.getRtcTime();
    expect(ticks).toBe(TICKS);
  });

  it('getRtcTime: an opcode-less post-ACK remainder is NOT mis-read; the framed response is still awaited', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_RWC_COMMAND) {
        // Piggyback 8 opcode-less junk bytes on the ACK (e.g. an unrelated
        // notification), then send the real framed response.
        scheduleChunks(tr, [
          [ACK, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88],
          [OPCODES.RWC_RESPONSE, ...ticksLE(TICKS)],
        ]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const { ticks } = await client.getRtcTime();
    expect(ticks).toBe(TICKS);
  });

  it('setRtcTime: sends SET_RWC + msToRtcBytesLE payload and resolves on ACK', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_RWC_COMMAND) scheduleChunks(tr, [[ACK]]);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const unixMs = 1754820000123;
    await client.setRtcTime(unixMs);

    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_RWC_COMMAND);
    expect(cmd).toBeDefined();
    expect(cmd!.bytes.length).toBe(9);
    // Encoding must match the dock path helper (truncating, per the Java driver).
    expect(Array.from(cmd!.bytes.slice(1))).toEqual(Array.from(msToRtcBytesLE(unixMs)));
  });

  it('setRtcTime: rejects non-finite input before touching the transport', async () => {
    const t = new LoopbackTransport();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    await expect(client.setRtcTime(Number.NaN)).rejects.toThrow(/finite/);
    expect(t.writes.find((w) => w.bytes[0] === OPCODES.SET_RWC_COMMAND)).toBeUndefined();
  });
});
