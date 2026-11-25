/**
 * A Bluetooth Classic link that has carried nothing for a while answers its
 * next command late (DEV-1516). shimmer-host-core measured about 1.8 s after
 * 10-20 s of quiet; on a Shimmer3 over Web Serial, Capture Web's battery read
 * once a minute timed out on 15 reads in 26. BLE does not slow down this way.
 *
 * The sensor here answers like that: on a byte stream, the first command after
 * SLEEP_AFTER_MS of quiet in either direction is answered WAKE_LATENCY_MS late,
 * and everything else at once. Over BLE it is never late.
 *
 * The client copes in two ways, as shimmer-host-core and the Java driver do: a
 * keep-alive once the link has been quiet for `idleKeepAliveMs`, and an ACK
 * wait of at least BYTE_STREAM_LINK.MIN_ACK_WAIT_MS on a byte stream.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { BYTE_STREAM_LINK, OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { SHIMMER3_FACTORY_TEST_TYPE } from '../../src/devices/shimmer3r/factoryTest.js';
import type { Shimmer3DeviceStatus } from '../../src/devices/shimmer3r/protocol.js';
import { ACK, HW, versionReply, type FwTuple } from './configFirmware.js';

const SLEEP_AFTER_MS = 10_000;
const WAKE_LATENCY_MS = 1800;
const AWAKE_LATENCY_MS = 25;
const IDLE_MS = BYTE_STREAM_LINK.KEEP_ALIVE_IDLE_MS;

/** A615 on the bench: a Shimmer3 on LogAndStream v1.01.009, one status byte. */
const FW_A615: FwTuple = [3, 1, 1, 9];

/** Status byte 0 bits (`parseShimmer3StatusBytes`). */
const DOCKED = 0x01;
const SENSING = 0x02;
const RTC_SET = 0x04;
const SD_LOGGING = 0x08;
const SD_PRESENT = 0x20;

const KEEP_ALIVE_OPS: readonly number[] = [
  OPCODES.GET_DEVICE_VERSION_COMMAND,
  OPCODES.GET_FW_VERSION_COMMAND,
  OPCODES.GET_STATUS_COMMAND,
];

const START_BANNER =
  '//**************************** TEST START ' + '************************************//\r\n';
const END_BANNER =
  '//***************************** TEST END ' + '*************************************//\r\n';
const REPORT = START_BANNER + 'Overall Result = PASS\r\n' + END_BANNER;

interface SensorOptions {
  framed?: boolean;
  hardwareVersion?: number;
  firmware?: FwTuple;
}

/**
 * The sensor. `state.status` is what GET_STATUS answers; `silent` holds
 * opcodes it leaves unanswered and `delay` per-opcode reply delays that
 * override its own latency. `writes` records each command with when it went.
 */
function sleepySensor(opts: SensorOptions = {}) {
  const framed = opts.framed ?? false;
  const t = new LoopbackTransport({
    capabilities: framed ? {} : { framed: false },
    deviceName: framed ? 'Shimmer3-BLE' : 'Shimmer3-SPP',
  });
  const t0 = Date.now();
  const state = {
    status: RTC_SET | SD_PRESENT,
    lastTraffic: t0,
    lateReplies: 0,
    silent: new Set<number>(),
    delay: new Map<number, number>(),
    writes: [] as { op: number; at: number }[],
  };
  /**
   * Bytes to the host: whole over BLE; over a byte stream three at a time,
   * each read a task after the last, as a serial port hands them over.
   */
  const deliver = (bytes: number[]): void => {
    if (framed) {
      state.lastTraffic = Date.now();
      t.notify(bytes);
      return;
    }
    for (let i = 0; i < bytes.length; i += 3) {
      const read = bytes.slice(i, i + 3);
      setTimeout(() => {
        state.lastTraffic = Date.now();
        t.notify(read);
      }, 0);
    }
  };
  const answer = (op: number, cmd: Uint8Array): number[] | null => {
    const version = versionReply(op, opts.hardwareVersion ?? HW.SHIMMER3, opts.firmware ?? FW_A615);
    if (version) return version;
    switch (op) {
      case OPCODES.GET_STATUS_COMMAND:
        return [ACK, OPCODES.INSTREAM_CMD_RESPONSE, OPCODES.STATUS_RESPONSE, state.status];
      case OPCODES.GET_VBATT_COMMAND:
        return [ACK, OPCODES.INSTREAM_CMD_RESPONSE, OPCODES.VBATT_RESPONSE, 0x00, 0x0b, 0x00];
      case OPCODES.START_LOGGING_COMMAND:
        state.status |= SENSING | SD_LOGGING;
        return [ACK];
      case OPCODES.STOP_LOGGING_COMMAND:
        state.status &= ~(SENSING | SD_LOGGING);
        return [ACK];
      case OPCODES.SET_FACTORY_TEST:
        return [ACK, ...Array.from(REPORT, (c) => c.charCodeAt(0))];
      case OPCODES.SET_DATA_RATE_TEST:
        // The test traffic itself is left out: the link stays quiet throughout
        return cmd[1] === 1 ? [ACK] : [ACK];
      default:
        return [ACK];
    }
  };
  t.setOnWrite((raw) => {
    const cmd = new Uint8Array(raw);
    const op = cmd[0];
    const now = Date.now();
    state.writes.push({ op, at: now - t0 });
    const late = !framed && now - state.lastTraffic >= SLEEP_AFTER_MS;
    state.lastTraffic = now;
    if (late) state.lateReplies++;
    if (state.silent.has(op)) return;
    const reply = answer(op, cmd);
    if (!reply) return;
    const wait = state.delay.get(op) ?? (late ? WAKE_LATENCY_MS : AWAKE_LATENCY_MS);
    setTimeout(() => deliver(reply), wait);
  });
  /** A status the firmware sends unasked: a dock, the button, a log's end. */
  const push = (status: number): void => {
    state.status = status;
    deliver([OPCODES.INSTREAM_CMD_RESPONSE, OPCODES.STATUS_RESPONSE, status]);
  };
  const ops = (): number[] => state.writes.map((w) => w.op);
  const keepAlives = (): number => ops().filter((op) => KEEP_ALIVE_OPS.includes(op)).length;
  return { t, state, push, ops, keepAlives };
}

async function connected(opts: SensorOptions & { idleKeepAliveMs?: number } = {}) {
  const sensor = sleepySensor(opts);
  const client = new Shimmer3RClient({ debug: false, idleKeepAliveMs: opts.idleKeepAliveMs });
  const lines: string[] = [];
  const pushes: Shimmer3DeviceStatus[] = [];
  client.onStatus = (line) => lines.push(line);
  client.onDeviceStatus = (status) => pushes.push(status);
  await client.connect(sensor.t);
  lines.length = 0;
  return { ...sensor, client, lines, pushes };
}

/** `p`, once fake time has run until it settled; it fails if `ms` is not enough. */
async function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let settled = false;
  const watched = p.finally(() => {
    settled = true;
  });
  watched.catch(() => undefined);
  for (let waited = 0; waited < ms && !settled; waited += 25) {
    await vi.advanceTimersByTimeAsync(25);
  }
  if (!settled) throw new Error(`still pending after ${ms} ms`);
  return watched;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('a byte-stream link left quiet: the ACK wait', () => {
  it("answers the first command after a minute's quiet, which took 1.8 s", async () => {
    // The keep-alive is off, so this is the floor on its own.
    const s = await connected({ idleKeepAliveMs: 0 });
    await vi.advanceTimersByTimeAsync(60_000);

    // getBattery asks for 1500 ms; the link takes 1800.
    const battery = s.client.getBattery();
    await expect(within(battery, 2500)).resolves.toMatchObject({
      chargingStatus: expect.anything(),
    });
    expect(s.state.lateReplies).toBe(1);
  });

  it('is never less than 2 s on a byte stream, whatever the caller asked for', async () => {
    const s = await connected({ idleKeepAliveMs: 0 });
    s.state.silent.add(OPCODES.GET_VBATT_COMMAND);
    let failed: Error | null = null;
    s.client.getBattery().catch((e: Error) => (failed = e));

    await vi.advanceTimersByTimeAsync(BYTE_STREAM_LINK.MIN_ACK_WAIT_MS - 1);
    expect(failed).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(failed).toMatchObject({ message: 'ACK timeout' });
  });

  it('is unchanged over BLE, which does not slow down', async () => {
    const s = await connected({ framed: true });
    s.state.silent.add(OPCODES.GET_VBATT_COMMAND);
    let failed: Error | null = null;
    s.client.getBattery().catch((e: Error) => (failed = e));

    await vi.advanceTimersByTimeAsync(1500);
    expect(failed).toMatchObject({ message: 'ACK timeout' });
  });
});

describe('a byte-stream link left quiet: the keep-alive', () => {
  it('keeps the link awake, so a command after a minute is answered at once', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.keepAlives()).toBeGreaterThanOrEqual(10);
    expect(s.state.lateReplies).toBe(0);

    const battery = s.client.getBattery();
    await expect(within(battery, 100)).resolves.toBeDefined();
    expect(s.state.lateReplies).toBe(0);
  });

  it('goes once the link has been quiet for 5 s, then every 5 s after the last reply', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(IDLE_MS - 1);
    expect(s.state.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state.writes).toEqual([{ op: OPCODES.GET_DEVICE_VERSION_COMMAND, at: IDLE_MS }]);

    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS + 5));
    const at = s.state.writes.map((w) => w.at);
    expect(at).toHaveLength(4);
    // Each after the reply's last read, which comes a few ms after its first
    for (let i = 1; i < at.length; i++) {
      expect(at[i] - at[i - 1]).toBeGreaterThanOrEqual(IDLE_MS + AWAKE_LATENCY_MS);
      expect(at[i] - at[i - 1]).toBeLessThanOrEqual(IDLE_MS + AWAKE_LATENCY_MS + 5);
    }
  });

  it('reads the versions it needs once each, then the status', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(4 * (IDLE_MS + AWAKE_LATENCY_MS));
    expect(s.ops()).toEqual([
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_FW_VERSION_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
    ]);
    // Cached, as the client's own reads would have cached them
    const before = s.state.writes.length;
    await expect(s.client.readDeviceVersion()).resolves.toEqual({ hardwareVersion: HW.SHIMMER3 });
    await expect(s.client.readFwVersion()).resolves.toMatchObject({ major: 1, minor: 1, patch: 9 });
    expect(s.state.writes).toHaveLength(before);
  });

  it('reads a version a host already read no more', async () => {
    const s = await connected();
    await within(s.client.readDeviceVersion(), 100);
    await within(s.client.readFwVersion(), 100);
    await vi.advanceTimersByTimeAsync(30_000);
    const keepAliveOps = s.ops().slice(2);
    expect(keepAliveOps.length).toBeGreaterThan(0);
    expect(new Set(keepAliveOps)).toEqual(new Set([OPCODES.GET_STATUS_COMMAND]));
  });

  it('says nothing, and reports no status that has not changed', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.lines).toEqual([]);
    expect(s.pushes).toEqual([]);
  });

  it('reports a change it finds, once: a push its read took for its answer would have said so', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(4 * (IDLE_MS + AWAKE_LATENCY_MS)); // two status reads
    s.state.status |= DOCKED;
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS));
    expect(s.pushes).toHaveLength(1);
    expect(s.pushes[0]).toMatchObject({ docked: true });
    expect(s.lines).toEqual([]);
  });

  it('makes a command issued while it is in flight wait for it', async () => {
    const s = await connected();
    s.state.delay.set(OPCODES.GET_DEVICE_VERSION_COMMAND, 1000);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    expect(s.ops()).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND]);

    const battery = s.client.getBattery();
    await vi.advanceTimersByTimeAsync(500);
    expect(s.ops()).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND]);

    await expect(within(battery, 1000)).resolves.toBeDefined();
    expect(s.ops()).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND, OPCODES.GET_VBATT_COMMAND]);
    expect(s.state.writes[1].at).toBeGreaterThanOrEqual(IDLE_MS + 1000);
  });

  it('goes only once the link is free', async () => {
    const s = await connected();
    // A command whose reply is slow: no keep-alive goes out over it
    s.state.delay.set(OPCODES.GET_VBATT_COMMAND, 1900);
    await vi.advanceTimersByTimeAsync(IDLE_MS - 100);
    const battery = s.client.getBattery();
    await expect(within(battery, 2500)).resolves.toBeDefined();
    expect(s.ops()[0]).toBe(OPCODES.GET_VBATT_COMMAND);
    expect(
      s
        .ops()
        .slice(1)
        .every((op) => KEEP_ALIVE_OPS.includes(op)),
    ).toBe(true);
  });

  it('lets an unanswered round go, silently, and the next command still works', async () => {
    const s = await connected();
    s.state.silent.add(OPCODES.GET_DEVICE_VERSION_COMMAND);
    await vi.advanceTimersByTimeAsync(IDLE_MS + BYTE_STREAM_LINK.MIN_ACK_WAIT_MS + 10);
    expect(s.lines).toEqual([]);
    s.state.silent.clear();
    await expect(within(s.client.getBattery(), 100)).resolves.toBeDefined();
  });

  it('stays quiet while streaming, and starts again after the stop', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS)); // versions learnt
    await within(s.client.startStreaming(), 100);
    const atStart = s.state.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toHaveLength(atStart);

    // This stream sent nothing for a minute, so the stop is answered late, and
    // the link is quiet from that answer on
    await within(s.client.stopStreaming(), 1000);
    await vi.advanceTimersByTimeAsync(WAKE_LATENCY_MS + IDLE_MS + 500);
    expect(s.ops().at(-1)).toBe(OPCODES.GET_STATUS_COMMAND);
  });

  it('stays quiet while the sensor logs, from a log started by command', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS));
    await within(s.client.startLogging(), 100);
    const atStart = s.state.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toHaveLength(atStart);

    // A stop costs a late reply (60 s quiet), which the 2 s wait covers
    await within(s.client.stopLogging(), 2500);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 100);
    expect(s.ops().at(-1)).toBe(OPCODES.GET_STATUS_COMMAND);
  });

  it('stays quiet while a status push says the sensor is logging', async () => {
    const s = await connected();
    // Just after the first status read, so the push does not land inside one
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS) + 100);
    s.push(RTC_SET | SD_PRESENT | SENSING | SD_LOGGING); // the button
    await vi.advanceTimersByTimeAsync(10);
    expect(s.pushes.at(-1)).toMatchObject({ sdLogging: true });
    const atPush = s.state.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toHaveLength(atPush);

    s.push(RTC_SET | SD_PRESENT); // the log's duration ran out
    await vi.advanceTimersByTimeAsync(IDLE_MS + BYTE_STREAM_LINK.KEEP_ALIVE_RETRY_MS);
    expect(s.state.writes.length).toBeGreaterThan(atPush);
  });

  it('pauses itself when its own read finds the sensor logging', async () => {
    const s = await connected();
    s.state.status |= SENSING | SD_LOGGING; // logging since before this link
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS));
    expect(s.ops()).toEqual([
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_FW_VERSION_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
    ]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.ops()).toHaveLength(3);
  });

  it('stays quiet during the data-rate test', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS));
    const atStart = s.state.writes.length;
    const test = s.client.runDataRateTest(20_000);
    await within(test, 25_000);
    const during = s.ops().slice(atStart);
    expect(during).toEqual([OPCODES.SET_DATA_RATE_TEST, OPCODES.SET_DATA_RATE_TEST]);
  });

  it('does not make a factory test refuse to start, and stays out of its way', async () => {
    const s = await connected();
    s.state.delay.set(OPCODES.GET_DEVICE_VERSION_COMMAND, 500);
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10); // the keep-alive is in flight
    const report = s.client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false });
    await expect(within(report, 1000)).resolves.toBe(REPORT);
    expect(s.ops()).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND, OPCODES.SET_FACTORY_TEST]);
  });

  it('stops when the host disconnects, and starts afresh on the next link', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(3 * (IDLE_MS + AWAKE_LATENCY_MS));
    await s.client.disconnect();
    const atEnd = s.state.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toHaveLength(atEnd);

    await s.client.connect(s.t);
    await vi.advanceTimersByTimeAsync(IDLE_MS);
    // A different sensor, perhaps: its versions are read again
    expect(s.ops().at(-1)).toBe(OPCODES.GET_DEVICE_VERSION_COMMAND);
  });

  it('stops when the link drops', async () => {
    const s = await connected();
    await vi.advanceTimersByTimeAsync(IDLE_MS + 10); // its first round in flight
    s.t.emitDisconnect(new Error('out of range'));
    const atDrop = s.state.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toHaveLength(atDrop);
  });

  it('never runs over BLE', async () => {
    const s = await connected({ framed: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toEqual([]);
  });
});

describe('idleKeepAliveMs', () => {
  it('turns the keep-alive off at 0, and back on at once when set', async () => {
    const s = await connected({ idleKeepAliveMs: 0 });
    expect(s.client.idleKeepAliveMs).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toEqual([]);

    // Quiet for a minute already, so the first round goes at once
    s.client.idleKeepAliveMs = IDLE_MS;
    await vi.advanceTimersByTimeAsync(0);
    expect(s.ops()).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND]);

    await vi.advanceTimersByTimeAsync(5000);
    s.client.idleKeepAliveMs = 0;
    const atOff = s.state.writes.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(s.state.writes).toHaveLength(atOff);
  });

  it('takes a different period', async () => {
    const s = await connected({ idleKeepAliveMs: 2000 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(s.state.writes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(s.state.writes).toHaveLength(1);
  });

  it('defaults to 5 s, the Java driver and shimmer-host-core period', () => {
    expect(new Shimmer3RClient({ debug: false }).idleKeepAliveMs).toBe(5000);
  });

  it('refuses a negative or non-finite period', () => {
    expect(() => new Shimmer3RClient({ debug: false, idleKeepAliveMs: -1 })).toThrow(RangeError);
    const client = new Shimmer3RClient({ debug: false });
    expect(() => (client.idleKeepAliveMs = Number.NaN)).toThrow(RangeError);
    expect(() => (client.idleKeepAliveMs = Infinity)).toThrow(RangeError);
    expect(client.idleKeepAliveMs).toBe(5000);
  });
});
