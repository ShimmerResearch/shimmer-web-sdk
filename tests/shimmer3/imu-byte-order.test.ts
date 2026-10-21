import { describe, it, expect } from 'vitest';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { buildShimmer3Schema } from '../../src/devices/shimmer3/protocol.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { ObjectCluster } from '../../src/core/ObjectCluster.js';

/*
 * Byte order of the Shimmer3's inertial channels (DEV-1288).
 *
 * The bytes below are a real Shimmer3 (SR48-4-2, LogAndStream v1.01.003)
 * recorded by shimmer-host-core in `conformance/traces/shimmer3_session.trace`,
 * whose expected values come from host-core, which is held to the Java driver.
 * The trace ran with a 1-byte link CRC; the CRC bytes are left off here, since
 * Shimmer3Client has none.
 */

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const hex = (s: string): number[] => s.match(/../g)!.map((b) => parseInt(b, 16));

/** The trace's replies, CRC removed. */
const DEVICE_VERSION = hex('2503'); // Shimmer3
const FW_VERSION = hex('2f030001000103'); // LogAndStream v1.01.003
const DAUGHTER_CARD_ID = hex('6503300402'); // SR48-4-2
// 51.2 Hz; LN accel X/Y/Z, battery, gyro X/Y/Z, mag X/Y/Z.
const INQUIRY = hex('028002019b0d080a01000102030a0b0c070809');

/**
 * Two of the trace's packets, without the 0x00 preamble, and the UNCAL values
 * host-core decoded from each. Gyro is big-endian, mag little-endian (new IMU).
 */
const SAMPLES = [
  {
    packet: hex('d2547d1605a7077f08390bfdba0476ffc00f00a9ff87fe'),
    timestamp: 8213714,
    lnAccel: [1302, 1959, 2175],
    battery: 2873,
    gyro: [-582, 1142, -64],
    mag: [15, -87, -377],
  },
  {
    packet: hex('d20b801505aa077a083a0bfdb10482ffc21500a8ff83fe'),
    timestamp: 0x800bd2,
    lnAccel: [1301, 1962, 2170],
    battery: 2874,
    gyro: [-591, 1154, -62],
    mag: [21, -88, -381],
  },
];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function device(daughterCardId: number[] = DAUGHTER_CARD_ID): LoopbackTransport {
  const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
  t.setOnWrite((bytes, tr) => {
    const reply: Record<number, number[]> = {
      [OPCODES.GET_DEVICE_VERSION_COMMAND]: DEVICE_VERSION,
      [OPCODES.GET_FW_VERSION_COMMAND]: [ACK, ...FW_VERSION],
      [OPCODES.GET_DAUGHTER_CARD_ID_COMMAND]: [ACK, ...daughterCardId],
      [OPCODES.INQUIRY_COMMAND]: [ACK, ...INQUIRY],
      [OPCODES.START_STREAMING_COMMAND]: [ACK],
    };
    const r = reply[bytes[0]];
    if (r) setTimeout(() => tr.notify(r), 0);
  });
  return t;
}

async function stream(
  client: Shimmer3Client,
  t: LoopbackTransport,
  packets: number[][],
): Promise<ObjectCluster[]> {
  const frames: ObjectCluster[] = [];
  client.onStreamFrame = (oc) => frames.push(oc);
  await client.startStreaming();
  // The last frame is held until the next preamble arrives, so send one more.
  t.notify([...packets.flatMap((p) => [0x00, ...p]), 0x00, ...packets[0]]);
  await tick();
  return frames;
}

const axes = (oc: ObjectCluster, prefix: string): number[] =>
  ['X', 'Y', 'Z'].map((a) => oc.get(`${prefix}_${a}`, 'raw')!.value);

describe('Shimmer3 streaming gyro byte order', () => {
  it('decodes a recorded Shimmer3 packet to the values host-core and Java read', async () => {
    const t = device();
    const client = new Shimmer3Client({ transport: t });
    await client.connect();
    await client.inquiry();
    const frames = await stream(
      client,
      t,
      SAMPLES.map((s) => s.packet),
    );

    expect(frames.length).toBeGreaterThanOrEqual(SAMPLES.length);
    SAMPLES.forEach((s, i) => {
      const oc = frames[i];
      expect(oc.get('TIMESTAMP', 'raw')!.value).toBe(s.timestamp);
      expect(axes(oc, 'LN_ACCEL')).toEqual(s.lnAccel);
      expect(oc.get('BATTERY', 'raw')!.value).toBe(s.battery);
      // Little-endian would read -19971 here for Gyro_X -591 (0xFDB1).
      expect(axes(oc, 'GYRO')).toEqual(s.gyro);
      expect(axes(oc, 'MAG')).toEqual(s.mag);
    });
  });

  it('types the gyro big-endian in the schema, and nothing else it did not before', () => {
    const schema = buildShimmer3Schema([0x00, 0x03, 0x0a, 0x0b, 0x0c, 0x07, 0x08, 0x09], 'u24');
    expect(schema.fields.map((f) => [f.name, f.endian])).toEqual([
      ['LN_ACCEL_X', 'le'],
      ['BATTERY', 'le'],
      ['GYRO_X', 'be'],
      ['GYRO_Y', 'be'],
      ['GYRO_Z', 'be'],
      ['MAG_X', 'le'],
      ['MAG_Y', 'le'],
      ['MAG_Z', 'le'],
    ]);
    expect(schema.trusted).toBe(true);
  });
});

describe('Shimmer3 streaming mag byte order follows the IMU generation', () => {
  /** The first sample with its mag rewritten big-endian, as an old-IMU board sends it. */
  const oldImuPacket = (): number[] => {
    const p = [...SAMPLES[0].packet];
    for (let i = 17; i < 23; i += 2) [p[i], p[i + 1]] = [p[i + 1], p[i]];
    return p;
  };

  it('stays little-endian while the board is unknown', async () => {
    const t = device();
    const client = new Shimmer3Client({ transport: t });
    await client.connect();
    expect(client.imuGeneration).toBeNull();
    await client.inquiry();
    expect(
      client.schema!.fields.filter((f) => f.name.startsWith('MAG')).map((f) => f.endian),
    ).toEqual(['le', 'le', 'le']);
  });

  it('reads a new-IMU board from the daughter-card id and keeps little-endian', async () => {
    const t = device();
    const client = new Shimmer3Client({ transport: t });
    await client.connect();
    const board = await client.readExpansionBoard();
    expect(board).toEqual({ boardId: 48, boardRev: 4, specialRev: 2 });
    expect(client.imuGeneration).toBe('new');
    await client.inquiry();
    const [oc] = await stream(client, t, [SAMPLES[0].packet]);
    expect(axes(oc, 'MAG')).toEqual(SAMPLES[0].mag);
  });

  it('decodes an old-IMU board mag big-endian', async () => {
    // SR31-4-0: a Shimmer3 main board before the new-IMU revision 6.
    const t = device(hex('65031f0400'));
    const client = new Shimmer3Client({ transport: t });
    await client.connect();
    await client.readExpansionBoard();
    expect(client.imuGeneration).toBe('old');
    await client.inquiry();
    const [oc] = await stream(client, t, [oldImuPacket()]);
    expect(axes(oc, 'MAG')).toEqual(SAMPLES[0].mag);
    expect(axes(oc, 'GYRO')).toEqual(SAMPLES[0].gyro);
  });

  it('treats a blank id page as old-IMU, as the Java driver does', async () => {
    const t = device(hex('6503ffffff'));
    const client = new Shimmer3Client({ transport: t });
    await client.connect();
    expect(await client.readExpansionBoard()).toBeNull();
    expect(client.imuGeneration).toBe('old');
  });

  it('lets the imuGeneration option win over the board', async () => {
    const t = device(hex('65031f0400'));
    const client = new Shimmer3Client({ transport: t, imuGeneration: 'new' });
    await client.connect();
    await client.readExpansionBoard();
    expect(client.imuGeneration).toBe('new');
    expect(client.expansionBoard).toEqual({ boardId: 31, boardRev: 4, specialRev: 0 });
  });

  it('decodes big-endian mag when imuGeneration is old', async () => {
    const t = device();
    const client = new Shimmer3Client({ transport: t, imuGeneration: 'old' });
    await client.connect();
    await client.inquiry();
    const [oc] = await stream(client, t, [oldImuPacket()]);
    expect(axes(oc, 'MAG')).toEqual(SAMPLES[0].mag);
  });

  it('forgets the board at the next connect', async () => {
    const t = device(hex('65031f0400'));
    const client = new Shimmer3Client({ transport: t });
    await client.connect();
    await client.readExpansionBoard();
    expect(client.imuGeneration).toBe('old');
    await client.connect(device());
    expect(client.imuGeneration).toBeNull();
    expect(client.expansionBoard).toBeNull();
  });
});
