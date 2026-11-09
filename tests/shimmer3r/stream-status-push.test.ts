/**
 * A status push that arrives while streaming.
 *
 * The firmware pushes `[ACK][0x8A][0x71][status]` whenever docking, logging,
 * streaming, the USB rail or the audio bits change, streaming or not, into the
 * same transmit ring as the data packets (`ShimBt_instreamStatusRespSend`,
 * log-and-stream-common `Comms/shimmer_bt_uart.c`). The ACK is there only while
 * the in-stream ACK prefix is on, the default; with a link CRC on, one CRC
 * covers every byte from the ACK.
 *
 * The stream parser knew only data packets, bare replies and event frames, so
 * it resynced through a push and lost it, with the packet in front of it. A
 * host that started a log with streaming never saw audio recording start
 * (status byte 1 bit 1, DEV-99), nor a log stopped by the button.
 */
import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { Shimmer3DeviceStatus } from '../../src/devices/shimmer3r/protocol.js';
import { versionReply } from './configFirmware.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE;
const STATUS = OPCODES.STATUS_RESPONSE;
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
const AZ = 16000;

/** Status byte 0: sensing, SD logging, streaming, SD present. Byte 1: audio recording and available. */
const LOGGING_WITH_AUDIO = [0x02 | 0x08 | 0x10 | 0x20, 0x02 | 0x08];

function wireFrame(ts: number, mode: CrcMode): Uint8Array {
  const i16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
  return appendCrc(
    new Uint8Array([
      0x00,
      ts & 0xff,
      (ts >> 8) & 0xff,
      (ts >> 16) & 0xff,
      ...i16(100),
      ...i16(-50),
      ...i16(AZ),
      ...i16(1),
      ...i16(-2),
      ...i16(0),
    ]),
    mode,
  );
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

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'classic SPP', framed: false },
] as const;
type Link = (typeof LINKS)[number];
const MODES = [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const;
const CASES = LINKS.flatMap((link) =>
  MODES.flatMap((mode) => [true, false].map((prefix) => [link, mode, prefix] as const)),
);
const label = (link: Link, mode: CrcMode, prefix: boolean): string =>
  `${link.name}, ${['no CRC', '1-byte CRC', '2-byte CRC'][mode]}, ` +
  `${prefix ? 'with' : 'without'} the ACK prefix`;

async function streamingDevice(link: Link, mode: CrcMode) {
  const t = new LoopbackTransport({ capabilities: { framed: link.framed } });
  const device = { crc: CRC_MODE.OFF as CrcMode, streaming: false, queued: [] as Uint8Array[] };
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
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
    } else reply([ACK]);
  });

  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  await client.inquiry();
  // The status width comes from the versions, which a host reads at connect.
  await client.readDeviceVersion();
  await client.readFwVersion();
  if (mode !== CRC_MODE.OFF) await client.setCrcMode(mode);
  const pushes: Shimmer3DeviceStatus[] = [];
  client.onDeviceStatus = (s) => pushes.push(s);
  await client.startStreaming();
  const frames: number[] = [];
  client.onStreamFrame = (oc) => {
    const raw: Record<string, number> = {};
    for (const f of oc.fields) if (f.kind === 'raw') raw[f.name] = f.value;
    expect(raw.LN_ACCEL_Z).toBe(AZ);
    frames.push(raw.TIMESTAMP);
  };

  const sent: number[] = [];
  let ts = 1000;
  return {
    client,
    device,
    pushes,
    frames,
    sent,
    /** Queue the status push the firmware sends, as it composes it. */
    push(status: number[], prefix = true): void {
      const msg = [...(prefix ? [ACK] : []), INSTREAM, STATUS, ...status];
      device.queued.push(appendCrc(new Uint8Array(msg), device.crc));
    },
    /** Send `n` packets, each behind whatever was queued before it, `chunk` bytes per read. */
    pump(n: number, chunk?: number): void {
      const parts: Uint8Array[] = [];
      for (let i = 0; i < n; i++) {
        parts.push(...device.queued.splice(0));
        parts.push(wireFrame(ts, device.crc));
        sent.push(ts);
        ts += TICKS_PER_FRAME;
      }
      if (!chunk) {
        for (const p of parts) t.notify(p);
        return;
      }
      const all = concat(parts);
      for (let at = 0; at < all.length; at += chunk) t.notify(all.slice(at, at + chunk));
    },
  };
}

const expectingAck = (client: Shimmer3RClient): number =>
  (client as unknown as { _expectingAck: number })._expectingAck;

describe('a status push between two stream packets', () => {
  for (const [link, mode, prefix] of CASES) {
    it(`reaches onDeviceStatus, and every packet is kept (${label(link, mode, prefix)})`, async () => {
      const s = await streamingDevice(link, mode);
      s.pump(3);
      s.push(LOGGING_WITH_AUDIO, prefix);
      s.pump(3);
      expect(s.pushes).toHaveLength(1);
      expect(s.pushes[0]).toMatchObject({
        sdLogging: true,
        streaming: true,
        usbPluggedIn: false,
        audioRecording: true,
        audioFault: false,
        audioAvailable: true,
      });
      // The parser holds the last packet until it sees where the next starts.
      expect(s.frames).toEqual(s.sent.slice(0, -1));
      expect(s.client.crcFailures).toBe(0);
      expect(expectingAck(s.client)).toBe(0);
    });
  }

  for (const [link, mode] of CASES.filter(([l, m, p]) => p && (!l.framed || m !== CRC_MODE.OFF))) {
    for (const chunk of [1, 3]) {
      it(`is reassembled from reads of ${chunk} byte(s) (${label(link, mode, true)})`, async () => {
        const s = await streamingDevice(link, mode);
        s.pump(3, chunk);
        s.push(LOGGING_WITH_AUDIO);
        s.pump(3, chunk);
        expect(s.pushes.map((p) => p.audioRecording)).toEqual([true]);
        expect(s.frames).toEqual(s.sent.slice(0, -1));
      });
    }
  }

  it('reports the recording bit clearing and a fault, push by push', async () => {
    const s = await streamingDevice(LINKS[1], CRC_MODE.TWO_BYTE);
    s.pump(2);
    s.push(LOGGING_WITH_AUDIO);
    s.pump(2);
    s.push([LOGGING_WITH_AUDIO[0], 0x04 | 0x08]); // the recording stopped by a fault
    s.pump(2);
    expect(s.pushes.map((p) => [p.audioRecording, p.audioFault])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(s.frames).toEqual(s.sent.slice(0, -1));
  });

  for (const [link, mode] of [
    [LINKS[0], CRC_MODE.OFF],
    [LINKS[1], CRC_MODE.OFF],
    [LINKS[0], CRC_MODE.TWO_BYTE],
  ] as const) {
    /* Over BLE with no CRC the push's ACK prefix cannot be told from the
     command's ACK, so the command may resolve on it; the push must still be
     reported, not handed to the command. Elsewhere the push is framed whole. */
    it(`still reports a push that lands where a command waits for its ACK (${label(link, mode, true)})`, async () => {
      const s = await streamingDevice(link, mode);
      s.pump(2);
      const done = vi.fn();
      const rtc = s.client.setRtcTime(Date.UTC(2026, 10, 9)).then(done);
      await new Promise((r) => setTimeout(r, 0));
      // The push lands before the command's own ACK, at the same boundary.
      const ackForCommand = s.device.queued.splice(0);
      s.push(LOGGING_WITH_AUDIO);
      s.device.queued.push(...ackForCommand);
      s.pump(2);
      await rtc;
      expect(done).toHaveBeenCalledTimes(1);
      expect(s.pushes).toHaveLength(1);
      expect(expectingAck(s.client)).toBe(0);
      expect(s.frames).toEqual(s.sent.slice(0, -1));
    });
  }

  it('with no CRC, takes bytes that look like a push only where the packet after them fits', async () => {
    const s = await streamingDevice(LINKS[1], CRC_MODE.OFF);
    s.pump(3);
    // A push whose next byte is not a packet start: junk, not a status.
    s.device.queued.push(new Uint8Array([ACK, INSTREAM, STATUS, 0x3a, 0x0a, 0x55]));
    s.pump(3);
    expect(s.pushes).toHaveLength(0);
  });
});
