import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { CRC_MODE } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { shimmerUartCrcCalc } from '../../src/devices/dock/crc.js';

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
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    if (op === OPCODES.INQUIRY_COMMAND) setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY]), 0);
    else if (op === OPCODES.SET_CRC_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
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

  it('clears the CRC width on disconnect, so a reconnect cannot assume it', async () => {
    const { client } = await session(0);
    await client.stopStreaming();
    await client.setCrcMode(CRC_MODE.TWO_BYTE);
    expect(client.crcMode).toBe(CRC_MODE.TWO_BYTE);

    await client.disconnect();
    expect(client.crcMode).toBe(CRC_MODE.OFF);
  });
});
