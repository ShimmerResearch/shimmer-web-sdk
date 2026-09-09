import { describe, expect, it } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { generateCalibDump } from '../../src/devices/calibration/dump.js';
import { generateKinematicCalibBlock } from '../../src/devices/calibration/kinematic.js';
import { getDefaultCalibration } from '../../src/devices/calibration/defaults.js';
import { SC_SENSOR } from '../../src/devices/calibration/sensorIds.js';
import type { ObjectCluster } from '../../src/core/ObjectCluster.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
/** The firmware's refusal byte. */
const NACK = OPCODES.NACK_COMMAND_PROCESSED;
const INQ_RSP = OPCODES.INQUIRY_RESPONSE;

const BMP390_COEFFS = [
  0xe7, 0x6b, 0xf0, 0x4a, 0xf9, 0xab, 0x1c, 0x9b, 0x15, 0x06, 0x01, 0xd2, 0x49, 0x18, 0x5f, 0x03,
  0xfa, 0x3a, 0x0f, 0x07, 0xf5,
];

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

const u24le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const u16le = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];

/**
 * A Shimmer3R inquiry response.
 *
 * `[0x02][divider u16 LE][7 config bytes][nCh][bufSize][ids…]`, which is the
 * layout `_interpretInquiryResponseShimmer3R` reads. 0x80 0x02 is a divider of
 * 640, i.e. 51.2 Hz — the rate the frame spacing below has to match for the
 * parser to confirm its alignment.
 */
const inquiry = (channelIds: number[], config: number[] = [0, 0, 0, 0, 0, 0, 0]): number[] => [
  INQ_RSP,
  0x80,
  0x02,
  ...config,
  channelIds.length,
  1,
  ...channelIds,
];

interface DeviceOpts {
  channelIds: number[];
  config?: number[];
  /** How the scripted firmware answers 0xA7. */
  pressure?: { sensorId: number; coeffs: number[] } | 'nack' | 'silent';
  /** Per-chip ExG banks the scripted GET_EXG_REGS returns. */
  exg?: { exg1: number[]; exg2: number[] };
  calibDump?: Uint8Array;
}

/** A loopback device that answers just enough to get a stream running. */
function scriptedDevice(opts: DeviceOpts): LoopbackTransport {
  const t = new LoopbackTransport();
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    const reply = (data: number[]) => setTimeout(() => tr.notify(data), 0);
    switch (op) {
      case OPCODES.INQUIRY_COMMAND:
        reply([ACK, ...inquiry(opts.channelIds, opts.config)]);
        break;
      case OPCODES.START_STREAMING_COMMAND:
      case OPCODES.STOP_STREAMING_COMMAND:
        reply([ACK]);
        break;
      case OPCODES.GET_PRESSURE_CALIBRATION_COEFFICIENTS_COMMAND: {
        const p = opts.pressure;
        if (!p || p === 'silent') break;
        if (p === 'nack') {
          reply([NACK]);
          break;
        }
        reply([
          ACK,
          OPCODES.PRESSURE_CALIBRATION_COEFFICIENTS_RESPONSE,
          1 + p.coeffs.length,
          p.sensorId,
          ...p.coeffs,
        ]);
        break;
      }
      case OPCODES.GET_EXG_REGS_COMMAND: {
        const chip = bytes[1];
        const bank = chip === 0 ? opts.exg?.exg1 : opts.exg?.exg2;
        if (!bank) {
          reply([NACK]);
          break;
        }
        reply([ACK, OPCODES.EXG_REGS_RESPONSE, bank.length, ...bank]);
        break;
      }
      case OPCODES.SET_MAG_GAIN_COMMAND:
      case OPCODES.SET_GYRO_RANGE_COMMAND:
      case OPCODES.SET_WR_ACCEL_RANGE_COMMAND:
        reply([ACK]);
        break;
      default:
        break;
    }
  });
  return t;
}

async function connectAndStream(
  t: LoopbackTransport,
  frames: number[][],
  clientOpts: Record<string, unknown> = {},
  before?: (c: Shimmer3RClient) => Promise<void>,
): Promise<{ client: Shimmer3RClient; received: ObjectCluster[] }> {
  const client = new Shimmer3RClient({ transport: t, ...clientOpts });
  const received: ObjectCluster[] = [];
  client.onStreamFrame = (oc) => received.push(oc);
  await client.connect();
  await client.inquiry();
  if (before) await before(client);
  await client.startStreaming();
  for (const f of frames) t.notify(f);
  await tick();
  return { client, received };
}

/** `[0x00][ts u24 LE][payload…]` */
const frame = (ts: number, payload: number[]): number[] => [0x00, ...u24le(ts), ...payload];

describe('Shimmer3RClient — calibrated channels end to end', () => {
  it('streams battery, an ADC line and PPG in millivolts', async () => {
    // 0x03 BATTERY, 0x0d EXT_ADC_0, 0x12 PPG — all 2 bytes little-endian.
    const t = scriptedDevice({ channelIds: [0x03, 0x0d, 0x12] });
    const payload = [...u16le(2048), ...u16le(2048), ...u16le(2048)];
    const { received } = await connectAndStream(t, [
      frame(640, payload),
      frame(1280, payload),
      frame(1920, payload),
    ]);
    expect(received.length).toBeGreaterThanOrEqual(1);
    const oc = received[0];

    expect(oc.get('BATTERY', 'raw')!.value).toBe(2048);
    expect(oc.get('BATTERY', 'raw')!.unit).toBe('no_units');
    expect(oc.get('BATTERY', 'cal')!.value).toBeCloseTo(3000.7326007, 6);
    expect(oc.get('BATTERY', 'cal')!.unit).toBe('mV');
    expect(oc.get('EXT_ADC_0', 'cal')!.value).toBeCloseTo(1500.3663004, 6);
    expect(oc.get('PPG', 'cal')!.value).toBeCloseTo(1500.3663004, 6);
  });

  it('streams pressure and temperature in kPa and °C once 0xA7 has answered', async () => {
    // 0x1b PRESSURE then 0x1a TEMPERATURE, both u24 LE on a Shimmer3R.
    const t = scriptedDevice({
      channelIds: [0x1b, 0x1a],
      pressure: { sensorId: 2, coeffs: BMP390_COEFFS },
    });
    const payload = [...u24le(0x640d00), ...u24le(0x7fba00)];
    const { client, received } = await connectAndStream(
      t,
      [frame(640, payload), frame(1280, payload)],
      {},
      async (c) => {
        const cal = await c.readPressureCalibration();
        expect(cal?.sensor).toBe('bmp390');
        expect(cal?.calibrated).toBe(true);
      },
    );
    const oc = received[0];
    expect(oc.get('PRESSURE', 'cal')!.value).toBeCloseTo(100.9118245, 6);
    expect(oc.get('PRESSURE', 'cal')!.unit).toBe('kPa');
    expect(oc.get('TEMPERATURE', 'cal')!.value).toBeCloseTo(23.1701699, 6);
    expect(oc.get('TEMPERATURE', 'cal')!.unit).toBe('Degrees Celsius');
    expect(client.calibrationInfo.pressure).toEqual({
      sensor: 'bmp390',
      calibrated: true,
      oversampling: 0,
    });
  });

  it('accepts a BMP581 answering with its id and no coefficients', async () => {
    const t = scriptedDevice({
      channelIds: [0x1b, 0x1a],
      pressure: { sensorId: 3, coeffs: [] },
    });
    const payload = [...u24le(6400000), ...u24le(1638400)];
    const { client, received } = await connectAndStream(
      t,
      [frame(640, payload), frame(1280, payload), frame(1920, payload)],
      {},
      async (c) => {
        const cal = await c.readPressureCalibration();
        expect(cal?.sensor).toBe('bmp581');
        // No coefficients is a SUCCESS for this part, not a refusal.
        expect(cal?.calibrated).toBe(true);
        expect(cal?.coefficients).toBeNull();
      },
    );
    expect(received[0].get('PRESSURE', 'cal')!.value).toBe(100);
    expect(received[0].get('TEMPERATURE', 'cal')!.value).toBe(25);
    expect(client.pressureCalibration?.sensor).toBe('bmp581');
  });

  it('streams pressure raw-only when the firmware NACKs 0xA7', async () => {
    const t = scriptedDevice({ channelIds: [0x1b, 0x1a], pressure: 'nack' });
    const status: string[] = [];
    const payload = [...u24le(0x640d00), ...u24le(0x7fba00)];
    const { client, received } = await connectAndStream(
      t,
      [frame(640, payload), frame(1280, payload), frame(1920, payload)],
      {},
      async (c) => {
        c.onStatus = (m) => status.push(m);
        // A refusal is not an error: null, and a status line saying why.
        expect(await c.readPressureCalibration(200)).toBeNull();
      },
    );
    expect(status.join(' ')).toMatch(/stream raw-only/);
    expect(received[0].get('PRESSURE', 'raw')!.value).toBe(0x640d00);
    expect(received[0].get('PRESSURE', 'cal')).toBeNull();
    expect(received[0].get('TEMPERATURE', 'cal')).toBeNull();
    expect(client.calibrationInfo.pressure.calibrated).toBe(false);
  });

  it('streams pressure raw-only when the firmware does not answer at all', async () => {
    const t = scriptedDevice({ channelIds: [0x1b, 0x1a], pressure: 'silent' });
    const payload = [...u24le(0x640d00), ...u24le(0x7fba00)];
    const { received } = await connectAndStream(
      t,
      [frame(640, payload), frame(1280, payload), frame(1920, payload)],
      {},
      async (c) => {
        expect(await c.readPressureCalibration(150)).toBeNull();
      },
    );
    expect(received[0].get('PRESSURE', 'cal')).toBeNull();
  });

  it('converts ExG against the banks it read, and the defaults before that', async () => {
    // Bank byte 3 bits 4-6 = ch1 gain; setting 6 is gain 12.
    const exg1 = new Array(10).fill(0);
    exg1[3] = 6 << 4;
    const t = scriptedDevice({
      channelIds: [0x1d, 0x1e, 0x1f],
      exg: { exg1, exg2: new Array(10).fill(0) },
    });
    // Exg1_Status u8, then two i24 BIG-endian channels.
    const be24 = (v: number): number[] => [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
    const payload = [0x2c, ...be24(1_000_000), ...be24(1_000_000)];

    // Before readExgConfig: the chip defaults (gain 6, 2.42 V).
    const first = await connectAndStream(t, [
      frame(640, payload),
      frame(1280, payload),
      frame(1920, payload),
    ]);
    expect(first.received[0].get('Exg1_CH1_24Bit', 'cal')!.value).toBeCloseTo(48.0810859, 6);
    expect(first.client.calibrationInfo.exg.source).toBe('default');
    expect(first.client.exgBanks).toBeNull();
    await first.client.stopStreaming();

    // After it: gain 12, so half the millivolts for the same counts.
    const t2 = scriptedDevice({
      channelIds: [0x1d, 0x1e, 0x1f],
      exg: { exg1, exg2: new Array(10).fill(0) },
    });
    const second = await connectAndStream(
      t2,
      [frame(640, payload), frame(1280, payload), frame(1920, payload)],
      {},
      async (c) => {
        const banks = await c.readExgConfig();
        expect(banks.exg1[3]).toBe(6 << 4);
      },
    );
    expect(second.received[0].get('Exg1_CH1_24Bit', 'cal')!.value).toBeCloseTo(24.040543, 6);
    expect(second.client.calibrationInfo.exg.source).toBe('device');
    expect(second.client.calibrationInfo.exg.chip1.gainCh1).toBe(12);
    // Chip 2's bank is all zeroes, so it keeps gain 6.
    expect(second.client.calibrationInfo.exg.chip2.gainCh1).toBe(6);
  });

  it('reads the alt-mag range from the inquiry, and honours a change to it', async () => {
    // ConfigSetupByte2 bits 5-7 = alt-mag range. Setting 1 (±8 Ga) → the
    // LIS3MDL's 3421 LSB/gauss rather than range 0's 6842.
    const config = [0, 0, 1 << 5, 0, 0, 0, 0];
    const t = scriptedDevice({ channelIds: [0x17, 0x18, 0x19], config });
    const payload = [...u16le(3421), ...u16le(3421), ...u16le(3421)];
    const { client, received } = await connectAndStream(t, [
      frame(640, payload),
      frame(1280, payload),
      frame(1920, payload),
    ]);
    expect(client.imuRanges.altMag).toBe(1);
    // At 3421 LSB/gauss the raw 3421 is one gauss, and the LIS3MDL's alignment
    // is [1,0,0, 0,-1,0, 0,0,-1] — so Y and Z invert and X does not. Had the
    // client kept its old hard-coded range 0, the sensitivity would have been
    // 6842 and every axis would read half this.
    expect(received[0].get('ALT_MAG_X', 'cal')!.value).toBeCloseTo(1, 6);
    expect(received[0].get('ALT_MAG_Y', 'cal')!.value).toBeCloseTo(-1, 6);
    expect(received[0].get('ALT_MAG_Z', 'cal')!.value).toBeCloseTo(-1, 6);
    expect(received[0].get('ALT_MAG_X', 'cal')!.unit).toBe('local_flux');

    await client.setAltMagRange(2);
    expect(client.imuRanges.altMag).toBe(2);
    expect(client.calibrationInfo.inertial.altMag?.range).toBe(2);
  });

  it('rejects an out-of-range alt-mag setting', async () => {
    const t = scriptedDevice({ channelIds: [0x17, 0x18, 0x19] });
    const client = new Shimmer3RClient({ transport: t });
    await client.connect();
    await expect(client.setAltMagRange(4)).rejects.toThrow(/0–3/);
  });

  it('reads the pressure oversampling out of the inquiry', async () => {
    // ConfigSetupByte3 bits 4-5 = the low two bits, ConfigSetupByte4 bit 0 the MSB.
    const config = [0, 0, 0, 2 << 4, 1, 0, 0];
    const t = scriptedDevice({ channelIds: [0x1b, 0x1a], config });
    const client = new Shimmer3RClient({ transport: t });
    await client.connect();
    await client.inquiry();
    expect(client.pressureOversampling).toBe(2 | (1 << 2));
  });
});

describe('Shimmer3RClient — calibration provenance', () => {
  const dumpFor = (group: 'gyro', range: number, offset: [number, number, number]): Uint8Array => {
    const defaults = getDefaultCalibration('shimmer3r', group, range)!;
    const bytes = generateKinematicCalibBlock(
      offset,
      defaults.calibration.sensitivity,
      defaults.calibration.alignment,
      { sensitivityScale: defaults.sensitivityScale },
    );
    return generateCalibDump(
      {
        hardwareId: 10,
        firmwareId: 3,
        firmwareMajor: 1,
        firmwareMinor: 1,
        firmwareInternal: 12,
      },
      [
        {
          sensorId: SC_SENSOR.LSM6DSV_GYRO,
          range,
          calibLen: bytes.length,
          timestampTicks: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]),
          calibBytes: bytes,
          isDefault: false,
        },
      ],
    );
  };

  it('reports `default` until something has been read', async () => {
    const t = scriptedDevice({ channelIds: [0x0a, 0x0b, 0x0c] });
    const client = new Shimmer3RClient({ transport: t });
    await client.connect();
    await client.inquiry();
    const info = client.calibrationInfo;
    expect(info.inertial.gyro).toEqual({
      range: 0,
      source: 'default',
      usingDefaultCalibration: true,
      unit: 'deg/s',
    });
    expect(info.adc).toEqual({ vrefVolts: 3, bits: 12 });
    expect(info.gsr).toEqual({ range: 0 });
  });

  it('follows a dump once adopted, and only at the range it covers', async () => {
    const t = scriptedDevice({ channelIds: [0x0a, 0x0b, 0x0c] });
    const client = new Shimmer3RClient({ transport: t });
    await client.connect();
    await client.inquiry();

    // A dump carrying gyro range 2 only. The configured range is 0, so nothing
    // changes for streaming yet — but the block is kept.
    const { parseCalibDump } = await import('../../src/devices/calibration/dump.js');
    const groups = client.applyCalibDump(parseCalibDump(dumpFor('gyro', 2, [7, 8, 9])));
    expect(groups).toEqual(['gyro']);
    expect(client.calibrationInfo.inertial.gyro?.source).toBe('default');

    // Move to range 2 and it applies, with no second read.
    await client.setGyroRange(2);
    expect(client.calibrationInfo.inertial.gyro).toEqual({
      range: 2,
      source: 'radio-dump',
      usingDefaultCalibration: false,
      unit: 'deg/s',
    });
  });

  it('says so when a dump holds nothing usable', async () => {
    const t = scriptedDevice({ channelIds: [0x0a, 0x0b, 0x0c] });
    const client = new Shimmer3RClient({ transport: t });
    const status: string[] = [];
    client.onStatus = (m) => status.push(m);
    await client.connect();
    await client.inquiry();
    const { parseCalibDump } = await import('../../src/devices/calibration/dump.js');
    expect(client.applyCalibDump(parseCalibDump(new Uint8Array(64)))).toEqual([]);
    expect(status.join(' ')).toMatch(/no usable inertial block/);
  });

  it('forgets everything read off the device when the link ends', async () => {
    const t = scriptedDevice({
      channelIds: [0x1b, 0x1a],
      pressure: { sensorId: 2, coeffs: BMP390_COEFFS },
      exg: { exg1: new Array(10).fill(0), exg2: new Array(10).fill(0) },
    });
    const client = new Shimmer3RClient({ transport: t });
    await client.connect();
    await client.inquiry();
    await client.readPressureCalibration();
    await client.readExgConfig();
    expect(client.pressureCalibration).not.toBeNull();
    expect(client.exgBanks).not.toBeNull();

    await client.disconnect();
    // A calibration belongs to the device that answered.
    expect(client.pressureCalibration).toBeNull();
    expect(client.exgBanks).toBeNull();
    expect(client.calibrationInfo.exg.source).toBe('default');
  });
});
