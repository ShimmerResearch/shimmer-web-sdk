import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// Exercise Shimmer3RClient's connect / inquiry / config flows against a scripted
// in-memory transport — no browser, no Web Bluetooth. The transport delivers the
// exact notification chunks it is told to, so these tests pin the ACK-first
// command flow and, critically, the ACK-remainder handling.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xff
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02

// A minimal, opcode-prefixed inquiry response:
//   [0x02, adcLo, adcHi, cfg0..cfg6, numCh, bufSize, ch0, ch1, ch2]
// adcRaw = 0x0280 = 640  ->  32768 / 640 = 51.2 Hz
// channels 0x0a/0x0b/0x0c = GYRO X/Y/Z  ->  SENSOR_GYRO
const INQUIRY_BODY = [INQ_RSP, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0x0a, 0x0b, 0x0c];

/**
 * Deliver each chunk in its own macrotask (successive `setTimeout(0)`s), so the
 * client's microtask-scheduled continuations (register ACK wait → register
 * response wait) run in between — mirroring how real notifications interleave.
 */
function scheduleChunks(t: LoopbackTransport, chunks: Array<number[] | Uint8Array>): void {
  for (const c of chunks) setTimeout(() => t.notify(c), 0);
}

describe('Shimmer3RClient over LoopbackTransport', () => {
  it('connects over an injected transport without touching navigator.bluetooth', async () => {
    const t = new LoopbackTransport({ deviceName: 'Shimmer3R-TEST' });
    const client = new Shimmer3RClient({ debug: false, transport: t });
    await client.connect();
    expect(t.connected).toBe(true);
    // No BluetoothDevice for a non-web transport.
    expect(client.device).toBeNull();
  });

  it('setSamplingRate sends the 16-bit divisor command and resolves on ACK', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((_bytes, tr) => scheduleChunks(tr, [[ACK]]));
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t); // connect(transport) parameter form

    const res = await client.setSamplingRate(51.2);
    expect(res.divisor).toBe(640);
    expect(res.appliedHz).toBeCloseTo(51.2, 5);

    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_SAMPLING_RATE_COMMAND);
    expect(cmd).toBeTruthy();
    expect(Array.from(cmd!.bytes)).toEqual([OPCODES.SET_SAMPLING_RATE_COMMAND, 0x80, 0x02]);
  });

  it('setGSRRange resolves on ACK and caches the range', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((_bytes, tr) => scheduleChunks(tr, [[ACK]]));
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const res = await client.setGSRRange(2);
    expect(res.gsrRange).toBe(2);
    expect(client.gsrRangeSetting).toBe(2);
  });

  it('parses an inquiry response piggybacked in the SAME chunk as its ACK (regression)', async () => {
    // The regression: Shimmer3R firmware frequently returns the ACK (0xFF) and
    // the INQUIRY_RESPONSE (0x02 ...) in a single BLE notification. The transport
    // must preserve that chunk so the client's ACK-remainder path can recover the
    // piggybacked response instead of timing out.
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        scheduleChunks(tr, [[ACK, ...INQUIRY_BODY]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const info = await client.inquiry();
    expect(info.opcode).toBe(INQ_RSP);
    expect(info.samplingRateHz).toBeCloseTo(51.2, 5);
    expect(info.numChannels).toBe(3);
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(info.schema.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);
  });

  it('parses an inquiry response delivered as a SEPARATE chunk after the ACK', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        // ACK alone, then the response in its own notification chunk.
        scheduleChunks(tr, [[ACK], INQUIRY_BODY]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const info = await client.inquiry();
    expect(info.numChannels).toBe(3);
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(info.schema.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);
  });

  it('setSensors ACKs then auto-inquires to rebuild the schema', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_SENSORS_COMMAND) scheduleChunks(tr, [[ACK]]);
      else if (bytes[0] === OPCODES.INQUIRY_COMMAND) scheduleChunks(tr, [[ACK, ...INQUIRY_BODY]]);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const res = await client.setSensors(SensorBitmapShimmer3.SENSOR_GYRO);
    expect(res.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);
    // A SET_SENSORS_CMD and a follow-up INQUIRY_CMD were both written.
    expect(t.writes.some((w) => w.bytes[0] === OPCODES.SET_SENSORS_COMMAND)).toBe(true);
    expect(t.writes.some((w) => w.bytes[0] === OPCODES.INQUIRY_COMMAND)).toBe(true);
  });

  it('readInfoMem sends [cmd, len, addrLSB, addrMSB] and parses a piggybacked response', async () => {
    const payload = [0x26, 0x01, 0x14, 0x01, 0x85, 0xb8];
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_INFOMEM_COMMAND) {
        // ACK + [INFOMEM_RSP][length][data...] in a single notification chunk.
        scheduleChunks(tr, [[ACK, OPCODES.INFOMEM_RESPONSE, payload.length, ...payload]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const data = await client.readInfoMem(224, 6);
    expect(Array.from(data)).toEqual(payload);

    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.GET_INFOMEM_COMMAND);
    expect(cmd).toBeTruthy();
    // 224 = 0x00e0 little-endian → addrLSB 0xe0, addrMSB 0x00.
    expect(Array.from(cmd!.bytes)).toEqual([OPCODES.GET_INFOMEM_COMMAND, 6, 0xe0, 0x00]);
  });

  it('readInfoMem rejects non-integer or out-of-range address/length before writing', async () => {
    const t = new LoopbackTransport();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    await expect(client.readInfoMem(-1, 6)).rejects.toThrow(/address/);
    await expect(client.readInfoMem(0x10000, 6)).rejects.toThrow(/address/);
    await expect(client.readInfoMem(224.5, 6)).rejects.toThrow(/address/);
    await expect(client.readInfoMem(224, 0)).rejects.toThrow(/length/);
    await expect(client.readInfoMem(224, 129)).rejects.toThrow(/length/);
    await expect(client.readInfoMem(224, 6.5)).rejects.toThrow(/length/);
    // No command bytes were written for any rejected call.
    expect(t.writes.length).toBe(0);
  });

  it('readInfoMem parses a response whose length byte is absent', async () => {
    const payload = [0x26, 0x01, 0x14, 0x01, 0x85, 0xb8];
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_INFOMEM_COMMAND) {
        // [INFOMEM_RSP][data...] with no length byte.
        scheduleChunks(tr, [[ACK], [OPCODES.INFOMEM_RESPONSE, ...payload]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const data = await client.readInfoMem(224, 6);
    expect(Array.from(data)).toEqual(payload);
  });

  it('getMacAddress reads InfoMem @224 and formats 12 uppercase hex chars', async () => {
    const payload = [0x26, 0x01, 0x14, 0x01, 0x85, 0xb8];
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_INFOMEM_COMMAND) {
        // ACK alone, then the response in its own notification chunk.
        scheduleChunks(tr, [[ACK], [OPCODES.INFOMEM_RESPONSE, payload.length, ...payload]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    await expect(client.getMacAddress()).resolves.toBe('2601140185B8');
  });

  it('getMacAddress rejects an unprovisioned (all-FF) MAC', async () => {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_INFOMEM_COMMAND) {
        scheduleChunks(tr, [
          [ACK, OPCODES.INFOMEM_RESPONSE, 6, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff],
        ]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    await expect(client.getMacAddress()).rejects.toThrow(/unprovisioned MAC/);
  });

  it('disconnect() tears the transport down', async () => {
    const t = new LoopbackTransport();
    const client = new Shimmer3RClient({ debug: false, transport: t });
    await client.connect();
    expect(t.connected).toBe(true);
    await client.disconnect();
    expect(t.connected).toBe(false);
    expect(client.device).toBeNull();
  });
});

describe('Shimmer3RClient daughter-card memory over LoopbackTransport', () => {
  // Brand record host offset 1952 = 0x07a0 little-endian → addrLSB 0xa0, addrMSB 0x07.
  const OFFSET = 1952;

  it('readDaughterCardMem sends [cmd, len, offLSB, offMSB] and parses a piggybacked response', async () => {
    const payload = Array.from({ length: 8 }, (_, i) => 0x40 + i);
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND) {
        // ACK + [DC_MEM_RSP][length][data...] in one notification chunk.
        scheduleChunks(tr, [[ACK, OPCODES.DAUGHTER_CARD_MEM_RESPONSE, payload.length, ...payload]]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const data = await client.readDaughterCardMem(OFFSET, payload.length);
    expect(Array.from(data)).toEqual(payload);

    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND);
    expect(cmd).toBeTruthy();
    expect(Array.from(cmd!.bytes)).toEqual([
      OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND,
      payload.length,
      0xa0,
      0x07,
    ]);
  });

  it('readDaughterCardMem parses ACK and response arriving as separate chunks', async () => {
    const payload = [0x11, 0x22, 0x33];
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DAUGHTER_CARD_MEM_COMMAND) {
        scheduleChunks(tr, [
          [ACK],
          [OPCODES.DAUGHTER_CARD_MEM_RESPONSE, payload.length, ...payload],
        ]);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    const data = await client.readDaughterCardMem(16, 3);
    expect(Array.from(data)).toEqual(payload);
  });

  it('writeDaughterCardMem sends [cmd, len, offLSB, offMSB, data...] and resolves on ACK', async () => {
    const data = [0x42, 0x53, 0x01, 0x00];
    const t = new LoopbackTransport();
    t.setOnWrite((_bytes, tr) => scheduleChunks(tr, [[ACK]]));
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    await client.writeDaughterCardMem(OFFSET, Uint8Array.from(data));

    const cmd = t.writes.find((w) => w.bytes[0] === OPCODES.SET_DAUGHTER_CARD_MEM_COMMAND);
    expect(cmd).toBeTruthy();
    expect(Array.from(cmd!.bytes)).toEqual([
      OPCODES.SET_DAUGHTER_CARD_MEM_COMMAND,
      data.length,
      0xa0,
      0x07,
      ...data,
    ]);
  });

  it('rejects out-of-range offsets/lengths before writing (firmware bounds: 1..128 within 0..2031)', async () => {
    const t = new LoopbackTransport();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);

    await expect(client.readDaughterCardMem(-1, 8)).rejects.toThrow(/offset/);
    await expect(client.readDaughterCardMem(2032, 8)).rejects.toThrow(/offset/);
    await expect(client.readDaughterCardMem(0, 0)).rejects.toThrow(/1\.\.128/);
    await expect(client.readDaughterCardMem(0, 129)).rejects.toThrow(/1\.\.128/);
    await expect(client.readDaughterCardMem(2000, 64)).rejects.toThrow(/1\.\.128/); // 2000+64 > 2032
    await expect(client.writeDaughterCardMem(2032, Uint8Array.of(1))).rejects.toThrow(/offset/);
    await expect(client.writeDaughterCardMem(0, new Uint8Array(0))).rejects.toThrow(/1\.\.128/);
    await expect(client.writeDaughterCardMem(2000, new Uint8Array(64))).rejects.toThrow(/1\.\.128/);
    expect(t.writes.length).toBe(0);
  });
});
