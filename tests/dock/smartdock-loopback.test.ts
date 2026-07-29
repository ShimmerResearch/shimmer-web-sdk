import { describe, it, expect } from 'vitest';
import { SmartDockClient } from '../../src/devices/dock/SmartDockClient.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { buildUartPacket, parseUartPacket } from '../../src/devices/dock/protocol.js';
import { UART_PACKET_CMD } from '../../src/devices/dock/constants.js';

// Drive SmartDockClient against a scripted in-memory SmartDock. The base uses a
// separate ASCII command channel from the per-Shimmer binary UART channel (two
// FTDI ports on real hardware), so we model two LoopbackTransports that share a
// tiny state object (the currently-active slot) — proving that a base slot
// switch re-routes the per-Shimmer identify/status to the right device.

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const dec = (u8: Uint8Array): string => new TextDecoder().decode(u8);

interface BaseState {
  slot: number; // currently active slot (per SDP,NN$)
  hwVersion: number; // 1 = base15, 2 = base6
  occupancy: string; // ASCII bitmap
}

// Per-Shimmer fixtures (mirroring the D1 loopback test).
const VER_PAYLOAD = Uint8Array.from([0x0a, 0x03, 0x00, 0x00, 0x00, 0x0f, 0x00]); // HW10 fwId3 0.15.0
const BAT_PAYLOAD = Uint8Array.from([0x00, 0x0a, 0x40]); // adc 0x0a00, FULLY_CHARGED
const CARDID_PAYLOAD = Uint8Array.from([0x08, 0x01, 0x03, ...Array(13).fill(0xff)]);

/** Script the ASCII base channel. `opts.silentSlotChange` never answers SDP. */
function scriptBase(
  t: LoopbackTransport,
  state: BaseState,
  opts: { silentSlotChange?: boolean; garbageBeforeVersion?: boolean } = {},
): void {
  t.setOnWrite((bytes, tr) => {
    const cmd = dec(bytes);
    if (cmd === 'SDV$') {
      const line = `V,${state.hwVersion},3,0,5,0\r\n`;
      const payload = opts.garbageBeforeVersion ? `zz\r\n${line}` : line;
      setTimeout(() => tr.notify(enc(payload)), 0);
    } else if (cmd === 'SDQ$') {
      setTimeout(() => tr.notify(enc(`Q,${state.occupancy}\r\n`)), 0);
    } else if (cmd.startsWith('SDP,')) {
      if (opts.silentSlotChange) return; // never answers → slot-change timeout
      const nn = cmd.slice(4, 6);
      state.slot = Number.parseInt(nn, 10);
      setTimeout(() => tr.notify(enc(`P,${nn}\r\n`)), 0);
    } else if (cmd === 'SDD$') {
      setTimeout(() => tr.notify(enc('D\r\n')), 0);
    }
  });
}

/** Script the per-Shimmer binary channel; MAC encodes the active slot. */
function scriptShimmer(t: LoopbackTransport, state: BaseState): void {
  t.setOnWrite((bytes, tr) => {
    const req = parseUartPacket(bytes);
    if (req.command !== UART_PACKET_CMD.READ) return;
    const c = req.component;
    const p = req.property;
    let payload: Uint8Array | null = null;
    if (c === 0x01 && p === 0x02) {
      // MAC — last byte = active slot, so identify() proves slot routing.
      payload = Uint8Array.from([0x00, 0x06, 0x66, 0x66, 0x80, state.slot & 0xff]);
    } else if (c === 0x01 && p === 0x03) payload = VER_PAYLOAD;
    else if (c === 0x02 && p === 0x02) payload = BAT_PAYLOAD;
    else if (c === 0x03 && p === 0x02) payload = CARDID_PAYLOAD;
    if (payload) {
      const arg = { component: c!, property: p!, permission: 'READ_ONLY' as const, name: 'x' };
      setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg, payload!)), 0);
    }
  });
}

const FAST = { responseTimeoutMs: 200, slotChangeTimeoutMs: 200, slotChangeoverDelayMs: 0 };

async function connectedDock(
  opts: {
    hwVersion?: number;
    occupancy?: string;
    baseScript?: Parameters<typeof scriptBase>[2];
  } = {},
): Promise<{
  dock: SmartDockClient;
  base: LoopbackTransport;
  shimmer: LoopbackTransport;
  state: BaseState;
}> {
  const state: BaseState = {
    slot: -1,
    hwVersion: opts.hwVersion ?? 1,
    occupancy: opts.occupancy ?? '100100000000000',
  };
  const base = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'SmartDock' });
  const shimmer = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Shimmer' });
  scriptBase(base, state, opts.baseScript);
  scriptShimmer(shimmer, state);
  const dock = new SmartDockClient({
    debug: false,
    transport: base,
    shimmerTransport: shimmer,
    timeouts: FAST,
  });
  await dock.connect();
  return { dock, base, shimmer, state };
}

describe('SmartDockClient connect', () => {
  it('throws without an injected base transport', async () => {
    const dock = new SmartDockClient({ debug: false });
    await expect(dock.connect()).rejects.toThrow(/requires an injected transport/i);
  });

  it('opens the base transport on connect', async () => {
    const { base } = await connectedDock();
    expect(base.connected).toBe(true);
  });

  it('rejects streaming', async () => {
    const { dock } = await connectedDock();
    await expect(dock.startStreaming()).rejects.toThrow(/not supported/i);
  });
});

describe('SmartDockClient getDockInfo', () => {
  it('detects a Base-15 (15 slots)', async () => {
    const { dock } = await connectedDock({ hwVersion: 1 });
    const info = await dock.getDockInfo();
    expect(info.hardwareType).toBe('base15');
    expect(info.slotCount).toBe(15);
    expect(info.firmwareVersion.firmwareVersionMinor).toBe(5);
  });

  it('detects a Base-6 (6 slots)', async () => {
    const { dock } = await connectedDock({ hwVersion: 2, occupancy: '100100' });
    const info = await dock.getDockInfo();
    expect(info.hardwareType).toBe('base6');
    expect(info.slotCount).toBe(6);
  });
});

describe('SmartDockClient getSlotOccupancy', () => {
  it('returns per-slot occupancy', async () => {
    const { dock } = await connectedDock({ occupancy: '100100000000000' });
    const occ = await dock.getSlotOccupancy();
    expect(occ.length).toBe(15);
    expect(occ.filter((s) => s.occupied).map((s) => s.slot)).toEqual([1, 4]);
  });
});

describe('SmartDockClient selectSlot', () => {
  it('sends SDP,NN$ and confirms the active slot', async () => {
    const { dock, base } = await connectedDock();
    await dock.selectSlot(4);
    expect(dock.activeSlot).toBe(4);
    expect(dec(base.lastWrite!.bytes)).toBe('SDP,04$');
  });

  it('rejects when the confirmed slot differs from the request', async () => {
    const state: BaseState = { slot: -1, hwVersion: 1, occupancy: '1' };
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    base.setOnWrite((bytes, tr) => {
      if (dec(bytes).startsWith('SDP,')) setTimeout(() => tr.notify(enc('P,09\r\n')), 0); // wrong slot
    });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    await expect(dock.selectSlot(4)).rejects.toThrow(/slot select failed|FAIL_SET/i);
    void state;
  });

  it('times out on the slot-change timeout when the base never answers', async () => {
    const { dock } = await connectedDock({ baseScript: { silentSlotChange: true } });
    await expect(dock.selectSlot(2)).rejects.toThrow(/timeout/i);
  });
});

describe('SmartDockClient docked-Shimmer ops (compose D1 WiredShimmerClient)', () => {
  it('identifyDockedShimmer selects the slot then returns that slot’s identity', async () => {
    const { dock, base } = await connectedDock();
    const id1 = await dock.identifyDockedShimmer(1);
    expect(id1.mac).toBe('000666668001'); // MAC last byte == slot 1
    expect(id1.firmwareVersion.firmwareVersionMinor).toBe(15);

    const id4 = await dock.identifyDockedShimmer(4);
    expect(id4.mac).toBe('000666668004'); // slot switched → different device

    // Base saw both slot selects.
    const selects = base.writes.map((w) => dec(w.bytes)).filter((c) => c.startsWith('SDP,'));
    expect(selects).toEqual(['SDP,01$', 'SDP,04$']);
  });

  it('getDockedShimmerStatus selects the slot then reads battery', async () => {
    const { dock } = await connectedDock();
    const st = await dock.getDockedShimmerStatus(2);
    expect(dock.activeSlot).toBe(2);
    expect(st.chargingStatus).toBe('FULLY_CHARGED');
    expect(st.adcValue).toBe(0x0a00);
  });

  it('throws when no per-Shimmer transport was supplied', async () => {
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    scriptBase(base, { slot: -1, hwVersion: 1, occupancy: '1' });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    await expect(dock.identifyDockedShimmer(1)).rejects.toThrow(/per-Shimmer transport/i);
  });
});

describe('SmartDockClient robustness (unframed base stream)', () => {
  it('ignores a garbage line before the version response (resync)', async () => {
    const { dock } = await connectedDock({ baseScript: { garbageBeforeVersion: true } });
    const info = await dock.getDockInfo();
    expect(info.hardwareType).toBe('base15');
  });

  it('reassembles a version response delivered one byte at a time', async () => {
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    base.setOnWrite((bytes, tr) => {
      if (dec(bytes) === 'SDV$') {
        const line = enc('V,2,3,0,5,0\r\n');
        line.forEach((b, i) => setTimeout(() => tr.notify([b]), i));
      }
    });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    const info = await dock.getDockInfo();
    expect(info.hardwareType).toBe('base6');
  });

  it('rejects on an E error response', async () => {
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    base.setOnWrite((bytes, tr) => {
      if (dec(bytes) === 'SDV$') setTimeout(() => tr.notify(enc('E\r\n')), 0);
    });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    await expect(dock.getDockInfo()).rejects.toThrow(/error response/i);
  });

  it('times out when the base never answers a normal command', async () => {
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    await expect(dock.getDockInfo()).rejects.toThrow(/timeout/i);
  });

  it('disconnectAllSlots sends SDD$ and clears the active slot', async () => {
    const { dock, base } = await connectedDock();
    await dock.selectSlot(3);
    await dock.disconnectAllSlots();
    expect(dock.activeSlot).toBe(-1);
    expect(dec(base.lastWrite!.bytes)).toBe('SDD$');
  });
});

describe('SmartDockClient base-command retry (CMD_RETRY_ATTEMPTS=2)', () => {
  it('re-sends a command whose first reply is missed, then succeeds', async () => {
    let versionWrites = 0;
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    base.setOnWrite((bytes, tr) => {
      if (dec(bytes) === 'SDV$') {
        versionWrites += 1;
        if (versionWrites === 1) return; // swallow the first attempt
        setTimeout(() => tr.notify(enc('V,2,3,0,5,0\r\n')), 0); // answer the second
      }
    });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    const info = await dock.getDockInfo();
    expect(info.hardwareType).toBe('base6');
    expect(versionWrites).toBe(2); // re-sent exactly once
  });

  it('gives up after exactly 2 attempts when no reply ever arrives', async () => {
    let versionWrites = 0;
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    base.setOnWrite((bytes) => {
      if (dec(bytes) === 'SDV$') versionWrites += 1; // never answers
    });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    await expect(dock.getDockInfo()).rejects.toThrow(/timeout/i);
    expect(versionWrites).toBe(2);
  });

  it('does NOT retry on an explicit error response (fails fast)', async () => {
    let versionWrites = 0;
    const base = new LoopbackTransport({ capabilities: { framed: false } });
    base.setOnWrite((bytes, tr) => {
      if (dec(bytes) === 'SDV$') {
        versionWrites += 1;
        setTimeout(() => tr.notify(enc('E\r\n')), 0);
      }
    });
    const dock = new SmartDockClient({ debug: false, transport: base, timeouts: FAST });
    await dock.connect();
    await expect(dock.getDockInfo()).rejects.toThrow(/error response/i);
    expect(versionWrites).toBe(1); // no re-send after an error reply
  });
});

describe('SmartDockClient serialization (atomic slot-select + read)', () => {
  it('serializes concurrent identifyDockedShimmer calls so each gets its own slot', async () => {
    const { dock } = await connectedDock();
    // Fired concurrently: without serialization both slot selects race on the
    // shared active-slot state and both reads return the last-selected slot.
    const [id1, id3] = await Promise.all([
      dock.identifyDockedShimmer(1),
      dock.identifyDockedShimmer(3),
    ]);
    expect(id1.mac).toBe('000666668001'); // slot 1's device
    expect(id3.mac).toBe('000666668003'); // slot 3's device
  });

  it('serializes a slot-select against a concurrent status read', async () => {
    const { dock } = await connectedDock();
    const [, st] = await Promise.all([
      dock.identifyDockedShimmer(2),
      dock.getDockedShimmerStatus(5),
    ]);
    // The status read ran as its own atomic unit → its slot won the race and
    // its battery payload is intact.
    expect(dock.activeSlot).toBe(5);
    expect(st.chargingStatus).toBe('FULLY_CHARGED');
  });
});
