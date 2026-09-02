import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

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
