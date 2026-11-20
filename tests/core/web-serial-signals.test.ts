import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WebSerialTransport } from '../../src/core/transport/WebSerialTransport.js';

/**
 * DTR/RTS assertion on connect (single-slot dock requirement).
 *
 * The Shimmer single-slot dock wires the docked sensor's reset to the COM
 * port control lines: with DTR/RTS deasserted the sensor is HELD IN RESET, so
 * opening the port without asserting both leaves the device unresponsive.
 * These tests pin the contract: both lines asserted by default immediately
 * after open, individually overridable, and setSignals absence/failure is
 * non-fatal (hardware that ignores the lines works either way).
 */

interface SignalsArg {
  dataTerminalReady: boolean;
  requestToSend: boolean;
}

function makeMockPort(opts: { withSetSignals?: boolean; failSetSignals?: boolean } = {}) {
  const calls: { open: unknown[]; setSignals: SignalsArg[] } = { open: [], setSignals: [] };
  const port: Record<string, unknown> = {
    open: async (o: unknown) => {
      calls.open.push(o);
    },
    // No `readable`: the transport's read loop tolerates its absence and exits.
  };
  if (opts.withSetSignals !== false) {
    port.setSignals = async (s: SignalsArg) => {
      if (opts.failSetSignals) throw new Error('NotSupportedError');
      calls.setSignals.push(s);
    };
  }
  return { port, calls };
}

describe('WebSerialTransport DTR/RTS on connect', () => {
  const g = globalThis as { navigator?: unknown };
  let savedNavigator: unknown;
  let hadNavigator: boolean;

  beforeEach(() => {
    hadNavigator = 'navigator' in g;
    savedNavigator = g.navigator;
    /*
     * connect() gates on the capability before using the injected port, and that
     * gate is "requestPort is callable" rather than "the serial property exists"
     * - a navigator.serial of null or {} would throw on first use, so it counts
     * as unavailable. These tests inject their own port and never call
     * requestPort; the stub just has to be shaped like a usable API.
     */
    Object.defineProperty(globalThis, 'navigator', {
      value: { serial: { requestPort() {} } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (hadNavigator) {
      Object.defineProperty(globalThis, 'navigator', {
        value: savedNavigator,
        configurable: true,
        writable: true,
      });
    } else {
      delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it('asserts both DTR and RTS by default, after open', async () => {
    const { port, calls } = makeMockPort();
    const t = new WebSerialTransport({ port: port as never });
    await t.connect();

    expect(calls.open).toHaveLength(1);
    expect(calls.setSignals).toEqual([{ dataTerminalReady: true, requestToSend: true }]);
    await t.disconnect();
  });

  it('honours explicit per-line overrides', async () => {
    const { port, calls } = makeMockPort();
    const t = new WebSerialTransport({
      port: port as never,
      dataTerminalReady: false,
      requestToSend: true,
    });
    await t.connect();

    expect(calls.setSignals).toEqual([{ dataTerminalReady: false, requestToSend: true }]);
    await t.disconnect();
  });

  it('connects fine when the port has no setSignals', async () => {
    const { port, calls } = makeMockPort({ withSetSignals: false });
    const t = new WebSerialTransport({ port: port as never });
    await expect(t.connect()).resolves.toBeUndefined();
    expect(calls.open).toHaveLength(1);
    await t.disconnect();
  });

  it('treats a setSignals failure as non-fatal', async () => {
    const { port } = makeMockPort({ failSetSignals: true });
    const t = new WebSerialTransport({ port: port as never });
    await expect(t.connect()).resolves.toBeUndefined();
    await t.disconnect();
  });
});
