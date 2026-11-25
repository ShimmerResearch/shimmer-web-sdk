import { describe, it, expect } from 'vitest';
import {
  STALE_KXTC9_DEFAULT_OFFSET,
  STALE_KXTC9_DEFAULT_SENSITIVITY,
  STALE_LN_ACCEL_DEFAULT_WARNING,
  isStaleKxtc9DefaultCalibration,
  generateKinematicCalibBlock,
  parseKinematicCalibBlock,
  getDefaultCalibration,
  parseCalibDump,
  generateCalibDump,
} from '../../src/index.js';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { SC_SENSOR } from '../../src/devices/calibration/sensorIds.js';

// DEV-1528 (rule agreed on DEV-1521). Firmware before DEV-4 (Feb 2025) wrote
// offset 2253 and sensitivity 92 - the KXTC9-2050's 3.3 V figures - into a
// new-IMU Shimmer3's own default calibration record. Every Shimmer3 runs the
// part at 3.0 V, so that record reads about 17 % high. A host keeps using it,
// unchanged, and says so: these are the rule and Shimmer3Client's side of it.

const KIONIX_ALIGN = [0, -1, 0, -1, 0, 0, 0, 0, -1];
const stale = {
  offset: [2253, 2253, 2253] as [number, number, number],
  sensitivity: [92, 92, 92] as [number, number, number],
  alignment: KIONIX_ALIGN,
};

describe('isStaleKxtc9DefaultCalibration', () => {
  it('matches the pre-2025 KXTC9-2050 default exactly', () => {
    expect(STALE_KXTC9_DEFAULT_OFFSET).toBe(2253);
    expect(STALE_KXTC9_DEFAULT_SENSITIVITY).toBe(92);
    expect(isStaleKxtc9DefaultCalibration(stale)).toBe(true);
  });

  it('matches the record as a calibration block decodes it', () => {
    const block = generateKinematicCalibBlock(stale.offset, stale.sensitivity, stale.alignment);
    expect(isStaleKxtc9DefaultCalibration(parseKinematicCalibBlock(block))).toBe(true);
  });

  it("carries the Kionix default alignment, the SDK's own", () => {
    const def = getDefaultCalibration('shimmer3-new', 'lnAccel', 0)!;
    expect(def.calibration.alignment).toEqual(KIONIX_ALIGN);
  });

  it("leaves today's 2047/83 default alone", () => {
    const def = getDefaultCalibration('shimmer3-new', 'lnAccel', 0)!.calibration;
    expect(def.offset).toEqual([2047, 2047, 2047]);
    expect(def.sensitivity).toEqual([83, 83, 83]);
    expect(isStaleKxtc9DefaultCalibration(def)).toBe(false);
  });

  it('leaves a real calibration alone', () => {
    expect(
      isStaleKxtc9DefaultCalibration({
        offset: [2251, 2260, 2249],
        sensitivity: [92, 91.5, 93],
        alignment: KIONIX_ALIGN,
      }),
    ).toBe(false);
    // One axis off is enough.
    expect(isStaleKxtc9DefaultCalibration({ ...stale, offset: [2253, 2253, 2254] })).toBe(false);
    expect(isStaleKxtc9DefaultCalibration({ ...stale, sensitivity: [92, 92, 91] })).toBe(false);
  });

  it('needs the default alignment too', () => {
    expect(
      isStaleKxtc9DefaultCalibration({ ...stale, alignment: [1, 0, 0, 0, 1, 0, 0, 0, 1] }),
    ).toBe(false);
  });

  it('is false for nothing at all', () => {
    expect(isStaleKxtc9DefaultCalibration(null)).toBe(false);
    expect(isStaleKxtc9DefaultCalibration(undefined)).toBe(false);
  });

  it('warns in the agreed words', () => {
    expect(STALE_LN_ACCEL_DEFAULT_WARNING).toBe(
      "This sensor's low-noise accelerometer still has the pre-2025 default calibration " +
        '(offset 2253, sensitivity 92), which reads about 17 % high on a Shimmer3. Raw data ' +
        'is unaffected. Recalibrate the low-noise accelerometer in Consensys to correct it.',
    );
  });
});

/** A Shimmer3 dump holding one LN accel record at range 0. */
function lnAccelDump(
  offset: [number, number, number],
  sensitivity: [number, number, number],
): ReturnType<typeof parseCalibDump> {
  const bytes = generateKinematicCalibBlock(offset, sensitivity, KIONIX_ALIGN);
  return parseCalibDump(
    generateCalibDump(
      { hardwareId: 3, firmwareId: 3, firmwareMajor: 1, firmwareMinor: 1, firmwareInternal: 9 },
      [
        {
          sensorId: SC_SENSOR.ANALOG_ACCEL,
          range: 0,
          calibLen: bytes.length,
          timestampTicks: new Uint8Array(8), // the firmware's "seeded by me" stamp
          calibBytes: bytes,
          isDefault: false,
        },
      ],
    ),
  );
}

async function connectedShimmer3(): Promise<{ client: Shimmer3Client; status: string[] }> {
  const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
  t.setOnWrite((bytes, tr) => {
    const op = bytes[0];
    if (op === OPCODES.GET_DEVICE_VERSION_COMMAND)
      setTimeout(() => tr.notify([OPCODES.DEVICE_VERSION_RESPONSE, 3]), 0);
    else if (op === OPCODES.GET_FW_VERSION_COMMAND)
      setTimeout(() => tr.notify([OPCODES.FW_VERSION_RESPONSE, 3, 0, 1, 0, 1, 9]), 0);
  });
  const client = new Shimmer3Client({ transport: t });
  const status: string[] = [];
  client.onStatus = (m) => status.push(m);
  await client.connect();
  return { client, status };
}

const warnings = (status: string[]): number =>
  status.filter((m) => m === STALE_LN_ACCEL_DEFAULT_WARNING).length;

describe('Shimmer3Client: a stale LN accel record (DEV-1528)', () => {
  it('warns once, flags it, and keeps it in force', async () => {
    const { client, status } = await connectedShimmer3();
    expect(client.applyCalibDump(lnAccelDump([2253, 2253, 2253], [92, 92, 92]))).toContain(
      'lnAccel',
    );
    expect(warnings(status)).toBe(1);
    const info = client.calibrationInfo.inertial.lnAccel!;
    expect(info).toMatchObject({ source: 'radio-dump', staleDefault: true });

    // Re-picking the calibration, here by adopting the same dump again, does
    // not warn a second time on this link.
    client.applyCalibDump(lnAccelDump([2253, 2253, 2253], [92, 92, 92]));
    expect(warnings(status)).toBe(1);
  });

  it('says nothing about a 2047/83 record or a real calibration', async () => {
    for (const [offset, sens] of [
      [
        [2047, 2047, 2047],
        [83, 83, 83],
      ],
      [
        [2051, 2040, 2049],
        [84, 82, 83],
      ],
    ] as [[number, number, number], [number, number, number]][]) {
      const { client, status } = await connectedShimmer3();
      client.applyCalibDump(lnAccelDump(offset, sens));
      expect(warnings(status)).toBe(0);
      expect(client.calibrationInfo.inertial.lnAccel!.staleDefault).toBe(false);
    }
  });

  it('warns for the record the per-sensor GET returns too', async () => {
    const stale = generateKinematicCalibBlock([2253, 2253, 2253], [92, 92, 92], KIONIX_ALIGN);
    const other = generateKinematicCalibBlock([1, 2, 3], [100, 100, 100], KIONIX_ALIGN);
    const gets: Record<number, [number, Uint8Array]> = {
      [OPCODES.GET_LN_ACCEL_CALIBRATION_COMMAND]: [OPCODES.LN_ACCEL_CALIBRATION_RESPONSE, stale],
      [OPCODES.GET_GYRO_CALIBRATION_COMMAND]: [OPCODES.GYRO_CALIBRATION_RESPONSE, other],
      [OPCODES.GET_MAG_CALIBRATION_COMMAND]: [OPCODES.MAG_CALIBRATION_RESPONSE, other],
      [OPCODES.GET_WR_ACCEL_CALIBRATION_COMMAND]: [OPCODES.WR_ACCEL_CALIBRATION_RESPONSE, other],
    };
    const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      const reply =
        op === OPCODES.GET_DEVICE_VERSION_COMMAND
          ? [OPCODES.DEVICE_VERSION_RESPONSE, 3]
          : op === OPCODES.GET_FW_VERSION_COMMAND
            ? [OPCODES.FW_VERSION_RESPONSE, 3, 0, 1, 0, 1, 9]
            : gets[op]
              ? [OPCODES.ACK_COMMAND_PROCESSED, gets[op][0], ...gets[op][1]]
              : null;
      if (reply) setTimeout(() => tr.notify(reply), 0);
    });
    const client = new Shimmer3Client({ transport: t });
    const status: string[] = [];
    client.onStatus = (m) => status.push(m);
    await client.connect();

    expect(await client.readCalibration()).toContain('lnAccel');
    expect(warnings(status)).toBe(1);
    expect(client.calibrationInfo.inertial.lnAccel).toMatchObject({
      source: 'bt-command',
      staleDefault: true,
    });
  });

  it('flags only the low-noise accel', async () => {
    const { client } = await connectedShimmer3();
    client.applyCalibDump(lnAccelDump([2253, 2253, 2253], [92, 92, 92]));
    for (const [group, entry] of Object.entries(client.calibrationInfo.inertial)) {
      expect(entry!.staleDefault).toBe(group === 'lnAccel');
    }
  });
});
