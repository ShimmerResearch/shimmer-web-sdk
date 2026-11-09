/**
 * What arrives after a stop, on a re-framed link (a byte stream, or any link
 * with a CRC on).
 *
 * Packets go on arriving for a while after STOP_STREAMING or STOP_SDBT, and
 * with them the stop's ACK and the status push the firmware sends when the log
 * closes. The client used to end the stream plane as soon as the stop was
 * written, so that tail reached the control framer part-way through a packet.
 * A tail whose first byte reads as a reply opcode with a length field then
 * swallowed everything behind it. On a bench Shimmer3R over classic Bluetooth
 * it began `C1 3D …`, an SD directory listing 2,840 bytes long by its own
 * header: the push was lost and the next command timed out.
 *
 * The stop now drains the tail through the stream parser until the link goes
 * quiet, as the Shimmer3 client's stop does, and commands wait for it.
 */
import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { Shimmer3DeviceStatus } from '../../src/devices/shimmer3r/protocol.js';
import { versionReply } from './configFirmware.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE;
const STATUS = OPCODES.STATUS_RESPONSE;

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

/** Status bytes while streaming and logging, with audio recording. */
const LOGGING = [0x02 | 0x04 | 0x08 | 0x10 | 0x20, 0x02];
/** The push when the log closes: still streaming, no longer logging or recording. */
const LOG_CLOSED = [0x02 | 0x04 | 0x10 | 0x20, 0x00];
/** GET_STATUS once stopped. */
const IDLE = [0x04 | 0x20, 0x00];

/**
 * A packet whose bytes after the timestamp and LN accel X read, from LN accel
 * Y on, as `C1 3D 80 3E 18 0B`: an SD_LIST_DIR_RESPONSE whose entries run
 * 0x0B18 = 2,840 bytes. Cut after X, its tail is what the bench saw.
 */
const TRAP = { x: 100, y: 0x3dc1, z: 0x3e80, gx: 0x0b18, gy: -2, gz: 0 };
const PLAIN = { x: 100, y: -50, z: 16000, gx: 1, gy: -2, gz: 0 };
const CUT_AFTER = 6; // preamble, 3-byte timestamp, LN accel X

function wireFrame(ts: number, v: typeof PLAIN, mode: CrcMode): Uint8Array {
  const i16 = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff];
  return appendCrc(
    new Uint8Array([
      0x00,
      ts & 0xff,
      (ts >> 8) & 0xff,
      (ts >> 16) & 0xff,
      ...i16(v.x),
      ...i16(v.y),
      ...i16(v.z),
      ...i16(v.gx),
      ...i16(v.gy),
      ...i16(v.gz),
    ]),
    mode,
  );
}

const LINKS = [
  {
    name: 'classic SPP',
    framed: false,
    modes: [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE],
  },
  // BLE is re-framed only with a CRC on; without one a stop still ends at once.
  { name: 'BLE', framed: true, modes: [CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] },
] as const;
const CASES = LINKS.flatMap((link) => link.modes.map((mode) => [link, mode] as const));
const label = (link: (typeof LINKS)[number], mode: CrcMode): string =>
  `${link.name}, ${['no CRC', '1-byte CRC', '2-byte CRC'][mode]}`;

async function streamingDevice(framed: boolean, mode: CrcMode) {
  const t = new LoopbackTransport({ capabilities: { framed } });
  const device = { crc: CRC_MODE.OFF as CrcMode, statusReads: 0, tail: [] as Uint8Array[] };
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    const reply = (msg: number[]): void => {
      const packet = appendCrc(new Uint8Array(msg), device.crc);
      setTimeout(() => tr.notify(packet), 0);
    };
    const version = versionReply(op);
    if (version) reply(version);
    else if (op === OPCODES.INQUIRY_COMMAND) reply([ACK, ...INQUIRY_BODY]);
    else if (op === OPCODES.SET_CRC_COMMAND) {
      device.crc = bytes[1] as CrcMode;
      reply([ACK]);
    } else if (op === OPCODES.GET_STATUS_COMMAND) {
      device.statusReads++;
      reply([ACK, INSTREAM, STATUS, ...IDLE]);
    } else if (op === OPCODES.START_SDBT_COMMAND) {
      reply([ACK]);
    } else if (op === OPCODES.STOP_SDBT_COMMAND) {
      // The tail, a few ms apart, as the radio delivers it
      device.tail.forEach((p, i) => setTimeout(() => tr.notify(p), 10 * (i + 1)));
    } else reply([ACK]);
  });

  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();
  await client.readDeviceVersion();
  await client.readFwVersion();
  if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);
  const pushes: Shimmer3DeviceStatus[] = [];
  client.onDeviceStatus = (s) => pushes.push(s);
  await client.startStreamingAndLogging();
  const frames: number[] = [];
  client.onStreamFrame = (oc) => {
    for (const f of oc.fields) if (f.kind === 'raw' && f.name === 'TIMESTAMP') frames.push(f.value);
  };
  return { t, client, device, pushes, frames };
}

describe('after a stop on a re-framed link', () => {
  for (const [link, mode] of CASES) {
    it(`the log-closed push and the next command get through a tail cut mid-packet (${label(link, mode)})`, async () => {
      const { t, client, device, pushes, frames } = await streamingDevice(link.framed, mode);
      const crc = (msg: number[]): Uint8Array => appendCrc(new Uint8Array(msg), mode);

      // Streaming and logging: packets, the audio push between two of them
      let ts = 1000;
      for (let i = 0; i < 6; i++, ts += TICKS_PER_FRAME) {
        t.notify(wireFrame(ts, PLAIN, mode));
        if (i === 2) t.notify(crc([ACK, INSTREAM, STATUS, ...LOGGING]));
      }
      // The stop goes out with a packet half-received
      const trap = wireFrame(ts, TRAP, mode);
      t.notify(trap.slice(0, CUT_AFTER));
      ts += TICKS_PER_FRAME;
      device.tail = [
        trap.slice(CUT_AFTER),
        wireFrame(ts, PLAIN, mode),
        crc([ACK]), // the stop's
        crc([ACK, INSTREAM, STATUS, ...LOG_CLOSED]),
      ];
      const sentFrames = 8;

      await client.stopStreamingAndLogging();
      expect(pushes.map((p) => [p.sdLogging, p.audioRecording])).toEqual([
        [true, true],
        [false, false],
      ]);
      // Every packet, the cut one and the one after the stop included
      expect(frames).toHaveLength(sentFrames);

      // And the link is free: the next command is answered, not timed out
      const status = await client.getStatus();
      expect(device.statusReads).toBe(1);
      expect((status as Shimmer3DeviceStatus).sensing).toBe(false);
    });
  }

  it('a command sent while the tail drains waits for it, and gets its own reply', async () => {
    const { t, client, device } = await streamingDevice(false, CRC_MODE.OFF);
    let ts = 1000;
    for (let i = 0; i < 4; i++, ts += TICKS_PER_FRAME) t.notify(wireFrame(ts, PLAIN, CRC_MODE.OFF));
    device.tail = [wireFrame(ts, PLAIN, CRC_MODE.OFF), new Uint8Array([ACK])];

    const stop = client.stopStreamingAndLogging();
    const read = client.getStatus(); // not awaited behind the stop by its caller
    await stop;
    const status = (await read) as Shimmer3DeviceStatus;
    expect(device.statusReads).toBe(1);
    expect(status.streaming).toBe(false);
  });

  it('a stop with nothing behind it ends after the quiet period, not the cap', async () => {
    const { client } = await streamingDevice(false, CRC_MODE.OFF);
    const t0 = Date.now();
    await client.stopStreamingAndLogging();
    const took = Date.now() - t0;
    expect(took).toBeGreaterThanOrEqual(250);
    expect(took).toBeLessThan(1500);
  });

  it('a BLE link with no CRC is not re-framed, and its stop still ends at once', async () => {
    const { client } = await streamingDevice(true, CRC_MODE.OFF);
    const t0 = Date.now();
    await client.stopStreamingAndLogging();
    expect(Date.now() - t0).toBeLessThan(100);
  });
});
