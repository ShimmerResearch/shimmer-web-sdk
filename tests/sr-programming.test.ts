/**
 * Programming a Shimmer3 / Shimmer3R's SR identity (DEV-1493): the page
 * Consensys writes, the boards a host offers, and the write-then-read-back on
 * each of the three clients that can reach the page.
 */
import { describe, it, expect } from 'vitest';
import {
  SHIMMER_SR_ID_PAGE_SIZE,
  assertShimmerSrBoardWritable,
  buildShimmerSrIdPage,
  formatShimmerSrBoardName,
  isSameShimmerSrBoard,
  listShimmerSrBoards,
  type ShimmerSrBoard,
} from '../src/devices/identity.js';
import { Shimmer3RClient } from '../src/devices/shimmer3r/Shimmer3RClient.js';
import { Shimmer3Client } from '../src/devices/shimmer3/Shimmer3Client.js';
import { WiredShimmerClient } from '../src/devices/dock/WiredShimmerClient.js';
import { OPCODES } from '../src/devices/shimmer3r/constants.js';
import { buildUartPacket, parseUartPacket } from '../src/devices/dock/protocol.js';
import { UART_PACKET_CMD } from '../src/devices/dock/constants.js';
import { LoopbackTransport } from '../src/core/transport/LoopbackTransport.js';
import { uartArg } from './dock/uartArg.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const ERASED = Array(13).fill(0xff);
const SR47_8_1: ShimmerSrBoard = { boardId: 47, boardRev: 8, specialRev: 1 };

describe('buildShimmerSrIdPage', () => {
  it("is Consensys's page: id, revision, special revision, then erased", () => {
    /* ExpansionBoardDetails.generateExpBrdIdArray(47, 8, 1). */
    const page = buildShimmerSrIdPage(SR47_8_1);
    expect(page.length).toBe(SHIMMER_SR_ID_PAGE_SIZE);
    expect(Array.from(page)).toEqual([47, 8, 1, ...ERASED]);
  });

  it('refuses the two "no board" ids and anything outside a byte', () => {
    for (const boardId of [0, 255, 256, -1, 1.5, Number.NaN]) {
      expect(() => buildShimmerSrIdPage({ boardId, boardRev: 1, specialRev: 0 })).toThrow(
        /board id must be an integer 1\.\.254/,
      );
    }
    expect(() =>
      assertShimmerSrBoardWritable({ boardId: 48, boardRev: 256, specialRev: 0 }),
    ).toThrow(/revision must be an integer 0\.\.255/);
    expect(() =>
      assertShimmerSrBoardWritable({ boardId: 48, boardRev: 8, specialRev: -1 }),
    ).toThrow(/special revision must be an integer 0\.\.255/);
  });

  it('accepts a code the SR table does not name, and the extremes of a byte', () => {
    /* A board newer than the table must still be programmable. */
    expect(
      Array.from(buildShimmerSrIdPage({ boardId: 232, boardRev: 0, specialRev: 255 })),
    ).toEqual([232, 0, 255, ...ERASED]);
    expect(buildShimmerSrIdPage({ boardId: 1, boardRev: 255, specialRev: 0 })[0]).toBe(1);
    expect(buildShimmerSrIdPage({ boardId: 254, boardRev: 0, specialRev: 0 })[0]).toBe(254);
  });
});

describe('the board list a host offers', () => {
  it('names a board as Consensys does, and falls back to the bare code', () => {
    expect(formatShimmerSrBoardName(47)).toBe('ECG/EMG/Resp (SR47)');
    expect(formatShimmerSrBoardName(48)).toBe('GSR+ (SR48)');
    expect(formatShimmerSrBoardName(232)).toBe('SR232');
  });

  it('offers a Shimmer3R its five fourth-generation boards', () => {
    expect(listShimmerSrBoards(10)).toEqual([
      { boardId: 31, name: 'IMU', label: 'IMU (SR31)' },
      { boardId: 38, name: 'PROTO3 Deluxe', label: 'PROTO3 Deluxe (SR38)' },
      { boardId: 47, name: 'ECG/EMG/Resp', label: 'ECG/EMG/Resp (SR47)' },
      { boardId: 48, name: 'GSR+', label: 'GSR+ (SR48)' },
      { boardId: 49, name: 'Bridge Amplifier+', label: 'Bridge Amplifier+ (SR49)' },
    ]);
  });

  it('offers a Shimmer3 its sensor boards, and never a dock or the Span', () => {
    const ids = listShimmerSrBoards(3).map((c) => c.boardId);
    expect(ids).toEqual([8, 14, 31, 36, 37, 38, 44, 46, 47, 48, 49, 55]);
    expect(ids).not.toContain(9);
    expect(ids).not.toContain(41);
    expect(ids).not.toContain(42);
    /* A sensor that has not said which it is gets the Shimmer3 list, which
       holds the Shimmer3R's five too. */
    expect(listShimmerSrBoards(null)).toEqual(listShimmerSrBoards(3));
    expect(listShimmerSrBoards().every((c) => c.label.endsWith(`(SR${c.boardId})`))).toBe(true);
  });

  it('compares boards field by field', () => {
    expect(isSameShimmerSrBoard(SR47_8_1, { boardId: 47, boardRev: 8, specialRev: 1 })).toBe(true);
    expect(isSameShimmerSrBoard(SR47_8_1, { boardId: 47, boardRev: 8, specialRev: 2 })).toBe(false);
    expect(isSameShimmerSrBoard(SR47_8_1, null)).toBe(false);
  });
});

/**
 * A sensor's identity page over the radio, as the firmware keeps it: 0x64
 * writes the page (EEPROM and cache together) and ACKs, 0x66 reads the cache.
 * `lands: false` models a write the firmware acknowledges but does not make,
 * which is what an out-of-range one is.
 */
function radioPage(initial: number[], opts: { lands?: boolean } = {}) {
  const page = [...initial, ...Array(SHIMMER_SR_ID_PAGE_SIZE - initial.length).fill(0xff)];
  const sets: number[][] = [];
  const onCommand = (cmd: Uint8Array): number[] => {
    if (cmd[0] === OPCODES.SET_DAUGHTER_CARD_ID_COMMAND) {
      sets.push(Array.from(cmd));
      const [len, offset] = [cmd[1], cmd[2]];
      if (opts.lands !== false) page.splice(offset, len, ...cmd.subarray(3, 3 + len));
      return [ACK];
    }
    if (cmd[0] === OPCODES.GET_DAUGHTER_CARD_ID_COMMAND) {
      const [len, offset] = [cmd[1], cmd[2]];
      return [ACK, OPCODES.DAUGHTER_CARD_ID_RESPONSE, len, ...page.slice(offset, offset + len)];
    }
    return [ACK];
  };
  return { page, sets, onCommand };
}

describe('Shimmer3RClient.writeSrBoard', () => {
  async function connected(page: ReturnType<typeof radioPage>, framed = true) {
    const t = new LoopbackTransport({ capabilities: { framed } });
    t.setOnWrite((raw) => {
      const cmd = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
      const reply = page.onCommand(cmd);
      setTimeout(() => t.notify(new Uint8Array(reply)), 0);
    });
    const client = new Shimmer3RClient({ debug: false });
    await client.connect(t);
    return client;
  }

  it('sends SET_DAUGHTER_CARD_ID with the whole page at offset 0, and reads it back', async () => {
    const dev = radioPage([232, 8, 1]);
    const client = await connected(dev);
    await expect(client.writeSrBoard(SR47_8_1)).resolves.toEqual(SR47_8_1);
    expect(dev.sets).toEqual([[0x64, 16, 0, 47, 8, 1, ...ERASED]]);
    expect(dev.page).toEqual([47, 8, 1, ...ERASED]);
  });

  it('works over an unframed serial link', async () => {
    const dev = radioPage([0xff, 0xff, 0xff]);
    const client = await connected(dev, false);
    await expect(client.writeSrBoard({ boardId: 48, boardRev: 8, specialRev: 3 })).resolves.toEqual(
      {
        boardId: 48,
        boardRev: 8,
        specialRev: 3,
      },
    );
  });

  it('throws when the page does not read back as written', async () => {
    const dev = radioPage([232, 8, 1], { lands: false });
    const client = await connected(dev);
    await expect(client.writeSrBoard(SR47_8_1)).rejects.toThrow(
      'SR number did not read back: wrote SR47-8-1, read SR232-8-1.',
    );
  });

  it('refuses a board it cannot write, before sending anything', async () => {
    const dev = radioPage([47, 8, 1]);
    const client = await connected(dev);
    await expect(client.writeSrBoard({ boardId: 0, boardRev: 0, specialRev: 0 })).rejects.toThrow(
      /1\.\.254/,
    );
    expect(dev.sets).toEqual([]);
  });
});

describe('Shimmer3Client.writeExpansionBoard', () => {
  /** A Shimmer3 on LogAndStream v1.01.003, which reads its board at connect. */
  function device(dev: ReturnType<typeof radioPage>): LoopbackTransport {
    const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
    t.setOnWrite((bytes, tr) => {
      let reply: number[];
      if (bytes[0] === OPCODES.GET_DEVICE_VERSION_COMMAND) reply = [0x25, 0x03];
      else if (bytes[0] === OPCODES.GET_FW_VERSION_COMMAND)
        reply = [ACK, 0x2f, 0x03, 0x00, 0x01, 0x00, 0x01, 0x03];
      else reply = dev.onCommand(bytes);
      setTimeout(() => tr.notify(reply), 0);
    });
    return t;
  }

  it('writes the page, reads it back and takes the new board', async () => {
    const dev = radioPage([31, 4, 0]);
    const client = new Shimmer3Client({ transport: device(dev) });
    await client.connect();
    expect(client.expansionBoard).toEqual({ boardId: 31, boardRev: 4, specialRev: 0 });
    expect(client.imuGeneration).toBe('old');

    const sr48 = { boardId: 48, boardRev: 4, specialRev: 2 };
    await expect(client.writeExpansionBoard(sr48)).resolves.toEqual(sr48);
    expect(dev.sets).toEqual([[0x64, 16, 0, 48, 4, 2, ...ERASED]]);
    /* The read-back is the connect handshake's own read, so the client's view
       of the board follows the write. */
    expect(client.expansionBoard).toEqual(sr48);
    expect(client.imuGeneration).toBe('new');
  });

  it('throws when the page does not read back as written', async () => {
    const dev = radioPage([31, 4, 0], { lands: false });
    const client = new Shimmer3Client({ transport: device(dev) });
    await client.connect();
    await expect(client.writeExpansionBoard(SR47_8_1)).rejects.toThrow(
      /wrote SR47-8-1, read SR31-4-0/,
    );
  });
});

describe('WiredShimmerClient.writeExpansionBoard', () => {
  /** A docked sensor whose CARD_ID can be written and read, as the dock firmware does. */
  function dock(initial: number[], opts: { lands?: boolean } = {}) {
    const page = [...initial, ...Array(SHIMMER_SR_ID_PAGE_SIZE - initial.length).fill(0xff)];
    const writes: number[][] = [];
    const t = new LoopbackTransport({
      capabilities: { framed: false },
      deviceName: 'Shimmer-Dock',
    });
    t.setOnWrite((bytes, tr) => {
      const req = parseUartPacket(bytes);
      if (req.component === 0x03 && req.property === 0x02) {
        if (req.command === UART_PACKET_CMD.WRITE) {
          writes.push(Array.from(req.payload));
          const [len, offset] = [req.payload[0], req.payload[1]];
          if (opts.lands !== false) page.splice(offset, len, ...req.payload.subarray(2, 2 + len));
          setTimeout(() => tr.notify(buildUartPacket(UART_PACKET_CMD.ACK_RESPONSE, null)), 0);
          return;
        }
        const [len, offset] = [req.payload[0], req.payload[1]];
        const rsp = buildUartPacket(
          UART_PACKET_CMD.DATA_RESPONSE,
          uartArg(0x03, 0x02, 'READ_ONLY'),
          Uint8Array.from(page.slice(offset, offset + len)),
        );
        setTimeout(() => tr.notify(rsp), 0);
      }
    });
    return { t, page, writes };
  }

  it("sends Consensys's WRITE CARD_ID — 16 bytes at address 0 — and reads it back", async () => {
    const d = dock([232, 8, 1]);
    const client = new WiredShimmerClient({ debug: false, transport: d.t });
    await client.connect();
    await expect(client.writeExpansionBoard(SR47_8_1)).resolves.toEqual(SR47_8_1);
    /* CommsProtocolWiredShimmerViaDock.writeDaughterCardId: [size][address][data],
       the address one byte for CARD_ID. */
    expect(d.writes).toEqual([[16, 0, 47, 8, 1, ...ERASED]]);
    expect(d.page).toEqual([47, 8, 1, ...ERASED]);
  });

  it('updates an identity it has already read', async () => {
    const d = dock([232, 8, 1]);
    const client = new WiredShimmerClient({ debug: false, transport: d.t });
    await client.connect();
    client.identity = {
      mac: '000666668001',
      hardwareVersion: 10,
      firmwareVersion: {} as never,
      expansionBoard: { boardId: 232, boardRev: 8, specialRev: 1 },
    };
    await client.writeExpansionBoard(SR47_8_1);
    expect(client.identity.expansionBoard).toEqual(SR47_8_1);
  });

  it('throws when the page does not read back as written', async () => {
    const d = dock([232, 8, 1], { lands: false });
    const client = new WiredShimmerClient({ debug: false, transport: d.t });
    await client.connect();
    await expect(client.writeExpansionBoard(SR47_8_1)).rejects.toThrow(
      'SR number did not read back: wrote SR47-8-1, read SR232-8-1.',
    );
  });
});
