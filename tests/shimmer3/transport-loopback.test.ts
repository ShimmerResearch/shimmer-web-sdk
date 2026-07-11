import { describe, it, expect } from 'vitest';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { ObjectCluster } from '../../src/core/ObjectCluster.js';

// Drive Shimmer3Client against a scripted in-memory transport marked `framed:
// false` (RFCOMM has no message boundaries). These tests pin the connect
// handshake bytes, the Shimmer3 inquiry parse, each setter, and — the whole
// point of this client — robustness to arbitrary stream fragmentation.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE; // 0x25
const FWVER = OPCODES.FW_VERSION_RESPONSE; // 0x2F

// Classic-Shimmer3 inquiry response (opcode-inclusive), 51.2 Hz, gyro X/Y/Z,
// gsrRange=2, expPower=1 — see protocol.test.ts for the byte-by-byte breakdown.
const INQUIRY_MSG = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x0a, 0x0b, 0x0c];

/** LogAndStream 0.15.0 => firmwareIdentifier=3, u24 timestamps. */
function replyHandshake(bytes: Uint8Array, tr: LoopbackTransport): void {
  const op = bytes[0];
  if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) setTimeout(() => tr.notify([DEVVER, 3]), 0);
  else if (op === OPCODES.GET_FW_VERSION_COMMAND)
    setTimeout(() => tr.notify([FWVER, 3, 0, 0, 0, 15, 0]), 0);
}

function newTransport(): LoopbackTransport {
  return new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Shimmer3-TEST' });
}

/** Connect a client (running the handshake) and return both. */
async function connected(): Promise<{ t: LoopbackTransport; client: Shimmer3Client }> {
  const t = newTransport();
  t.setOnWrite((bytes, tr) => replyHandshake(bytes, tr));
  const client = new Shimmer3Client({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

/** Deliver bytes one-per-macrotask, preserving order (RFCOMM 1-byte dribble). */
function dribble(tr: LoopbackTransport, bytes: number[]): void {
  bytes.forEach((b, i) => setTimeout(() => tr.notify([b]), i));
}

describe('Shimmer3Client connect handshake', () => {
  it('throws without an injected transport (no browser classic BT)', async () => {
    const client = new Shimmer3Client({ debug: false });
    await expect(client.connect()).rejects.toThrow(/requires an injected transport/i);
  });

  it('sends STOP, dummy GET_SAMPLING_RATE, GET_DEVICE_VERSION, GET_FW_VERSION in order', async () => {
    const { t, client } = await connected();
    const opcodes = t.writes.map((w) => w.bytes[0]);
    expect(opcodes).toEqual([
      OPCODES.STOP_STREAMING_COMMAND, // 0x20 safety stop
      OPCODES.GET_SAMPLING_RATE_COMMAND, // 0x03 dummy read / buffer flush
      OPCODES.GET_DEVICE_VERSION_COMMAND, // 0x3F
      OPCODES.GET_FW_VERSION_COMMAND, // 0x2E
    ]);
    expect(client.deviceVersion?.hardwareVersion).toBe(3);
    expect(client.firmwareVersion?.minor).toBe(15);
    expect(client.timestampFmt).toBe('u24'); // derived from firmware
  });

  it('honours a forced timestamp width', async () => {
    const t = newTransport();
    t.setOnWrite((bytes, tr) => replyHandshake(bytes, tr));
    const client = new Shimmer3Client({ debug: false, transport: t, timestampFmt: 'u16' });
    await client.connect();
    expect(client.timestampFmt).toBe('u16');
  });
});

describe('Shimmer3Client inquiry (Shimmer3 layout)', () => {
  it('parses a response coalesced with its ACK in one chunk', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND)
        setTimeout(() => tr.notify([ACK, ...INQUIRY_MSG]), 0);
    });
    const info = await client.inquiry();
    expect(info.samplingRateHz).toBeCloseTo(51.2, 5);
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(info.gsrRange).toBe(2);
    expect(info.internalExpPower).toBe(1);
    expect(info.schema.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);
    expect(client.samplingRateHz).toBeCloseTo(51.2, 5);
  });

  it('parses a response arriving in 1-byte dribbles', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) dribble(tr, [ACK, ...INQUIRY_MSG]);
    });
    const info = await client.inquiry();
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(info.numChannels).toBe(3);
  });

  it('parses an ACK split from a response split at an awkward boundary', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        // ACK in its own chunk, then the response cut across the numChannels byte.
        setTimeout(() => tr.notify([ACK]), 0);
        setTimeout(() => tr.notify(INQUIRY_MSG.slice(0, 5)), 1);
        setTimeout(() => tr.notify(INQUIRY_MSG.slice(5)), 2);
      }
    });
    const info = await client.inquiry();
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
  });
});

describe('Shimmer3Client setters', () => {
  it('setSamplingRate writes the 16-bit divisor and resolves on ACK', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_SAMPLING_RATE_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const res = await client.setSamplingRate(51.2);
    expect(res.divisor).toBe(640);
    expect(res.appliedHz).toBeCloseTo(51.2, 5);
    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_SAMPLING_RATE_COMMAND)!;
    expect(Array.from(cmd.bytes)).toEqual([OPCODES.SET_SAMPLING_RATE_COMMAND, 0x80, 0x02]);
  });

  it('setGSRRange writes range + ACK and caches it', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_GSR_RANGE_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const res = await client.setGSRRange(2);
    expect(res.gsrRange).toBe(2);
    expect(client.gsrRangeSetting).toBe(2);
    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_GSR_RANGE_COMMAND)!;
    expect(Array.from(cmd.bytes)).toEqual([OPCODES.SET_GSR_RANGE_COMMAND, 2]);
  });

  it('setInternalExpPower writes the enable byte + ACK', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_INTERNAL_EXP_POWER_ENABLE_COMMAND)
        setTimeout(() => tr.notify([ACK]), 0);
    });
    const res = await client.setInternalExpPower(1);
    expect(res.expPower).toBe(1);
    expect(client.getInternalExpPower()).toBe(1);
  });

  it('setSensors ACKs then auto-inquires to rebuild the schema', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_SENSORS_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
      else if (bytes[0] === OPCODES.INQUIRY_COMMAND)
        setTimeout(() => tr.notify([ACK, ...INQUIRY_MSG]), 0);
    });
    const res = await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
    expect(res.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);
    expect(t.writes.some((w) => w.bytes[0] === OPCODES.SET_SENSORS_COMMAND)).toBe(true);
    expect(t.writes.some((w) => w.bytes[0] === OPCODES.INQUIRY_COMMAND)).toBe(true);
    const setCmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_SENSORS_COMMAND)!;
    // 24-bit little-endian bitmask payload (SENSOR_GYRO = 0x000040).
    expect(Array.from(setCmd.bytes)).toEqual([OPCODES.SET_SENSORS_COMMAND, 0x40, 0x00, 0x00]);
  });
});

describe('Shimmer3Client error paths', () => {
  it('rejects on a NACK', async () => {
    const { t, client } = await connected();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_SAMPLING_RATE_COMMAND) setTimeout(() => tr.notify([NACK]), 0);
    });
    await expect(client.setSamplingRate(51.2)).rejects.toThrow(/NACK/i);
  });

  it('rejects on ACK timeout when the device is silent', async () => {
    const { t, client } = await connected();
    t.setOnWrite(() => {
      /* never reply */
    });
    await expect(client.setGSRRange(1)).rejects.toThrow(/ACK timeout/i);
  }, 4000);
});

describe('Shimmer3Client streaming', () => {
  /** Build a 10-byte gyro frame: [0x00 preamble][u24 ts][i16 x][i16 y][i16 z]. */
  function frame(ts: number, x: number, y: number, z: number): number[] {
    const le16 = (v: number) => [v & 0xff, (v >> 8) & 0xff];
    return [
      0x00,
      ts & 0xff,
      (ts >> 8) & 0xff,
      (ts >> 16) & 0xff,
      ...le16(x),
      ...le16(y),
      ...le16(z),
    ];
  }

  it('parses fragmented data frames after START_STREAMING ACK', async () => {
    const { t, client } = await connected();
    // Establish the gyro/u24 schema via inquiry first.
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND)
        setTimeout(() => tr.notify([ACK, ...INQUIRY_MSG]), 0);
    });
    await client.inquiry();

    const frames: ObjectCluster[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);

    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    await client.startStreaming();

    // Three frames delivered split across arbitrary chunk boundaries.
    const stream = [...frame(100, 1, 2, 3), ...frame(200, 4, 5, 6), ...frame(300, 7, 8, 9)];
    t.notify(stream.slice(0, 7));
    t.notify(stream.slice(7, 13));
    t.notify(stream.slice(13));

    // Double-preamble sync means the last frame needs a following preamble; the
    // first two are decodable.
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames[0].get('TIMESTAMP', 'raw')?.value).toBe(100);
    expect(frames[0].get('GYRO_X', 'raw')?.value).toBe(1);
    expect(frames[1].get('GYRO_Z', 'raw')?.value).toBe(6);
  });

  it('stopStreaming is best-effort and clears state', async () => {
    const { t, client } = await connected();
    t.setOnWrite(() => {
      /* STOP needs no ACK */
    });
    await client.stopStreaming();
    expect(t.writes.some((w) => w.bytes[0] === OPCODES.STOP_STREAMING_COMMAND)).toBe(true);
  });
});

describe('Shimmer3Client disconnect', () => {
  it('tears the transport down', async () => {
    const { t, client } = await connected();
    expect(t.connected).toBe(true);
    await client.disconnect();
    expect(t.connected).toBe(false);
  });
});
