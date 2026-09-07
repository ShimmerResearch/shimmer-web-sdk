/**
 * The dock's half of the Bluetooth-module version read: the same reply and the
 * same parser as the Bluetooth link, reached through `BLUETOOTH.VER` instead
 * of an opcode.
 *
 * Worth its own loopback pass rather than trusting the Shimmer3R tests: what
 * this exercises is the component/property mapping and the fact that a dock
 * read is one CRC'd packet, so nothing here shares a code path with the
 * declared-length reassembly the Bluetooth client needs.
 */
import { describe, it, expect } from 'vitest';
import { WiredShimmerClient } from '../../src/devices/dock/WiredShimmerClient.js';
import { buildUartPacket, parseUartPacket } from '../../src/devices/dock/protocol.js';
import { UART_PACKET_CMD, UART_PROP } from '../../src/devices/dock/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { uartArg } from './uartArg.js';

const latin1 = (s: string): Uint8Array => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/**
 * A docked Shimmer that answers only `BLUETOOTH.VER`, with `reply` as its
 * payload — so a request for the wrong component gets no answer at all and the
 * read times out rather than passing by accident.
 */
async function dockReporting(reply: Uint8Array): Promise<{
  client: WiredShimmerClient;
  reads: () => number;
}> {
  const t = new LoopbackTransport({ capabilities: { framed: false } });
  let reads = 0;
  const VER = UART_PROP.BLUETOOTH.VER;
  t.setOnWrite((bytes, tr) => {
    const req = parseUartPacket(bytes);
    if (
      req.command === UART_PACKET_CMD.READ &&
      req.component === VER.component &&
      req.property === VER.property
    ) {
      reads += 1;
      const arg = uartArg(VER.component, VER.property, 'READ_ONLY');
      setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.DATA_RESPONSE, arg, reply)), 0);
    }
  });
  const client = new WiredShimmerClient({ debug: false, transport: t });
  await client.connect();
  return { client, reads: () => reads };
}

describe('WiredShimmerClient.readBtModuleVersion', () => {
  it('reads a Shimmer3 module banner through BLUETOOTH.VER', async () => {
    const raw = 'RN4678 V1.23 06/30/2021 (c)Microchip Technology Inc';
    const { client, reads } = await dockReporting(latin1(raw));
    const v = await client.readBtModuleVersion();
    expect(reads()).toBe(1);
    expect(v.model).toBe('RN4678');
    expect(v.label).toBe('RN4678 v1.23');
    expect(v.raw).toBe(raw);
  });

  it('reads the Shimmer3R reply and parses its version fields', async () => {
    const raw = 'CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0000, hardware=0x00';
    const { client } = await dockReporting(latin1(raw));
    const v = await client.readBtModuleVersion();
    expect(v.family).toBe('cyw20820');
    expect(v.version).toBe('1.4.18.18');
    expect(v.details).toEqual({ stack: '0x00000000', protocol: '0x0000', hardware: '0x00' });
  });

  it('reports an empty reply as not reported, not as an error', async () => {
    /* A docked sensor may have had its radio off since boot, so the firmware's
       version buffer is still zeroed. That is a real state. */
    const { client } = await dockReporting(new Uint8Array(0));
    const v = await client.readBtModuleVersion();
    expect(v.family).toBe('unknown');
    expect(v.label).toBe('not reported');
  });

  it('ignores the trailing NULs a fixed-size firmware buffer sends', async () => {
    const padded = new Uint8Array(40);
    padded.set(latin1('RN4678 V1.23'), 0);
    const { client } = await dockReporting(padded);
    expect((await client.readBtModuleVersion()).model).toBe('RN4678');
  });

  it('hands back an unrecognised reply rather than swallowing it', async () => {
    const { client } = await dockReporting(latin1('IF820 V9.9 (c)Someone'));
    const v = await client.readBtModuleVersion();
    expect(v.model).toBeNull();
    expect(v.label).toBe('IF820 V9.9 (c)Someone');
  });
});
