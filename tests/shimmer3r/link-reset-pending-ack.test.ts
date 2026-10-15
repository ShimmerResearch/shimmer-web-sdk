import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { SHIMMER3_FACTORY_TEST_TYPE } from '../../src/devices/shimmer3r/factoryTest.js';
import {
  SD_TRANSFER_OPCODES as SD,
  SD_STATUS,
} from '../../src/devices/shimmer3r/sdTransfer/protocol.js';

/* Review finding (a "reconnect race"): a command whose ACK was still awaited
   when the link dropped left its waiter registered. On the next link, that
   waiter took the first ACK - and the response coalesced behind it, which the
   remainder hand-off gives to whichever waiter runs first - so the new link's
   own command timed out, and the ACK count stayed one too high for good. The
   data-rate test's stop made this likely: it waits up to 2 s for its ACK. */

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const TP = OPCODES.DATA_RATE_TEST_RESPONSE;
const FW = [OPCODES.FW_VERSION_RESPONSE, 3, 0, 1, 0, 1, 17];
/** Shimmer3R hardware; with `FW`, LogAndStream v1.01.017, two status bytes. */
const DEVVER = [OPCODES.DEVICE_VERSION_RESPONSE, 10];
/** The reply to a version read, which a status read makes first to learn its width. */
const versionOf = (op: number): number[] =>
  op === OPCODES.GET_DEVICE_VERSION_COMMAND
    ? DEVVER
    : op === OPCODES.GET_FW_VERSION_COMMAND
      ? FW
      : [];
const pkt = (c: number): number[] => [TP, c & 0xff, (c >> 8) & 0xff, 0, 0];
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const expectingAck = (c: Shimmer3RClient): number =>
  (c as unknown as { _expectingAck: number })._expectingAck;

/** A device that ACKs everything, except what `silent` names, which it never answers. */
function device(silent: (cmd: Uint8Array) => boolean): LoopbackTransport {
  const t = new LoopbackTransport();
  t.setOnWrite((bytes, tr) => {
    const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (silent(cmd)) return;
    if (cmd[0] === OPCODES.SET_DATA_RATE_TEST && cmd[1] === 1) {
      setTimeout(() => tr.notify(new Uint8Array([ACK, ...pkt(0), ...pkt(1)])), 0);
    } else if (cmd[0] === OPCODES.GET_FW_VERSION_COMMAND) {
      setTimeout(() => tr.notify(new Uint8Array([ACK, ...FW])), 0);
    } else {
      setTimeout(() => tr.notify(new Uint8Array([ACK])), 0);
    }
  });
  return t;
}
const answersAll = (): boolean => false;

describe('a command pending when the link drops', () => {
  it("does not take the next link's ACK and reply: data-rate stop", async () => {
    const isStop = (c: Uint8Array): boolean => c[0] === OPCODES.SET_DATA_RATE_TEST && c[1] === 0;
    const first = device(isStop);
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const test = client.runDataRateTest(100);
    await tick(160); // the stop has gone out and its ACK is awaited
    first.emitDisconnect(new Error('dropped'));

    await client.connect(device(answersAll));
    const v = await client.readFwVersion();
    expect(`${v.major}.${v.minor}.${v.patch}`).toBe('1.1.17');
    await test; // the measurement was over before the drop
    expect(expectingAck(client)).toBe(0);
  });

  it("does not take the next link's ACK and reply: any command", async () => {
    const first = device((c) => c[0] === OPCODES.GET_FW_VERSION_COMMAND);
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const stranded = client.readFwVersion().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    first.emitDisconnect(new Error('dropped'));

    await client.connect(device(answersAll));
    const v = await client.readFwVersion();
    expect(`${v.major}.${v.minor}.${v.patch}`).toBe('1.1.17');
    expect(await stranded).toMatch(/link was reset/);
    expect(expectingAck(client)).toBe(0);
  });

  it("does not take the next link's ACK and reply: a write still in flight at the reset", async () => {
    /* Review finding: the write is asynchronous. A waiter registered after it
       resolves - here once the link has already been replaced - used to read
       the next link's generation, pass as current, and take that link's ACK
       and reply. */
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    const first = new LoopbackTransport();
    first.setOnWrite(async (bytes) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) await held; // never answered
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const stranded = client.readFwVersion().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20); // its write is still pending
    first.emitDisconnect(new Error('dropped'));

    await client.connect(device(answersAll));
    const fresh = client.readFwVersion();
    // The old write completes just before the new link's reply arrives, so
    // its command would be first in line for it
    release();
    const v = await fresh;
    expect(`${v.major}.${v.minor}.${v.patch}`).toBe('1.1.17');
    expect(await stranded).toMatch(/link was reset/);
    expect(expectingAck(client)).toBe(0);
  });

  /* The same rule for every reply waiter on the temp plane, raised in review:
     a stranded operation must not accept a reply from a later connection. */
  const STATUS = [OPCODES.INSTREAM_CMD_RESPONSE, OPCODES.STATUS_RESPONSE, 0x24, 0x01];
  const infomem = (n: number): number[] => [
    OPCODES.INFOMEM_RESPONSE,
    n,
    ...Array.from({ length: n }, (_, k) => 0x40 + k),
  ];
  /** A device that answers status and InfoMem reads in full, each reply in a
   *  notification of its own after the ACK's, as BLE can deliver them. (A reply
   *  packed in behind the ACK goes to the ACK's own waiter alone, so a split
   *  reply is the case in which a stranded waiter sees all of it.) */
  function fullDevice(): LoopbackTransport {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      const reply =
        cmd[0] === OPCODES.GET_STATUS_COMMAND
          ? STATUS
          : cmd[0] === OPCODES.GET_INFOMEM_COMMAND
            ? infomem(cmd[1])
            : versionOf(cmd[0]);
      setTimeout(() => tr.notify(new Uint8Array([ACK])), 0);
      if (reply.length) setTimeout(() => tr.notify(new Uint8Array(reply)), 0);
    });
    return t;
  }

  it("a status read waiting for its instream reply does not take the next link's", async () => {
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      // The version reads answered, so the status read itself goes out. Then
      // ACK only: its instream reply never comes on this link.
      setTimeout(() => tr.notify(new Uint8Array([ACK, ...versionOf(bytes[0])])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const stranded = client.getStatus().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    first.emitDisconnect(new Error('dropped'));

    await client.connect(fullDevice());
    await client.getStatus();
    expect(await stranded).toMatch(/link was reset/);
  });

  it('an InfoMem read with half its reply does not take the rest from the next link', async () => {
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      // the opcode, length and 4 of the bytes asked for, then nothing
      setTimeout(() => tr.notify(new Uint8Array([ACK, ...infomem(cmd[1]).slice(0, 6)])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const stranded = client.readInfoMem(0, 16).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    first.emitDisconnect(new Error('dropped'));

    await client.connect(fullDevice());
    const data = await client.readInfoMem(0, 16);
    expect(Array.from(data)).toEqual(infomem(16).slice(2));
    expect(await stranded).toMatch(/link was reset/);
  });

  it('an SD command fails at the reset rather than refusing new SD commands until it times out', async () => {
    const client = new Shimmer3RClient({ debug: false });
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...FW])), 0);
      } else {
        setTimeout(() => tr.notify(new Uint8Array([ACK])), 0); // and no SD reply
      }
    });
    await client.connect(first);
    const started = client.sdListDir('data').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(50); // the listing has been asked for and is awaited
    const droppedAt = Date.now();
    first.emitDisconnect(new Error('dropped'));
    expect(await started).toMatch(/link was reset/);
    expect(Date.now() - droppedAt).toBeLessThan(1000); // not its 5 s timeout
    expect((client as unknown as { _sdExpect: unknown })._sdExpect).toBeNull();
  });

  it('an SD file read fails at the reset rather than waiting out its stall timer', async () => {
    const client = new Shimmer3RClient({ debug: false });
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      const cmd = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (cmd[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...FW])), 0);
      } else {
        setTimeout(() => tr.notify(new Uint8Array([ACK])), 0); // and no data frames
      }
    });
    await client.connect(first);
    const reading = client.sdReadFileWindow('data/f.bin', 0, 4096).then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(50); // the window has been asked for and is awaited
    const droppedAt = Date.now();
    first.emitDisconnect(new Error('dropped'));
    expect(await reading).toMatch(/link was reset/);
    expect(Date.now() - droppedAt).toBeLessThan(1000); // not its 6 s stall timer
    expect((client as unknown as { _sdFrameListener: unknown })._sdFrameListener).toBeNull();
  });

  it("an SD command's write failing after the reset leaves the next link's SD command alone", async () => {
    /* Review finding: the reset rejects the SD command but cannot cancel its
       write. A write that failed only after the next link's SD command had
       taken the slot emptied it, and that command's response was ignored
       until it timed out. */
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    const client = new Shimmer3RClient({ debug: false });
    const first = new LoopbackTransport();
    first.setOnWrite(async (bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...FW])), 0);
      } else {
        await held; // the SD command's write is still pending at the drop
      }
    });
    await client.connect(first);
    const stranded = client.sdListDir('data').then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(50);
    first.emitDisconnect(new Error('dropped'));
    expect(await stranded).toMatch(/link was reset/);

    // One entry, 'f.bin' of 4 bytes: attribute, size, date, time, name
    const name = Array.from(new TextEncoder().encode('f.bin'));
    const entry = [0, 4, 0, 0, 0, 0, 0, 0, 0, name.length, ...name];
    const listing = [SD.LIST_DIR_RESPONSE, SD_STATUS.OK, 0, 0, entry.length, 0, 1, 0, ...entry];
    const second = new LoopbackTransport();
    second.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...FW])), 0);
      } else if (bytes[0] === SD.LIST_DIR_COMMAND) {
        // late enough that the old write has failed by then
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...listing])), 30);
      }
    });
    await client.connect(second);
    const reply = client.sdListDir('data').catch((e: Error) => e.message);
    await tick(10); // the new command holds the slot
    release();
    const got = await Promise.race([reply, tick(1000).then(() => 'no listing after 1 s')]);
    expect(got).toMatchObject([{ name: 'f.bin', size: 4 }]);
  });

  it("a status read stranded on the old link does not hide the next link's status pushes", async () => {
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      // The version reads answered, so the status read is claimed and goes
      // out; it gets an ACK and no reply.
      setTimeout(() => tr.notify(new Uint8Array([ACK, ...versionOf(bytes[0])])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    const pushes: unknown[] = [];
    client.onDeviceStatus = (s) => pushes.push(s);
    await client.connect(first);
    const stranded = client.getStatus().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20);
    first.emitDisconnect(new Error('dropped'));

    const second = fullDevice();
    await client.connect(second);
    second.notify(new Uint8Array(STATUS)); // unsolicited, as on docking
    expect(pushes).toHaveLength(1);
    expect(await stranded).toMatch(/link was reset/);
  });
});

describe('a multi-step operation a reconnect splits', () => {
  /* Review finding: each step of these operations captured the link afresh,
     so a drop and a reconnect between two steps sent the later one to the
     device that replaced the first - and a caught reset read as a failed
     refresh or a missing calibration group. Each operation is now bound to
     the link it began on, and fails when that link goes. */
  const INQ = [OPCODES.INQUIRY_RESPONSE, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0x0a, 0x0b, 0x0c];
  const CALIB: Record<number, number> = {
    [OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND]: OPCODES.LN_ACCEL_CALIBRATION_RESPONSE,
    [OPCODES.GET_GYRO_CALIBRATION_COMMAND]: OPCODES.GYRO_CALIBRATION_RESPONSE,
    [OPCODES.GET_MAG_CALIBRATION_COMMAND]: OPCODES.MAG_CALIBRATION_RESPONSE,
    [OPCODES.GET_WR_ACCEL_CALIBRATION_COMMAND]: OPCODES.WR_ACCEL_CALIBRATION_RESPONSE,
    [OPCODES.GET_ALT_ACCEL_CALIBRATION_COMMAND]: OPCODES.ALT_ACCEL_CALIBRATION_RESPONSE,
    [OPCODES.GET_ALT_MAG_CALIBRATION_COMMAND]: OPCODES.ALT_MAG_CALIBRATION_RESPONSE,
  };
  /** A device that answers everything these operations send - its ExG banks
   *  held as written - except `silent`, which it never answers. */
  function regDevice(silent?: number): LoopbackTransport {
    const banks = [new Array<number>(10).fill(0), new Array<number>(10).fill(0)];
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const cmd = Array.from(bytes);
      if (cmd[0] === silent) return;
      let reply: number[] = [];
      if (cmd[0] === OPCODES.SET_EXG_REGS_COMMAND) banks[cmd[1]] = cmd.slice(4, 14);
      else if (cmd[0] === OPCODES.GET_EXG_REGS_COMMAND) {
        reply = [OPCODES.EXG_REGS_RESPONSE, 10, ...banks[cmd[1]]];
      } else if (cmd[0] === OPCODES.INQUIRY_COMMAND) reply = INQ;
      else if (CALIB[cmd[0]] !== undefined)
        reply = [CALIB[cmd[0]], ...new Array<number>(21).fill(1)];
      setTimeout(() => tr.notify(new Uint8Array([ACK, ...reply])), 0);
    });
    return t;
  }
  const sent = (t: LoopbackTransport): number[] => t.writes.map((w) => w.bytes[0]);

  /** A client on `first`, and a `swap` that drops it and starts connecting `second`. */
  async function onFirst(): Promise<{
    client: Shimmer3RClient;
    first: LoopbackTransport;
    second: LoopbackTransport;
    swap: () => void;
    reconnected: () => Promise<void>;
  }> {
    const first = regDevice();
    const second = regDevice();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    let reconnecting: Promise<void> = Promise.resolve();
    const swap = (): void => {
      first.emitDisconnect(new Error('dropped'));
      reconnecting = client.connect(second);
    };
    return { client, first, second, swap, reconnected: () => reconnecting };
  }
  /** Run `swap` once, as soon as `client` reports a status starting `prefix`. */
  function swapAtStatus(client: Shimmer3RClient, prefix: string, swap: () => void): void {
    client.onStatus = (m) => {
      if (!m.startsWith(prefix)) return;
      client.onStatus = null;
      swap();
    };
  }
  /** Run `swap` once, after the private step `name` has returned for a call `when` picks. */
  function swapAfterStep(
    client: Shimmer3RClient,
    name: string,
    when: (args: unknown[]) => boolean,
    swap: () => void,
  ): void {
    const priv = client as unknown as Record<string, (...a: unknown[]) => Promise<unknown>>;
    const step = priv[name].bind(client);
    let done = false;
    priv[name] = async (...a: unknown[]) => {
      const r = await step(...a);
      if (!done && when(a)) {
        done = true;
        swap();
      }
      return r;
    };
  }

  it('setSensors fails, and does not re-inquire the next device', async () => {
    const { client, second, swap, reconnected } = await onFirst();
    swapAtStatus(client, 'Sensors ACK received', swap);
    await expect(client.setSensors(0x000080)).rejects.toThrow(/link was reset/);
    await reconnected();
    // No phantom ACK left counted against the next link
    expect(expectingAck(client)).toBe(0);
    expect(sent(second)).not.toContain(OPCODES.INQUIRY_COMMAND);
  });

  it('setSensors fails when its onInquiry callback replaces the link', async () => {
    const { client, swap, reconnected } = await onFirst();
    client.onInquiry = () => {
      client.onInquiry = null;
      swap();
    };
    await expect(client.setSensors(0x000080)).rejects.toThrow(/link was reset/);
    await reconnected();
    // The old device's bitmap, stored before the callback ran, is not the next one's
    expect(client.getEnabledSensors()).toBe(0);
  });

  it('setSensors fails when its onInquiry callback disconnects', async () => {
    const { client } = await onFirst();
    let disconnected: Promise<void> = Promise.resolve();
    client.onInquiry = () => {
      client.onInquiry = null;
      disconnected = client.disconnect(); // resets the link only after its own await
    };
    await expect(client.setSensors(0x000080)).rejects.toThrow(/link was reset/);
    await disconnected;
    // The old device's bitmap did not land after the disconnect cleared it
    expect(client.getEnabledSensors()).toBe(0);
  });

  it('readCalibration fails when the skip of its last group reconnects', async () => {
    const first = regDevice(OPCODES.GET_ALT_MAG_CALIBRATION_COMMAND);
    const second = regDevice();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    let reconnected: Promise<void> = Promise.resolve();
    client.onStatus = (m) => {
      if (!m.startsWith('readCalibration(altMag) skipped')) return;
      client.onStatus = null;
      first.emitDisconnect(new Error('dropped'));
      reconnected = client.connect(second);
    };
    await expect(client.readCalibration(100)).rejects.toThrow(/link was reset/);
    await reconnected;
  });

  it('an inquiry reply does not land on the next link when its status line reconnects', async () => {
    const { client, swap, reconnected } = await onFirst();
    swapAtStatus(client, 'Inquiry RSP', swap);
    await expect(client.setSensors(0x000080)).rejects.toThrow(/link was reset/);
    await reconnected();
    expect((client as unknown as { schema: unknown }).schema).toBeNull();
    expect(client.getEnabledSensors()).toBe(0);
  });

  it('an ExG preset fails when the link is disconnected as its last step completes', async () => {
    const { client } = await onFirst();
    let disconnected: Promise<void> = Promise.resolve();
    client.onStatus = (m) => {
      if (!m.startsWith('Inquiry complete')) return;
      client.onStatus = null;
      disconnected = client.disconnect(); // resets the link only after its own await
    };
    const said: string[] = [];
    const onStatus = client.onStatus;
    client.onStatus = (m) => {
      said.push(m);
      onStatus?.(m);
    };
    await expect(client.applyExgPresetLive('ecg', '16bit')).rejects.toThrow(/link was reset/);
    await disconnected;
    expect(said.some((m) => /preset .* applied/.test(m))).toBe(false);
  });

  it("readExgConfig does not take chip 2's bank from the next device", async () => {
    const { client, second, swap, reconnected } = await onFirst();
    swapAfterStep(client, '_readExgChip', (a) => a[0] === 0, swap);
    await expect(client.readExgConfig()).rejects.toThrow(/link was reset/);
    await reconnected();
    // No phantom ACK left counted against the next link
    expect(expectingAck(client)).toBe(0);
    expect(sent(second)).not.toContain(OPCODES.GET_EXG_REGS_COMMAND);
  });

  it("writeExgConfig does not verify against the next device's registers", async () => {
    const { client, second, swap, reconnected } = await onFirst();
    swapAfterStep(
      client,
      '_writeExpectingAck',
      (a) => {
        const cmd = a[0] as Uint8Array;
        return cmd[0] === OPCODES.SET_EXG_REGS_COMMAND && cmd[1] === 1;
      },
      swap,
    );
    const bank = new Uint8Array(10);
    await expect(client.writeExgConfig(bank, bank)).rejects.toThrow(/link was reset/);
    await reconnected();
    // No phantom ACK left counted against the next link
    expect(expectingAck(client)).toBe(0);
    expect(sent(second)).not.toContain(OPCODES.GET_EXG_REGS_COMMAND);
  });

  it('an ExG preset dropped part-way fails, rather than finish on the next device', async () => {
    const { client, second, swap, reconnected } = await onFirst();
    const said: string[] = [];
    swapAtStatus(client, 'ExG registers written', swap);
    const onStatus = client.onStatus;
    client.onStatus = (m) => {
      said.push(m);
      onStatus?.(m);
    };
    await expect(client.applyExgPresetLive('ecg', '16bit')).rejects.toThrow(/link was reset/);
    await reconnected();
    // No phantom ACK left counted against the next link
    expect(expectingAck(client)).toBe(0);
    expect(sent(second)).not.toContain(OPCODES.SET_SENSORS_COMMAND);
    expect(said.some((m) => /preset .* applied/.test(m))).toBe(false);
  });

  it('readCalibration fails at a drop, rather than read the rest from the next device', async () => {
    const first = regDevice(OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND);
    const second = regDevice();
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const reading = client.readCalibration().then(
      (groups) => groups,
      (e: Error) => e.message,
    );
    await tick(20); // the first group's ACK is awaited
    first.emitDisconnect(new Error('dropped'));
    await client.connect(second);
    expect(await reading).toMatch(/link was reset/);
    for (const get of Object.keys(CALIB).map(Number)) expect(sent(second)).not.toContain(get);
    expect(expectingAck(client)).toBe(0);
  });
});

describe('the transport of a link that dropped', () => {
  it('has its late traffic and disconnect ignored on the next link', async () => {
    const first = device(answersAll);
    const client = new Shimmer3RClient({ debug: false });
    let drops = 0;
    client.onDisconnect = () => drops++;
    await client.connect(first);
    first.emitDisconnect(new Error('dropped'));

    const second = new LoopbackTransport();
    second.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...FW])), 30);
      }
    });
    await client.connect(second);
    const v = client.readFwVersion();
    await tick(5);
    // A reply the old link's transport delivers late, from a different firmware
    first.notify(new Uint8Array([ACK, OPCODES.FW_VERSION_RESPONSE, 3, 0, 9, 0, 9, 0]));
    const got = await v;
    expect(`${got.major}.${got.minor}.${got.patch}`).toBe('1.1.17');

    first.emitDisconnect(new Error('late'));
    expect(drops).toBe(1);
  });
});

describe('a link reset with a command still waiting', () => {
  it('fails the command at once, so the next link can start a factory test', async () => {
    /* Review finding: the reset zeroed the ACK count but left the command's
       waiter registered, to fail at the next link's traffic or at its own
       timeout. runFactoryTest refuses to start while any waiter is registered,
       so until then it reported the next link busy. */
    const first = device((c) => c[0] === OPCODES.GET_FW_VERSION_COMMAND);
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    const stranded = client.readFwVersion().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20); // its ACK is awaited
    first.emitDisconnect(new Error('dropped'));
    // Nothing has arrived on any link since, so only the reset can fail it
    const early = await Promise.race([stranded, tick(200).then(() => 'still waiting')]);
    expect(early).toMatch(/link was reset/);

    const report =
      '//**************************** TEST START ' +
      '************************************//\r\n' +
      'Overall Result = PASS\r\n' +
      '//***************************** TEST END ' +
      '*************************************//\r\n';
    const second = new LoopbackTransport();
    second.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_FACTORY_TEST) {
        const text = Uint8Array.from(report, (c) => c.charCodeAt(0));
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...text])), 0);
      }
    });
    await client.connect(second);
    const run = client.runFactoryTest(SHIMMER3_FACTORY_TEST_TYPE.MAIN, { preflight: false });
    await expect(run).resolves.toBe(report);
  });
});

describe('a write the old transport holds across a reconnect', () => {
  /* Review finding: a held write failed only when the old transport let go of
     it, and its caller's cleanup then ran against the link that had replaced
     it. The write now fails at the reset, and the cleanups it could reach only
     touch their own link's state. */
  const streaming = (c: Shimmer3RClient): boolean =>
    (c as unknown as { _streaming: boolean })._streaming;
  function holding(opcode: number): { t: LoopbackTransport; release: () => void } {
    let release = (): void => undefined;
    const held = new Promise<void>((r) => (release = r));
    const t = new LoopbackTransport();
    t.setOnWrite(async (bytes) => {
      if (bytes[0] === opcode) await held; // never acknowledged
    });
    return { t, release };
  }

  it("does not end the next link's stream: START_STREAMING", async () => {
    const first = holding(OPCODES.START_STREAMING_COMMAND);
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first.t);
    const stranded = client.startStreaming().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    await tick(20); // the start's write is held
    first.t.emitDisconnect(new Error('dropped'));

    await client.connect(device(answersAll));
    await client.startStreaming();
    expect(streaming(client)).toBe(true);
    first.release(); // the old transport lets go only now
    expect(await stranded).toMatch(/link was reset/);
    await tick(10);
    expect(streaming(client)).toBe(true);
  });

  it("does not clear the next device's pressure calibration", async () => {
    const first = holding(OPCODES.GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND);
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first.t);
    const stranded = client.readPressureCalibration();
    await tick(20); // the read's write is held
    first.t.emitDisconnect(new Error('dropped'));

    const second = new LoopbackTransport();
    second.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND) {
        // A BMP581: its id and no coefficients, since it compensates on-chip
        const reply = [ACK, OPCODES.PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE, 1, 3];
        setTimeout(() => tr.notify(new Uint8Array(reply)), 0);
      }
    });
    await client.connect(second);
    expect((await client.readPressureCalibration())?.sensor).toBe('bmp581');
    first.release(); // the old transport lets go only now
    expect(await stranded).toBeNull();
    await tick(10);
    expect(client.pressureCalibration?.sensor).toBe('bmp581');
  });
});

describe('a reply settled in the same turn as the drop', () => {
  /* Review finding: a waiter that settled, and so left the reset's reach,
     inside the very notification whose transport then reported the link down
     delivered its result after the next link had begun. A notification and a
     disconnect in one turn, with the application reconnecting from
     onDisconnect, is the case. */
  const OLD_FW = [OPCODES.FW_VERSION_RESPONSE, 3, 0, 9, 0, 9, 0]; // v9.9.0

  it('does not refill the version cache the reconnect cleared', async () => {
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => {
          tr.notify(new Uint8Array([ACK, ...OLD_FW])); // settles the ACK waiter...
          tr.emitDisconnect(new Error('dropped')); // ...and the link drops in the same turn
        }, 0);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    let reconnected: Promise<void> = Promise.resolve();
    client.onDisconnect = () => {
      reconnected = client.connect(device(answersAll));
    };
    const stale = client.readFwVersion().then(
      (v) => `${v.major}.${v.minor}.${v.patch}`,
      (e: Error) => e.message,
    );
    expect(await stale).toMatch(/link was reset/);
    await reconnected;
    const v = await client.readFwVersion();
    expect(`${v.major}.${v.minor}.${v.patch}`).toBe('1.1.17');
  });

  it("does not hand the old device's status to its caller", async () => {
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      const version = versionOf(bytes[0]);
      if (version.length) {
        // The version reads the status read makes first, to learn its width
        setTimeout(() => tr.notify(new Uint8Array([ACK, ...version])), 0);
      } else if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
        setTimeout(() => tr.notify(new Uint8Array([ACK])), 0);
        setTimeout(() => {
          // settles the instream waiter...
          tr.notify(
            new Uint8Array([OPCODES.INSTREAM_CMD_RESPONSE, OPCODES.STATUS_RESPONSE, 0x24, 0x01]),
          );
          tr.emitDisconnect(new Error('dropped')); // ...and the link drops in the same turn
        }, 5);
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(first);
    let reconnected: Promise<void> = Promise.resolve();
    client.onDisconnect = () => {
      reconnected = client.connect(device(answersAll));
    };
    const stale = client.getStatus().then(
      () => 'resolved',
      (e: Error) => e.message,
    );
    expect(await stale).toMatch(/link was reset/);
    await reconnected;
  });
});
