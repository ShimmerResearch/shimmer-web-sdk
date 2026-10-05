import { describe, it, expect, vi } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { WiredShimmerClient } from '../../src/devices/dock/WiredShimmerClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// `onDisconnect` reports the link going away WITHOUT the application asking.
// The distinction is the whole point: an app that reconnects from this callback
// must not be told about its own `disconnect()`, or it reconnects forever. The
// tests below therefore pin the negative cases as hard as the positive one.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE; // 0x25
const FWVER = OPCODES.FW_VERSION_RESPONSE; // 0x2F

/** Reach the private streaming flag — there is no public getter for it. */
function isStreaming(client: object): boolean {
  return (client as { _streaming: boolean })._streaming;
}

describe('Shimmer3RClient onDisconnect', () => {
  async function connected(): Promise<{ t: LoopbackTransport; client: Shimmer3RClient }> {
    const t = new LoopbackTransport({ deviceName: 'Shimmer3R-TEST' });
    t.setOnWrite((bytes, tr) => {
      if (bytes[0] === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const client = new Shimmer3RClient({ debug: false, transport: t });
    await client.connect();
    return { t, client };
  }

  it('fires once with the transport reason and clears the streaming flag', async () => {
    const { t, client } = await connected();
    await client.startStreaming();
    expect(isStreaming(client)).toBe(true);

    const seen: (Error | undefined)[] = [];
    client.onDisconnect = (reason) => void seen.push(reason);

    const reason = new Error('GATT Server is disconnected');
    t.emitDisconnect(reason);

    expect(seen).toEqual([reason]);
    expect(isStreaming(client)).toBe(false);
  });

  it('collapses a transport that reports the same drop twice', async () => {
    const { t, client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;

    t.emitDisconnect(new Error('link lost'));
    t.emitDisconnect(new Error('link lost'));

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('stays silent for an application-initiated disconnect()', async () => {
    const { client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;

    await client.disconnect();

    expect(spy).not.toHaveBeenCalled();
  });

  it('does not fire a second time when disconnect() cleans up after a drop', async () => {
    const { t, client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;

    t.emitDisconnect(new Error('link lost'));
    await client.disconnect();

    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('re-arms for the next connection', async () => {
    const { t, client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;

    t.emitDisconnect(new Error('first drop'));
    await client.disconnect();
    expect(spy).toHaveBeenCalledTimes(1);

    const t2 = new LoopbackTransport({ deviceName: 'Shimmer3R-TEST' });
    await client.connect(t2);
    t2.emitDisconnect(new Error('second drop'));

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenLastCalledWith(new Error('second drop'));
  });

  it('survives a throwing handler — the drop has already happened', async () => {
    const { t, client } = await connected();
    client.onDisconnect = () => {
      throw new Error('application bug');
    };
    expect(() => t.emitDisconnect()).not.toThrow();
  });

  it('still emits the status line, so existing consumers are unaffected', async () => {
    const { t, client } = await connected();
    const seen: string[] = [];
    client.onStatus = (m) => void seen.push(m);
    t.emitDisconnect();
    expect(seen).toContain('Device disconnected');
  });
});

describe('Shimmer3Client onDisconnect', () => {
  async function connected(): Promise<{ t: LoopbackTransport; client: Shimmer3Client }> {
    const t = new LoopbackTransport({
      capabilities: { framed: false },
      deviceName: 'Shimmer3-TEST',
    });
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) setTimeout(() => tr.notify([DEVVER, 3]), 0);
      else if (op === OPCODES.GET_FW_VERSION_COMMAND)
        setTimeout(() => tr.notify([FWVER, 3, 0, 0, 0, 15, 0]), 0);
    });
    const client = new Shimmer3Client({ debug: false, transport: t });
    await client.connect();
    return { t, client };
  }

  it('fires once with the reason on a dropped RFCOMM link', async () => {
    const { t, client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;

    const reason = new Error('The device has been lost');
    t.emitDisconnect(reason);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(reason);
    expect(isStreaming(client)).toBe(false);
  });

  it('stays silent for an application-initiated disconnect()', async () => {
    const { client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;
    await client.disconnect();
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('WiredShimmerClient onDisconnect', () => {
  async function connected(): Promise<{ t: LoopbackTransport; client: WiredShimmerClient }> {
    const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Dock-TEST' });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    return { t, client };
  }

  it('fires once with the reason when the dock UART goes away', async () => {
    const { t, client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;

    const reason = new Error('The device has been lost');
    t.emitDisconnect(reason);
    t.emitDisconnect(reason);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(reason);
  });

  it('stays silent for an application-initiated disconnect()', async () => {
    const { client } = await connected();
    const spy = vi.fn();
    client.onDisconnect = spy;
    await client.disconnect();
    expect(spy).not.toHaveBeenCalled();
  });
});
