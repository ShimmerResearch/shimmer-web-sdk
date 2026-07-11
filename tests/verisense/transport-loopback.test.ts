import { describe, it, expect } from 'vitest';
import { VerisenseBleDevice } from '../../src/devices/verisense/VerisenseClient.js';
import { ASM_COMMAND, ASM_PROPERTY } from '../../src/devices/verisense/constants.js';
import { buildMessage } from '../../src/devices/verisense/protocol.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

// Exercise VerisenseBleDevice's connect / config flows against a scripted
// in-memory transport — no browser, no Web Bluetooth / Web Serial. Verisense
// frames are `[header, lenLo, lenHi, ...payload]`; the client re-frames the byte
// stream itself, so these tests also cover chunk reassembly.

// An erased (all-0xFF) config blob — the bootstrap treats it as erased and skips
// hardware-specific parsing, so connect() succeeds without a full config image.
const ERASED = Array.from(new Uint8Array(56).fill(0xff));

const headerOf = (bytes: Uint8Array) => ({
  command: bytes[0] & 0xf0,
  property: bytes[0] & 0x0f,
});

/** Answer the two connect-time config reads with erased blobs. */
function scriptBootstrap(t: LoopbackTransport): void {
  t.setOnWrite((bytes, tr) => {
    const { command, property } = headerOf(bytes);
    if (command !== ASM_COMMAND.READ) return;
    if (property === ASM_PROPERTY.PRODUCTION_CONFIGURATION) {
      setTimeout(
        () =>
          tr.notify(
            buildMessage(ASM_COMMAND.RESPONSE, ASM_PROPERTY.PRODUCTION_CONFIGURATION, ERASED),
          ),
        0,
      );
    } else if (property === ASM_PROPERTY.OPERATIONAL_CONFIGURATION) {
      setTimeout(
        () =>
          tr.notify(
            buildMessage(ASM_COMMAND.RESPONSE, ASM_PROPERTY.OPERATIONAL_CONFIGURATION, ERASED),
          ),
        0,
      );
    }
  });
}

describe('VerisenseBleDevice over LoopbackTransport', () => {
  it('connects and bootstraps config over an injected transport (no browser)', async () => {
    const t = new LoopbackTransport({ deviceName: 'Verisense-TEST' });
    scriptBootstrap(t);
    const v = new VerisenseBleDevice({ debug: false, transport: t });

    const connected: unknown[] = [];
    const opConfig: unknown[] = [];
    v.on('connected', (e) => connected.push(e));
    v.on('opConfig', (e) => opConfig.push(e));

    await expect(v.connect()).resolves.toBe(true);
    expect(t.connected).toBe(true);
    expect(connected).toHaveLength(1);
    // Erased operational config was cached via the erased-fallback path.
    expect(v.operationalConfig).not.toBeNull();
    expect(opConfig.length).toBeGreaterThan(0);
    // A production + an operational config READ were issued during bootstrap.
    const props = t.writes.map((w) => w.bytes[0] & 0x0f);
    expect(props).toContain(ASM_PROPERTY.PRODUCTION_CONFIGURATION);
    expect(props).toContain(ASM_PROPERTY.OPERATIONAL_CONFIGURATION);
  });

  it('round-trips a command response delivered in a single notification chunk', async () => {
    const t = new LoopbackTransport();
    scriptBootstrap(t);
    const v = new VerisenseBleDevice({ debug: false, transport: t });
    await v.connect();

    const payload = [0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77];
    t.setOnWrite((bytes, tr) => {
      const { command, property } = headerOf(bytes);
      if (command === ASM_COMMAND.READ && property === ASM_PROPERTY.TIME) {
        setTimeout(
          () => tr.notify(buildMessage(ASM_COMMAND.RESPONSE, ASM_PROPERTY.TIME, payload)),
          0,
        );
      }
    });

    const rsp = await v.request(ASM_COMMAND.READ | ASM_PROPERTY.TIME);
    expect(Array.from(rsp.payload)).toEqual(payload);
  });

  it('reassembles a command response split across two notification chunks', async () => {
    const t = new LoopbackTransport();
    scriptBootstrap(t);
    const v = new VerisenseBleDevice({ debug: false, transport: t });
    await v.connect();

    const payload = [0xde, 0xad, 0xbe, 0xef];
    const frame = buildMessage(ASM_COMMAND.RESPONSE, ASM_PROPERTY.TIME, payload);
    t.setOnWrite((bytes, tr) => {
      const { command, property } = headerOf(bytes);
      if (command === ASM_COMMAND.READ && property === ASM_PROPERTY.TIME) {
        // Header + length in one chunk; the payload in a second chunk. The client
        // must buffer the partial frame and complete it on the next notification.
        setTimeout(() => tr.notify(frame.slice(0, 3)), 0);
        setTimeout(() => tr.notify(frame.slice(3)), 0);
      }
    });

    const rsp = await v.request(ASM_COMMAND.READ | ASM_PROPERTY.TIME);
    expect(Array.from(rsp.payload)).toEqual(payload);
  });

  it('parses the real response when its chunk carries leading transient bytes', async () => {
    const t = new LoopbackTransport();
    scriptBootstrap(t);
    const v = new VerisenseBleDevice({ debug: false, transport: t });
    await v.connect();

    const payload = [0xaa, 0xbb];
    const frame = buildMessage(ASM_COMMAND.RESPONSE, ASM_PROPERTY.STATUS1, payload);
    t.setOnWrite((bytes, tr) => {
      const { command, property } = headerOf(bytes);
      if (command === ASM_COMMAND.READ && property === ASM_PROPERTY.STATUS1) {
        // Leading transient 0x00 bytes precede the real frame in ONE chunk; the
        // client resyncs past them and still delivers the response.
        setTimeout(() => tr.notify([0x00, 0x00, 0x00, ...frame]), 0);
      }
    });

    const rsp = await v.request(ASM_COMMAND.READ | ASM_PROPERTY.STATUS1);
    expect(Array.from(rsp.payload)).toEqual(payload);
  });

  it('routes stopStreaming disable as a write-WITH-response through the transport', async () => {
    const t = new LoopbackTransport();
    scriptBootstrap(t);
    const v = new VerisenseBleDevice({ debug: false, transport: t });
    await v.connect();

    // Simulate active streaming, then stop.
    (v as unknown as { _mode: string })._mode = 'streaming';
    await v.stopStreaming();

    const disableHeader = (ASM_COMMAND.WRITE | ASM_PROPERTY.STREAM_MODE) & 0xff;
    const disable = t.writes.find((w) => w.bytes[0] === disableHeader);
    expect(disable).toBeTruthy();
    expect(disable!.withResponse).toBe(true);
  });

  it('disconnect() tears the transport down and emits disconnected', async () => {
    const t = new LoopbackTransport();
    scriptBootstrap(t);
    const v = new VerisenseBleDevice({ debug: false, transport: t });
    await v.connect();

    const disconnected: unknown[] = [];
    v.on('disconnected', (e) => disconnected.push(e));

    await expect(v.disconnect()).resolves.toBe(true);
    expect(t.connected).toBe(false);
    expect(disconnected).toHaveLength(1);
  });
});
