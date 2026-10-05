import { afterEach, describe, expect, it, vi } from 'vitest';

import { WebBluetoothTransport } from '../../src/core/transport/WebBluetoothTransport.js';
import { SHIMMER3R_DEFAULTS } from '../../src/devices/shimmer3r/constants.js';

const SERVICE = SHIMMER3R_DEFAULTS.SERVICE_UUID;
/**
 * CYSPP Unacknowledged Data — write-without-response AND notify, so it is both
 * the write characteristic and the preferred device→host subscription. The two
 * default UUIDs are deliberately the same characteristic.
 */
const UNACKED = SHIMMER3R_DEFAULTS.CHAR_TX_UUID; // …ca102
/** CYSPP Acknowledged Data — indicate-only, the slower fallback. */
const ACKED = SHIMMER3R_DEFAULTS.CHAR_TX_ACKED_UUID; // …ca101
/** CYSPP RX Flow — indicate-only. */
const RX_FLOW = SHIMMER3R_DEFAULTS.CHAR_RX_FLOW_UUID; // …ca103

type Props = Partial<{ notify: boolean; indicate: boolean; write: boolean }> | undefined;

/** Minimal stand-in for a GATT characteristic. */
function makeChar(uuid: string, properties: Props) {
  const listeners = new Map<string, ((evt: Event) => void)[]>();
  return {
    uuid,
    properties,
    startNotifications: vi.fn().mockResolvedValue(undefined),
    stopNotifications: vi.fn().mockResolvedValue(undefined),
    writeValue: vi.fn().mockResolvedValue(undefined),
    addEventListener: vi.fn((type: string, cb: (evt: Event) => void) => {
      const arr = listeners.get(type) ?? [];
      arr.push(cb);
      listeners.set(type, arr);
    }),
    removeEventListener: vi.fn(),
    /** Test helper: deliver a value to subscribers, as Web Bluetooth would. */
    emit(bytes: Uint8Array) {
      const view = new DataView(bytes.buffer.slice(0));
      for (const cb of listeners.get('characteristicvaluechanged') ?? []) {
        cb({ target: { value: view } } as unknown as Event);
      }
    },
  };
}

/** Installs a fake `navigator.bluetooth` exposing exactly `chars`. */
function installFakeBluetooth(chars: ReturnType<typeof makeChar>[]) {
  const byUuid = new Map(chars.map((c) => [c.uuid, c]));
  expect(byUuid.size, 'fixture must not define the same UUID twice').toBe(chars.length);
  const service = {
    getCharacteristic: vi.fn(async (uuid: string) => {
      const c = byUuid.get(uuid);
      if (!c) throw new Error(`NotFoundError: no characteristic ${uuid}`);
      return c;
    }),
  };
  const device = {
    name: 'Shimmer3R-TEST-BLE',
    gatt: {
      connected: true,
      connect: vi.fn().mockResolvedValue({
        getPrimaryService: vi.fn().mockResolvedValue(service),
      }),
      disconnect: vi.fn(),
    },
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  vi.stubGlobal('navigator', {
    bluetooth: { requestDevice: vi.fn().mockResolvedValue(device) },
  });
  return { service, device };
}

/* `navigator` is stubbed per test by the helper above. Restoring it here rather
   than nowhere: a stub left in place leaks into every file that runs after this
   one in the same worker, which turns an unrelated suite into an
   order-dependent failure that reproduces only in full-suite runs. */
afterEach(() => {
  vi.unstubAllGlobals();
});

function makeTransport(extra: Record<string, unknown> = {}) {
  return new WebBluetoothTransport({
    serviceUUID: SERVICE,
    writeCharUUID: SHIMMER3R_DEFAULTS.CHAR_RX_UUID,
    notifyCharUUID: UNACKED,
    notifyCharUUIDFallback: ACKED,
    ...extra,
  });
}

describe('Shimmer3R BLE device→host characteristic selection', () => {
  it('subscribes to the notify-capable characteristic when the device offers it', async () => {
    const unacked = makeChar(UNACKED, { notify: true, write: true });
    const acked = makeChar(ACKED, { indicate: true, write: true });
    installFakeBluetooth([unacked, acked]);

    const t = makeTransport();
    await t.connect();

    expect(t.notifyCharacteristic?.uuid).toBe(UNACKED);
    expect(t.notifyIsAcknowledged).toBe(false);
    expect(unacked.startNotifications).toHaveBeenCalledOnce();
    // The slower path must not also be subscribed.
    expect(acked.startNotifications).not.toHaveBeenCalled();
  });

  it('falls back to indicate-only when the preferred characteristic cannot notify', async () => {
    // Pre-0.2.2 style layout: …ca102 exists but is write-only, so the only
    // subscribable device→host path is the acknowledged characteristic.
    const writeOnly = makeChar(UNACKED, { write: true });
    const acked = makeChar(ACKED, { indicate: true });
    installFakeBluetooth([writeOnly, acked]);

    const t = makeTransport();
    await t.connect();

    expect(t.notifyCharacteristic?.uuid).toBe(ACKED);
    // Surfaced so an unexpectedly slow link is diagnosable rather than silent.
    expect(t.notifyIsAcknowledged).toBe(true);
    expect(acked.startNotifications).toHaveBeenCalledOnce();
    expect(writeOnly.startNotifications).not.toHaveBeenCalled();
  });

  it('falls back when the preferred characteristic is absent entirely', async () => {
    const acked = makeChar(ACKED, { indicate: true, write: true });
    installFakeBluetooth([acked]);

    const t = new WebBluetoothTransport({
      serviceUUID: SERVICE,
      // A device where everything lives on the acknowledged characteristic.
      writeCharUUID: ACKED,
      notifyCharUUID: UNACKED,
      notifyCharUUIDFallback: ACKED,
    });
    await t.connect();

    expect(t.notifyCharacteristic?.uuid).toBe(ACKED);
    expect(t.notifyIsAcknowledged).toBe(true);
  });

  it('prefers a notifying fallback over an indicate-only preferred characteristic', async () => {
    const preferredIndicateOnly = makeChar(UNACKED, { indicate: true, write: true });
    const fallbackNotify = makeChar(ACKED, { notify: true });
    installFakeBluetooth([preferredIndicateOnly, fallbackNotify]);

    const t = makeTransport();
    await t.connect();

    expect(t.notifyCharacteristic?.uuid).toBe(ACKED);
    expect(t.notifyIsAcknowledged).toBe(false);
  });

  it('treats absent `properties` as subscribable (polyfills and test doubles)', async () => {
    const noProps = makeChar(UNACKED, undefined);
    installFakeBluetooth([noProps]);

    const t = makeTransport();
    await t.connect();

    expect(t.notifyCharacteristic?.uuid).toBe(UNACKED);
    expect(t.notifyIsAcknowledged).toBe(false);
  });

  it('throws when no candidate can be subscribed to', async () => {
    // Both present, neither notify nor indicate: nothing to subscribe to.
    installFakeBluetooth([makeChar(UNACKED, { write: true }), makeChar(ACKED, { write: true })]);
    await expect(makeTransport().connect()).rejects.toThrow(/subscribable/i);
  });

  it('still delivers notifications through the chosen characteristic', async () => {
    const unacked = makeChar(UNACKED, { notify: true, write: true });
    installFakeBluetooth([unacked]);

    const t = makeTransport();
    const seen: Uint8Array[] = [];
    t.onNotify((d) => seen.push(d));
    await t.connect();

    unacked.emit(new Uint8Array([0xff, 0x01, 0x02]));
    expect(seen).toHaveLength(1);
    expect(Array.from(seen[0]!)).toEqual([0xff, 0x01, 0x02]);
  });
});

describe('Shimmer3R BLE flow-control characteristic', () => {
  it('subscribes when present and reports values verbatim without gating writes', async () => {
    const unacked = makeChar(UNACKED, { notify: true, write: true });
    const rxFlow = makeChar(RX_FLOW, { indicate: true });
    installFakeBluetooth([unacked, rxFlow]);

    const t = makeTransport({ rxFlowCharUUID: RX_FLOW });
    const flow: Uint8Array[] = [];
    t.onFlowControl((d) => flow.push(d));
    await t.connect();

    expect(rxFlow.startNotifications).toHaveBeenCalledOnce();
    rxFlow.emit(new Uint8Array([0x01]));
    expect(flow).toHaveLength(1);
    expect(Array.from(flow[0]!)).toEqual([0x01]);

    // Deliberately NOT gated: the value encoding is undocumented, so a write
    // after a flow-control value must still go through. Guessing the polarity
    // could otherwise block every write.
    await t.write(new Uint8Array([0x03]), { withResponse: true });
    expect(unacked.writeValue).toHaveBeenCalledOnce();
  });

  it('connects normally when the flow-control characteristic is absent', async () => {
    installFakeBluetooth([makeChar(UNACKED, { notify: true, write: true })]);

    const t = makeTransport({ rxFlowCharUUID: RX_FLOW });
    await expect(t.connect()).resolves.toBeUndefined();
    expect(t.rxFlowCharacteristic).toBeNull();
  });

  it('connects normally when subscribing to flow control is refused', async () => {
    const unacked = makeChar(UNACKED, { notify: true, write: true });
    const rxFlow = makeChar(RX_FLOW, { indicate: true });
    rxFlow.startNotifications.mockRejectedValue(new Error('NotSupportedError'));
    installFakeBluetooth([unacked, rxFlow]);

    const t = makeTransport({ rxFlowCharUUID: RX_FLOW });
    await expect(t.connect()).resolves.toBeUndefined();
    expect(t.rxFlowCharacteristic).toBeNull();
    // The data path is unaffected by a flow-control subscription failure.
    expect(unacked.startNotifications).toHaveBeenCalledOnce();
  });
});
