/**
 * The two identity reads: the SR board id page, and the Bluetooth module's own
 * version string — whose length only the firmware knows, and which is longer
 * than one BLE notification on a Shimmer3R.
 */
import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;

const bytesOf = (s: string): number[] => [...s].map((c) => c.charCodeAt(0));

/**
 * A sensor that answers the two id commands the way the firmware does, in
 * chunks of `chunk` bytes so reassembly is exercised.
 *
 * `btVersion` is what the module replied; `board` is the id page. Either can
 * be null to model a firmware that answers with a zero length (the module
 * never spoke) or a blank page.
 */
async function connectedSensor(opts: {
  btVersion?: string | null;
  board?: [number, number, number] | null;
  chunk?: number;
  framed?: boolean;
}) {
  const chunk = opts.chunk ?? 512;
  const t = new LoopbackTransport({ capabilities: { framed: opts.framed ?? true } });
  const reads = { board: 0, btVersion: 0 };

  const send = (bytes: number[]): void => {
    for (let i = 0; i < bytes.length; i += chunk) {
      const slice = new Uint8Array(bytes.slice(i, i + chunk));
      setTimeout(() => t.notify(slice), 0);
    }
  };

  t.setOnWrite((raw) => {
    const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (cmd[0] === OPCODES.GET_DAUGHTER_CARD_ID_COMMAND) {
      reads.board += 1;
      const page = opts.board ?? [0xff, 0xff, 0xff];
      send([ACK, OPCODES.DAUGHTER_CARD_ID_RESPONSE, cmd[1], ...page.slice(0, cmd[1])]);
      return;
    }
    if (cmd[0] === OPCODES.GET_BT_VERSION_STR_COMMAND) {
      reads.btVersion += 1;
      const text = opts.btVersion ?? '';
      send([ACK, OPCODES.BT_VERSION_STR_RESPONSE, text.length, ...bytesOf(text)]);
      return;
    }
    setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
  });

  const client = new Shimmer3RClient({ debug: false });
  await client.connect(t);
  return { t, client, reads };
}

describe('Shimmer3RClient.readSrBoard', () => {
  it('asks for three bytes at offset zero and parses them', async () => {
    const { t, client, reads } = await connectedSensor({ board: [48, 3, 0] });
    await expect(client.readSrBoard()).resolves.toEqual({
      boardId: 48,
      boardRev: 3,
      specialRev: 0,
    });
    expect(reads.board).toBe(1);
    expect(t.writes.map((w) => Array.from(w.bytes))).toContainEqual([
      OPCODES.GET_DAUGHTER_CARD_ID_COMMAND,
      3,
      0,
    ]);
  });

  it('returns null for an erased id page', async () => {
    const { client } = await connectedSensor({ board: [0xff, 0xff, 0xff] });
    await expect(client.readSrBoard()).resolves.toBeNull();
  });

  it('returns null for an id page that was never written', async () => {
    /* All zeroes is as much "no board here" as all 0xFF, and returning
       {0,0,0} would surface as the board SR0-0-0. */
    const { client } = await connectedSensor({ board: [0, 0, 0] });
    await expect(client.readSrBoard()).resolves.toBeNull();
  });

  it('works over an unframed serial link', async () => {
    /* The unframer has to know how long a DAUGHTER_CARD_ID_RESPONSE is, or it
       resyncs straight through it and the read times out. */
    const { client } = await connectedSensor({ board: [31, 10, 0], chunk: 2, framed: false });
    await expect(client.readSrBoard()).resolves.toEqual({
      boardId: 31,
      boardRev: 10,
      specialRev: 0,
    });
  });
});

describe('Shimmer3RClient.readBtModuleVersion', () => {
  it('reads a Shimmer3 module banner', async () => {
    const { t, client } = await connectedSensor({
      btVersion: 'RN4678 V1.23 06/30/2021 (c)Microchip Technology Inc',
    });
    const v = await client.readBtModuleVersion();
    expect(v.label).toBe('RN4678 v1.23');
    expect(t.writes.map((w) => Array.from(w.bytes))).toContainEqual([
      OPCODES.GET_BT_VERSION_STR_COMMAND,
    ]);
  });

  it('reassembles the Shimmer3R reply across BLE notifications', async () => {
    /* Seventy-odd characters at a 20-byte MTU: the point of taking the length
       from the response rather than assuming one. */
    const raw = 'CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0000, hardware=0x00';
    const { client } = await connectedSensor({ btVersion: raw, chunk: 20 });
    const v = await client.readBtModuleVersion();
    expect(v.raw).toBe(raw);
    expect(v.label).toBe('CYW20820 v1.4.18.18');
  });

  it('reassembles it over an unframed serial link too', async () => {
    const raw = 'CYW20820 app=v01.04.18.18, stack=0x00000000, protocol=0x0000, hardware=0x00';
    const { client } = await connectedSensor({ btVersion: raw, chunk: 3, framed: false });
    await expect(client.readBtModuleVersion()).resolves.toMatchObject({
      version: '1.4.18.18',
    });
  });

  it('reports a zero-length reply as "not reported" rather than failing', async () => {
    /* The firmware's buffer starts zeroed and is filled only once the module
       has answered its own query, so a length of 0 is a real answer. */
    const { client, reads } = await connectedSensor({ btVersion: '' });
    const v = await client.readBtModuleVersion();
    expect(reads.btVersion).toBe(1);
    expect(v.label).toBe('not reported');
    expect(v.family).toBe('unknown');
  });

  it('refuses a declared length beyond what the firmware can report', async () => {
    /* The cap is 99: the firmware sends strlen() of a char[100], so the
       hundredth byte is the terminator. A larger length means the byte was
       not a length at all, and on a serial link accepting it would swallow
       real traffic while waiting for bytes that never come. */
    const t = new LoopbackTransport({ capabilities: { framed: false } });
    t.setOnWrite((raw) => {
      const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (cmd[0] === OPCODES.GET_BT_VERSION_STR_COMMAND) {
        setTimeout(
          () => t.notify(new Uint8Array([ACK, OPCODES.BT_VERSION_STR_RESPONSE, 100, 0x41])),
          0,
        );
      }
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await expect(client.readBtModuleVersion()).rejects.toThrow();
  }, 10000);

  it('refuses when the response carries no length byte at all', async () => {
    const t = new LoopbackTransport({ capabilities: { framed: true } });
    t.setOnWrite((raw) => {
      const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      if (cmd[0] === OPCODES.GET_BT_VERSION_STR_COMMAND) {
        setTimeout(() => t.notify(new Uint8Array([ACK, OPCODES.BT_VERSION_STR_RESPONSE])), 0);
        return;
      }
      setTimeout(() => t.notify(new Uint8Array([ACK])), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    await expect(client.readBtModuleVersion()).rejects.toThrow(/no length byte/);
  });
});
