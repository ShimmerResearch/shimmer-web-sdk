import { describe, it, expect } from 'vitest';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import {
  generateCalibDump,
  parseCalibDump,
  MAX_CALIB_DUMP_BYTES,
  type CalibDumpRecord,
  type CalibDumpVersion,
} from '../../src/devices/calibration/index.js';
import { scriptedFirmware, CALIB_RAM_SIZE } from './configFirmware.js';

// The 0x9A / 0x98 calibration-dump transfer. Unlike the per-sensor calibration
// GETs, the dump carries provenance — which sensor, which range, and when it
// was calibrated — so it is the only way a host can tell a factory calibration
// from a default the firmware seeded. Its length is not fixed and not known in
// advance: it comes out of the dump's own first two bytes, which is exactly the
// part worth pinning down, because trusting a length a device sent is how a
// reader ends up paging through 64 kB of nothing.

const GET_DUMP = OPCODES.GET_CALIB_DUMP_COMMAND; // 0x9A
const SET_DUMP = OPCODES.SET_CALIB_DUMP_COMMAND; // 0x98
const UPD_DUMP = OPCODES.UPD_CALIB_DUMP_COMMAND; // 0x9B

const VERSION: CalibDumpVersion = {
  hardwareId: 10, // Shimmer3R
  firmwareId: 3, // LogAndStream
  firmwareMajor: 1,
  firmwareMinor: 0,
  firmwareInternal: 40,
};

/** A kinematic-shaped record with a distinguishable payload. */
function record(sensorId: number, range: number, fill: number, dated = true): CalibDumpRecord {
  return {
    sensorId,
    range,
    calibLen: 21,
    timestampTicks: dated
      ? Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8])
      : new Uint8Array(8) /* all-zero = default/seeded */,
    calibBytes: new Uint8Array(21).fill(fill),
    isDefault: !dated,
  };
}

/** A dump with `n` records — 10 + n×33 bytes, so `n` drives it past one chunk. */
function dumpOf(n: number): Uint8Array {
  const records = Array.from({ length: n }, (_, i) => record(i + 1, i % 4, 0x40 + i, i !== 0));
  return generateCalibDump(VERSION, records);
}

/** Place a dump at offset 0 of a 1024-byte calibration RAM, as firmware holds it. */
function ram(dump: Uint8Array): Uint8Array {
  const r = new Uint8Array(CALIB_RAM_SIZE);
  r.set(dump, 0);
  return r;
}

/** `[len, offset]` of each dump command of the given opcode, in order. */
function chunks(cmds: number[][]): Array<[number, number]> {
  return cmds.map((c) => [c[1], c[2] | (c[3] << 8)]);
}

const SHAPES: ReadonlyArray<[string, boolean]> = [
  ['framed (BLE)', true],
  ['unframed (byte stream)', false],
];

describe.each(SHAPES)('Shimmer3RClient.readCalibDump — %s', (_name, framed) => {
  it('takes the total length from the header and returns both raw and parsed', async () => {
    const dump = dumpOf(2); // 76 bytes — inside the first chunk
    const fw = await scriptedFirmware({ framed, calibRam: ram(dump) });
    const { bytes, dump: parsed } = await fw.client.readCalibDump();
    expect(bytes.length).toBe(dump.length);
    expect([...bytes]).toEqual([...dump]);
    expect(parsed.packetLength).toBe(dump.length - 2);
    expect(parsed.version).toEqual(VERSION);
    expect(parsed.records).toHaveLength(2);
    expect(parsed.records[0].isDefault).toBe(true); // first record left undated
    expect(parsed.records[1].sensorId).toBe(2);
  });

  it('asks for 128 bytes at offset 0 first, then pages the remainder', async () => {
    // 8 records = 274 bytes: header chunk plus two more.
    const dump = dumpOf(8);
    expect(dump.length).toBe(274);
    const fw = await scriptedFirmware({ framed, calibRam: ram(dump) });
    const { bytes } = await fw.client.readCalibDump();
    expect([...bytes]).toEqual([...dump]);
    expect(chunks(fw.cmdsOf(GET_DUMP))).toEqual([
      [128, 0],
      [128, 128],
      [18, 256],
    ]);
    // Exact request bytes for the tail read: [0x9A][len][offLo][offHi].
    expect(fw.cmdsOf(GET_DUMP)[2]).toEqual([GET_DUMP, 18, 0x00, 0x01]);
  });

  it('needs no second read when the dump fits in the first chunk', async () => {
    const fw = await scriptedFirmware({ framed, calibRam: ram(dumpOf(1)) });
    await fw.client.readCalibDump();
    expect(fw.cmdsOf(GET_DUMP)).toHaveLength(1);
  });

  it('round-trips through generateCalibDump / parseCalibDump unchanged', async () => {
    const dump = dumpOf(6);
    const fw = await scriptedFirmware({ framed, calibRam: ram(dump) });
    const { bytes, dump: parsed } = await fw.client.readCalibDump();
    expect([...generateCalibDump(parsed.version, parsed.records)]).toEqual([...bytes]);
    expect(parseCalibDump(bytes)).toEqual(parsed);
  });

  it('rejects an unprovisioned (zero-length) header instead of looping', async () => {
    // A blank calibration RAM reads back a length of 0 — total 2, which is not a
    // dump. Paging "after" it would ask for the rest of nothing forever.
    const fw = await scriptedFirmware({ framed, calibRam: new Uint8Array(CALIB_RAM_SIZE) });
    await expect(fw.client.readCalibDump()).rejects.toThrow(/implausible length/);
    expect(fw.cmdsOf(GET_DUMP)).toHaveLength(1);
  });

  it('rejects a length beyond the ceiling the Java driver uses', async () => {
    const r = new Uint8Array(CALIB_RAM_SIZE);
    r[0] = 0xff;
    r[1] = 0xff; // 65535 + 2
    const fw = await scriptedFirmware({ framed, calibRam: r });
    await expect(fw.client.readCalibDump()).rejects.toThrow(
      new RegExp(`3\\.\\.${MAX_CALIB_DUMP_BYTES}`),
    );
    expect(fw.cmdsOf(GET_DUMP)).toHaveLength(1);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3RClient({ debug: false });
    await expect(client.readCalibDump()).rejects.toThrow(/Not connected/);
  });
});

describe('Shimmer3RClient.readCalibDump — BLE notification reassembly', () => {
  it('rebuilds a multi-chunk dump out of 20-byte notifications', async () => {
    // Each 132-byte reply ([0x99][len][offLo][offHi] + 128 payload) crosses
    // seven notifications, whose continuations carry no opcode of their own.
    const dump = dumpOf(8);
    const fw = await scriptedFirmware({ framed: true, calibRam: ram(dump), notifyBytes: 20 });
    const { bytes } = await fw.client.readCalibDump();
    expect([...bytes]).toEqual([...dump]);
  });
});

describe.each(SHAPES)('Shimmer3RClient.writeCalibDump — %s', (_name, framed) => {
  it('writes forward from offset 0 with exact per-chunk headers', async () => {
    const dump = dumpOf(8); // 274 bytes
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeCalibDump(dump);
    const expected = framed
      ? [
          [64, 0],
          [64, 64],
          [64, 128],
          [64, 192],
          [18, 256],
        ]
      : [
          [128, 0],
          [128, 128],
          [18, 256],
        ];
    expect(chunks(fw.cmdsOf(SET_DUMP))).toEqual(expected);
    // The firmware takes the total from the FIRST chunk's header bytes and
    // counts the rest in, so the first chunk must start at offset 0.
    expect(fw.cmdsOf(SET_DUMP)[0].slice(0, 4)).toEqual([SET_DUMP, expected[0][0], 0, 0]);
    expect([...fw.calibRam.subarray(0, dump.length)]).toEqual([...dump]);
  });

  it('applies the dump with UPD_CALIB_DUMP (0x9B) by default', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeCalibDump(dumpOf(2));
    expect(fw.cmdsOf(UPD_DUMP)).toEqual([[UPD_DUMP]]);
    // …and only after the last chunk.
    const opcodes = fw.cmds.map((c) => c[0]).filter((o) => o === SET_DUMP || o === UPD_DUMP);
    expect(opcodes[opcodes.length - 1]).toBe(UPD_DUMP);
  });

  it('skips the apply when update is false', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeCalibDump(dumpOf(2), { update: false });
    expect(fw.cmdsOf(SET_DUMP).length).toBeGreaterThan(0);
    expect(fw.cmdsOf(UPD_DUMP)).toHaveLength(0);
  });

  it('honours an explicit chunkBytes', async () => {
    const dump = dumpOf(4); // 142 bytes
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeCalibDump(dump, { chunkBytes: 128, update: false });
    expect(chunks(fw.cmdsOf(SET_DUMP))).toEqual([
      [128, 0],
      [14, 128],
    ]);
  });

  it('survives the whole loop: write it, read it back, parse it', async () => {
    const dump = dumpOf(5);
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeCalibDump(dump);
    const { bytes, dump: parsed } = await fw.client.readCalibDump();
    expect([...bytes]).toEqual([...dump]);
    expect(parsed.records).toHaveLength(5);
  });

  it('rejects a dump that is too short or beyond the ceiling', async () => {
    const fw = await scriptedFirmware({ framed });
    await expect(fw.client.writeCalibDump(new Uint8Array(2))).rejects.toThrow(
      new RegExp(`3\\.\\.${MAX_CALIB_DUMP_BYTES} bytes`),
    );
    await expect(
      fw.client.writeCalibDump(new Uint8Array(MAX_CALIB_DUMP_BYTES + 1)),
    ).rejects.toThrow(new RegExp(`3\\.\\.${MAX_CALIB_DUMP_BYTES} bytes`));
    expect(fw.cmdsOf(SET_DUMP)).toHaveLength(0);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3RClient({ debug: false });
    await expect(client.writeCalibDump(new Uint8Array(40))).rejects.toThrow(/Not connected/);
  });
});

describe('Shimmer3RClient.writeCalibDump while streaming', () => {
  it('refuses and writes nothing — the firmware NACKs every SET while sensing', async () => {
    const fw = await scriptedFirmware({ framed: true });
    await fw.client.startStreaming();
    fw.cmds.length = 0;
    await expect(fw.client.writeCalibDump(dumpOf(2))).rejects.toThrow(/while streaming/);
    expect(fw.cmds).toHaveLength(0);
    expect(fw.calibRam.every((b) => b === 0)).toBe(true);
  });
});
