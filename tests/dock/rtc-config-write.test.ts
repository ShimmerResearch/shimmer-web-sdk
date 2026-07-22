import { describe, it, expect } from 'vitest';
import { WiredShimmerClient } from '../../src/devices/dock/WiredShimmerClient.js';
import { SmartDockClient } from '../../src/devices/dock/SmartDockClient.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import {
  buildUartPacket,
  parseUartPacket,
  msToRtcBytesLE,
  isSupportedRtcConfigViaUart,
  type UartRxPacket,
} from '../../src/devices/dock/protocol.js';
import { UART_PACKET_CMD } from '../../src/devices/dock/constants.js';
import { parseInfoMem, INFOMEM_SIZE } from '../../src/devices/infomem/index.js';
import type { InfoMemContext } from '../../src/devices/infomem/index.js';

const dec = (u8: Uint8Array): string => new TextDecoder().decode(u8);
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// VER payloads (7-byte): [hw][fwId LE(2)][major LE(2)][minor][internal].
const VER_S3_LOGANDSTREAM = Uint8Array.from([3, 3, 0, 0, 0, 16, 11]); // hw3 + LogAndStream 0.16.11 → RTC supported
const VER_S3_BTSTREAM = Uint8Array.from([3, 1, 0, 0, 0, 6, 0]); // hw3 + BtStream 0.6.0 → RTC UNsupported
const VER_S3R = Uint8Array.from([10, 3, 0, 1, 0, 0, 40]); // hw10 (Shimmer3R) + LogAndStream 1.0.40 → RTC supported
const MAC_PAYLOAD = Uint8Array.from([0x00, 0x06, 0x66, 0x12, 0x34, 0x56]);

const CTX_S3_LAS: InfoMemContext = {
  hardwareVersion: 3,
  firmwareId: 3,
  firmwareVersion: { major: 0, minor: 16, internal: 11 },
};
const CTX_S3_BT: InfoMemContext = {
  hardwareVersion: 3,
  firmwareId: 1,
  firmwareVersion: { major: 0, minor: 6, internal: 0 },
};
const CTX_S3R: InfoMemContext = {
  hardwareVersion: 10,
  firmwareId: 3,
  firmwareVersion: { major: 1, minor: 0, internal: 40 },
};

/** A raw array whose first byte is non-0xFF so parse treats it as valid/configured. */
function seedRaw(): Uint8Array {
  const b = new Uint8Array(INFOMEM_SIZE);
  b[0] = 64;
  return b;
}

function makeConfig(ctx: InfoMemContext): ReturnType<typeof parseInfoMem> {
  return { ...parseInfoMem(seedRaw(), ctx), samplingRateHz: 128, deviceName: 'RTC' };
}

interface DockOpts {
  ver?: Uint8Array;
  store?: Uint8Array;
  /** If set, BAD_ARG-respond to a WRITE against this [component, property]. */
  badWriteOn?: [number, number];
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
      if (c === 0x01 && p === 0x03) return reply(opts.ver ?? VER_S3_LOGANDSTREAM);
      if (c === 0x01 && p === 0x06) {
        const size = req.payload[0];
        const addr = req.payload[1] | (req.payload[2] << 8);
        const off = addr >= 0x1800 ? addr - 0x1800 : addr;
        const data = store.slice(off, off + size);
        setTimeout(
          () => tr.notify(buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg(0x01, 0x06), data)),
          0,
        );
      }
      return;
    }
    if (req.command === UART_PACKET_CMD.WRITE) {
      if (opts.badWriteOn && c === opts.badWriteOn[0] && p === opts.badWriteOn[1]) {
        setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.BAD_ARG_RESPONSE, null)), 0);
        return;
      }
      if (c === 0x01 && p === 0x06) {
        const addr = req.payload[1] | (req.payload[2] << 8);
        const off = addr >= 0x1800 ? addr - 0x1800 : addr;
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
  await client.identify();
  return { t, client, store };
}

/** Parsed host→device WRITE frames, in order. */
function writeFrames(t: LoopbackTransport): UartRxPacket[] {
  return t.writes
    .map((w) => parseUartPacket(w.bytes))
    .filter((r) => r.command === UART_PACKET_CMD.WRITE);
}

// ---------------------------------------------------------------------------

describe('msToRtcBytesLE — RTC tick payload (UtilShimmer parity)', () => {
  it('encodes 1000 ms as 32768 ticks, 8 bytes LSB-first', () => {
    // 1000 × 32.768 = 32768 ticks = 0x8000 → LSB-first over 8 bytes.
    expect([...msToRtcBytesLE(1000)]).toEqual([0x00, 0x80, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  });

  it('encodes 1_000_000 ms as 32_768_000 ticks (0x01F40000) LSB-first', () => {
    expect([...msToRtcBytesLE(1_000_000)]).toEqual([
      0x00, 0x00, 0xf4, 0x01, 0x00, 0x00, 0x00, 0x00,
    ]);
  });

  it('encodes 0 ms as all-zero', () => {
    expect([...msToRtcBytesLE(0)]).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
  });
});

describe('isSupportedRtcConfigViaUart — gate parity (ShimmerVerObject.java:405)', () => {
  it('Shimmer3 supports RTC only on SDLog/LogAndStream/StroKare firmware', () => {
    expect(isSupportedRtcConfigViaUart(3, 2)).toBe(true); // SDLog
    expect(isSupportedRtcConfigViaUart(3, 3)).toBe(true); // LogAndStream
    expect(isSupportedRtcConfigViaUart(3, 15)).toBe(true); // StroKare
    expect(isSupportedRtcConfigViaUart(3, 1)).toBe(false); // BtStream
  });

  it('Shimmer3R supports RTC on any firmware', () => {
    expect(isSupportedRtcConfigViaUart(10, 1)).toBe(true);
    expect(isSupportedRtcConfigViaUart(10, 3)).toBe(true);
  });
});

describe('WiredShimmerClient.writeRtcFromHostTime', () => {
  it('writes the injected timestamp to MAIN_PROCESSOR.RTC_CFG_TIME (0x01/0x04)', async () => {
    const { t, client } = await connected();
    await client.writeRtcFromHostTime(1_000_000);
    const frames = writeFrames(t);
    const rtc = frames.find((f) => f.component === 0x01 && f.property === 0x04);
    expect(rtc).toBeDefined();
    expect([...rtc!.payload]).toEqual([0x00, 0x00, 0xf4, 0x01, 0x00, 0x00, 0x00, 0x00]);
  });
});

describe('WiredShimmerClient.writeInfoMemConfig — RTC ordering + gating', () => {
  it('writes the RTC frame BEFORE the first InfoMem chunk (desktop order)', async () => {
    const { t, client } = await connected();
    await client.writeInfoMemConfig(makeConfig(CTX_S3_LAS));
    const frames = writeFrames(t);
    const firstRtc = frames.findIndex((f) => f.component === 0x01 && f.property === 0x04);
    const firstInfoMem = frames.findIndex((f) => f.component === 0x01 && f.property === 0x06);
    expect(firstRtc).toBeGreaterThanOrEqual(0);
    expect(firstInfoMem).toBeGreaterThanOrEqual(0);
    expect(firstRtc).toBeLessThan(firstInfoMem);
  });

  it('setRtc:false skips the RTC write but still writes InfoMem', async () => {
    const { t, client, store } = await connected();
    await client.writeInfoMemConfig(makeConfig(CTX_S3_LAS), { setRtc: false });
    const frames = writeFrames(t);
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x04)).toBe(false);
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x06)).toBe(true);
    expect(store[224]).toBe(0xff); // MAC forced 0xFF → InfoMem did run
  });

  it('skips the RTC write on an unsupported identity (Shimmer3 + BtStream), InfoMem still written', async () => {
    const { t, client } = await connected({ ver: VER_S3_BTSTREAM });
    await client.writeInfoMemConfig(makeConfig(CTX_S3_BT));
    const frames = writeFrames(t);
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x04)).toBe(false);
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x06)).toBe(true);
  });

  it('ABORTS the config write when the RTC write fails — InfoMem is NOT attempted', async () => {
    // Desktop CallableWriteConfig rethrows the RTC ExecutionException before the
    // InfoMem write (BasicDock.java:1564-1573): failure is fatal, not best-effort.
    const { t, client } = await connected({ badWriteOn: [0x01, 0x04] });
    await expect(client.writeInfoMemConfig(makeConfig(CTX_S3_LAS))).rejects.toThrow();
    const frames = writeFrames(t);
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x04)).toBe(true); // RTC attempted
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x06)).toBe(false); // InfoMem NOT attempted
  });

  it('Shimmer3R performs the RTC write (supported on any firmware)', async () => {
    const { t, client } = await connected({ ver: VER_S3R });
    await client.writeInfoMemConfig(makeConfig(CTX_S3R));
    const frames = writeFrames(t);
    expect(frames.some((f) => f.component === 0x01 && f.property === 0x04)).toBe(true);
  });
});

describe('SmartDockClient.writeInfoMemConfig — RTC in the per-slot flow', () => {
  it('selects the slot then writes RTC before InfoMem over the per-Shimmer UART', async () => {
    const base = new LoopbackTransport({
      capabilities: { framed: false },
      deviceName: 'SmartDock',
    });
    const shimmer = newTransport();
    const { store } = scriptDock(shimmer, { ver: VER_S3_LOGANDSTREAM });
    let activeSlot = -1;
    base.setOnWrite((bytes, tr) => {
      const cmd = dec(bytes);
      if (cmd.startsWith('SDP,')) {
        const nn = cmd.slice(4, 6);
        activeSlot = Number.parseInt(nn, 10);
        setTimeout(() => tr.notify(enc(`P,${nn}\r\n`)), 0);
      }
    });
    const dock = new SmartDockClient({
      debug: false,
      transport: base,
      shimmerTransport: shimmer,
      timeouts: { responseTimeoutMs: 200, slotChangeTimeoutMs: 200, slotChangeoverDelayMs: 0 },
    });
    await dock.connect();

    const res = await dock.writeInfoMemConfig(2, makeConfig(CTX_S3_LAS));
    expect(activeSlot).toBe(2);
    expect(res.verified).toBeNull();

    const frames = writeFrames(shimmer);
    const firstRtc = frames.findIndex((f) => f.component === 0x01 && f.property === 0x04);
    const firstInfoMem = frames.findIndex((f) => f.component === 0x01 && f.property === 0x06);
    expect(firstRtc).toBeGreaterThanOrEqual(0);
    expect(firstRtc).toBeLessThan(firstInfoMem);
    expect(store[224]).toBe(0xff); // device-write MAC forced 0xFF
  });
});
