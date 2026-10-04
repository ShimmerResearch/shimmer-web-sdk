import { describe, it, expect, vi } from 'vitest';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import type { Shimmer3DeviceStatus } from '../../src/devices/shimmer3r/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// What a Shimmer3 sends behind the 0x8A prefix, taken through Shimmer3Client's
// byte-stream framer: the GET_STATUS and GET_VBATT replies, and the status the
// firmware pushes unasked when the sensor is docked or undocked and when
// sensing starts or stops other than by host command.
//
// A Shimmer3 sends ONE status byte. Its push carries an ACK in front
// (`useAckPrefixForInstreamResponses`, on by default and re-armed at every
// connection), and so does each reply, being an ordinary command response.
//
// Most of these use status 0x25 (docked, RTC set, SD card in). As a byte it is
// also DEVICE_VERSION_RESPONSE, which is what made a push dangerous before the
// framer could size it.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE; // 0x25
const FWVER = OPCODES.FW_VERSION_RESPONSE; // 0x2F
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE; // 0x8A
const STATUS = OPCODES.STATUS_RESPONSE; // 0x71
const VBATT = OPCODES.VBATT_RESPONSE; // 0x94

/** Docked, RTC set, SD card in. */
const DOCKED = 0x25;
/** The same sensor taken out of its dock. */
const UNDOCKED = 0x24;
/** What the firmware sends when the sensor is docked. */
const PUSH_DOCKED = [ACK, INSTREAM, STATUS, DOCKED];

/** Sensing, RTC set, SD logging, SD card in: a recording, undocked. */
const RECORDING = 0x2e;
const RECORDING_STATUS = {
  docked: false,
  sensing: true,
  rtcSet: true,
  sdLogging: true,
  streaming: false,
  sdPresent: true,
  sdError: false,
  redLedOn: false,
  usbPluggedIn: null,
};

/** adc = 0x0a00 = 2560, charger STAT bits 0x40 = fully charged. */
const BATT_RAW = [0x00, 0x0a, 0x40];

/** LogAndStream 0.16.0: firmwareIdentifier 3, major 0, minor 16, internal 0. */
const LOGANDSTREAM_0_16_0 = [3, 0, 0, 0, 16, 0];

/** Classic-Shimmer3 inquiry: 51.2 Hz, gyro X/Y/Z (see protocol.test.ts). */
const INQUIRY_MSG = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x0a, 0x0b, 0x0c];

type Reply = (bytes: Uint8Array, tr: LoopbackTransport) => void;

/**
 * A scripted Shimmer3 on an unframed link, past its connect handshake. The
 * handshake replies carry the ACK the firmware stages in front of every
 * response; `reply` answers everything else.
 */
async function connected(
  reply: Reply = () => {},
  opts: {
    fw?: number[];
    onDeviceStatus?: (s: Shimmer3DeviceStatus) => void;
    t?: LoopbackTransport;
    client?: Shimmer3Client;
  } = {},
): Promise<{ t: LoopbackTransport; client: Shimmer3Client }> {
  const t =
    opts.t ??
    new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Shimmer3-TEST' });
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) {
      setTimeout(() => tr.notify([ACK, DEVVER, 3]), 0);
    } else if (op === OPCODES.GET_FW_VERSION_COMMAND) {
      setTimeout(() => tr.notify([ACK, FWVER, ...(opts.fw ?? LOGANDSTREAM_0_16_0)]), 0);
    } else {
      reply(new Uint8Array(bytes), tr);
    }
  });
  const client = opts.client ?? new Shimmer3Client({ debug: false, transport: t });
  if (opts.onDeviceStatus) client.onDeviceStatus = opts.onDeviceStatus;
  await client.connect(t);
  return { t, client };
}

/**
 * Deliver bytes one per read, in order. Each read schedules the next, so the
 * bytes cannot overtake one another the way independent timers can.
 */
function dribble(tr: LoopbackTransport, bytes: number[]): void {
  const queue = [...bytes];
  const next = (): void => {
    const b = queue.shift();
    if (b === undefined) return;
    tr.notify([b]);
    setTimeout(next, 0);
  };
  setTimeout(next, 0);
}

/** Answer SET_GSR_RANGE with a bare ACK: the probe that a link is still in step. */
function ackGsrRange(bytes: Uint8Array, tr: LoopbackTransport): boolean {
  if (bytes[0] !== OPCODES.SET_GSR_RANGE_COMMAND) return false;
  setTimeout(() => tr.notify([ACK]), 0);
  return true;
}

// ---------------------------------------------------------------------------
// The defect: a push the framer could not size
// ---------------------------------------------------------------------------

describe('Shimmer3Client with a status push on the link', () => {
  it("keeps the next command's ACK when a push arrives while idle", async () => {
    // Before the fix 0x25 was framed as DEVICE_VERSION_RESPONSE and waited for
    // one more byte, which was the next command's ACK: "ACK timeout".
    const pushed: Shimmer3DeviceStatus[] = [];
    const { t, client } = await connected(ackGsrRange, { onDeviceStatus: (s) => pushed.push(s) });

    t.notify(PUSH_DOCKED);
    await expect(client.setGSRRange(2)).resolves.toEqual({ gsrRange: 2 });

    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ docked: true, rtcSet: true, sdPresent: true });
  });

  it('keeps it when the push and the ACK each arrive a byte per read', async () => {
    const { t, client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_GSR_RANGE_COMMAND) dribble(tr, [ACK]);
    });
    for (const b of PUSH_DOCKED) t.notify([b]);
    await expect(client.setGSRRange(1)).resolves.toEqual({ gsrRange: 1 });
  });

  it('does not take a push during connect for the hardware version', async () => {
    // The push lands just ahead of the GET_DEVICE_VERSION reply. Before the fix
    // 0x25 was taken as that reply, and the reply's own ACK became the
    // hardware version: 255, which then decides the ExG, real-world-clock and
    // InfoMem gates.
    const t = new LoopbackTransport({ capabilities: { framed: false } });
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND) {
        setTimeout(() => tr.notify([...PUSH_DOCKED, ACK, DEVVER, 3]), 0);
      } else if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND) {
        setTimeout(() => tr.notify([ACK, FWVER, ...LOGANDSTREAM_0_16_0]), 0);
      }
    });
    const client = new Shimmer3Client({ debug: false, transport: t });
    const pushed = vi.fn();
    client.onDeviceStatus = pushed;

    await client.connect();

    expect(client.deviceVersion).toEqual({ hardwareVersion: 3 });
    expect(client.firmwareVersion).toMatchObject({ firmwareIdentifier: 3, minor: 16 });
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it('delivers the reply ahead of a push in the same read, and the push too', async () => {
    const pushed = vi.fn();
    const { client } = await connected(
      (bytes, tr) => {
        if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
          setTimeout(() => tr.notify([ACK, ...INQUIRY_MSG, ...PUSH_DOCKED]), 0);
        }
      },
      { onDeviceStatus: pushed },
    );
    const info = await client.inquiry();
    expect(info.channelIds).toEqual([0x0a, 0x0b, 0x0c]);
    expect(pushed).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// GET_STATUS (0x72) -> [ACK][0x8A][0x71][status0]
// ---------------------------------------------------------------------------

describe('Shimmer3Client.getStatus', () => {
  it('reads a status that arrives in one read with its ACK', async () => {
    const { t, client } = await connected((bytes, tr) => {
      if (!ackGsrRange(bytes, tr) && bytes[0] === OPCODES.GET_STATUS_COMMAND) {
        setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, RECORDING]), 0);
      }
    });
    const writesBefore = t.writes.length;

    const status = await client.getStatus();
    expect(status).toMatchObject(RECORDING_STATUS);
    expect(Array.from(status.raw)).toEqual([RECORDING]);
    expect(t.writes.slice(writesBefore).map((w) => Array.from(w.bytes))).toEqual([
      [OPCODES.GET_STATUS_COMMAND],
    ]);

    // Nothing was over-read: the next command still gets its ACK.
    await expect(client.setGSRRange(2)).resolves.toEqual({ gsrRange: 2 });
  });

  it('reads a status that arrives a byte per read', async () => {
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
        dribble(tr, [ACK, INSTREAM, STATUS, RECORDING]);
      }
    });
    await expect(client.getStatus()).resolves.toMatchObject(RECORDING_STATUS);
  });

  it('does not report its own answer as a push', async () => {
    const pushed = vi.fn();
    const { client } = await connected(
      (bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
          setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, DOCKED]), 0);
        }
      },
      { onDeviceStatus: pushed },
    );
    await expect(client.getStatus()).resolves.toMatchObject({ docked: true });
    expect(pushed).not.toHaveBeenCalled();
  });

  it('refuses firmware that does not serve it, without writing anything', async () => {
    // LogAndStream 0.5.1: one below the Java driver's 0.5.2.
    const { t, client } = await connected(undefined, { fw: [3, 0, 0, 0, 5, 1] });
    const writesBefore = t.writes.length;
    await expect(client.getStatus()).rejects.toThrow(/does not serve the status command/);
    expect(t.writes).toHaveLength(writesBefore);
  });

  it('refuses while streaming, when the stream parser owns every byte', async () => {
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.INQUIRY_COMMAND) {
        setTimeout(() => tr.notify([ACK, ...INQUIRY_MSG]), 0);
      } else if (bytes[0] === OPCODES.START_STREAMING_COMMAND) {
        setTimeout(() => tr.notify([ACK]), 0);
      }
    });
    await client.inquiry();
    client.anchorStreamClock = false;
    await client.startStreaming();
    await expect(client.getStatus()).rejects.toThrow(/while streaming/);
  });

  it('times out naming the message it wanted', async () => {
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_STATUS_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    await expect(client.getStatus(50)).rejects.toThrow(/Response timeout \(opcode 0x8a 0x71\)/);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3Client({ debug: false });
    await expect(client.getStatus()).rejects.toThrow(/Not connected/);
  });
});

// ---------------------------------------------------------------------------
// GET_VBATT (0x95) -> [ACK][0x8A][0x94][BattStatusRaw x3]
// ---------------------------------------------------------------------------

describe('Shimmer3Client.getBattery', () => {
  it('reads the battery in one read with its ACK', async () => {
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND) {
        setTimeout(() => tr.notify([ACK, INSTREAM, VBATT, ...BATT_RAW]), 0);
      }
    });
    const batt = await client.getBattery();
    expect(batt.adcValue).toBe(0x0a00);
    expect(batt.chargingStatus).toBe('FULLY_CHARGED');
    expect(batt.voltage).toBeCloseTo(3.7284, 3);
    expect(batt.percentage).not.toBeNull();
  });

  it('reads the battery a byte per read', async () => {
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND) {
        dribble(tr, [ACK, INSTREAM, VBATT, ...BATT_RAW]);
      }
    });
    await expect(client.getBattery()).resolves.toMatchObject({ adcValue: 0x0a00 });
  });

  it('leaves the message behind it intact', async () => {
    // Followed by a status with no ACK in front of it, so an over-read of even
    // one byte would eat the 0x8A and lose the status, rather than hiding in
    // the ACK a push normally carries.
    const pushed = vi.fn();
    const { client } = await connected(
      (bytes, tr) => {
        if (bytes[0] === OPCODES.GET_VBATT_COMMAND) {
          setTimeout(
            () => tr.notify([ACK, INSTREAM, VBATT, ...BATT_RAW, INSTREAM, STATUS, DOCKED]),
            0,
          );
        }
      },
      { onDeviceStatus: pushed },
    );
    await expect(client.getBattery()).resolves.toMatchObject({ adcValue: 0x0a00 });
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed.mock.calls[0][0]).toMatchObject({ docked: true });
  });

  it('applies its own gate, which differs from the status one', async () => {
    // LogAndStream 0.5.8 answers GET_STATUS (0.5.2+) but not GET_VBATT (0.5.9+).
    const { t, client } = await connected(
      (bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
          setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, DOCKED]), 0);
        }
      },
      { fw: [3, 0, 0, 0, 5, 8] },
    );
    await expect(client.getStatus()).resolves.toMatchObject({ docked: true });
    const writesBefore = t.writes.length;
    await expect(client.getBattery()).rejects.toThrow(/does not serve the battery command/);
    expect(t.writes).toHaveLength(writesBefore);
  });

  it('times out naming the message it wanted', async () => {
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    await expect(client.getBattery(50)).rejects.toThrow(/Response timeout \(opcode 0x8a 0x94\)/);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3Client({ debug: false });
    await expect(client.getBattery()).rejects.toThrow(/Not connected/);
  });
});

// ---------------------------------------------------------------------------
// Unsolicited status pushes
// ---------------------------------------------------------------------------

describe('Shimmer3Client.onDeviceStatus', () => {
  it('reports a push, with no USB flag on a Shimmer3', async () => {
    const pushed: Shimmer3DeviceStatus[] = [];
    const { t } = await connected(undefined, { onDeviceStatus: (s) => pushed.push(s) });
    t.notify(PUSH_DOCKED);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({
      docked: true,
      sensing: false,
      rtcSet: true,
      sdLogging: false,
      streaming: false,
      sdPresent: true,
      sdError: false,
      redLedOn: false,
      usbPluggedIn: null,
    });
    expect(Array.from(pushed[0].raw)).toEqual([DOCKED]);
  });

  it('reports a push only once all of it has arrived', async () => {
    const pushed = vi.fn();
    const { t } = await connected(undefined, { onDeviceStatus: pushed });
    t.notify([ACK, INSTREAM]);
    t.notify([STATUS]);
    expect(pushed).not.toHaveBeenCalled();
    t.notify([DOCKED]);
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it('reports back-to-back pushes in order', async () => {
    const seen: boolean[] = [];
    const { t } = await connected(undefined, { onDeviceStatus: (s) => seen.push(s.docked) });
    t.notify([ACK, INSTREAM, STATUS, UNDOCKED, ...PUSH_DOCKED]);
    expect(seen).toEqual([false, true]);
  });

  it('leaves the battery reply alone', async () => {
    const pushed = vi.fn();
    const { client } = await connected(
      (bytes, tr) => {
        if (bytes[0] === OPCODES.GET_VBATT_COMMAND) {
          setTimeout(() => tr.notify([ACK, INSTREAM, VBATT, ...BATT_RAW]), 0);
        }
      },
      { onDeviceStatus: pushed },
    );
    await client.getBattery();
    expect(pushed).not.toHaveBeenCalled();
  });

  it('survives a throwing handler, and the link stays in step', async () => {
    const { t, client } = await connected(ackGsrRange, {
      onDeviceStatus: () => {
        throw new Error('application bug');
      },
    });
    expect(() => t.notify(PUSH_DOCKED)).not.toThrow();
    await expect(client.setGSRRange(3)).resolves.toEqual({ gsrRange: 3 });
  });

  it('reports a push that follows the reply in the same read', async () => {
    // The reply is consumed as it goes past, not when getStatus's caller
    // resumes, so the push right behind it is still news.
    const pushed = vi.fn();
    const { client } = await connected(
      (bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
          setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, RECORDING, ...PUSH_DOCKED]), 0);
        }
      },
      { onDeviceStatus: pushed },
    );
    await expect(client.getStatus()).resolves.toMatchObject(RECORDING_STATUS);
    expect(pushed).toHaveBeenCalledTimes(1);
    expect(pushed.mock.calls[0][0]).toMatchObject({ docked: true });
  });
});

// ---------------------------------------------------------------------------
// Reads in flight together, early replies, and a link that goes
// ---------------------------------------------------------------------------

describe('Shimmer3Client status and battery reads', () => {
  /** Let a read's write go out and its waiter register. */
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

  it('runs status reads made together one after another, each with its own reply', async () => {
    // Every waiter sees every message, so two reads in flight together would
    // both take the first reply, and the second reply would be reported as a
    // push.
    const events: string[] = [];
    const replies = [DOCKED, UNDOCKED];
    let sent = 0;
    const pushed = vi.fn();
    const { client } = await connected(
      (bytes, tr) => {
        if (bytes[0] !== OPCODES.GET_STATUS_COMMAND) return;
        const i = sent++;
        events.push(`GET_STATUS ${i}`);
        setTimeout(() => {
          events.push(`reply ${i}`);
          tr.notify([ACK, INSTREAM, STATUS, replies[i]]);
        }, 5);
      },
      { onDeviceStatus: pushed },
    );

    const [first, second] = await Promise.all([client.getStatus(), client.getStatus()]);
    expect(first.docked).toBe(true);
    expect(second.docked).toBe(false);
    expect(events).toEqual(['GET_STATUS 0', 'reply 0', 'GET_STATUS 1', 'reply 1']);
    expect(pushed).not.toHaveBeenCalled();
  });

  it('runs battery reads made together one after another too', async () => {
    const adc = [0x00, 0x10];
    let sent = 0;
    const { client } = await connected((bytes, tr) => {
      if (bytes[0] !== OPCODES.GET_VBATT_COMMAND) return;
      const i = sent++;
      setTimeout(() => tr.notify([ACK, INSTREAM, VBATT, adc[i], 0x0a, 0x40]), 5);
    });
    const [first, second] = await Promise.all([client.getBattery(), client.getBattery()]);
    expect(first.adcValue).toBe(0x0a00);
    expect(second.adcValue).toBe(0x0a10);
  });

  it('takes a reply that lands before its write has finished', async () => {
    // The waiter is registered before the write. Registered after it, this
    // reply reached nobody and the read timed out.
    const pushed = vi.fn();
    const { t, client } = await connected(undefined, { onDeviceStatus: pushed });
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_STATUS_COMMAND) tr.notify([ACK, INSTREAM, STATUS, DOCKED]);
    });
    await expect(client.getStatus(200)).resolves.toMatchObject({ docked: true });
    expect(pushed).not.toHaveBeenCalled();
  });

  it('is cancelled at once by a disconnect, and leaves the next link alone', async () => {
    const pushed = vi.fn();
    const { client } = await connected(undefined, { onDeviceStatus: pushed });
    const started = Date.now();
    const stranded = client.getStatus(5000);
    await settle();
    await client.disconnect();
    await expect(stranded).rejects.toThrow(/link closed while waiting/);
    expect(Date.now() - started).toBeLessThan(1000);

    // Nothing from the old link is left waiting to take this push as its reply.
    const t2 = new LoopbackTransport({ capabilities: { framed: false } });
    await connected(undefined, { t: t2, client });
    t2.notify(PUSH_DOCKED);
    expect(pushed).toHaveBeenCalledTimes(1);
  });

  it('is cancelled at once when the transport drops', async () => {
    const { t, client } = await connected();
    const started = Date.now();
    const stranded = client.getBattery(5000);
    await settle();
    t.emitDisconnect(new Error('link lost'));
    await expect(stranded).rejects.toThrow(/link closed while waiting/);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('fails at once when its write fails, and leaves nothing waiting', async () => {
    const pushed = vi.fn();
    const { t, client } = await connected(undefined, { onDeviceStatus: pushed });
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_STATUS_COMMAND) throw new Error('port closed');
      ackGsrRange(bytes, tr);
    });
    const started = Date.now();
    await expect(client.getStatus(5000)).rejects.toThrow(/port closed/);
    expect(Date.now() - started).toBeLessThan(1000);

    // No reply is owed, so a status is a push. And the next command runs.
    t.notify(PUSH_DOCKED);
    expect(pushed).toHaveBeenCalledTimes(1);
    await expect(client.setGSRRange(2)).resolves.toEqual({ gsrRange: 2 });
  });
});
