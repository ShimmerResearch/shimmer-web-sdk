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
