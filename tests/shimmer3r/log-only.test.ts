/**
 * SD logging on its own: START_LOGGING_COMMAND (0x92) and STOP_LOGGING_COMMAND
 * (0x93), with no stream, or added to and taken from a running stream.
 *
 * Idle, the ACK is a reply like any other. While streaming, the firmware sends
 * it between two packets, where the stream parser finds it. A start the
 * firmware cannot carry out is ACKed by firmware released so far; firmware
 * that NACKs it makes the start throw LogStartRefusedError, and a NACKed
 * START_SDBT starts nothing, not even the stream.
 */
import { describe, it, expect } from 'vitest';
import {
  Shimmer3RClient,
  LogStartRefusedError,
} from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { appendCrc, CRC_MODE, type CrcMode } from '../../src/devices/shimmer3r/crcMode.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { Shimmer3DeviceStatus } from '../../src/devices/shimmer3r/protocol.js';
import { versionReply, NACK } from './configFirmware.js';

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
/** Logging, not streaming, recording audio. */
const LOGGING_ONLY = [0x02 | 0x04 | 0x08 | 0x20, 0x02];
const IDLE = [0x04 | 0x20, 0x00];

function wireFrame(ts: number, mode: CrcMode): Uint8Array {
  return appendCrc(
    new Uint8Array([
      0x00,
      ts & 0xff,
      (ts >> 8) & 0xff,
      (ts >> 16) & 0xff,
      100,
      0,
      206,
      255,
      128,
      62,
      1,
      0,
      254,
      255,
      0,
      0,
    ]),
    mode,
  );
}

const LINKS = [
  { name: 'classic SPP', framed: false },
  { name: 'BLE', framed: true },
] as const;
const MODES = [CRC_MODE.OFF, CRC_MODE.ONE_BYTE, CRC_MODE.TWO_BYTE] as const;
const label = (name: string, mode: CrcMode): string =>
  `${name}, ${['no CRC', '1-byte CRC', '2-byte CRC'][mode]}`;

interface Device {
  crc: CrcMode;
  writes: number[];
  /** What the next 0x92 / 0x70 gets: an ACK, or a NACK as refusing firmware sends. */
  startReply: number;
  streaming: boolean;
}

async function connected(framed: boolean, mode: CrcMode) {
  const t = new LoopbackTransport({ capabilities: { framed } });
  const device: Device = { crc: CRC_MODE.OFF, writes: [], startReply: ACK, streaming: false };
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    device.writes.push(op);
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
      reply([ACK, INSTREAM, STATUS, ...IDLE]);
    } else if (op === OPCODES.START_LOGGING_COMMAND || op === OPCODES.START_SDBT_COMMAND) {
      reply([device.startReply]);
      if (op === OPCODES.START_SDBT_COMMAND && device.startReply === ACK) device.streaming = true;
    } else if (op === OPCODES.START_STREAMING_COMMAND) {
      reply([ACK]);
      device.streaming = true;
    } else if (op === OPCODES.STOP_LOGGING_COMMAND) {
      // While streaming the test sends the ACK itself, between two packets
      if (!device.streaming) reply([ACK]);
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
  const frames: number[] = [];
  client.onStreamFrame = (oc) => {
    for (const f of oc.fields) if (f.kind === 'raw' && f.name === 'TIMESTAMP') frames.push(f.value);
  };
  return { t, client, device, pushes, frames };
}

describe('SD logging without a stream', () => {
  for (const link of LINKS) {
    it(`starts and stops a log with 0x92 and 0x93, and the push that follows reaches onDeviceStatus (${link.name})`, async () => {
      const { t, client, device, pushes } = await connected(link.framed, CRC_MODE.OFF);
      await client.startLogging();
      expect(device.writes).toContain(OPCODES.START_LOGGING_COMMAND);
      // About a second into the log, the firmware pushes the audio bits
      t.notify(new Uint8Array([ACK, INSTREAM, STATUS, ...LOGGING_ONLY]));
      await new Promise((r) => setTimeout(r, 10));
      expect(pushes.map((p) => [p.sdLogging, p.streaming, p.audioRecording])).toEqual([
        [true, false, true],
      ]);
      await client.stopLogging();
      expect(device.writes).toContain(OPCODES.STOP_LOGGING_COMMAND);
      // And the link is free for the next command
      const status = (await client.getStatus()) as Shimmer3DeviceStatus;
      expect(status.sdLogging).toBe(false);
    });
  }

  it('a NACKed log start throws LogStartRefusedError', async () => {
    const { client, device } = await connected(false, CRC_MODE.OFF);
    device.startReply = NACK;
    const err = await client.startLogging().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LogStartRefusedError);
    expect((err as LogStartRefusedError).command).toBe('START_LOGGING');
    // The next command still gets its own reply
    await expect(client.getStatus()).resolves.toBeTruthy();
  });

  for (const link of LINKS) {
    it(`a NACKed START_SDBT throws LogStartRefusedError and leaves the client not streaming (${link.name})`, async () => {
      const { client, device, frames } = await connected(link.framed, CRC_MODE.OFF);
      device.startReply = NACK;
      const err = await client.startStreamingAndLogging().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LogStartRefusedError);
      expect((err as LogStartRefusedError).command).toBe('START_SDBT');
      // Not streaming: a status read is a plain reply, and no frame was made of it
      const status = (await client.getStatus()) as Shimmer3DeviceStatus;
      expect(status.streaming).toBe(false);
      expect(frames).toHaveLength(0);
    });
  }
});

describe('SD logging added to and taken from a running stream', () => {
  for (const link of LINKS) {
    for (const mode of MODES) {
      it(`its ACK between two packets ends the command, and the stream goes on (${label(link.name, mode)})`, async () => {
        const { t, client, frames } = await connected(link.framed, mode);
        await client.startStreaming();
        let ts = 1000;
        const packet = (): void => {
          t.notify(wireFrame(ts, mode));
          ts += TICKS_PER_FRAME;
        };
        for (let i = 0; i < 4; i++) packet();

        // Start a log mid-stream: the ACK comes between two packets
        const start = client.startLogging();
        await new Promise((r) => setTimeout(r, 5));
        packet();
        t.notify(appendCrc(new Uint8Array([ACK]), mode));
        packet();
        await start;

        for (let i = 0; i < 3; i++) packet();
        const stop = client.stopLogging();
        await new Promise((r) => setTimeout(r, 5));
        packet();
        t.notify(appendCrc(new Uint8Array([ACK]), mode));
        packet();
        await stop;
        for (let i = 0; i < 2; i++) packet();
        await new Promise((r) => setTimeout(r, 10));

        // Every packet but the last, which waits for the one after it without a CRC
        const sent = (ts - 1000) / TICKS_PER_FRAME;
        expect(frames.length).toBeGreaterThanOrEqual(sent - 1);
        expect(frames.slice(0, sent - 1)).toEqual(
          Array.from({ length: sent - 1 }, (_, i) => 1000 + i * TICKS_PER_FRAME),
        );
        await client.stopStreaming();
      });
    }
  }
});
