import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { interpretShimmer3InquiryResponse } from '../../src/devices/shimmer3/protocol.js';
import {
  getDefaultCalibration,
  type ImuFamily,
  type InertialGroup,
} from '../../src/devices/calibration/defaults.js';
import {
  calibrateVector3,
  generateKinematicCalibBlock,
  parseKinematicCalibBlock,
} from '../../src/devices/calibration/kinematic.js';
import { generateCalibDump, parseCalibDump } from '../../src/devices/calibration/dump.js';
import { SC_SENSOR } from '../../src/devices/calibration/sensorIds.js';
import type { StreamingImuRanges } from '../../src/devices/calibration/streaming.js';
import type { ObjectCluster } from '../../src/core/ObjectCluster.js';
import { HW, versionReply, type FwTuple } from './configFirmware.js';

// DEV-1515. `Shimmer3RClient` also drives a classic Shimmer3, and Shimmer
// Capture Web uses it for every Bluetooth sensor. Once DEV-1514 let a
// Shimmer3's inquiry through, two things were still the Shimmer3R's:
//
// - The config word's range bits. On a Shimmer3, ConfigSetupByte2 bits 5-7 are
//   the LSM303 mag's range, which the client stored as the Shimmer3R's alt mag,
//   and ConfigSetupByte3 bits 6-7 the MPU9x50 accel's, which it stored as a
//   low-noise accel range.
// - The IMU family. Default calibrations, and the sensor IDs that sort a
//   calibration dump into groups, were always the Shimmer3R's.
//
// A Shimmer3 now reads both as `Shimmer3Client` does: the ranges as
// `interpretShimmer3InquiryResponse` reads them, and the family from the
// board's IMU generation (`readSrBoard`). A Shimmer3R is read as before.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const NACK = OPCODES.NACK_COMMAND_PROCESSED; // 0xFE

const FW: FwTuple = [3, 1, 1, 5];

/**
 * One config word for both devices, with every inertial range bit the two
 * read differently set:
 * - byte 0 `0x08`: bits 2-3 = 2, the WR accel range on both.
 * - byte 2 `0xC1`: bits 0-1 = 1, the gyro range's low bits on both; bits 5-7
 *   = 6, the LSM303 mag's range on a Shimmer3 and the LIS3MDL alt mag's on a
 *   Shimmer3R.
 * - byte 3 `0xC8`: bits 1-3 = 4, GSR auto; bits 6-7 = 3, the MPU9x50 accel's
 *   range on a Shimmer3 and the LSM6DSV LN accel's on a Shimmer3R.
 * - byte 4 `0x04` (Shimmer3R only): bit 2, the gyro range's MSB.
 */
const S3_CONFIG = [0x08, 0x00, 0xc1, 0xc8];
const S3R_CONFIG = [...S3_CONFIG, 0x04, 0x00, 0x00];

/** LN accel, WR accel, mag and gyro, in the order the firmware sends them. */
const CHANNELS = [0x00, 0x01, 0x02, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c];

/** Boards: SR31-9-1 carries the new IMU, SR31-4-0 the old (`isNewImuSensors`). */
const NEW_IMU_BOARD: [number, number, number] = [31, 9, 1];
const OLD_IMU_BOARD: [number, number, number] = [31, 4, 0];

interface Device {
  name: string;
  hw: number;
  config: number[];
  /** The daughter-card id page; null is a blank (erased) page. */
  board: [number, number, number] | null;
  /** The whole inquiry reply, opcode included, when not built from `config` and {@link CHANNELS}. */
  inquiry?: number[];
}

const SHIMMER3_NEW: Device = {
  name: 'a new-IMU Shimmer3 (SR31-9-1)',
  hw: HW.SHIMMER3,
  config: S3_CONFIG,
  board: NEW_IMU_BOARD,
};
const SHIMMER3_OLD: Device = {
  name: 'an old-IMU Shimmer3 (SR31-4-0)',
  hw: HW.SHIMMER3,
  config: S3_CONFIG,
  board: OLD_IMU_BOARD,
};
const SHIMMER3_BLANK: Device = {
  name: 'a Shimmer3 with a blank id page',
  hw: HW.SHIMMER3,
  config: S3_CONFIG,
  board: null,
};
const SHIMMER3R: Device = {
  name: 'a Shimmer3R (SR48-8-2)',
  hw: HW.SHIMMER3R,
  config: S3R_CONFIG,
  board: [48, 8, 2],
};

const LINKS = [
  { name: 'BLE', framed: true },
  { name: 'a byte stream', framed: false },
] as const;
type Link = (typeof LINKS)[number];

const u24le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const i16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const i16be = (v: number): number[] => [(v >> 8) & 0xff, v & 0xff];

/** A data frame: 0x00 preamble, 24-bit little-endian timestamp, then payload. */
const frame = (ts: number, payload: number[]): number[] => [0x00, ...u24le(ts), ...payload];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

interface Sensor {
  client: Shimmer3RClient;
  status: string[];
  /** Deliver bytes as this link would: whole, or in 3-byte reads. */
  deliver(bytes: number[]): void;
}

/** `device` connected over `link`, answering what a connect and a stream need. */
async function sensor(
  device: Device,
  link: Link,
  clientOpts: { imuGeneration?: 'old' | 'new' } = {},
): Promise<Sensor> {
  const t = new LoopbackTransport({
    capabilities: link.framed ? {} : { framed: false },
    deviceName: link.framed ? 'Shimmer-BLE' : 'Shimmer-SPP',
  });
  const deliver = (bytes: number[]): void => {
    const step = link.framed ? bytes.length : 3;
    for (let i = 0; i < bytes.length; i += step) {
      const read = Uint8Array.from(bytes.slice(i, i + step));
      setTimeout(() => t.notify(read), 0);
    }
  };
  t.setOnWrite((bytes) => {
    const op = bytes[0];
    const version = versionReply(op, device.hw, FW);
    if (version) {
      deliver(version);
    } else if (op === OPCODES.INQUIRY_COMMAND) {
      deliver([
        ACK,
        ...(device.inquiry ?? [
          OPCODES.INQUIRY_RESPONSE,
          0x80,
          0x02,
          ...device.config,
          CHANNELS.length,
          1,
          ...CHANNELS,
        ]),
      ]);
    } else if (op === OPCODES.GET_DAUGHTER_CARD_ID_COMMAND) {
      const page = device.board ?? [0xff, 0xff, 0xff];
      deliver([ACK, OPCODES.DAUGHTER_CARD_ID_RESPONSE, 3, ...page]);
    } else if (
      op === OPCODES.START_STREAMING_COMMAND ||
      op === OPCODES.STOP_STREAMING_COMMAND ||
      op === OPCODES.SET_GYRO_RANGE_COMMAND
    ) {
      deliver([ACK]);
    } else {
      deliver([NACK]);
    }
  });
  const client = new Shimmer3RClient({ debug: false, transport: t, ...clientOpts });
  const status: string[] = [];
  client.onStatus = (m) => status.push(m);
  await client.connect();
  return { client, status, deliver };
}

/** As Shimmer Capture Web connects: the versions, the board, then the inquiry. */
async function identifyAndInquire(s: Sensor): Promise<void> {
  await s.client.readFwVersion();
  await s.client.readDeviceVersion();
  await s.client.readSrBoard();
  await s.client.inquiry();
}

/** Raw counts per group, as the frame below carries them. */
const RAW: Record<'lnAccel' | 'wrAccel' | 'mag' | 'gyro', [number, number, number]> = {
  lnAccel: [2100, 1900, 2300],
  wrAccel: [836, -418, 1671],
  mag: [330, -667, 295],
  gyro: [655, -131, 3280],
};

/**
 * One frame of {@link CHANNELS}, encoded as `device` sends it: LN and WR accel
 * little-endian; gyro big-endian on a Shimmer3; mag big-endian on an old-IMU
 * Shimmer3 only.
 */
function payloadFor(device: Device, oldImuMag: boolean): number[] {
  const gyro = device.hw === HW.SHIMMER3 ? i16be : i16le;
  const mag = oldImuMag ? i16be : i16le;
  return [
    ...RAW.lnAccel.flatMap(i16le),
    ...RAW.wrAccel.flatMap(i16le),
    ...RAW.mag.flatMap(mag),
    ...RAW.gyro.flatMap(gyro),
  ];
}

/** Stream three frames and return the first decoded one. */
async function streamOne(s: Sensor, payload: number[]): Promise<ObjectCluster> {
  const frames: ObjectCluster[] = [];
  s.client.onStreamFrame = (oc) => frames.push(oc);
  await s.client.startStreaming();
  // 640 ticks apart: the 51.2 Hz the inquiry declares, which the parser
  // checks its alignment against.
  s.deliver([...frame(640, payload), ...frame(1280, payload), ...frame(1920, payload)]);
  await tick();
  expect(frames.length).toBeGreaterThanOrEqual(1);
  return frames[0];
}

const AXES: Record<'lnAccel' | 'wrAccel' | 'mag' | 'gyro', string> = {
  lnAccel: 'LN_ACCEL',
  wrAccel: 'WR_ACCEL',
  mag: 'MAG',
  gyro: 'GYRO',
};

/** What `group` should calibrate to against `family`'s default at `range`. */
function expected(
  family: ImuFamily,
  group: InertialGroup & keyof typeof RAW,
  range: number,
): [number, number, number] {
  const def = getDefaultCalibration(family, group, range);
  if (!def) throw new Error(`no ${family} default for ${group}`);
  return calibrateVector3(RAW[group], def.calibration);
}

function calOf(oc: ObjectCluster, group: keyof typeof AXES): [number, number, number] {
  const p = AXES[group];
  return [
    oc.get(`${p}_X`, 'cal')!.value,
    oc.get(`${p}_Y`, 'cal')!.value,
    oc.get(`${p}_Z`, 'cal')!.value,
  ];
}

function expectClose(actual: number[], want: number[]): void {
  expect(actual).toHaveLength(want.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(want[i], 9));
}

/** What a Shimmer3's config word holds, as `Shimmer3Client` reads it. */
const SHIMMER3_RANGES: StreamingImuRanges = {
  lnAccel: 0,
  wrAccel: 2,
  gyro: 1,
  mag: 6,
  altAccel: 0,
  altMag: 0,
};

/** What a Shimmer3R's holds, exactly as this client always read it. */
const SHIMMER3R_RANGES: StreamingImuRanges = {
  lnAccel: 3,
  wrAccel: 2,
  gyro: 5,
  mag: 0,
  altAccel: 0,
  altMag: 6,
};

describe("the config word's ranges are read with the answering device's meanings", () => {
  for (const link of LINKS) {
    it(`a Shimmer3 over ${link.name}: LSM303 mag and fixed LN accel`, async () => {
      const s = await sensor(SHIMMER3_NEW, link);
      await identifyAndInquire(s);
      expect(s.client.imuRanges).toEqual(SHIMMER3_RANGES);
      expect(s.client.gsrRangeSetting).toBe(4);

      // The same bits `Shimmer3Client` reads, through its own parser.
      const info = interpretShimmer3InquiryResponse(
        Uint8Array.from([OPCODES.INQUIRY_RESPONSE, 0x80, 0x02, ...S3_CONFIG, 0, 1]),
      );
      expect([info.accelRange, info.gyroRange, info.magRange]).toEqual([
        s.client.imuRanges.wrAccel,
        s.client.imuRanges.gyro,
        s.client.imuRanges.mag,
      ]);
    });

    it(`a Shimmer3R over ${link.name}: unchanged`, async () => {
      const s = await sensor(SHIMMER3R, link);
      await identifyAndInquire(s);
      expect(s.client.imuRanges).toEqual(SHIMMER3R_RANGES);
      expect(s.client.gsrRangeSetting).toBe(4);
    });
  }
});

describe("inertial channels are calibrated against the device's own IMU", () => {
  const CASES: ReadonlyArray<{ device: Device; family: ImuFamily; oldImuMag: boolean }> = [
    { device: SHIMMER3_NEW, family: 'shimmer3-new', oldImuMag: false },
    { device: SHIMMER3_OLD, family: 'shimmer3-old', oldImuMag: true },
    { device: SHIMMER3_BLANK, family: 'shimmer3-old', oldImuMag: true },
    { device: SHIMMER3R, family: 'shimmer3r', oldImuMag: false },
  ];

  for (const { device, family, oldImuMag } of CASES) {
    for (const link of LINKS) {
      it(`${device.name} over ${link.name}: ${family} defaults`, async () => {
        const s = await sensor(device, link);
        await identifyAndInquire(s);
        const ranges = s.client.imuRanges;
        const oc = await streamOne(s, payloadFor(device, oldImuMag));

        // Raw first: an old IMU's mag arrives big-endian and is decoded so.
        expect(oc.get('MAG_X', 'raw')!.value).toBe(RAW.mag[0]);
        expect(oc.get('MAG_Y', 'raw')!.value).toBe(RAW.mag[1]);

        for (const group of ['lnAccel', 'wrAccel', 'mag', 'gyro'] as const) {
          expectClose(calOf(oc, group), expected(family, group, ranges[group]));
        }

        const info = s.client.calibrationInfo.inertial;
        expect(info.mag?.range).toBe(ranges.mag);
        expect(info.lnAccel?.range).toBe(ranges.lnAccel);
        if (device.hw === HW.SHIMMER3) {
          // Neither part exists on a Shimmer3, so neither is reported.
          expect(info.altAccel).toBeUndefined();
          expect(info.altMag).toBeUndefined();
          // And the numbers really are not the Shimmer3R's.
          expect(calOf(oc, 'mag')[0]).not.toBeCloseTo(expected('shimmer3r', 'mag', 0)[0], 3);
        } else {
          expect(info.altMag?.range).toBe(6);
        }
      });
    }
  }

  it('a gyro range set on a Shimmer3 picks its MPU9x50 default', async () => {
    const s = await sensor(SHIMMER3_NEW, LINKS[0]);
    await identifyAndInquire(s);
    await s.client.setGyroRange(3);
    const oc = await streamOne(s, payloadFor(SHIMMER3_NEW, false));
    expectClose(calOf(oc, 'gyro'), expected('shimmer3-new', 'gyro', 3));
  });
});

describe("a Shimmer3's IMU generation", () => {
  it('follows the board read, and the imuGeneration option wins over it', async () => {
    const read = await sensor(SHIMMER3_OLD, LINKS[0]);
    expect(read.client.imuGeneration).toBeNull();
    await identifyAndInquire(read);
    expect(read.client.imuGeneration).toBe('old');
    expect(read.status.join('\n')).toMatch(/SR board SR31-4-0 → old IMU/);

    const forced = await sensor(SHIMMER3_OLD, LINKS[0], { imuGeneration: 'new' });
    await identifyAndInquire(forced);
    expect(forced.client.imuGeneration).toBe('new');
    expect(forced.status.join('\n')).toMatch(/imuGeneration option 'new' kept/);
    const oc = await streamOne(forced, payloadFor(SHIMMER3_OLD, false));
    expectClose(calOf(oc, 'mag'), expected('shimmer3-new', 'mag', 6));
  });

  it('takes the old IMU defaults while the board is unread, as Shimmer3Client does', async () => {
    const s = await sensor(SHIMMER3_NEW, LINKS[1]);
    await s.client.readDeviceVersion();
    await s.client.inquiry();
    expect(s.client.imuGeneration).toBeNull();
    // Little-endian mag while unknown, so a skipped read never byte-swaps a new board.
    const oc = await streamOne(s, payloadFor(SHIMMER3_NEW, false));
    expect(oc.get('MAG_X', 'raw')!.value).toBe(RAW.mag[0]);
    expectClose(calOf(oc, 'wrAccel'), expected('shimmer3-old', 'wrAccel', 2));
  });

  it('does not need the board read after the version read', async () => {
    // Board before version: the generation is worked out when it is asked for.
    const s = await sensor(SHIMMER3_NEW, LINKS[0]);
    await s.client.readSrBoard();
    await s.client.readDeviceVersion();
    await s.client.inquiry();
    const oc = await streamOne(s, payloadFor(SHIMMER3_NEW, false));
    expectClose(calOf(oc, 'wrAccel'), expected('shimmer3-new', 'wrAccel', 2));
  });

  it('is forgotten when the client connects again', async () => {
    const s = await sensor(SHIMMER3_NEW, LINKS[0]);
    await identifyAndInquire(s);
    expect(s.client.imuGeneration).toBe('new');
    await s.client.disconnect();
    await s.client.connect();
    expect(s.client.imuGeneration).toBeNull();
  });
});

describe("a calibration dump is sorted by the device's own sensor IDs", () => {
  /** A Shimmer3 dump holding one LSM303 mag block, at mag range 6. */
  const shimmer3MagDump = (offset: [number, number, number]) => {
    const def = getDefaultCalibration('shimmer3-old', 'mag', 6)!;
    const bytes = generateKinematicCalibBlock(
      offset,
      def.calibration.sensitivity,
      def.calibration.alignment,
      { sensitivityScale: def.sensitivityScale },
    );
    return parseCalibDump(
      generateCalibDump(
        {
          hardwareId: HW.SHIMMER3,
          firmwareId: 3,
          firmwareMajor: 1,
          firmwareMinor: 1,
          firmwareInternal: 5,
        },
        [
          {
            sensorId: SC_SENSOR.LSM303_MAG,
            range: 6,
            calibLen: bytes.length,
            timestampTicks: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
            calibBytes: bytes,
            isDefault: false,
          },
        ],
      ),
    );
  };

  for (const link of LINKS) {
    it(`an old-IMU Shimmer3's mag block is adopted, over ${link.name}`, async () => {
      const s = await sensor(SHIMMER3_OLD, link);
      await identifyAndInquire(s);
      expect(s.client.applyCalibDump(shimmer3MagDump([10, 20, 30]))).toEqual(['mag']);
      expect(s.client.calibrationInfo.inertial.mag).toMatchObject({
        range: 6,
        source: 'radio-dump',
      });
    });
  }

  it('a dump adopted before the version read is sorted again once it lands', async () => {
    const s = await sensor(SHIMMER3_OLD, LINKS[0]);
    // Still taken for a Shimmer3R: the LSM303 mag ID names nothing there.
    expect(s.client.applyCalibDump(shimmer3MagDump([10, 20, 30]))).toEqual([]);

    await identifyAndInquire(s);
    expect(s.client.calibrationInfo.inertial.mag?.source).toBe('radio-dump');
    const oc = await streamOne(s, payloadFor(SHIMMER3_OLD, true));
    const def = getDefaultCalibration('shimmer3-old', 'mag', 6)!.calibration;
    expect(calOf(oc, 'mag')).not.toEqual(calibrateVector3(RAW.mag, def));
  });
});

describe('Shimmer3 A615, as the bench saw it through SDK 0.5.18 (20 Nov 2026)', () => {
  // A615: LogAndStream v1.01.009, RN4678 v1.23, board SR49-3-1 (a new IMU),
  // over Classic Bluetooth. Its inquiry reply as captured, and a calibration
  // dump laid out as its own was: 17 records, the Kionix LN accel at range 0,
  // the MPU9x50 gyro at 0-3, the LSM303 accel at 0-3 and the LSM303 mag at 0-7.
  // Through 0.5.18 the page logged "The calibration dump held no usable
  // inertial block", and streamed against the Shimmer3R's defaults.
  const hex = (s: string): number[] => s.split(' ').map((h) => parseInt(h, 16));
  const A615_CHANNELS = hex('00 01 02 03 0a 0b 0c 04 05 06 07 08 09 14 15 16 17 18 19 1a 1b');
  const A615: Device = {
    name: 'Shimmer3 A615',
    hw: HW.SHIMMER3,
    config: hex('00 06 0d 08'),
    board: [49, 3, 1],
    inquiry: hex('02 80 02 00 06 0d 08 15 01').concat(A615_CHANNELS),
  };

  const a615Dump = () => {
    const layout: Array<[number, InertialGroup, number[]]> = [
      [SC_SENSOR.ANALOG_ACCEL, 'lnAccel', [0]],
      [SC_SENSOR.MPU9X50_GYRO, 'gyro', [0, 1, 2, 3]],
      [SC_SENSOR.LSM303_ACCEL, 'wrAccel', [0, 1, 2, 3]],
      [SC_SENSOR.LSM303_MAG, 'mag', [0, 1, 2, 3, 4, 5, 6, 7]],
    ];
    const records = layout.flatMap(([sensorId, group, ranges]) =>
      ranges.map((range) => {
        const def = getDefaultCalibration('shimmer3-new', group, range)!;
        // A device's own offsets, so a block in force is told from a default.
        const calibBytes = generateKinematicCalibBlock(
          [range + 1, 2, 3],
          def.calibration.sensitivity,
          def.calibration.alignment,
          { sensitivityScale: def.sensitivityScale },
        );
        return {
          sensorId,
          range,
          calibLen: calibBytes.length,
          timestampTicks: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
          calibBytes,
          isDefault: false,
        };
      }),
    );
    expect(records).toHaveLength(17);
    return parseCalibDump(
      generateCalibDump(
        {
          hardwareId: HW.SHIMMER3,
          firmwareId: 3,
          firmwareMajor: 1,
          firmwareMinor: 1,
          firmwareInternal: 9,
        },
        records,
      ),
    );
  };

  for (const link of LINKS) {
    it(`reads its ranges, adopts its dump and leaves its MPU channels raw, over ${link.name}`, async () => {
      const s = await sensor(A615, link);
      await identifyAndInquire(s);
      expect(s.client.imuGeneration).toBe('new');
      // The ranges the page logged were right for this unit: its mag and MPU
      // accel bits happen to be 0, so both readings agree on them.
      expect(s.client.imuRanges).toEqual({
        lnAccel: 0,
        wrAccel: 0,
        gyro: 1,
        mag: 0,
        altAccel: 0,
        altMag: 0,
      });
      expect(s.client.gsrRangeSetting).toBe(4);

      expect(s.client.applyCalibDump(a615Dump()).sort()).toEqual([
        'gyro',
        'lnAccel',
        'mag',
        'wrAccel',
      ]);
      const info = s.client.calibrationInfo.inertial;
      expect(Object.keys(info).sort()).toEqual(['gyro', 'lnAccel', 'mag', 'wrAccel']);
      for (const group of ['lnAccel', 'wrAccel', 'gyro', 'mag'] as const) {
        expect(info[group]?.source).toBe('radio-dump');
      }

      // One frame of its 21 channels: LN accel, battery, gyro (big-endian),
      // WR accel, mag, the MPU9x50 accel (0x14-0x16, big-endian) and mag
      // (0x17-0x19), then temperature (2 bytes) and pressure (3), big-endian.
      const payload = [
        ...RAW.lnAccel.flatMap(i16le),
        ...i16le(2900),
        ...RAW.gyro.flatMap(i16be),
        ...RAW.wrAccel.flatMap(i16le),
        ...RAW.mag.flatMap(i16le),
        ...[100, 200, 300].flatMap(i16be),
        ...[10, 20, 30].flatMap(i16le),
        0x12,
        0x34,
        0x01,
        0x02,
        0x03,
      ];
      const oc = await streamOne(s, payload);
      expect(oc.get('MAG_X', 'raw')!.value).toBe(RAW.mag[0]);
      expect(calOf(oc, 'mag')).not.toEqual(expected('shimmer3-new', 'mag', 0));
      // A Shimmer3's MPU9x50 accel and mag are not the Shimmer3R's ADXL371 and
      // LIS3MDL, whose calibrations 0.5.18 put on them. Neither client has a
      // calibration for them, so they stream raw, as from Shimmer3Client.
      expect(oc.get('HG_ACCEL_X', 'raw')!.value).toBe(100);
      expect(oc.get('HG_ACCEL_X', 'cal')).toBeNull();
      expect(oc.get('ALT_MAG_X', 'raw')!.value).toBe(10);
      expect(oc.get('ALT_MAG_X', 'cal')).toBeNull();
    });
  }
});

describe('a Shimmer3 whose LN accel record is the pre-2025 default (DEV-1528)', () => {
  // Firmware before DEV-4 (Feb 2025) wrote 2253/92, the KXTC9-2050's 3.3 V
  // figures, into a new-IMU Shimmer3's own record; the part runs at 3.0 V, so
  // the record reads about 17 % high. The client keeps it in force - nothing
  // a customer gets out changes on an update - and says so, once per link.
  const KIONIX_ALIGN = [0, -1, 0, -1, 0, 0, 0, 0, -1];
  const STALE = 'pre-2025 default calibration (offset 2253, sensitivity 92)';

  /** A dump holding one LN accel record per range, `offset`/`sensitivity` on every axis. */
  const lnAccelDump = (
    hw: number,
    sensorId: number,
    ranges: number[],
    offset: number,
    sensitivity: number,
    sensitivityScale = 1,
  ) =>
    parseCalibDump(
      generateCalibDump(
        { hardwareId: hw, firmwareId: 3, firmwareMajor: 1, firmwareMinor: 1, firmwareInternal: 9 },
        ranges.map((range) => {
          const calibBytes = generateKinematicCalibBlock(
            [offset, offset, offset],
            [sensitivity, sensitivity, sensitivity],
            KIONIX_ALIGN,
            { sensitivityScale },
          );
          return {
            sensorId,
            range,
            calibLen: calibBytes.length,
            timestampTicks: new Uint8Array(8),
            calibBytes,
            isDefault: false,
          };
        }),
      ),
    );
  const staleShimmer3 = () => lnAccelDump(HW.SHIMMER3, SC_SENSOR.ANALOG_ACCEL, [0], 2253, 92);
  const warnings = (s: Sensor) => s.status.filter((m) => m.includes(STALE)).length;

  for (const link of LINKS) {
    it(`warns once and streams with the record unchanged, over ${link.name}`, async () => {
      const s = await sensor(SHIMMER3_NEW, link);
      await identifyAndInquire(s);
      expect(s.client.applyCalibDump(staleShimmer3())).toEqual(['lnAccel']);
      expect(warnings(s)).toBe(1);
      expect(s.client.calibrationInfo.inertial.lnAccel).toMatchObject({
        source: 'radio-dump',
        staleDefault: true,
      });

      const oc = await streamOne(s, payloadFor(SHIMMER3_NEW, false));
      expectClose(
        calOf(oc, 'lnAccel'),
        calibrateVector3(
          RAW.lnAccel,
          parseKinematicCalibBlock(
            generateKinematicCalibBlock([2253, 2253, 2253], [92, 92, 92], KIONIX_ALIGN),
          )!,
        ),
      );
      // Not the 2047/83 default: the stale record really is the one in force.
      expect(calOf(oc, 'lnAccel')).not.toEqual(expected('shimmer3-new', 'lnAccel', 0));
      // The stream and its stop re-pick nothing that warns again.
      expect(warnings(s)).toBe(1);
    });
  }

  it('warns once the version read shows a dump adopted before it is a Shimmer3', async () => {
    const s = await sensor(SHIMMER3_NEW, LINKS[0]);
    s.client.applyCalibDump(staleShimmer3());
    expect(warnings(s)).toBe(0);
    await identifyAndInquire(s);
    expect(warnings(s)).toBe(1);
    expect(s.client.calibrationInfo.inertial.lnAccel?.staleDefault).toBe(true);
  });

  it('warns again on the next connect', async () => {
    const s = await sensor(SHIMMER3_NEW, LINKS[0]);
    await identifyAndInquire(s);
    s.client.applyCalibDump(staleShimmer3());
    await s.client.disconnect();
    await s.client.connect();
    await identifyAndInquire(s);
    s.client.applyCalibDump(staleShimmer3());
    expect(warnings(s)).toBe(2);
  });

  it('says nothing of a 2047/83 record', async () => {
    const s = await sensor(SHIMMER3_NEW, LINKS[0]);
    await identifyAndInquire(s);
    s.client.applyCalibDump(lnAccelDump(HW.SHIMMER3, SC_SENSOR.ANALOG_ACCEL, [0], 2047, 83));
    expect(warnings(s)).toBe(0);
    expect(s.client.calibrationInfo.inertial.lnAccel?.staleDefault).toBe(false);
  });

  it('says nothing of the same numbers on a Shimmer3R, whose LN accel is not a KXTC9', async () => {
    const s = await sensor(SHIMMER3R, LINKS[0]);
    await identifyAndInquire(s);
    const def = getDefaultCalibration('shimmer3r', 'lnAccel', 0)!;
    const adopted = s.client.applyCalibDump(
      lnAccelDump(
        HW.SHIMMER3R,
        SC_SENSOR.LSM6DSV_ACCEL,
        [0, 1, 2, 3],
        2253,
        92,
        def.sensitivityScale,
      ),
    );
    expect(adopted).toEqual(['lnAccel']);
    expect(warnings(s)).toBe(0);
    expect(s.client.calibrationInfo.inertial.lnAccel?.staleDefault).toBe(false);
  });
});
