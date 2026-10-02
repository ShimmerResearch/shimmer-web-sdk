import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { parseShimmer3StatusBytes } from '../../src/devices/shimmer3r/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { FW_SHIMMER3R, HW, versionReply, type FwTuple } from './configFirmware.js';

// The idle-time device queries: hardware version, device status and battery.
//
// Every one of them is exercised over BOTH transport shapes, because they are
// the two ways the same firmware bytes reach this client and they fail
// differently. BLE delivers one notification per message and packs an ACK in
// with the reply that followed it; a byte stream delivers whatever the OS had
// buffered, so a reply can arrive three bytes at a time and the framer has to
// put the message back together.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE; // 0x25
const INSTREAM = OPCODES.INSTREAM_CMD_RESPONSE; // 0x8A
const STATUS = OPCODES.STATUS_RESPONSE; // 0x71
const VBATT = OPCODES.VBATT_RESPONSE; // 0x94

type Reply = (bytes: Uint8Array, tr: LoopbackTransport) => void;

/** BLE-shaped: one notification per firmware message. */
async function framed(reply: Reply): Promise<{ t: LoopbackTransport; client: Shimmer3RClient }> {
  const t = new LoopbackTransport({ deviceName: 'Shimmer3R-BLE' });
  t.setOnWrite((bytes, tr) => reply(new Uint8Array(bytes), tr));
  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

/** Serial-shaped: a byte stream with no message boundaries. */
async function unframed(reply: Reply): Promise<{ t: LoopbackTransport; client: Shimmer3RClient }> {
  const t = new LoopbackTransport({
    capabilities: { framed: false },
    deviceName: 'Shimmer3R-SPP',
  });
  t.setOnWrite((bytes, tr) => reply(new Uint8Array(bytes), tr));
  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

/** Deliver bytes in 3-byte reads — the fragmentation a real serial port hands us. */
function dribble3(tr: LoopbackTransport, bytes: number[]): void {
  for (let i = 0; i < bytes.length; i += 3) {
    const slice = bytes.slice(i, i + 3);
    setTimeout(() => tr.notify(slice), 0);
  }
}

/**
 * `reply`, on a device that also answers the two version reads, as hardware
 * `hw` running `fw`. `getStatus` reads both first while the status width is
 * unknown, because the width follows from them. The default, LogAndStream
 * v1.00.040 on a Shimmer3R, sends two status bytes.
 */
function withVersions(reply: Reply, hw: number = HW.SHIMMER3R, fw: FwTuple = FW_SHIMMER3R): Reply {
  return (bytes, tr) => {
    const version = versionReply(bytes[0], hw, fw);
    if (version) setTimeout(() => tr.notify(version), 0);
    else reply(bytes, tr);
  };
}

// ---------------------------------------------------------------------------
// GET_DEVICE_VERSION (0x3F) -> [0x25][hw]
// ---------------------------------------------------------------------------

describe('Shimmer3RClient.readDeviceVersion', () => {
  /** Shimmer3R hardware id, per ShimmerVerDetails.HW_ID. */
  const HW_SHIMMER3R = 10;
  const HW_SHIMMER3 = 3;

  it('reads the hardware version over a framed transport', async () => {
    const { t, client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, DEVVER, HW_SHIMMER3R]), 0);
    });
    await expect(client.readDeviceVersion()).resolves.toEqual({ hardwareVersion: HW_SHIMMER3R });
    expect(t.writes.map((w) => w.bytes[0])).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND]);
  });

  it('reads the hardware version when the reply follows its ACK separately', async () => {
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND) {
        setTimeout(() => tr.notify([ACK]), 0);
        setTimeout(() => tr.notify([DEVVER, HW_SHIMMER3R]), 1);
      }
    });
    await expect(client.readDeviceVersion()).resolves.toEqual({ hardwareVersion: HW_SHIMMER3R });
  });

  it('reads the hardware version dribbled over a byte stream', async () => {
    const { client } = await unframed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND) dribble3(tr, [ACK, DEVVER, HW_SHIMMER3]);
    });
    await expect(client.readDeviceVersion()).resolves.toEqual({ hardwareVersion: HW_SHIMMER3 });
  });

  it('caches the answer — a second call costs no round trip', async () => {
    const { t, client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, DEVVER, HW_SHIMMER3R]), 0);
    });
    await client.readDeviceVersion();
    await client.readDeviceVersion();
    expect(t.writes).toHaveLength(1);
  });

  it('re-reads after a reconnect, which may be to a different sensor', async () => {
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, DEVVER, HW_SHIMMER3R]), 0);
    });
    expect(await client.readDeviceVersion()).toEqual({ hardwareVersion: HW_SHIMMER3R });
    await client.disconnect();

    const t2 = new LoopbackTransport({ deviceName: 'Shimmer3-BLE' });
    t2.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, DEVVER, HW_SHIMMER3]), 0);
    });
    await client.connect(t2);
    expect(await client.readDeviceVersion()).toEqual({ hardwareVersion: HW_SHIMMER3 });
  });

  it('rejects a truncated response rather than reporting hardware 0', async () => {
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, DEVVER]), 0);
    });
    await expect(client.readDeviceVersion()).rejects.toThrow(/short DEVICE_VERSION_RESPONSE/);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3RClient({ debug: false });
    await expect(client.readDeviceVersion()).rejects.toThrow(/Not connected/);
  });
});

// ---------------------------------------------------------------------------
// parseShimmer3StatusBytes
// ---------------------------------------------------------------------------

describe('parseShimmer3StatusBytes', () => {
  it('maps every bit to its own field', () => {
    // Each bit alone, so a swapped pair cannot hide behind a shared fixture.
    const only = (bit: number) => parseShimmer3StatusBytes(new Uint8Array([1 << bit]));
    expect(only(0).docked).toBe(true);
    expect(only(1).sensing).toBe(true);
    expect(only(2).rtcSet).toBe(true);
    expect(only(3).sdLogging).toBe(true);
    expect(only(4).streaming).toBe(true);
    expect(only(5).sdPresent).toBe(true);
    expect(only(6).sdError).toBe(true);
    expect(only(7).redLedOn).toBe(true);
  });

  it('reads all-clear and all-set', () => {
    expect(parseShimmer3StatusBytes(new Uint8Array([0x00, 0x00]))).toMatchObject({
      docked: false,
      sensing: false,
      rtcSet: false,
      sdLogging: false,
      streaming: false,
      sdPresent: false,
      sdError: false,
      redLedOn: false,
      usbPluggedIn: false,
    });
    expect(parseShimmer3StatusBytes(new Uint8Array([0xff, 0x01]))).toMatchObject({
      docked: true,
      sensing: true,
      rtcSet: true,
      sdLogging: true,
      streaming: true,
      sdPresent: true,
      sdError: true,
      redLedOn: true,
      usbPluggedIn: true,
    });
  });

  it('reports usbPluggedIn as null when the byte is absent, not as false', () => {
    // A Shimmer3 omits the byte entirely (`#if defined(SHIMMER3R)`), so
    // "unknown" and "unplugged" have to stay tellable apart.
    expect(parseShimmer3StatusBytes(new Uint8Array([0x21])).usbPluggedIn).toBeNull();
    expect(parseShimmer3StatusBytes(new Uint8Array([0x21, 0x00])).usbPluggedIn).toBe(false);
  });

  it('keeps a copy of the bytes, not a view onto the caller buffer', () => {
    const bytes = new Uint8Array([0x21, 0x01]);
    const status = parseShimmer3StatusBytes(bytes);
    bytes[0] = 0x00;
    expect(Array.from(status.raw)).toEqual([0x21, 0x01]);
  });

  it('rejects an empty payload', () => {
    expect(() => parseShimmer3StatusBytes(new Uint8Array(0))).toThrow(/too short/);
  });
});

// ---------------------------------------------------------------------------
// GET_STATUS (0x72) -> [0x8A][0x71][status0][status1?]
// ---------------------------------------------------------------------------

describe('Shimmer3RClient.getStatus', () => {
  // docked + sensing + rtcSet + sdLogging + sdPresent = 0x2F, USB in.
  const S0 = 0x2f;
  const RECORDING = {
    docked: true,
    sensing: true,
    rtcSet: true,
    sdLogging: true,
    streaming: false,
    sdPresent: true,
    sdError: false,
    redLedOn: false,
    usbPluggedIn: true,
  };

  /** A sensor answering GET_STATUS as `[ACK][0x8A][0x71][S0][USB in]`, one packet. */
  const recording: Reply = (bytes, tr) => {
    if (bytes[0] === OPCODES.GET_STATUS_COMMAND)
      setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, S0, 1]), 0);
  };

  /** The opcode of every command the client wrote. */
  const written = (t: LoopbackTransport): number[] => t.writes.map((w) => w.bytes[0]);

  it('reads the status coalesced with its ACK in one notification', async () => {
    const { t, client } = await framed(withVersions(recording));
    expect(await client.getStatus()).toMatchObject(RECORDING);
    // The status width follows from both versions, so they are read first.
    expect(written(t)).toEqual([
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_FW_VERSION_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
    ]);
  });

  it('reads the versions once per link, not on every status read', async () => {
    const { t, client } = await framed(withVersions(recording));
    await client.getStatus();
    await client.getStatus();
    expect(written(t)).toEqual([
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_FW_VERSION_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
    ]);
  });

  it('reads them once for two status reads in flight together', async () => {
    const { t, client } = await framed(withVersions(recording));
    const [a, b] = await Promise.all([client.getStatus(), client.getStatus()]);
    expect(a).toMatchObject(RECORDING);
    expect(b).toMatchObject(RECORDING);
    expect(written(t).filter((op) => op === OPCODES.GET_DEVICE_VERSION_COMMAND)).toHaveLength(1);
    expect(written(t).filter((op) => op === OPCODES.GET_FW_VERSION_COMMAND)).toHaveLength(1);
  });

  it('skips the firmware version on a Shimmer3, whose hardware settles the width', async () => {
    const { t, client } = await framed(
      withVersions((bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND)
          setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, S0]), 0);
      }, HW.SHIMMER3),
    );
    expect((await client.getStatus()).usbPluggedIn).toBeNull();
    expect(written(t)).toEqual([OPCODES.GET_DEVICE_VERSION_COMMAND, OPCODES.GET_STATUS_COMMAND]);
  });

  it('reads no versions while streaming', async () => {
    // Their replies would have to get past the stream parser. The status reply
    // shares the ACK's notification, which is how a mid-stream read works.
    const { t, client } = await framed(withVersions(recording));
    (client as unknown as { _streaming: boolean })._streaming = true;
    expect(await client.getStatus()).toMatchObject(RECORDING);
    expect(written(t)).toEqual([OPCODES.GET_STATUS_COMMAND]);
  });

  it('reads the status when it arrives in its own notification', async () => {
    const { client } = await framed(
      withVersions((bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
          setTimeout(() => tr.notify([ACK]), 0);
          setTimeout(() => tr.notify([INSTREAM, STATUS, S0, 1]), 1);
        }
      }),
    );
    expect(await client.getStatus()).toMatchObject(RECORDING);
  });

  it('reads the status dribbled three bytes at a time over a byte stream', async () => {
    const { client } = await unframed(
      withVersions((bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) dribble3(tr, [ACK, INSTREAM, STATUS, S0, 1]);
      }),
    );
    expect(await client.getStatus()).toMatchObject(RECORDING);
  });

  it('does not report its own answer as an unsolicited push', async () => {
    const { client } = await framed(withVersions(recording));
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    await client.getStatus();
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not report its own answer as a push when the reply arrives separately', async () => {
    const { client } = await framed(
      withVersions((bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
          setTimeout(() => tr.notify([ACK]), 0);
          setTimeout(() => tr.notify([INSTREAM, STATUS, S0, 1]), 1);
        }
      }),
    );
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    await client.getStatus();
    expect(spy).not.toHaveBeenCalled();
  });

  it('still reports a push that lands while the versions are being read', async () => {
    // The versions are read before this status read is claimed, so a push in
    // that window is news, not this read's answer.
    const { client } = await framed((bytes, tr) => {
      const version = versionReply(bytes[0]);
      if (version) {
        setTimeout(() => tr.notify(version), 0);
        if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
          setTimeout(() => tr.notify([INSTREAM, STATUS, 0x01, 0x00]), 0); // docked
      } else recording(bytes, tr);
    });
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    expect(await client.getStatus()).toMatchObject(RECORDING);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ docked: true, usbPluggedIn: false });
  });

  it('accepts a one-byte answer when the versions cannot be read', async () => {
    // With the width unknown, one byte may be the whole status: a Shimmer3
    // sends one, and so does a Shimmer3R before LogAndStream v1.00.024. A
    // waiter demanding two would time out on a valid reply.
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_STATUS_COMMAND) {
        setTimeout(() => tr.notify([ACK]), 0);
        setTimeout(() => tr.notify([INSTREAM, STATUS, S0]), 1);
      } else setTimeout(() => tr.notify([OPCODES.NACK_COMMAND_PROCESSED]), 0);
    });
    const status = await client.getStatus();
    expect(status.sdLogging).toBe(true);
    expect(status.usbPluggedIn).toBeNull();
  });

  it('tries the versions again on the next status read after they failed', async () => {
    // A failure is not remembered for the link. A transient one would
    // otherwise leave every later status read guessing at the width.
    let refusals = 0;
    const { t, client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND && refusals++ === 0) {
        setTimeout(() => tr.notify([OPCODES.NACK_COMMAND_PROCESSED]), 0);
        return;
      }
      withVersions(recording)(bytes, tr);
    });
    expect(await client.getStatus()).toMatchObject(RECORDING); // read leniently
    expect(await client.getStatus()).toMatchObject(RECORDING);
    expect(written(t)).toEqual([
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
      OPCODES.GET_DEVICE_VERSION_COMMAND,
      OPCODES.GET_FW_VERSION_COMMAND,
      OPCODES.GET_STATUS_COMMAND,
    ]);
    // …and once learnt, the width holds: no third round of version reads.
    await client.getStatus();
    expect(written(t).slice(5)).toEqual([OPCODES.GET_STATUS_COMMAND]);
  });

  it('splits a Shimmer3 one-byte status correctly on a byte stream', async () => {
    // Told it is HW 3, the framer must stop waiting for the usbPluggedIn byte —
    // otherwise it swallows the ACK of the NEXT command, not just this reply.
    const { t, client } = await unframed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND)
        setTimeout(() => tr.notify([ACK, DEVVER, 3]), 0);
      else if (bytes[0] === OPCODES.GET_STATUS_COMMAND)
        setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, S0]), 0);
      else if (bytes[0] === OPCODES.GET_VBATT_COMMAND)
        setTimeout(() => tr.notify([ACK, INSTREAM, VBATT, 0x00, 0x0a, 0x40]), 0);
    });
    expect(await client.readDeviceVersion()).toEqual({ hardwareVersion: 3 });

    const status = await client.getStatus();
    expect(status.usbPluggedIn).toBeNull();
    expect(status.sdLogging).toBe(true);

    // The proof that nothing was over-read: the very next command still works.
    const batt = await client.getBattery();
    expect(batt.adcValue).toBe(0x0a00);
    expect(t.writes).toHaveLength(3);
  });

  it('rejects a truncated answer once the versions make two bytes a contract', async () => {
    // A Shimmer3R on LogAndStream v1.00.024 or later sends two status bytes,
    // so once both versions are read two is a contract, not an assumption. A
    // one-byte answer is a truncated message; returning it would report
    // `usbPluggedIn: null` — "this firmware has no such field" — for a sensor
    // that does have the field. Failing is the honest answer.
    const { client } = await framed(
      withVersions((bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND)
          setTimeout(() => tr.notify([ACK, INSTREAM, STATUS, S0]), 0);
      }),
    );
    await expect(client.getStatus()).rejects.toThrow(/Instream response 0x71 timeout/);
  }, 3000);

  it('throws when not connected', async () => {
    const client = new Shimmer3RClient({ debug: false });
    await expect(client.getStatus()).rejects.toThrow(/Not connected/);
  });

  it('times out with a message naming the response it wanted', async () => {
    const { client } = await framed(
      withVersions((bytes, tr) => {
        if (bytes[0] === OPCODES.GET_STATUS_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
      }),
    );
    await expect(client.getStatus()).rejects.toThrow(/Instream response 0x71 timeout/);
  }, 3000);
});

// ---------------------------------------------------------------------------
// Unsolicited status pushes
// ---------------------------------------------------------------------------

describe('Shimmer3RClient.onDeviceStatus', () => {
  it('reports a push that arrives while idle', async () => {
    const { t, client } = await framed(() => {});
    const seen: boolean[] = [];
    client.onDeviceStatus = (s) => void seen.push(s.docked);
    t.notify([INSTREAM, STATUS, 0x01, 0x01]);
    expect(seen).toEqual([true]);
  });

  it('steps over the ACK prefix the firmware can put in front of a push', async () => {
    // SET_INSTREAM_RESPONSE_ACK_PREFIX_STATE (0xA3) turns this on, and the whole
    // push then shares a single notification with its prefix.
    const { t, client } = await framed(() => {});
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([ACK, INSTREAM, STATUS, 0x08, 0x00]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sdLogging: true, usbPluggedIn: false });
  });

  it('reports a push that dribbles in over a byte stream', async () => {
    const { t, client } = await unframed(() => {});
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, STATUS]);
    expect(spy).not.toHaveBeenCalled(); // still incomplete
    t.notify([0x11, 0x01]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ docked: true, streaming: true });
  });

  /**
   * Connect, then read both versions, so the client knows how wide this
   * device's status is. The default firmware, Shimmer3R LogAndStream v1.00.040,
   * sends two bytes.
   */
  async function framedKnowing(
    hw: number,
    fw: FwTuple = FW_SHIMMER3R,
  ): Promise<{ t: LoopbackTransport; client: Shimmer3RClient }> {
    const ctx = await framed(withVersions(() => {}, hw, fw));
    expect(await ctx.client.readDeviceVersion()).toEqual({ hardwareVersion: hw });
    await ctx.client.readFwVersion();
    return ctx;
  }

  it('drops a truncated push instead of reporting usbPluggedIn as null', async () => {
    // A push from a Shimmer3R on LogAndStream v1.00.024 or later carries TWO
    // status bytes. A three-byte one is a framing failure, and surfacing it
    // would say `usbPluggedIn: null`, which means "this firmware has no such
    // field" — not "the byte never arrived". A caller has no way to tell those
    // apart, so the truncated push must not become a status at all.
    const { t, client } = await framedKnowing(HW.SHIMMER3R);
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, STATUS, 0x21]);
    expect(spy).not.toHaveBeenCalled();

    // …and the complete push still lands, so the guard is not just "off".
    t.notify([INSTREAM, STATUS, 0x21, 0x01]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sdPresent: true, usbPluggedIn: true });
  });

  it('drops a truncated ACK-prefixed push too', async () => {
    const { t, client } = await framedKnowing(HW.SHIMMER3R);
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([ACK, INSTREAM, STATUS, 0x21]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('still reports a Shimmer3 one-byte push, which is complete, not truncated', async () => {
    const { t, client } = await framedKnowing(HW.SHIMMER3);
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, STATUS, 0x21]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sdPresent: true, usbPluggedIn: null });
  });

  it('still reports the one-byte push a Shimmer3R before v1.00.024 sends', async () => {
    // These releases have no second status byte. Judged by the hardware alone,
    // every push they sent was dropped as truncated.
    const { t, client } = await framedKnowing(HW.SHIMMER3R, [3, 1, 0, 23]);
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, STATUS, 0x21]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sdPresent: true, usbPluggedIn: null });
  });

  it('reports a one-byte push while the width is still unknown', async () => {
    // Until both versions are read the width is not known, so it must not be
    // enforced as a contract yet: an app that never probes would otherwise lose
    // every push a Shimmer3, or an early Shimmer3R, sends.
    const { t, client } = await framed(() => {});
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, STATUS, 0x21]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sdPresent: true, usbPluggedIn: null });
  });

  it('reports a one-byte push when only the hardware version is known', async () => {
    // A Shimmer3R's hardware version does not settle the width, because
    // LogAndStream sent one byte there until v1.00.024.
    const { t, client } = await framed(withVersions(() => {}));
    expect(await client.readDeviceVersion()).toEqual({ hardwareVersion: HW.SHIMMER3R });
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, STATUS, 0x21]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toMatchObject({ sdPresent: true, usbPluggedIn: null });
  });

  it('leaves other instream traffic alone', async () => {
    const { t, client } = await framed(() => {});
    const spy = vi.fn();
    client.onDeviceStatus = spy;
    t.notify([INSTREAM, VBATT, 0x00, 0x0a, 0x40]);
    expect(spy).not.toHaveBeenCalled();
  });

  it('survives a throwing handler', async () => {
    const { t, client } = await framed(() => {});
    client.onDeviceStatus = () => {
      throw new Error('application bug');
    };
    expect(() => t.notify([INSTREAM, STATUS, 0x01, 0x01])).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// GET_VBATT (0x95) -> [0x8A][0x94][BattStatusRaw x3]
// ---------------------------------------------------------------------------

describe('Shimmer3RClient.getBattery', () => {
  // adc = (0x0a << 8) | 0x00 = 2560; status 0x40 = FULLY_CHARGED.
  const RAW = [0x00, 0x0a, 0x40];

  it('reads the battery coalesced with its ACK', async () => {
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND)
        setTimeout(() => tr.notify([ACK, INSTREAM, VBATT, ...RAW]), 0);
    });
    const batt = await client.getBattery();
    expect(batt.adcValue).toBe(0x0a00);
    expect(batt.chargingStatus).toBe('FULLY_CHARGED');
    expect(batt.voltage).toBeCloseTo(3.7284, 3);
    expect(batt.percentage).not.toBeNull();
  });

  it('reads the battery when it arrives in its own notification', async () => {
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND) {
        setTimeout(() => tr.notify([ACK]), 0);
        setTimeout(() => tr.notify([INSTREAM, VBATT, ...RAW]), 1);
      }
    });
    expect((await client.getBattery()).adcValue).toBe(0x0a00);
  });

  it('reads the battery dribbled three bytes at a time over a byte stream', async () => {
    const { client } = await unframed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND) dribble3(tr, [ACK, INSTREAM, VBATT, ...RAW]);
    });
    expect((await client.getBattery()).adcValue).toBe(0x0a00);
  });

  it('keeps a following message intact on a byte stream', async () => {
    // The battery reply is fixed-width; over-reading it would eat the push
    // behind it, and that push is the only signal a host gets that the user
    // undocked the sensor.
    const { client } = await unframed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND)
        setTimeout(
          () => tr.notify([ACK, INSTREAM, VBATT, ...RAW, INSTREAM, STATUS, 0x00, 0x00]),
          0,
        );
    });
    const pushed: unknown[] = [];
    client.onDeviceStatus = (s) => void pushed.push(s);
    expect((await client.getBattery()).adcValue).toBe(0x0a00);
    expect(pushed).toHaveLength(1);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3RClient({ debug: false });
    await expect(client.getBattery()).rejects.toThrow(/Not connected/);
  });

  it('times out with a message naming the response it wanted', async () => {
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.GET_VBATT_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    await expect(client.getBattery()).rejects.toThrow(/Instream response 0x94 timeout/);
  }, 3000);
});

// ---------------------------------------------------------------------------
// NACK
// ---------------------------------------------------------------------------

describe('Shimmer3RClient NACK handling', () => {
  const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE

  it('rejects a refused command at once instead of waiting out the ACK timeout', async () => {
    // The firmware refuses several commands outright while sensing
    // (ShimBt_isCmdBlockedWhileSensing). "ACK timeout" a second and a half
    // later reads as a dead link; this reads as a refusal.
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_GSR_RANGE_COMMAND) setTimeout(() => tr.notify([NACK]), 0);
    });
    const started = Date.now();
    await expect(client.setGSRRange(2)).rejects.toThrow(/NACK received/);
    // The setter's own ACK timeout is 1500 ms; failing fast is the point.
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('rejects a NACK dribbled over a byte stream too', async () => {
    const { client } = await unframed((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_WR_ACCEL_RANGE_COMMAND) dribble3(tr, [NACK]);
    });
    await expect(client.setWrAccelRange(1)).rejects.toThrow(/NACK received/);
  });

  it('leaves the client usable — the next command still ACKs', async () => {
    // A rejection must not leak the in-flight-command count, or every later
    // command mistakes a stray byte for its own ACK.
    const { client } = await framed((bytes, tr) => {
      if (bytes[0] === OPCODES.SET_GSR_RANGE_COMMAND) setTimeout(() => tr.notify([NACK]), 0);
      else setTimeout(() => tr.notify([ACK]), 0);
    });
    await expect(client.setGSRRange(2)).rejects.toThrow(/NACK received/);
    await expect(client.setWrAccelRange(3)).resolves.toMatchObject({ wrAccelRange: 3 });
  });

  it('ignores a stray 0xFE arriving with no command in flight', async () => {
    const { t, client } = await framed((_bytes, tr) => setTimeout(() => tr.notify([ACK]), 0));
    t.notify([NACK]);
    await expect(client.setWrAccelRange(2)).resolves.toMatchObject({ wrAccelRange: 2 });
  });
});
