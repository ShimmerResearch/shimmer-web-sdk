import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
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
            : cmd[0] === OPCODES.GET_FW_VERSION_COMMAND
              ? FW
              : [];
      setTimeout(() => tr.notify(new Uint8Array([ACK])), 0);
      if (reply.length) setTimeout(() => tr.notify(new Uint8Array(reply)), 0);
    });
    return t;
  }

  it("a status read waiting for its instream reply does not take the next link's", async () => {
    const first = new LoopbackTransport();
    first.setOnWrite((bytes, tr) => {
      // ACK only: the instream reply never comes on this link
      setTimeout(() => tr.notify(new Uint8Array([ACK])), 0);
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
      setTimeout(() => tr.notify(new Uint8Array([ACK])), 0); // and no reply
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
