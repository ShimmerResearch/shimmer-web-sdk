import { describe, it, expect } from 'vitest';
import { WiredShimmerClient } from '../../src/devices/dock/WiredShimmerClient.js';
import { SmartDockClient } from '../../src/devices/dock/SmartDockClient.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { buildUartPacket, parseUartPacket } from '../../src/devices/dock/protocol.js';
import { UART_PACKET_CMD } from '../../src/devices/dock/constants.js';
import { generateInfoMem, parseInfoMem, INFOMEM_SIZE } from '../../src/devices/infomem/index.js';
import { CTX } from './fixtures.js';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u8: Uint8Array): string => new TextDecoder().decode(u8);

// VER payload (7-byte): [hw][fwId LE(2)][major LE(2)][minor][internal].
const VER_MODERN = Uint8Array.from([3, 3, 0, 0, 0, 16, 11]); // Shimmer3 + LogAndStream 0.16.11 → flat addr
const VER_LEGACY = Uint8Array.from([3, 2, 0, 0, 0, 8, 68]); // Shimmer3 + SDLog 0.8.68 → legacy 0x1800 addr
const MAC_PAYLOAD = Uint8Array.from([0x00, 0x06, 0x66, 0x12, 0x34, 0x56]);

interface DockOpts {
  ver?: Uint8Array;
  store?: Uint8Array; // 384-byte InfoMem
  corruptInfoMemCrc?: boolean;
  /** Mutate the read-back copy to prove verify excludes the divergent ranges. */
  divergeReadback?: (bytes: Uint8Array) => void;
}

/** Map a page address (flat 0/128/256 or legacy 0x1800/0x1880/0x1900) to a store offset. */
function pageOffset(addr: number): number {
  return addr >= 0x1800 ? addr - 0x1800 : addr;
}

/** A scripted docked Shimmer with a 384-byte InfoMem store served in 128-byte pages. */
function scriptDock(t: LoopbackTransport, opts: DockOpts = {}): { store: Uint8Array } {
  const store = opts.store ?? new Uint8Array(INFOMEM_SIZE);
  t.setOnWrite((bytes, tr) => {
    const req = parseUartPacket(bytes);
    const c = req.component;
    const p = req.property;
    const arg = (comp: number, prop: number) => ({
      component: comp,
      property: prop,
      permission: 'READ_WRITE' as const,
      name: 'x',
    });

    if (req.command === UART_PACKET_CMD.READ) {
      if (c === 0x01 && p === 0x02) return reply(MAC_PAYLOAD);
      if (c === 0x01 && p === 0x03) return reply(opts.ver ?? VER_MODERN);
      if (c === 0x01 && p === 0x06) {
        // InfoMem mem-read: payload [size, addrLo, addrHi].
        const size = req.payload[0];
        const addr = req.payload[1] | (req.payload[2] << 8);
        const off = pageOffset(addr);
        const view = store.slice();
        if (opts.divergeReadback) opts.divergeReadback(view);
        const data = view.slice(off, off + size);
        const rsp = buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg(0x01, 0x06), data);
        if (opts.corruptInfoMemCrc) rsp[rsp.length - 1] ^= 0xff;
        setTimeout(() => tr.notify(rsp), 0);
      }
      return;
    }
    if (req.command === UART_PACKET_CMD.WRITE) {
      if (c === 0x01 && p === 0x06) {
        // InfoMem mem-write: payload [len, addrLo, addrHi, ...data].
        const addr = req.payload[1] | (req.payload[2] << 8);
        const off = pageOffset(addr);
        store.set(req.payload.subarray(3), off);
      }
      setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE, null)), 0);
    }

    function reply(payload: Uint8Array): void {
      setTimeout(
        () => tr.notify(buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg(c!, p!), payload)),
        0,
      );
    }
  });
  return { store };
}

function newTransport(): LoopbackTransport {
  return new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Shimmer-Dock' });
}

async function connected(opts?: DockOpts): Promise<{
  t: LoopbackTransport;
  client: WiredShimmerClient;
  store: Uint8Array;
}> {
  const t = newTransport();
  const { store } = scriptDock(t, opts);
  const client = new WiredShimmerClient({ debug: false, transport: t });
  await client.connect();
  await client.identify(); // populate identity (needed for InfoMem ctx)
  return { t, client, store };
}

/** Pull the InfoMem read-request addresses (addrLo/Hi) out of the recorded writes. */
function infoMemReadAddrs(t: LoopbackTransport): number[] {
  return t.writes
    .map((w) => parseUartPacket(w.bytes))
    .filter(
      (r) => r.command === UART_PACKET_CMD.READ && r.component === 0x01 && r.property === 0x06,
    )
    .map((r) => r.payload[1] | (r.payload[2] << 8));
}

describe('WiredShimmerClient.readInfoMemBytes — chunked (3×128) reassembly', () => {
  it('reassembles the full 384-byte InfoMem in D→C→B order', async () => {
    const store = Uint8Array.from({ length: INFOMEM_SIZE }, (_, i) => i % 256);
    const { t, client } = await connected({ store });
    const bytes = await client.readInfoMemBytes();
    expect(bytes.length).toBe(INFOMEM_SIZE);
    expect([...bytes]).toEqual([...store]);
    // Flat addressing (LogAndStream 0.16.11): pages 0, 128, 256.
    expect(infoMemReadAddrs(t)).toEqual([0, 128, 256]);
  });

  it('sends LEGACY 0x1800/0x1880/0x1900 page addresses for SDLog 0.8.68', async () => {
    const { t, client } = await connected({ ver: VER_LEGACY });
    await client.readInfoMemBytes();
    expect(infoMemReadAddrs(t)).toEqual([0x1800, 0x1880, 0x1900]);
  });
});

describe('WiredShimmerClient.writeInfoMemBytes — chunked write', () => {
  it('writes all 384 bytes across 3 pages, each ACKed', async () => {
    const pattern = Uint8Array.from({ length: INFOMEM_SIZE }, (_, i) => (i * 7) & 0xff);
    const { t, client, store } = await connected();
    await client.writeInfoMemBytes(pattern);
    expect([...store]).toEqual([...pattern]);
    const writeAddrs = t.writes
      .map((w) => parseUartPacket(w.bytes))
      .filter(
        (r) => r.command === UART_PACKET_CMD.WRITE && r.component === 0x01 && r.property === 0x06,
      )
      .map((r) => r.payload[1] | (r.payload[2] << 8));
    expect(writeAddrs).toEqual([0, 128, 256]);
  });

  it('rejects a wrong-length buffer', async () => {
    const { client } = await connected();
    await expect(client.writeInfoMemBytes(new Uint8Array(100))).rejects.toThrow(/384 bytes/);
  });
});

describe('WiredShimmerClient InfoMem — error paths', () => {
  it('rejects on a bad-CRC InfoMem response', async () => {
    const { client } = await connected({ corruptInfoMemCrc: true });
    await expect(client.readInfoMemBytes()).rejects.toThrow(/timeout/i);
  }, 3000);

  it('throws if identity has not been read', async () => {
    const t = newTransport();
    scriptDock(t);
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect(); // no identify()
    await expect(client.readInfoMemBytes()).rejects.toThrow(/version/i);
  });
});

describe('WiredShimmerClient.readInfoMemConfig / writeInfoMemConfig', () => {
  it('reads and decodes a stored configuration', async () => {
    const seed = generateInfoMem(
      {
        ...parseInfoMem(seedRaw(), CTX.modernShimmer3),
        deviceName: 'DockDev',
        samplingRateHz: 256,
      },
      CTX.modernShimmer3,
      { forDeviceWrite: false },
    );
    const { client } = await connected({ store: seed });
    const cfg = await client.readInfoMemConfig();
    expect(cfg.valid).toBe(true);
    expect(cfg.deviceName).toBe('DockDev');
    expect(cfg.samplingRateHz).toBeCloseTo(256, 6);
  });

  it('writes with device-write finalization; verify=null when not requested', async () => {
    const { client, store } = await connected();
    const cfg = {
      ...parseInfoMem(seedRaw(), CTX.modernShimmer3),
      samplingRateHz: 128,
      deviceName: 'W',
    };
    const res = await client.writeInfoMemConfig(cfg);
    expect(res.verified).toBeNull();
    // MAC forced 0xFF in the stored bytes (device-write semantics).
    for (let i = 0; i < 6; i++) expect(store[224 + i]).toBe(0xff);
  });

  it('verify=true passes even when the device diverges the MAC + config-delay byte on read-back', async () => {
    // Simulate firmware: on read-back the MAC is the real transceiver MAC and the
    // config-delay flag has been cleared — both EXCLUDED from the comparison.
    const t = newTransport();
    scriptDock(t, {
      divergeReadback: (b) => {
        for (let i = 0; i < 6; i++) b[224 + i] = 0x11 + i; // real MAC
        b[230] = 0x00; // flag cleared by FW
      },
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    await client.identify();
    const cfg = { ...parseInfoMem(seedRaw(), CTX.modernShimmer3), samplingRateHz: 200 };
    const res = await client.writeInfoMemConfig(cfg, { verify: true });
    expect(res.verified).toBe(true);
  });

  it('verify=false when a NON-excluded byte diverges on read-back', async () => {
    const t = newTransport();
    scriptDock(t, {
      divergeReadback: (b) => {
        b[3] = (b[3] + 1) & 0xff; // corrupt a sensors byte (not excluded)
      },
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    await client.identify();
    const cfg = { ...parseInfoMem(seedRaw(), CTX.modernShimmer3), enabledSensors: 0x0000e0 };
    const res = await client.writeInfoMemConfig(cfg, { verify: true });
    expect(res.verified).toBe(false);
  });
});

describe('SmartDockClient InfoMem per-slot (atomic selectSlot + read)', () => {
  it('selects the slot then reads the docked config over the per-Shimmer UART', async () => {
    const enc2 = enc;
    const base = new LoopbackTransport({
      capabilities: { framed: false },
      deviceName: 'SmartDock',
    });
    const shimmer = newTransport();
    const seed = generateInfoMem(
      {
        ...parseInfoMem(seedRaw(), CTX.modernShimmer3),
        deviceName: 'Slot2Dev',
        samplingRateHz: 51.2,
      },
      CTX.modernShimmer3,
      { forDeviceWrite: false },
    );
    scriptDock(shimmer, { store: seed });
    let activeSlot = -1;
    base.setOnWrite((bytes, tr) => {
      const cmd = dec(bytes);
      if (cmd.startsWith('SDP,')) {
        const nn = cmd.slice(4, 6);
        activeSlot = Number.parseInt(nn, 10);
        setTimeout(() => tr.notify(enc2(`P,${nn}\r\n`)), 0);
      }
    });
    const dock = new SmartDockClient({
      debug: false,
      transport: base,
      shimmerTransport: shimmer,
      timeouts: { responseTimeoutMs: 200, slotChangeTimeoutMs: 200, slotChangeoverDelayMs: 0 },
    });
    await dock.connect();

    const cfg = await dock.readInfoMemConfig(2);
    expect(activeSlot).toBe(2);
    expect(cfg.deviceName).toBe('Slot2Dev');

    // Concurrent per-slot calls must not interleave (serialized queue).
    const [a, b] = await Promise.all([dock.readInfoMemConfig(3), dock.readInfoMemConfig(4)]);
    expect(a.deviceName).toBe('Slot2Dev');
    expect(b.deviceName).toBe('Slot2Dev');
    expect(dock.activeSlot).toBe(4); // last selected wins after both settle
  });
});

/** A raw array whose first byte is non-0xFF so parse treats it as valid/configured. */
function seedRaw(): Uint8Array {
  const b = new Uint8Array(INFOMEM_SIZE);
  b[0] = 64;
  return b;
}
