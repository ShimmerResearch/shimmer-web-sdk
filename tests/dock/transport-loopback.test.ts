import { describe, it, expect } from 'vitest';
import { WiredShimmerClient } from '../../src/devices/dock/WiredShimmerClient.js';
import {
  buildUartPacket,
  parseUartPacket,
  type UartRxPacket,
} from '../../src/devices/dock/protocol.js';
import { UART_PACKET_CMD, UART_PROP } from '../../src/devices/dock/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// Drive WiredShimmerClient against a scripted in-memory dock over a transport
// marked `framed: false` (dock UART is an unframed serial byte stream). These
// tests pin identify/status/config behaviour and — the whole point — robustness
// to arbitrary stream fragmentation, bad CRC, and device error responses.

const u8 = (...b: number[]): Uint8Array => Uint8Array.from(b);

// Hand-derived response fixtures (see protocol.test.ts for the byte breakdowns).
const MAC_PAYLOAD = u8(0x00, 0x06, 0x66, 0x66, 0x80, 0x01); // → "000666668001"
const VER_PAYLOAD = u8(0x0a, 0x03, 0x00, 0x00, 0x00, 0x0f, 0x00); // HW10 fwId3 0.15.0
const BAT_PAYLOAD = u8(0x00, 0x0a, 0x40); // adc 0x0a00, FULLY_CHARGED
const CARDID_PAYLOAD = u8(0x08, 0x01, 0x03, ...Array(13).fill(0xff)); // board 8/1/3

/** A scripted docked Shimmer: answers READs with DATA_RESPONSEs and WRITEs with ACKs. */
function scriptDock(t: LoopbackTransport, opts: { corruptCrc?: boolean } = {}): void {
  t.setOnWrite((bytes, tr) => {
    const req = parseUartPacket(bytes);
    if (req.command === UART_PACKET_CMD.READ) {
      let payload: Uint8Array | null = null;
      const c = req.component;
      const p = req.property;
      if (
        c === UART_PROP.MAIN_PROCESSOR.MAC.component &&
        p === UART_PROP.MAIN_PROCESSOR.MAC.property
      )
        payload = MAC_PAYLOAD;
      else if (c === 0x01 && p === 0x03) payload = VER_PAYLOAD;
      else if (c === 0x02 && p === 0x02) payload = BAT_PAYLOAD;
      else if (c === 0x03 && p === 0x02) payload = CARDID_PAYLOAD;
      if (payload) {
        const arg = { component: c!, property: p!, permission: 'READ_ONLY' as const, name: 'x' };
        const rsp = buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg, payload);
        if (opts.corruptCrc) rsp[rsp.length - 1] ^= 0xff;
        setTimeout(() => tr.notify(rsp), 0);
      }
    } else if (req.command === UART_PACKET_CMD.WRITE) {
      setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE, null)), 0);
    }
  });
}

function newTransport(): LoopbackTransport {
  return new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Shimmer-Dock' });
}

async function connected(opts?: { corruptCrc?: boolean }): Promise<{
  t: LoopbackTransport;
  client: WiredShimmerClient;
}> {
  const t = newTransport();
  scriptDock(t, opts);
  const client = new WiredShimmerClient({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

describe('WiredShimmerClient connect', () => {
  it('throws without an injected transport', async () => {
    const client = new WiredShimmerClient({ debug: false });
    await expect(client.connect()).rejects.toThrow(/requires an injected transport/i);
  });

  it('opens the transport on connect', async () => {
    const { t } = await connected();
    expect(t.connected).toBe(true);
  });

  it('rejects streaming (not a dock capability)', async () => {
    const { client } = await connected();
    await expect(client.startStreaming()).rejects.toThrow(/not supported/i);
  });
});

describe('WiredShimmerClient identify / status', () => {
  it('identify reads MAC → VER → expansion board in order', async () => {
    const { t, client } = await connected();
    const id = await client.identify();
    expect(id.mac).toBe('000666668001');
    expect(id.hardwareVersion).toBe(0x0a);
    expect(id.firmwareVersion.firmwareIdentifier).toBe(3);
    expect(id.firmwareVersion.firmwareVersionMinor).toBe(15);
    expect(id.expansionBoard).toEqual({ boardId: 8, boardRev: 1, specialRev: 3 });

    // Request order: READ MAC (01/02), READ VER (01/03), READ CARD_ID (03/02).
    const reads = t.writes.map((w) => parseUartPacket(w.bytes)).filter((r) => r.command === 0x03);
    expect(reads.map((r) => [r.component, r.property])).toEqual([
      [0x01, 0x02],
      [0x01, 0x03],
      [0x03, 0x02],
    ]);
  });

  it('getStatus decodes battery voltage / % / charging', async () => {
    const { client } = await connected();
    const s = await client.getStatus();
    expect(s.adcValue).toBe(0x0a00);
    expect(s.chargingStatus).toBe('FULLY_CHARGED');
    expect(s.voltage).toBeCloseTo(3.7284, 3);
    expect(s.percentage).toBeGreaterThan(0);
  });
});

describe('WiredShimmerClient config', () => {
  it('getConfig returns the raw property payload', async () => {
    const { client } = await connected();
    const mac = await client.getConfig(UART_PROP.MAIN_PROCESSOR.MAC);
    expect([...mac]).toEqual([...MAC_PAYLOAD]);
  });

  it('setConfig sends a WRITE and resolves on ACK', async () => {
    const { t, client } = await connected();
    await client.setConfig(UART_PROP.GSR.RANGE, u8(0x02));
    const write = parseUartPacket(t.lastWrite!.bytes);
    expect(write.command).toBe(UART_PACKET_CMD.WRITE);
    expect(write.component).toBe(UART_PROP.GSR.RANGE.component);
    expect(write.property).toBe(UART_PROP.GSR.RANGE.property);
    expect([...write.payload]).toEqual([0x02]);
  });

  it('getConfig rejects a write-only property; setConfig rejects a read-only one', async () => {
    const { client } = await connected();
    await expect(client.getConfig(UART_PROP.MAIN_PROCESSOR.ENTER_BOOTLOADER)).rejects.toThrow(
      /write-only/i,
    );
    await expect(client.setConfig(UART_PROP.MAIN_PROCESSOR.VER, u8(0))).rejects.toThrow(
      /read-only/i,
    );
  });

  it('readInfoMem issues a memory READ with [size, addrLE...] payload', async () => {
    const t = newTransport();
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command === UART_PACKET_CMD.READ && req.component === 0x01 && req.property === 0x06) {
        // Echo the requested size worth of bytes.
        const size = req.payload[0];
        const arg = {
          component: 0x01,
          property: 0x06,
          permission: 'READ_WRITE' as const,
          name: 'INFOMEM',
        };
        const data = Uint8Array.from({ length: size }, (_, i) => i);
        setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg, data)), 0);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    const mem = await client.readInfoMem(0x0010, 4);
    expect([...mem]).toEqual([0, 1, 2, 3]);
    const req = parseUartPacket(t.lastWrite!.bytes);
    expect([...req.payload]).toEqual([0x04, 0x10, 0x00]); // size, addr LE
  });
});

describe('WiredShimmerClient robustness (unframed stream)', () => {
  /** Deliver bytes one-per-macrotask (serial 1-byte dribble). */
  function dribble(tr: LoopbackTransport, bytes: number[]): void {
    bytes.forEach((b, i) => setTimeout(() => tr.notify([b]), i));
  }

  it('reassembles a response delivered one byte at a time', async () => {
    const t = newTransport();
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command === UART_PACKET_CMD.READ) {
        const arg = {
          component: 0x01,
          property: 0x02,
          permission: 'READ_ONLY' as const,
          name: 'MAC',
        };
        const rsp = buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg, MAC_PAYLOAD);
        dribble(tr, [...rsp]);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    expect(await client.readMac()).toBe('000666668001');
  });

  it('reassembles two coalesced packets in one chunk', async () => {
    const t = newTransport();
    const captured: UartRxPacket[] = [];
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command === UART_PACKET_CMD.WRITE) {
        // Deliver a stray ACK glued in front of the real ACK in a single chunk.
        const ack = buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE, null);
        setTimeout(() => tr.notify(Uint8Array.from([...ack, ...ack])), 0);
        captured.push(req);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    // Two ACKs arrive coalesced; the first satisfies the write, the extra is harmless.
    await expect(client.setConfig(UART_PROP.GSR.RANGE, u8(1))).resolves.toBeUndefined();
  });

  it('recovers from leading garbage bytes before a valid packet', async () => {
    const t = newTransport();
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command === UART_PACKET_CMD.READ) {
        const arg = {
          component: 0x02,
          property: 0x02,
          permission: 'READ_ONLY' as const,
          name: 'BAT',
        };
        const rsp = buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg, BAT_PAYLOAD);
        // Prepend non-header noise; the client should resync on the '$'.
        setTimeout(() => tr.notify(Uint8Array.from([0x11, 0x22, ...rsp])), 0);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    const s = await client.getStatus();
    expect(s.adcValue).toBe(0x0a00);
  });

  it('rejects on a bad-CRC response (single-byte resync never yields a valid frame)', async () => {
    const { client } = await connected({ corruptCrc: true });
    await expect(client.readMac()).rejects.toThrow(/timeout/i);
  });

  it('rejects with the device error reason on a BAD_ARG response', async () => {
    const t = newTransport();
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command === UART_PACKET_CMD.READ) {
        setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.BAD_ARG_RESPONSE, null)), 0);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    await expect(client.readVersion()).rejects.toThrow(/BAD_ARG/);
  });

  it('times out when the device never answers', async () => {
    const t = newTransport(); // no onWrite → silent device
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    await expect(client.getStatus()).rejects.toThrow(/timeout/i);
  }, 2000);
});

describe('WiredShimmerClient MAC-read retry (oracle READ_MAC_RETRY_ATTEMPTS=2)', () => {
  it('reads the MAC exactly twice before failing', async () => {
    const t = newTransport();
    let macReads = 0;
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command === UART_PACKET_CMD.READ && req.component === 0x01 && req.property === 0x02) {
        macReads += 1;
        setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.BAD_ARG_RESPONSE, null)), 0);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();
    await expect(client.readMac()).rejects.toThrow();
    // AbstractDock.java:1153 `for(i=0;i<2;i++)` → 2 total attempts (not 3).
    expect(macReads).toBe(2);
  }, 2000);
});

describe('WiredShimmerClient command serialization (ACK correlation)', () => {
  it('does not let a silent-failing write steal a later command’s ACK', async () => {
    const t = newTransport();
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.command !== UART_PACKET_CMD.WRITE) return;
      // Only the GSR.RANGE write is ACKed; the LSM accel write is silently
      // dropped. Without serialization the (earlier-registered) accel write's
      // _waitForAck would consume the GSR write's ACK — masking the failure and
      // starving the good write. Serialization keeps each op self-contained.
      if (
        req.component === UART_PROP.GSR.RANGE.component &&
        req.property === UART_PROP.GSR.RANGE.property
      ) {
        setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE, null)), 0);
      }
    });
    const client = new WiredShimmerClient({ debug: false, transport: t });
    await client.connect();

    const pSilent = client.setConfig(UART_PROP.LSM303DLHC_ACCEL.RANGE, u8(1)); // never ACKed
    const pAcked = client.setConfig(UART_PROP.GSR.RANGE, u8(2)); // ACKed
    const [rSilent, rAcked] = await Promise.allSettled([pSilent, pAcked]);

    expect(rSilent.status).toBe('rejected'); // failed write is surfaced, not masked
    expect((rSilent as PromiseRejectedResult).reason.message).toMatch(/timeout/i);
    expect(rAcked.status).toBe('fulfilled'); // good write still succeeds with its own ACK
  }, 3000);
});
