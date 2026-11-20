import { describe, it, expect, vi, afterEach } from 'vitest';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';
import type { StreamPacket } from '../../src/devices/verisense/VerisenseTypes.js';
import {
  ASM_COMMAND,
  ASM_PROPERTY,
  type AsmProperty,
} from '../../src/devices/verisense/constants.js';
import {
  buildHeader,
  buildMessage,
  crc16_ccitt_false,
  STREAM_FRAME_HEADER,
} from '../../src/devices/verisense/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// DEV-1513. A request takes over how the client routes incoming bytes: it set
// `_mode = 'command'` whatever was using the link, so a request sent while
// streaming stopped the stream decoding, one sent during a logged-data sync
// took the sync's frames, and one sent during a test report or throughput test
// had the raw capture frame-parsed and lost. It is now refused before anything
// is written. Separately, a request whose write failed stayed pending for its
// whole timeout, refusing every other request as "already pending".

const ERASED = Array.from(new Uint8Array(56).fill(0xff));

type Internals = {
  _mode: string;
  _pending: unknown;
  _testReportMode: boolean;
  _feedStreamBytes(c: Uint8Array): void;
};
const internals = (v: VerisenseBleDevice) => v as unknown as Internals;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A device on a loopback link, connected with erased configs; every WRITE is ACKed. */
async function connectedDevice(): Promise<{ v: VerisenseBleDevice; t: LoopbackTransport }> {
  const t = new LoopbackTransport();
  t.setOnWrite((bytes, tr) => {
    const command = bytes[0] & 0xf0;
    const property = (bytes[0] & 0x0f) as AsmProperty;
    if (command === ASM_COMMAND.READ) {
      setTimeout(() => tr.notify(buildMessage(ASM_COMMAND.RESPONSE, property, ERASED)), 0);
    } else if (command === ASM_COMMAND.WRITE) {
      setTimeout(() => tr.notify([buildHeader(ASM_COMMAND.ACK, property), 0x00, 0x00]), 0);
    }
  });
  const v = new VerisenseBleDevice({ debug: false, transport: t });
  await v.connect();
  return { v, t };
}

/** A CRC-framed LIS2DW12 (sensor 2) stream frame carrying one accel sample. */
function accelFrame(tick: number): Uint8Array {
  const body = [0x02, tick & 0xff, (tick >> 8) & 0xff, (tick >> 16) & 0xff, 1, 0, 2, 0, 3, 0];
  const crc = crc16_ccitt_false(new Uint8Array(body));
  const len = body.length + 2;
  return new Uint8Array([STREAM_FRAME_HEADER, len & 0xff, len >> 8, ...body, crc & 0xff, crc >> 8]);
}

/** A logged-data frame: [index u16][data][CRC-16 over index and data]. */
function loggedFrame(index: number, data: number[]): Uint8Array {
  const payload = [index & 0xff, index >> 8, ...data];
  const crc = crc16_ccitt_false(new Uint8Array(payload));
  const withCrc = [...payload, crc & 0xff, crc >> 8];
  const header = buildHeader(ASM_COMMAND.RESPONSE, ASM_PROPERTY.DATA);
  return new Uint8Array([header, withCrc.length & 0xff, withCrc.length >> 8, ...withCrc]);
}

/** Attach a fake NUS TX characteristic, the path transferLoggedData() accepts. */
function attachFakeTx(v: VerisenseBleDevice): Uint8Array[] {
  const writes: Uint8Array[] = [];
  const record = async (b: ArrayBuffer | ArrayBufferView) => {
    writes.push(
      ArrayBuffer.isView(b)
        ? new Uint8Array(b.buffer, b.byteOffset, b.byteLength).slice()
        : new Uint8Array(b).slice(),
    );
  };
  const fake = v as unknown as { tx: unknown; rx: unknown };
  fake.tx = { writeValue: record, writeValueWithoutResponse: record };
  fake.rx = {};
  return writes;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('VerisenseBleDevice: a request is refused while something else uses the link', () => {
  it('refuses it while streaming, writes nothing, and the stream keeps decoding', async () => {
    const { v, t } = await connectedDevice();
    const packets: StreamPacket[] = [];
    const streaming: boolean[] = [];
    v.on<StreamPacket>('streamPacket', (p) => packets.push(p));
    v.on<{ on: boolean }>('streaming', (e) => streaming.push(e.on));

    await v.startStreaming();
    t.notify(accelFrame(1));
    expect(packets).toHaveLength(1);

    const writesBefore = t.writes.length;
    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow(
      'Cannot send a request while streaming',
    );
    expect(t.writes).toHaveLength(writesBefore);
    expect(internals(v)._mode).toBe('streaming');

    // The next frame is still decoded as stream data, not read as a reply.
    t.notify(accelFrame(2));
    expect(packets).toHaveLength(2);
    expect(packets[1].decoded).toHaveLength(1);
    expect(streaming).toEqual([true]);
  });

  it('refuses it during a logged-data sync, and the sync still completes', async () => {
    const v = new VerisenseBleDevice({ debug: false });
    const writes = attachFakeTx(v);

    const sync = v.transferLoggedData({ timeoutMs: 60_000 });
    expect(internals(v)._mode).toBe('logged');
    await sleep(0);
    const writesBefore = writes.length;

    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow(
      'Cannot send a request while logged data is being transferred',
    );
    expect(writes).toHaveLength(writesBefore);
    expect(internals(v)._mode).toBe('logged');

    internals(v)._feedStreamBytes(loggedFrame(1, [0x10, 0x20, 0x30, 0x40]));
    await sleep(0); // the sync ACKs the payload on its own chain
    internals(v)._feedStreamBytes(
      new Uint8Array([buildHeader(ASM_COMMAND.ACK, ASM_PROPERTY.DATA), 0x00, 0x00]),
    );

    const result = await sync;
    expect(result.ok).toBe(true);
    expect(result.bytesWritten).toBe(8); // index + 4 data bytes + CRC
  });

  it('does not start a sync under a pending request', async () => {
    const v = new VerisenseBleDevice({ debug: false });
    attachFakeTx(v);
    const request = v.readProperty(ASM_PROPERTY.STATUS2, 50);
    await expect(v.transferLoggedData()).rejects.toThrow('A request is pending');
    await expect(request).rejects.toThrow('Request timeout');
  });

  it('refuses it during a hardware test report, and the report still arrives whole', async () => {
    const { v, t } = await connectedDevice();
    const START = '//*** TEST START ***\r\n';
    const report = v.runHardwareTestReport(1, 0, 0, { timeoutMs: 5000, marker: START });
    await sleep(5); // the TEST_MODE start is ACKed; the report text follows raw
    const writesBefore = t.writes.length;

    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow(
      'Cannot send a request while a hardware test report is running',
    );
    // A second report is refused up front: it neither clears the running
    // report's capture nor sends the device a stop.
    await expect(v.runHardwareTestReport(1)).rejects.toThrow(
      'Cannot start a hardware test report while a hardware test report is running',
    );
    expect(t.writes).toHaveLength(writesBefore);
    expect(internals(v)._testReportMode).toBe(true);

    t.notify(new TextEncoder().encode(`${START}IMU ........ PASS\r\n//*** TEST END ***\r\n`));
    await expect(report).resolves.toContain('IMU ........ PASS');
    expect(internals(v)._testReportMode).toBe(false);
  });

  it('still lets stopTestMode() through during a test report', async () => {
    const { v, t } = await connectedDevice();
    const controller = new AbortController();
    const report = v.runHardwareTestReport(1, 0, 0, { timeoutMs: 5000, signal: controller.signal });
    const aborted = expect(report).rejects.toThrow('runHardwareTestReport aborted');
    await sleep(5);

    // The exit is how a test is stopped, so the guard lets it through.
    await expect(v.stopTestMode(1)).resolves.toBeUndefined();
    const exit = t.lastWrite!.bytes;
    expect(exit[0]).toBe(buildHeader(ASM_COMMAND.WRITE, ASM_PROPERTY.TEST_MODE));
    expect(exit[3]).toBe(0x00);

    controller.abort();
    await aborted;
    await sleep(5); // let the report's own best-effort stop be ACKed
  });

  it('refuses it during a throughput test, and the blast is still counted', async () => {
    const { v, t } = await connectedDevice();
    const test = v.runThroughputTest({ durationMs: 100, idleMs: 100 });
    await sleep(5); // the data-transfer-loop command is ACKed; the blast follows raw
    const writesBefore = t.writes.length;

    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow(
      'Cannot send a request while a throughput test is running',
    );
    expect(t.writes).toHaveLength(writesBefore);

    t.notify(new Uint8Array(200));
    t.notify(new Uint8Array(200));
    const result = await test;
    expect(result.bytesReceived).toBe(400);
    expect(result.packetsReceived).toBe(2);
  });
});

describe('VerisenseBleDevice: a failed write frees the link at once', () => {
  it('rejects with the write error and leaves no pending request or timer', async () => {
    vi.useFakeTimers();
    // No transport and no TX characteristic: the write throws "Not connected".
    const v = new VerisenseBleDevice({ debug: false });

    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow('Not connected');
    expect(internals(v)._pending).toBeNull();
    expect(internals(v)._mode).toBe('idle');
    // The request's timeout is cleared, so nothing rejects later unobserved.
    expect(vi.getTimerCount()).toBe(0);

    // The next request is not refused as "already pending".
    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow('Not connected');
  });

  it('lets the next request through straight after a failed write', async () => {
    const { v, t } = await connectedDevice();
    let failNext = true;
    t.setOnWrite((bytes, tr) => {
      if (failNext) {
        failNext = false;
        throw new Error('GATT operation failed');
      }
      setTimeout(
        () => tr.notify(buildMessage(ASM_COMMAND.RESPONSE, ASM_PROPERTY.STATUS2, [1, 2, 3])),
        0,
      );
    });

    await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow('GATT operation failed');
    const rsp = await v.readProperty(ASM_PROPERTY.STATUS2);
    expect(Array.from(rsp.payload)).toEqual([1, 2, 3]);
  });

  it('hands a reply that arrives during a slow write to the caller, not to Node (DEV-1086)', async () => {
    const { v, t } = await connectedDevice();
    t.setOnWrite(async (_bytes, tr) => {
      // The device NACKs while the host's write is still in progress.
      tr.notify([buildHeader(ASM_COMMAND.NACK_GENERIC, ASM_PROPERTY.STATUS2), 0x00, 0x00]);
      await sleep(10);
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(v.readProperty(ASM_PROPERTY.STATUS2)).rejects.toThrow('NACK');
      await sleep(0);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('VerisenseBleDevice: a capture does not outlive its link', () => {
  it('a link drop ends a test report without a stop, and the next connect bootstraps at once', async () => {
    const { v, t } = await connectedDevice();
    const report = v.runHardwareTestReport(1, 0, 0, { timeoutMs: 5000 });
    const ended = expect(report).rejects.toThrow('link lost');
    await sleep(5);
    const writesBefore = t.writes.length;

    t.emitDisconnect(new Error('link lost'));
    await ended;
    // The firmware ends a report itself when its link drops: no stop is sent.
    expect(t.writes).toHaveLength(writesBefore);
    expect(internals(v)._testReportMode).toBe(false);

    await expect(v.connect()).resolves.toBe(true);
  });

  it('a new connection ends a throughput test its old link never reported gone', async () => {
    const { v } = await connectedDevice();
    const test = v.runThroughputTest({ durationMs: 100, idleMs: 100 });
    const ended = expect(test).rejects.toThrow('replaced by a new connection');
    await sleep(5);

    // connect() again with no disconnect in between: the bootstrap's reads
    // must not be refused by the old link's capture.
    await expect(v.connect()).resolves.toBe(true);
    await ended;
  });
});

describe('VerisenseBleDevice.disconnect()', () => {
  it('fails a request still waiting for its reply at once, not at its timeout', async () => {
    vi.useFakeTimers();
    const v = new VerisenseBleDevice({ debug: false });
    attachFakeTx(v);

    const request = v.readProperty(ASM_PROPERTY.STATUS2);
    const failed = expect(request).rejects.toThrow('Disconnected');
    await v.disconnect();
    await failed;

    expect(internals(v)._pending).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ends a running test report, telling the device to stop while the link is open', async () => {
    const { v, t } = await connectedDevice();
    const report = v.runHardwareTestReport(1, 0, 0, { timeoutMs: 5000 });
    const ended = expect(report).rejects.toThrow('Disconnected');
    await sleep(5);
    const writesBefore = t.writes.length;

    await v.disconnect();
    await ended;

    const sent = t.writes.slice(writesBefore).map((w) => w.bytes);
    expect(sent[0][0]).toBe(buildHeader(ASM_COMMAND.WRITE, ASM_PROPERTY.TEST_MODE));
    expect(sent[0][3]).toBe(0x00); // TEST_MODE exit
    expect(internals(v)._testReportMode).toBe(false);
    expect(internals(v)._pending).toBeNull();
  });

  it('passes its reason on to the pending request', async () => {
    const v = new VerisenseBleDevice({ debug: false });
    attachFakeTx(v);
    const request = v.readProperty(ASM_PROPERTY.STATUS2);
    const failed = expect(request).rejects.toThrow('User closed the console');
    await v.disconnect({ reason: 'User closed the console' });
    await failed;
  });
});
