import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import type { ObjectCluster } from '../../src/core/ObjectCluster.js';

const ACK = OPCODES.ACK_COMMAND_PROCESSED;
const INQ_RSP = OPCODES.INQUIRY_RESPONSE;

// Gyro X/Y/Z inquiry, all config bytes 0 → gyro range 0.
const INQUIRY_BODY_3R = [INQ_RSP, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0x0a, 0x0b, 0x0c];

// Raw gyro [229,458,687] (LE i16) — chosen so the Shimmer3R default (sens 229,
// align [[-1,0,0],[0,1,0],[0,0,-1]]) yields exactly [-1, 2, -3] deg/s.
const GYRO_3R = [0xe5, 0x00, 0xca, 0x01, 0xaf, 0x02];
const frame3R = (ts: number): number[] => [
  0x00,
  ts & 0xff,
  (ts >> 8) & 0xff,
  (ts >> 16) & 0xff,
  ...GYRO_3R,
];

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

describe('Shimmer3RClient streaming inertial calibration', () => {
  async function streamOnce(
    opts: { emitCalibratedInertial?: boolean } = {},
  ): Promise<ObjectCluster[]> {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.INQUIRY_COMMAND) setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY_3R]), 0);
      else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const client = new Shimmer3RClient({ transport: t, ...opts });
    const frames: ObjectCluster[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    await client.connect();
    await client.inquiry();
    expect(client.imuRanges.gyro).toBe(0);
    await client.startStreaming();
    // 640 ticks apart: one sampling interval at the 51.2 Hz the inquiry declares,
    // which is what the stream parser confirms its frame alignment against.
    t.notify([...frame3R(640), ...frame3R(1280), ...frame3R(1920)]);
    await tick();
    return frames;
  }

  it('adds calibrated GYRO fields (deg/s) alongside raw, hand-computed', async () => {
    const frames = await streamOnce();
    expect(frames.length).toBeGreaterThanOrEqual(1);
    const oc = frames[0];
    // Raw preserved.
    expect(oc.get('GYRO_X', 'raw')!.value).toBe(229);
    // Calibrated: [-1, 2, -3] deg/s (sens 229, align [[-1,0,0],[0,1,0],[0,0,-1]]).
    const cx = oc.get('GYRO_X', 'cal')!;
    const cy = oc.get('GYRO_Y', 'cal')!;
    const cz = oc.get('GYRO_Z', 'cal')!;
    expect(cx.unit).toBe('deg/s');
    expect(cx.value).toBeCloseTo(-1, 9);
    expect(cy.value).toBeCloseTo(2, 9);
    expect(cz.value).toBeCloseTo(-3, 9);
  });

  it('emits raw-only when emitCalibratedInertial is false', async () => {
    const frames = await streamOnce({ emitCalibratedInertial: false });
    expect(frames.length).toBeGreaterThanOrEqual(1);
    expect(frames[0].get('GYRO_X', 'cal')).toBeNull();
    expect(frames[0].get('GYRO_X', 'raw')!.value).toBe(229);
  });

  it('readCalibration overrides the default with a device block', async () => {
    const t = new LoopbackTransport();
    // A device gyro block: offset 0, sens 100 (÷100 scale → 1), identity align.
    // → calibrated gyro = raw (no axis swap, unit sens). raw 229 → 229.
    const gyroBlock = [
      0,
      0,
      0,
      0,
      0,
      0, // offset 0
      0x27,
      0x10,
      0x27,
      0x10,
      0x27,
      0x10, // sens = 10000 → ÷100 = 100
      100,
      0,
      0,
      0,
      100,
      0,
      0,
      0,
      100, // identity alignment (×100)
    ];
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.INQUIRY_COMMAND) setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY_3R]), 0);
      else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
      else if (op === OPCODES.GET_GYRO_CALIBRATION_COMMAND)
        setTimeout(() => tr.notify([ACK, OPCODES.GYRO_CALIBRATION_RESPONSE, ...gyroBlock]), 0);
      else setTimeout(() => tr.notify([ACK]), 0); // ACK other GET_*_CALIBRATION commands (no body → skipped)
    });
    const client = new Shimmer3RClient({ transport: t });
    const frames: ObjectCluster[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    await client.connect();
    await client.inquiry();
    const got = await client.readCalibration(200);
    expect(got).toContain('gyro');
    await client.startStreaming();
    // 640 ticks apart: one sampling interval at the 51.2 Hz the inquiry declares,
    // which is what the stream parser confirms its frame alignment against.
    t.notify([...frame3R(640), ...frame3R(1280), ...frame3R(1920)]);
    await tick();
    // Device block: sens 100 (÷100 = 1) identity → gyro / 1 = raw value.
    expect(frames[0].get('GYRO_X', 'cal')!.value).toBeCloseTo(229 / 100, 6);
  });
});

// --- Shimmer3 (classic) --------------------------------------------------------

const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE;
const FWVER = OPCODES.FW_VERSION_RESPONSE;
// Classic inquiry: 51.2 Hz, gyro X/Y/Z, config bytes all 0 → all ranges 0.
const INQUIRY_MSG_S3 = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x00, 0x03, 0x01, 0x0a, 0x0b, 0x0c];
// Raw gyro [0,131,262] → default MPU (sens 131, align [[0,-1,0],[-1,0,0],[0,0,-1]])
// gives [-1, 0, -2] deg/s.
const GYRO_S3 = [0x00, 0x00, 0x83, 0x00, 0x06, 0x01];
const frameS3 = (ts: number): number[] => [
  0x00,
  ts & 0xff,
  (ts >> 8) & 0xff,
  (ts >> 16) & 0xff,
  ...GYRO_S3,
];

describe('Shimmer3Client streaming inertial calibration', () => {
  it('calibrates gyro with the range-selected old-IMU default (deg/s)', async () => {
    const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) setTimeout(() => tr.notify([DEVVER, 3]), 0);
      else if (op === OPCODES.GET_FW_VERSION_COMMAND)
        setTimeout(() => tr.notify([FWVER, 3, 0, 0, 0, 15, 0]), 0);
      else if (op === OPCODES.INQUIRY_COMMAND) setTimeout(() => tr.notify(INQUIRY_MSG_S3), 0);
      else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const client = new Shimmer3Client({ transport: t });
    const frames: ObjectCluster[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    await client.connect();
    await client.inquiry();
    expect(client.imuRanges.gyro).toBe(0);
    await client.startStreaming();
    t.notify([...frameS3(100), ...frameS3(200), ...frameS3(300)]);
    await tick();

    expect(frames.length).toBeGreaterThanOrEqual(1);
    const oc = frames[0];
    expect(oc.get('GYRO_X', 'raw')!.value).toBe(0);
    const cx = oc.get('GYRO_X', 'cal')!;
    expect(cx.unit).toBe('deg/s');
    expect(cx.value).toBeCloseTo(-1, 9);
    expect(oc.get('GYRO_Y', 'cal')!.value).toBeCloseTo(0, 9);
    expect(oc.get('GYRO_Z', 'cal')!.value).toBeCloseTo(-2, 9);
  });
});

// --- Gyro on-the-fly offset calibration ----------------------------------------

/*
 * A sensor lying perfectly still: the same raw gyro in every frame. At 51.2 Hz
 * the window is round(51.2) = 51 samples, so frames 0-50 are calibrated against
 * the stored offset, and from frame 51 on the offset is the window's raw mean —
 * the sample itself — and every axis reads exactly 0 deg/s.
 *
 * The raw bytes are 0x0101 on every axis, which decodes to 257 in either byte
 * order, so these cases do not depend on how a Shimmer3's gyro is decoded.
 */
const STILL = [0x01, 0x01, 0x01, 0x01, 0x01, 0x01];
const stillFrames = (n: number, ticks: number): number[] =>
  Array.from({ length: n }, (_, i) => {
    const ts = ticks * (i + 1);
    return [0x00, ts & 0xff, (ts >> 8) & 0xff, (ts >> 16) & 0xff, ...STILL];
  }).flat();

const gyroCal = (oc: ObjectCluster): number[] =>
  ['GYRO_X', 'GYRO_Y', 'GYRO_Z'].map((n) => oc.get(n, 'cal')!.value);

describe('gyro on-the-fly offset calibration, end to end', () => {
  async function streamStill3R(enable: boolean) {
    const t = new LoopbackTransport();
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.INQUIRY_COMMAND) setTimeout(() => tr.notify([ACK, ...INQUIRY_BODY_3R]), 0);
      else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const client = new Shimmer3RClient({ transport: t });
    const frames: ObjectCluster[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    await client.connect();
    await client.inquiry();
    client.gyroOnTheFlyCal = enable;
    await client.startStreaming();
    t.notify(stillFrames(60, 640));
    await tick();
    return { client, frames };
  }

  it('Shimmer3RClient: re-estimates the offset once a still window has filled', async () => {
    const { client, frames } = await streamStill3R(true);
    expect(frames.length).toBeGreaterThan(52);
    // Before: the default calibration of 257 counts (sens 229): about ±1.12 deg/s.
    expect(Math.abs(gyroCal(frames[50])[0])).toBeCloseTo(257 / 229, 9);
    // After: the offset is the sample, so exactly +0 on every axis.
    for (const oc of frames.slice(51)) {
      for (const v of gyroCal(oc)) expect(Object.is(v, 0)).toBe(true);
    }
    expect(client.calibrationInfo.gyroOnTheFly).toMatchObject({
      enabled: true,
      active: true,
      windowSamples: 51,
      thresholdDps: 1.2,
      offset: [257, 257, 257],
    });
  });

  it('Shimmer3RClient: leaves the offset alone when it is off', async () => {
    const { client, frames } = await streamStill3R(false);
    expect(Math.abs(gyroCal(frames[frames.length - 1])[0])).toBeCloseTo(257 / 229, 9);
    expect(client.calibrationInfo.gyroOnTheFly).toMatchObject({ enabled: false, active: false });
  });

  it('Shimmer3RClient: turning it off puts the stored offset back, and a new link forgets', async () => {
    const { client } = await streamStill3R(true);
    expect(client.calibrationInfo.gyroOnTheFly.active).toBe(true);
    client.gyroOnTheFlyCal = false;
    expect(client.calibrationInfo.gyroOnTheFly).toMatchObject({ active: false, updates: 0 });

    const again = await streamStill3R(true);
    await again.client.disconnect();
    expect(again.client.calibrationInfo.gyroOnTheFly).toMatchObject({
      active: false,
      updates: 0,
      offset: null,
    });
  });

  it('Shimmer3Client: the same, on the classic client', async () => {
    const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'S3' });
    t.setOnWrite((bytes, tr) => {
      const op = bytes[0];
      if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) setTimeout(() => tr.notify([DEVVER, 3]), 0);
      else if (op === OPCODES.GET_FW_VERSION_COMMAND)
        setTimeout(() => tr.notify([FWVER, 3, 0, 0, 0, 15, 0]), 0);
      else if (op === OPCODES.INQUIRY_COMMAND) setTimeout(() => tr.notify(INQUIRY_MSG_S3), 0);
      else if (op === OPCODES.START_STREAMING_COMMAND) setTimeout(() => tr.notify([ACK]), 0);
    });
    const client = new Shimmer3Client({ transport: t });
    const frames: ObjectCluster[] = [];
    client.onStreamFrame = (oc) => frames.push(oc);
    await client.connect();
    await client.inquiry();
    client.gyroOnTheFlyCal = true;
    await client.startStreaming();
    t.notify(stillFrames(60, 640));
    await tick();
    expect(frames.length).toBeGreaterThan(52);
    expect(gyroCal(frames[50]).some((v) => v !== 0)).toBe(true);
    for (const oc of frames.slice(51)) {
      for (const v of gyroCal(oc)) expect(Object.is(v, 0)).toBe(true);
    }
    expect(client.calibrationInfo.gyroOnTheFly).toMatchObject({
      enabled: true,
      active: true,
      windowSamples: 51,
    });
  });
});
