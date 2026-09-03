import { describe, it, expect } from 'vitest';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import {
  parseInfoMem,
  generateInfoMem,
  INFOMEM_SIZE,
  type InfoMemDeviceConfig,
} from '../../src/devices/infomem/index.js';
import { CTX } from '../infomem/fixtures.js';
import {
  scriptedFirmware,
  pageOffset,
  HW,
  FW_LEGACY_SDLOG,
  type ScriptedFirmware,
  type ScriptedFirmwareOptions,
} from './configFirmware.js';

// The InfoMem read/write path over the radio. A host could previously read the
// configuration one 128-byte page at a time and had no way at all to put one
// back, so this is the surface that makes configuring a sensor over Bluetooth
// possible — and the surface where a half-finished write leaves a device in a
// state nobody asked for, which is why the ordering, chunking and refusal cases
// below are asserted rather than assumed.

const GET_INFOMEM = OPCODES.GET_INFOMEM_COMMAND; // 0x8E
const SET_INFOMEM = OPCODES.SET_INFOMEM_COMMAND; // 0x8C
const SET_RWC = OPCODES.SET_RWC_COMMAND; // 0x8F

/** A distinctive 384-byte image, deliberately including 0xFF bytes. */
function patternImage(): Uint8Array {
  return Uint8Array.from({ length: INFOMEM_SIZE }, (_, i) => i % 256);
}

/** Addresses of the page reads, in order. */
function readAddrs(fw: ScriptedFirmware): number[] {
  return fw.cmdsOf(GET_INFOMEM).map((c) => c[2] | (c[3] << 8));
}

/** `[len, address]` of each write chunk, in order. */
function writeChunks(fw: ScriptedFirmware): Array<[number, number]> {
  return fw.cmdsOf(SET_INFOMEM).map((c) => [c[1], c[2] | (c[3] << 8)]);
}

/** A parsed configuration seeded from a valid (non-0xFF) image. */
function seedConfig(): InfoMemDeviceConfig {
  const raw = new Uint8Array(INFOMEM_SIZE);
  raw[0] = 64; // sampling divider — makes checkConfigBytesValid() true
  return parseInfoMem(raw, CTX.shimmer3R);
}

/** Both transport shapes, so every case runs twice. */
const SHAPES: ReadonlyArray<[string, boolean]> = [
  ['framed (BLE)', true],
  ['unframed (byte stream)', false],
];

describe.each(SHAPES)('Shimmer3RClient.readInfoMemBytes — %s', (_name, framed) => {
  const opts = (extra: ScriptedFirmwareOptions = {}): ScriptedFirmwareOptions => ({
    framed,
    ...extra,
  });

  it('reassembles the full 384-byte image in D→C→B order', async () => {
    const store = patternImage();
    const fw = await scriptedFirmware(opts({ store }));
    const bytes = await fw.client.readInfoMemBytes();
    expect(bytes.length).toBe(INFOMEM_SIZE);
    expect([...bytes]).toEqual([...store]);
  });

  it('sends the FLAT 0/128/256 page addresses for a Shimmer3R', async () => {
    const fw = await scriptedFirmware(opts({ store: patternImage() }));
    await fw.client.readInfoMemBytes();
    expect(readAddrs(fw)).toEqual([0, 128, 256]);
    // Exact request bytes: [0x8E][len][offLo][offHi].
    expect(fw.cmdsOf(GET_INFOMEM)).toEqual([
      [GET_INFOMEM, 128, 0, 0],
      [GET_INFOMEM, 128, 128, 0],
      [GET_INFOMEM, 128, 0, 1],
    ]);
  });

  it('sends the LEGACY 0x1800/0x1880/0x1900 addresses for a Shimmer3 on SDLog 0.8.68', async () => {
    const store = patternImage();
    const fw = await scriptedFirmware(
      opts({ store, hardwareVersion: HW.SHIMMER3, firmware: FW_LEGACY_SDLOG }),
    );
    const bytes = await fw.client.readInfoMemBytes();
    expect([...bytes]).toEqual([...store]);
    expect(fw.cmdsOf(GET_INFOMEM)).toEqual([
      [GET_INFOMEM, 128, 0x00, 0x18],
      [GET_INFOMEM, 128, 0x80, 0x18],
      [GET_INFOMEM, 128, 0x00, 0x19],
    ]);
  });

  it('asks the device which platform it is exactly once per connection', async () => {
    const fw = await scriptedFirmware(opts());
    await fw.client.readInfoMemBytes();
    await fw.client.readInfoMemBytes();
    expect(fw.cmdsOf(OPCODES.GET_DEVICE_VERSION_COMMAND)).toHaveLength(1);
    expect(fw.cmdsOf(OPCODES.GET_FW_VERSION_COMMAND)).toHaveLength(1);
  });

  it('decodes the image into a named configuration', async () => {
    const store = generateInfoMem(
      { ...seedConfig(), deviceName: 'RADIO-1', samplingRateHz: 256 },
      CTX.shimmer3R,
      { forDeviceWrite: false },
    );
    const fw = await scriptedFirmware(opts({ store }));
    const cfg = await fw.client.readInfoMemConfig();
    expect(cfg.valid).toBe(true);
    expect(cfg.deviceName).toBe('RADIO-1');
    expect(cfg.samplingRateHz).toBeCloseTo(256, 6);
  });

  it('throws when not connected', async () => {
    const client = new Shimmer3RClient({ debug: false });
    await expect(client.readInfoMemBytes()).rejects.toThrow(/Not connected/);
    await expect(client.readInfoMemConfig()).rejects.toThrow(/Not connected/);
  });
});

describe('Shimmer3RClient.readInfoMemBytes — BLE notification reassembly', () => {
  it('rebuilds a 384-byte image out of 20-byte notifications', async () => {
    // A real link hands over ~20-40 bytes at a time, so each 130-byte page reply
    // arrives as one opcode-led notification followed by continuations that
    // carry raw payload and no opcode of their own. The pattern image contains
    // 0xFF bytes on purpose: a continuation byte that looks like an ACK must not
    // be dropped.
    const store = patternImage();
    const fw = await scriptedFirmware({ framed: true, store, notifyBytes: 20 });
    const bytes = await fw.client.readInfoMemBytes();
    expect([...bytes]).toEqual([...store]);
    expect(bytes[255]).toBe(255); // 0xFF survived the continuation path
  });
});

describe.each(SHAPES)('Shimmer3RClient.writeInfoMem — one chunk, %s', (_name, framed) => {
  it('sends [0x8C][len][offLo][offHi][data…] and resolves on the ACK', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeInfoMem(0x0102, Uint8Array.from([1, 2, 3, 4]));
    expect(fw.cmdsOf(SET_INFOMEM)).toEqual([[SET_INFOMEM, 4, 0x02, 0x01, 1, 2, 3, 4]]);
  });

  it('rejects a chunk beyond the firmware ceiling of 128 bytes', async () => {
    const fw = await scriptedFirmware({ framed });
    await expect(fw.client.writeInfoMem(0, new Uint8Array(129))).rejects.toThrow(/1\.\.128/);
    await expect(fw.client.writeInfoMem(0, new Uint8Array(0))).rejects.toThrow(/1\.\.128/);
    expect(fw.cmdsOf(SET_INFOMEM)).toHaveLength(0);
  });

  it('rejects an out-of-range address', async () => {
    const fw = await scriptedFirmware({ framed });
    await expect(fw.client.writeInfoMem(0x10000, new Uint8Array(4))).rejects.toThrow(/0\.\.65535/);
  });

  it('surfaces the firmware NACK rather than timing out', async () => {
    const fw = await scriptedFirmware({ framed, nackInfoMemWrite: true });
    await expect(fw.client.writeInfoMem(0, new Uint8Array(4))).rejects.toThrow(/NACK/);
  });
});

describe('Shimmer3RClient.writeInfoMemBytes — chunking', () => {
  it('defaults to 64-byte chunks over BLE', async () => {
    const image = patternImage();
    const fw = await scriptedFirmware({ framed: true });
    await fw.client.writeInfoMemBytes(image);
    expect(writeChunks(fw)).toEqual([
      [64, 0],
      [64, 64],
      [64, 128],
      [64, 192],
      [64, 256],
      [64, 320],
    ]);
    expect([...fw.store]).toEqual([...image]);
  });

  it('defaults to the firmware ceiling of 128 over a byte stream', async () => {
    const image = patternImage();
    const fw = await scriptedFirmware({ framed: false });
    await fw.client.writeInfoMemBytes(image);
    expect(writeChunks(fw)).toEqual([
      [128, 0],
      [128, 128],
      [128, 256],
    ]);
    expect([...fw.store]).toEqual([...image]);
  });

  it('honours an explicit chunkBytes on either transport', async () => {
    for (const framed of [true, false]) {
      const image = patternImage();
      const fw = await scriptedFirmware({ framed });
      await fw.client.writeInfoMemBytes(image, { chunkBytes: 128 });
      expect(writeChunks(fw)).toEqual([
        [128, 0],
        [128, 128],
        [128, 256],
      ]);
      expect([...fw.store]).toEqual([...image]);
    }
  });

  it('sends exact per-chunk headers and one ACK is consumed per chunk', async () => {
    const image = patternImage();
    const fw = await scriptedFirmware({ framed: true });
    await fw.client.writeInfoMemBytes(image, { chunkBytes: 64 });
    const chunks = fw.cmdsOf(SET_INFOMEM);
    expect(chunks).toHaveLength(6);
    chunks.forEach((c, i) => {
      const off = i * 64;
      expect(c.slice(0, 4)).toEqual([SET_INFOMEM, 64, off & 0xff, (off >> 8) & 0xff]);
      expect(c.slice(4)).toEqual([...image.subarray(off, off + 64)]);
    });
    // One ACK consumed per chunk, asserted where it shows: a leftover ACK would
    // resolve the NEXT command's waiter early, so a read that still returns the
    // right image proves the accounting stayed balanced across all six.
    expect([...(await fw.client.readInfoMemBytes())]).toEqual([...image]);
  });

  it('chunks against the LEGACY page base for old Shimmer3 firmware', async () => {
    const image = patternImage();
    const fw = await scriptedFirmware({
      framed: false,
      hardwareVersion: HW.SHIMMER3,
      firmware: FW_LEGACY_SDLOG,
    });
    await fw.client.writeInfoMemBytes(image);
    expect(writeChunks(fw)).toEqual([
      [128, 0x1800],
      [128, 0x1880],
      [128, 0x1900],
    ]);
    expect([...fw.store]).toEqual([...image]);
  });

  it('rejects a wrong-length image before writing anything', async () => {
    const fw = await scriptedFirmware({ framed: true });
    await expect(fw.client.writeInfoMemBytes(new Uint8Array(100))).rejects.toThrow(/384 bytes/);
    expect(fw.cmdsOf(SET_INFOMEM)).toHaveLength(0);
  });

  it('rejects a nonsense chunkBytes', async () => {
    const fw = await scriptedFirmware({ framed: true });
    await expect(fw.client.writeInfoMemBytes(patternImage(), { chunkBytes: 200 })).rejects.toThrow(
      /chunkBytes/,
    );
    expect(fw.cmdsOf(SET_INFOMEM)).toHaveLength(0);
  });
});

describe.each(SHAPES)('Shimmer3RClient.writeInfoMemConfig — %s', (_name, framed) => {
  it('writes the RTC FIRST, then the image', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeInfoMemConfig(
      { ...seedConfig(), samplingRateHz: 128 },
      {
        verify: false,
      },
    );
    // Ignore the two version reads; what matters is that no page write precedes
    // the clock write, matching desktop CallableWriteConfig's order.
    const order = fw.cmds.map((c) => c[0]).filter((op) => op === SET_RWC || op === SET_INFOMEM);
    expect(order[0]).toBe(SET_RWC);
    expect(order.filter((op) => op === SET_RWC)).toHaveLength(1);
    expect(order.slice(1).every((op) => op === SET_INFOMEM)).toBe(true);
  });

  it('skips the clock write when setRtc is false', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeInfoMemConfig(seedConfig(), { setRtc: false, verify: false });
    expect(fw.cmdsOf(SET_RWC)).toHaveLength(0);
    expect(fw.cmdsOf(SET_INFOMEM).length).toBeGreaterThan(0);
  });

  it('aborts before any page write when the clock write fails', async () => {
    const fw = await scriptedFirmware({ framed, nackRtc: true });
    await expect(fw.client.writeInfoMemConfig(seedConfig())).rejects.toThrow(/NACK/);
    expect(fw.cmdsOf(SET_RWC)).toHaveLength(1);
    expect(fw.cmdsOf(SET_INFOMEM)).toHaveLength(0);
  });

  it('applies device-write finalization: the stored MAC becomes 0xFF×6', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.writeInfoMemConfig(seedConfig(), { verify: false });
    for (let i = 0; i < 6; i++) expect(fw.store[224 + i]).toBe(0xff);
  });

  it('reports verified: null when verification is declined', async () => {
    const fw = await scriptedFirmware({ framed });
    const res = await fw.client.writeInfoMemConfig(seedConfig(), { verify: false });
    expect(res.verified).toBeNull();
    expect(fw.cmdsOf(GET_INFOMEM)).toHaveLength(0);
  });

  it('verifies by default, re-reading all three pages', async () => {
    const fw = await scriptedFirmware({ framed });
    const res = await fw.client.writeInfoMemConfig({ ...seedConfig(), samplingRateHz: 200 });
    expect(res.verified).toBe(true);
    expect(fw.cmdsOf(GET_INFOMEM)).toHaveLength(3);
  });

  it('still verifies when the device only diverges the MAC and config-delay byte', async () => {
    // Real firmware overwrites the MAC with the address it reads from its own
    // transceiver and rewrites the config-delay flag as it regenerates the SD
    // configuration. Both are excluded from the comparison, or every successful
    // write would report a mismatch.
    const fw = await scriptedFirmware({
      framed,
      divergeReadback: (b) => {
        for (let i = 0; i < 6; i++) b[224 + i] = 0x11 + i;
        b[230] = 0x00;
      },
    });
    const res = await fw.client.writeInfoMemConfig({ ...seedConfig(), samplingRateHz: 200 });
    expect(res.verified).toBe(true);
  });

  it('reports a mismatch when a byte OUTSIDE the divergent ranges comes back wrong', async () => {
    const fw = await scriptedFirmware({
      framed,
      divergeReadback: (b) => {
        b[3] = (b[3] + 1) & 0xff; // a sensors byte — nothing excuses this
      },
    });
    const res = await fw.client.writeInfoMemConfig({
      ...seedConfig(),
      enabledSensors: 0x0000e0,
    });
    expect(res.verified).toBe(false);
  });

  it('round-trips a whole configuration through the device', async () => {
    const fw = await scriptedFirmware({ framed });
    const cfg: InfoMemDeviceConfig = {
      ...seedConfig(),
      deviceName: 'ROUNDTRIP',
      trialName: 'TRIAL-9',
      samplingRateHz: 512,
    };
    await fw.client.writeInfoMemConfig(cfg, { verify: false });
    const back = await fw.client.readInfoMemConfig();
    expect(back.deviceName).toBe('ROUNDTRIP');
    expect(back.trialName).toBe('TRIAL-9');
    expect(back.samplingRateHz).toBeCloseTo(512, 6);
  });
});

describe('Shimmer3RClient configuration writes while streaming', () => {
  it('refuses every write, and puts nothing on the wire', async () => {
    const fw = await scriptedFirmware({ framed: true });
    await fw.client.startStreaming();
    fw.cmds.length = 0; // only what happens AFTER the stream starts matters

    await expect(fw.client.writeInfoMemBytes(patternImage())).rejects.toThrow(
      /unavailable while this client is streaming/,
    );
    await expect(fw.client.writeInfoMemConfig(seedConfig())).rejects.toThrow(
      /unavailable while this client is streaming/,
    );
    await expect(fw.client.updateSdLogConfig()).rejects.toThrow(
      /unavailable while this client is streaming/,
    );
    await expect(fw.client.updateCalibDump()).rejects.toThrow(
      /unavailable while this client is streaming/,
    );
    // Not one byte written: the refusal happens before the version reads, let
    // alone before a page write, so there is no half-written image to explain.
    expect(fw.cmds).toHaveLength(0);
    expect(fw.store.every((b) => b === 0)).toBe(true);
  });

  it('allows them again once streaming has stopped', async () => {
    const fw = await scriptedFirmware({ framed: true });
    await fw.client.startStreaming();
    await fw.client.stopStreaming();
    await expect(fw.client.updateSdLogConfig()).resolves.toBeUndefined();
  });
});

describe.each(SHAPES)('Shimmer3RClient device-side config regeneration — %s', (_name, framed) => {
  it('UPD_SDLOG_CFG (0x9C) takes no arguments and resolves on the ACK', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.updateSdLogConfig();
    expect(fw.cmdsOf(OPCODES.UPD_SDLOG_CFG_COMMAND)).toEqual([[OPCODES.UPD_SDLOG_CFG_COMMAND]]);
  });

  it('UPD_CALIB_DUMP (0x9B) takes no arguments and resolves on the ACK', async () => {
    const fw = await scriptedFirmware({ framed });
    await fw.client.updateCalibDump();
    expect(fw.cmdsOf(OPCODES.UPD_CALIB_DUMP_COMMAND)).toEqual([[OPCODES.UPD_CALIB_DUMP_COMMAND]]);
  });
});

describe('page addressing helper', () => {
  it('maps both address bases onto the same store offsets', () => {
    expect([0, 128, 256].map(pageOffset)).toEqual([0, 128, 256]);
    expect([0x1800, 0x1880, 0x1900].map(pageOffset)).toEqual([0, 128, 256]);
  });
});
