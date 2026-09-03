import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';
import { buildStreamSchema } from '../../src/devices/shimmer3r/streamSchema.js';
import {
  channelLayoutDiffersByGeneration,
  isGenerationSensitiveChannel,
} from '../../src/devices/shimmer3r/channelFormats.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { ObjectCluster } from '../../src/core/ObjectCluster.js';

// The bug these tests exist for: a data frame carries no per-channel length, so
// the channel ID is the only thing that says how wide a channel is. The schema
// builder used to assume 2 bytes, little-endian, signed for any ID it did not
// recognise — and it did not recognise BMP_PRESSURE (3 bytes) or, on a
// Shimmer3R, BMP_TEMPERATURE (3 bytes). Enabling the stock pressure sensor
// therefore made the real packet 1-2 bytes longer than the computed one and
// every channel after pressure decoded from the wrong offset, with no error.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xff
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE; // 0x25

const HW_SHIMMER3 = 3;
const HW_SHIMMER3R = 10;

const CH = {
  GYRO_X: 0x0a,
  BATTERY: 0x03,
  TEMPERATURE: 0x1a,
  PRESSURE: 0x1b,
  EXT_ADC_0: 0x0d,
  BRIDGE_HIGH: 0x27,
  /** Not in any firmware channel enum — stands in for a future channel. */
  UNKNOWN: 0x2f,
} as const;

/**
 * Shimmer3R-layout inquiry response, opcode-inclusive:
 * `[0x02, adcLo, adcHi, cfg0..cfg6, numCh, bufSize, ...channelIds]`.
 * adcRaw 0x0280 = 640 → 32768/640 = 51.2 Hz; config word all zero.
 */
const inquiry = (channelIds: number[]): number[] => [
  INQ_RSP,
  0x80,
  0x02,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  channelIds.length,
  1,
  ...channelIds,
];

const u24le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const u24be = (v: number): number[] => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
const u16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u16be = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];

/** A data frame: 0x00 preamble, 24-bit little-endian timestamp, then payload. */
const frame = (ts: number, payload: number[]): number[] => [0x00, ...u24le(ts), ...payload];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

interface Session {
  client: Shimmer3RClient;
  transport: LoopbackTransport;
  status: string[];
}

/** A connected client whose fake firmware answers the version and the inquiry. */
async function session(hardwareVersion: number | null, channelIds: number[]): Promise<Session> {
  const transport = new LoopbackTransport({ deviceName: 'Shimmer3R-TEST' });
  transport.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) {
      if (hardwareVersion !== null) setTimeout(() => tr.notify([ACK, DEVVER, hardwareVersion]), 0);
    } else if (op === OPCODES.INQUIRY_COMMAND) {
      setTimeout(() => tr.notify([ACK, ...inquiry(channelIds)]), 0);
    } else {
      setTimeout(() => tr.notify([ACK]), 0);
    }
  });
  const client = new Shimmer3RClient({ debug: false, transport, emitCalibratedInertial: false });
  const status: string[] = [];
  client.onStatus = (m) => status.push(m);
  await client.connect();
  // The generation is what makes 0x1A's width knowable, so a host that streams
  // pressure has to ask. Skipped when `hardwareVersion` is null, to exercise the
  // assumed-generation path.
  if (hardwareVersion !== null) await client.readDeviceVersion();
  return { client, transport, status };
}

/** Stream three frames of the same payload and return the decoded clusters. */
async function streamFrames(s: Session, payload: number[]): Promise<ObjectCluster[]> {
  const frames: ObjectCluster[] = [];
  s.client.onStreamFrame = (oc) => frames.push(oc);
  await s.client.startStreaming();
  s.transport.notify([...frame(100, payload), ...frame(200, payload), ...frame(300, payload)]);
  await tick();
  return frames;
}

// ---------------------------------------------------------------------------
// The regression: pressure followed by another channel
// ---------------------------------------------------------------------------

describe('a Shimmer3R packet with pressure and temperature enabled', () => {
  // Firmware emission order on a Shimmer3R is PRESSURE then TEMPERATURE
  // (spi.c:739-756, `#if defined(SHIMMER3R)`), 3 bytes each. Battery brings up
  // the rear: it is the channel that used to decode as rubbish.
  const CHANNELS = [CH.GYRO_X, CH.PRESSURE, CH.TEMPERATURE, CH.BATTERY];
  const GYRO_X = 229;
  const PRESSURE = 0x123456; // 1193046
  const TEMPERATURE = 0x0abcde; // 703710
  const BATTERY = 3054;
  const PAYLOAD = [...u16le(GYRO_X), ...u24le(PRESSURE), ...u24le(TEMPERATURE), ...u16le(BATTERY)];

  it('computes the frame size the firmware actually sends', async () => {
    const s = await session(HW_SHIMMER3R, CHANNELS);
    const { schema } = await s.client.inquiry();

    // 1 preamble + 3 timestamp + 2 gyro + 3 pressure + 3 temperature + 2 battery.
    expect(schema.frameBytes).toBe(14);
    expect(schema.frameBytes).toBe(4 + schema.fields.reduce((n, f) => n + f.sizeBytes, 0));
    // What the old 2-bytes-for-anything-unknown fallback computed. Two bytes
    // short, so the parser's preamble check lands mid-frame and never
    // resynchronises on a real stream.
    expect(schema.frameBytes).not.toBe(12);
    expect(schema.fields.map((f) => f.sizeBytes)).toEqual([2, 3, 3, 2]);
  });

  it('decodes the channel AFTER pressure correctly (this failed before the fix)', async () => {
    const s = await session(HW_SHIMMER3R, CHANNELS);
    await s.client.inquiry();
    const frames = await streamFrames(s, PAYLOAD);

    expect(frames.length).toBeGreaterThanOrEqual(1);
    const oc = frames[0];
    expect(oc.get('GYRO_X', 'raw')!.value).toBe(GYRO_X);
    expect(oc.get('PRESSURE', 'raw')!.value).toBe(PRESSURE);
    expect(oc.get('TEMPERATURE', 'raw')!.value).toBe(TEMPERATURE);
    // The whole point: with 2-byte pressure and temperature this read
    // frame[10..11] = 0xbc,0x0a → 2748, a plausible battery reading and a wrong
    // one. Nothing threw, nothing warned; the number was just false.
    expect(oc.get('BATTERY', 'raw')!.value).toBe(BATTERY);
    expect(oc.get('BATTERY', 'raw')!.value).not.toBe(0x0abc);
  });

  it('names and types the pair, and trusts the schema', async () => {
    const s = await session(HW_SHIMMER3R, CHANNELS);
    const { schema } = await s.client.inquiry();
    expect(schema.fields.map((f) => f.name)).toEqual([
      'GYRO_X',
      'PRESSURE',
      'TEMPERATURE',
      'BATTERY',
    ]);
    expect(schema.fields[1]).toMatchObject({ fmt: 'u24', endian: 'le', sizeBytes: 3 });
    expect(schema.fields[2]).toMatchObject({ fmt: 'u24', endian: 'le', sizeBytes: 3 });
    expect(schema.generation).toBe('shimmer3r');
    expect(schema.generationAssumed).toBe(false);
    expect(schema.unknownChannelIds).toEqual([]);
    expect(schema.trusted).toBe(true);
    expect(schema.enabledSensors & SensorBitmapShimmer3.SENSOR_PRESSURE).toBeTruthy();
    expect(schema.enabledSensors & SensorBitmapShimmer3.SENSOR_VBATT).toBeTruthy();
  });
});

describe('the same packet on a classic Shimmer3', () => {
  // Firmware emission order on a Shimmer3 is the other way round —
  // TEMPERATURE then PRESSURE (i2c.c:389-394) — and temperature is 2 bytes,
  // not 3 (bmpX80.h:103-105). Both readings are big-endian: BMP180/BMP280
  // registers come off the I2C bus MSB first.
  const CHANNELS = [CH.GYRO_X, CH.TEMPERATURE, CH.PRESSURE, CH.BATTERY];
  const GYRO_X = 229;
  const TEMPERATURE = 0xabcd; // 43981
  const PRESSURE = 0x123456; // 1193046
  const BATTERY = 3054;

  it('gives temperature 2 big-endian bytes and pressure 3', async () => {
    const s = await session(HW_SHIMMER3, CHANNELS);
    const { schema } = await s.client.inquiry();

    expect(schema.generation).toBe('shimmer3');
    // 1 + 3 + 2 gyro + 2 temperature + 3 pressure + 2 battery.
    expect(schema.frameBytes).toBe(13);
    expect(schema.fields.map((f) => [f.name, f.fmt, f.endian, f.sizeBytes])).toEqual([
      ['GYRO_X', 'i16', 'le', 2],
      ['TEMPERATURE', 'u16', 'be', 2],
      ['PRESSURE', 'u24', 'be', 3],
      ['BATTERY', 'u16', 'le', 2],
    ]);
    expect(schema.trusted).toBe(true);
  });

  it('decodes the big-endian pair and the channel after it', async () => {
    const s = await session(HW_SHIMMER3, CHANNELS);
    await s.client.inquiry();
    const frames = await streamFrames(s, [
      ...u16le(GYRO_X),
      ...u16be(TEMPERATURE),
      ...u24be(PRESSURE),
      ...u16le(BATTERY),
    ]);

    const oc = frames[0];
    expect(oc.get('GYRO_X', 'raw')!.value).toBe(GYRO_X);
    expect(oc.get('TEMPERATURE', 'raw')!.value).toBe(TEMPERATURE);
    expect(oc.get('PRESSURE', 'raw')!.value).toBe(PRESSURE);
    expect(oc.get('BATTERY', 'raw')!.value).toBe(BATTERY);
  });

  it('reads the identical channel list into a different frame size per generation', async () => {
    // Same bytes on the wire, two hardware generations, two correct answers.
    const list = [CH.PRESSURE, CH.TEMPERATURE, CH.BATTERY];
    const s3 = await (await session(HW_SHIMMER3, list)).client.inquiry();
    const s3r = await (await session(HW_SHIMMER3R, list)).client.inquiry();
    expect(s3.schema.frameBytes).toBe(1 + 3 + 3 + 2 + 2); // temperature 2 bytes
    expect(s3r.schema.frameBytes).toBe(1 + 3 + 3 + 3 + 2); // temperature 3 bytes
    expect(s3.schema.frameBytes).not.toBe(s3r.schema.frameBytes);
  });
});

// ---------------------------------------------------------------------------
// The ADC block: same IDs, different signals
// ---------------------------------------------------------------------------

describe('the ADC block names per generation', () => {
  const list = [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13];

  it('uses the Shimmer3 expansion-connector names on a Shimmer3', async () => {
    const s = await session(HW_SHIMMER3, list);
    const { schema } = await s.client.inquiry();
    expect(schema.fields.map((f) => f.name)).toEqual([
      'EXT_EXP_ADC_A7',
      'EXT_EXP_ADC_A6',
      'EXT_EXP_ADC_A15',
      'INT_EXP_ADC_A1',
      'INT_EXP_ADC_A12',
      'INT_EXP_ADC_A14',
    ]);
    // Names differ, widths do not — 2 little-endian bytes throughout.
    expect(schema.frameBytes).toBe(4 + 6 * 2);
    expect(schema.trusted).toBe(true);
  });

  it('uses the Shimmer3R names on a Shimmer3R', async () => {
    const s = await session(HW_SHIMMER3R, list);
    const { schema } = await s.client.inquiry();
    expect(schema.fields.map((f) => f.name)).toEqual([
      'EXT_ADC_0',
      'EXT_ADC_1',
      'EXT_ADC_2',
      'INT_ADC_3',
      'INT_ADC_0',
      'INT_ADC_2',
    ]);
    expect(schema.frameBytes).toBe(4 + 6 * 2);
  });

  it('maps both generations’ ADC channels onto the same enable bits', async () => {
    const s3 = await (await session(HW_SHIMMER3, list)).client.inquiry();
    const s3r = await (await session(HW_SHIMMER3R, list)).client.inquiry();
    expect(s3.schema.enabledSensors).toBe(s3r.schema.enabledSensors);
    expect(s3.schema.enabledSensors).toBe(
      SensorBitmapShimmer3.SENSOR_EXT_A0 |
        SensorBitmapShimmer3.SENSOR_EXT_A1 |
        SensorBitmapShimmer3.SENSOR_EXT_A2 |
        SensorBitmapShimmer3.SENSOR_INT_A3 |
        SensorBitmapShimmer3.SENSOR_INT_A0 |
        SensorBitmapShimmer3.SENSOR_INT_A2,
    );
  });
});

// ---------------------------------------------------------------------------
// Loud, not silent
// ---------------------------------------------------------------------------

describe('a channel ID this SDK cannot describe', () => {
  const CHANNELS = [CH.GYRO_X, CH.UNKNOWN, CH.BATTERY];

  it('flags the schema, names the ID in a status message, and marks the fields', async () => {
    const s = await session(HW_SHIMMER3R, CHANNELS);
    const { schema } = await s.client.inquiry();

    expect(schema.trusted).toBe(false);
    expect(schema.unknownChannelIds).toEqual([CH.UNKNOWN]);

    const [gyro, unknown, battery] = schema.fields;
    // The channels before the guess are still sound.
    expect(gyro).toMatchObject({ name: 'GYRO_X', offsetTrusted: true });
    expect(gyro.assumed).toBeUndefined();
    // The guess itself, still named the way earlier releases named it.
    expect(unknown).toMatchObject({ name: 'CH_2F', sizeBytes: 2, assumed: true });
    // Everything downstream of the guess sits at an offset that may be wrong.
    expect(battery).toMatchObject({ name: 'BATTERY', offsetTrusted: false });

    const warning = s.status.find((m) => m.includes('0x2F'));
    expect(warning, `no status message named 0x2F: ${s.status.join(' | ')}`).toBeDefined();
    expect(warning).toMatch(/unknown channel id/i);
    expect(warning).toMatch(/assumed/i);
  });

  it('still decodes, so one unfamiliar channel does not cost every channel', async () => {
    const s = await session(HW_SHIMMER3R, CHANNELS);
    await s.client.inquiry();
    const frames = await streamFrames(s, [...u16le(229), 0x11, 0x22, ...u16le(3054)]);
    // GYRO_X sits before the guess and is right; BATTERY sits after it and is
    // only right by luck (the real channel happened to be 2 bytes). The schema
    // says which is which, via offsetTrusted.
    expect(frames[0].get('GYRO_X', 'raw')!.value).toBe(229);
    expect(frames[0].get('CH_2F', 'raw')).toBeDefined();
  });

  it('reports the bridge-amp channels as unknown on a Shimmer3R, not as Shimmer3 channels', async () => {
    const s3 = await (await session(HW_SHIMMER3, [CH.BRIDGE_HIGH])).client.inquiry();
    expect(s3.schema.fields[0].name).toBe('BRIDGE_AMP_HIGH');
    expect(s3.schema.trusted).toBe(true);

    const s3r = await (await session(HW_SHIMMER3R, [CH.BRIDGE_HIGH])).client.inquiry();
    expect(s3r.schema.fields[0].name).toBe('CH_27');
    expect(s3r.schema.trusted).toBe(false);
  });
});

describe('a generation this client had to assume', () => {
  it('distrusts the schema and names the channels when the assumption matters', async () => {
    // No device-version answer, so `generation` falls back to shimmer3r.
    const s = await session(null, [CH.GYRO_X, CH.PRESSURE, CH.TEMPERATURE]);
    expect(s.client.generationIsAssumed).toBe(true);
    expect(s.client.generation).toBe('shimmer3r');

    const { schema } = await s.client.inquiry();
    expect(schema.generationAssumed).toBe(true);
    expect(schema.trusted).toBe(false);
    // Nothing was unrecognised — the doubt is entirely about which platform.
    expect(schema.unknownChannelIds).toEqual([]);

    const warning = s.status.find((m) => m.includes('readDeviceVersion'));
    expect(warning, `no assumption warning: ${s.status.join(' | ')}`).toBeDefined();
    expect(warning).toContain('0x1A');
    expect(warning).toContain('0x1B');
  });

  it('trusts the schema when nothing in the packet depends on the generation', async () => {
    const s = await session(null, [CH.GYRO_X, CH.BATTERY]);
    const { schema } = await s.client.inquiry();
    expect(schema.generationAssumed).toBe(true);
    expect(schema.trusted).toBe(true);
    expect(s.status.some((m) => m.includes('readDeviceVersion'))).toBe(false);
  });

  it('settles the generation once readDeviceVersion has been called', async () => {
    const s = await session(HW_SHIMMER3, [CH.EXT_ADC_0]);
    expect(s.client.generationIsAssumed).toBe(false);
    expect(s.client.generation).toBe('shimmer3');
    const { schema } = await s.client.inquiry();
    expect(schema.fields[0].name).toBe('EXT_EXP_ADC_A7');
    expect(schema.trusted).toBe(true);
  });

  it('keeps trusting a frame whose only doubt is a channel NAME', async () => {
    // The ADC block is u16/le/2 bytes on both generations and differs only in
    // what the channel is called, so assuming the wrong platform mislabels a
    // column without moving an offset. Distrusting the frame here would cry
    // wolf on the commonest expansion-board setup.
    const s = await session(null, [CH.GYRO_X, CH.EXT_ADC_0]);
    expect(s.client.generationIsAssumed).toBe(true);

    const { schema } = await s.client.inquiry();
    expect(schema.generationAssumed).toBe(true);
    expect(schema.trusted).toBe(true);
    expect(schema.unknownChannelIds).toEqual([]);

    // Said out loud all the same, and named as a labelling doubt.
    const warning = s.status.find((m) => m.includes('0x0D'));
    expect(warning, `no naming warning: ${s.status.join(' | ')}`).toBeDefined();
    expect(warning).toContain('different name');
    expect(warning).toContain('stays trusted');
  });

  it('still distrusts a frame mixing a name-only and a layout difference', async () => {
    const s = await session(null, [CH.EXT_ADC_0, CH.PRESSURE]);
    const { schema } = await s.client.inquiry();
    expect(schema.trusted).toBe(false);
    // The two doubts are reported separately, not conflated.
    expect(s.status.some((m) => m.includes('decoded differently') && m.includes('0x1B'))).toBe(
      true,
    );
    expect(s.status.some((m) => m.includes('different name') && m.includes('0x0D'))).toBe(true);
  });
});

describe('channelLayoutDiffersByGeneration', () => {
  it('is false for a channel both generations lay out identically', () => {
    expect(channelLayoutDiffersByGeneration(CH.GYRO_X)).toBe(false);
    expect(channelLayoutDiffersByGeneration(CH.BATTERY)).toBe(false);
  });

  it('is false across the ADC block, where only the name differs', () => {
    for (const id of [0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x13]) {
      expect(channelLayoutDiffersByGeneration(id), `0x${id.toString(16)}`).toBe(false);
      // ...but they are still generation-sensitive in the broad sense.
      expect(isGenerationSensitiveChannel(id), `0x${id.toString(16)}`).toBe(true);
    }
  });

  it('is true for the BMP pair, which differs in width and byte order', () => {
    expect(channelLayoutDiffersByGeneration(CH.TEMPERATURE)).toBe(true);
    expect(channelLayoutDiffersByGeneration(CH.PRESSURE)).toBe(true);
  });

  it('is true for a channel only one generation has at all', () => {
    expect(channelLayoutDiffersByGeneration(CH.BRIDGE_HIGH)).toBe(true);
    expect(channelLayoutDiffersByGeneration(0x28)).toBe(true);
  });

  it('is false for an ID neither generation describes', () => {
    expect(channelLayoutDiffersByGeneration(CH.UNKNOWN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The builder on its own
// ---------------------------------------------------------------------------

describe('buildStreamSchema', () => {
  it('counts a u16 timestamp as 2 bytes and a u24 as 3', () => {
    const ids = [CH.GYRO_X, CH.PRESSURE];
    const u16 = buildStreamSchema(ids, 'u16', { generation: 'shimmer3r' });
    const u24 = buildStreamSchema(ids, 'u24', { generation: 'shimmer3r' });
    expect(u16.frameBytes).toBe(1 + 2 + 2 + 3);
    expect(u24.frameBytes).toBe(1 + 3 + 2 + 3);
  });

  it('accepts an empty channel list', () => {
    const s = buildStreamSchema([], 'u24', { generation: 'shimmer3r' });
    expect(s.fields).toEqual([]);
    expect(s.frameBytes).toBe(4);
    expect(s.enabledSensors).toBe(0);
    expect(s.trusted).toBe(true);
  });

  it('lists every unknown ID, in order, once per occurrence', () => {
    const s = buildStreamSchema([0x2f, CH.GYRO_X, 0x30, 0x2f], 'u24', {
      generation: 'shimmer3r',
    });
    expect(s.unknownChannelIds).toEqual([0x2f, 0x30, 0x2f]);
    expect(s.trusted).toBe(false);
    // Only the first field predates the guessing.
    expect(s.fields.map((f) => f.offsetTrusted)).toEqual([true, false, false, false]);
  });

  it('reports each problem exactly once', () => {
    const problems: string[] = [];
    buildStreamSchema([0x2f, 0x30], 'u24', {
      generation: 'shimmer3r',
      onProblem: (m) => problems.push(m),
    });
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('0x2F');
    expect(problems[1]).toContain('0x30');
  });

  it('keeps the ExG status bytes 1 byte wide and free of an enable bit of their own', () => {
    const s = buildStreamSchema([0x1d, 0x1e, 0x1f], 'u24', { generation: 'shimmer3r' });
    expect(s.fields.map((f) => f.sizeBytes)).toEqual([1, 3, 3]);
    expect(s.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_EXG1_24BIT);
    expect(s.frameBytes).toBe(4 + 1 + 3 + 3);
  });
});
