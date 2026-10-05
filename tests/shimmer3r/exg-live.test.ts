import { describe, it, expect } from 'vitest';
import { Shimmer3RClient } from '../../src/devices/shimmer3r/Shimmer3RClient.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { getOversamplingRatioADS1292R } from '../../src/devices/shimmer3r/calibration.js';
import {
  EXG_PRESET_ARRAYS,
  detectExgPreset,
  applyExgMustBeBits,
} from '../../src/devices/exg/index.js';

// EX3: live EXG GET/SET over the radio for Shimmer3R, exercised against a
// stateful in-memory device that stores the register banks on SET and echoes
// them on GET — so the SET → read-back-verify flow can be pinned end-to-end.

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xff
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02
const SET_EXG = OPCODES.SET_EXG_REGS_COMMAND; // 0x61
const EXG_RSP = OPCODES.EXG_REGS_RESPONSE; // 0x62
const GET_EXG = OPCODES.GET_EXG_REGS_COMMAND; // 0x63

// GYRO-only inquiry (51.2 Hz), same as transport-loopback.test.ts.
const GYRO_INQ = [INQ_RSP, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 3, 1, 0x0a, 0x0b, 0x0c];
// ECG 16-bit inquiry: EXG1_16BIT (0x23/0x24) + EXG2_16BIT (0x25/0x26) channels.
const EXG_INQ = [INQ_RSP, 0x80, 0x02, 0, 0, 0, 0, 0, 0, 0, 4, 1, 0x23, 0x24, 0x25, 0x26];

interface ExgDevice {
  banks: [Uint8Array, Uint8Array];
  handler: (bytes: Uint8Array, tr: LoopbackTransport) => void;
  /** When set, the read-back GET for this chip returns a mutated bank (mismatch). */
  corruptChip?: 0 | 1;
}

function exgDevice(init?: {
  banks?: [number[], number[]];
  piggyback?: boolean;
  /** When true, the chip forces the ADS1292R must-be bits on every SET (as real
   *  firmware does) — so a zeroed write reads back non-zero. */
  enforceMustBe?: boolean;
}): ExgDevice {
  const dev: ExgDevice = {
    banks: [
      new Uint8Array(init?.banks?.[0] ?? new Array(10).fill(0)),
      new Uint8Array(init?.banks?.[1] ?? new Array(10).fill(0)),
    ],
    handler: () => {},
  };
  let inquiry = GYRO_INQ;
  const piggyback = init?.piggyback ?? true;
  dev.handler = (bytes, tr) => {
    const op = bytes[0];
    if (op === GET_EXG) {
      const chip = bytes[1] as 0 | 1;
      let bank = dev.banks[chip];
      if (dev.corruptChip === chip) {
        bank = new Uint8Array(bank);
        bank[0] ^= 0x40; // flip a writable-register bit to force a mismatch
      }
      const frame = [EXG_RSP, 10, ...bank];
      if (piggyback) setTimeout(() => tr.notify([ACK, ...frame]), 0);
      else {
        setTimeout(() => tr.notify([ACK]), 0);
        setTimeout(() => tr.notify(frame), 1);
      }
    } else if (op === SET_EXG) {
      const chip = bytes[1] as 0 | 1;
      const written = bytes.slice(4, 4 + 10);
      dev.banks[chip] = init?.enforceMustBe ? applyExgMustBeBits(new Uint8Array(written)) : written;
      setTimeout(() => tr.notify([ACK]), 0);
    } else if (op === OPCODES.SET_SENSORS_COMMAND) {
      inquiry = EXG_INQ; // reflect the EXG enable on the next inquiry
      setTimeout(() => tr.notify([ACK]), 0);
    } else if (op === OPCODES.INQUIRY_COMMAND) {
      setTimeout(() => tr.notify([ACK, ...inquiry]), 0);
    } else if (op === OPCODES.START_STREAMING_COMMAND) {
      setTimeout(() => tr.notify([ACK]), 0);
    }
  };
  return dev;
}

async function connected(
  dev: ExgDevice,
): Promise<{ t: LoopbackTransport; client: Shimmer3RClient }> {
  const t = new LoopbackTransport({ deviceName: 'Shimmer3R-EXG' });
  t.setOnWrite((bytes, tr) => dev.handler(bytes, tr));
  const client = new Shimmer3RClient({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

describe('Shimmer3RClient EXG live GET/SET', () => {
  it('readExgConfig sends GET {0x63,chip,0,10} for CHIP1 then CHIP2 and decodes both banks', async () => {
    const dev = exgDevice({
      banks: [
        [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        [11, 12, 13, 14, 15, 16, 17, 18, 19, 20],
      ],
    });
    const { t, client } = await connected(dev);

    const { exg1, exg2 } = await client.readExgConfig();
    expect(Array.from(exg1)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(Array.from(exg2)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]);

    const gets = t.writes.filter((w) => w.bytes[0] === GET_EXG).map((w) => Array.from(w.bytes));
    expect(gets).toEqual([
      [0x63, 0, 0, 10],
      [0x63, 1, 0, 10],
    ]);
  });

  it('readExgConfig also works when ACK and response arrive in separate chunks', async () => {
    const dev = exgDevice({
      banks: [
        [9, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        [8, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      ],
      piggyback: false,
    });
    const { client } = await connected(dev);
    const { exg1, exg2 } = await client.readExgConfig();
    expect(exg1[0]).toBe(9);
    expect(exg2[0]).toBe(8);
  });

  it('writeExgConfig sends SET {0x61,chip,0,10,...} per chip, injects the 3R oversampling ratio into REG1, and read-back-verifies', async () => {
    const dev = exgDevice();
    const { t, client } = await connected(dev);
    client.samplingRateHz = 1000; // getOversamplingRatioADS1292R(1000) = 4

    const ecg1 = Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg1);
    const ecg2 = Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg2);
    await client.writeExgConfig(ecg1, ecg2);

    const sets = t.writes.filter((w) => w.bytes[0] === SET_EXG).map((w) => w.bytes);
    expect(sets.length).toBe(2);
    expect(sets[0][1]).toBe(0); // chip 0
    expect(sets[1][1]).toBe(1); // chip 1
    expect(Array.from(sets[0].slice(0, 4))).toEqual([0x61, 0, 0, 10]);

    // REG1 (instruction byte 4) low 3 bits carry the oversampling ratio.
    const ratio = getOversamplingRatioADS1292R(1000);
    expect(ratio).toBe(4);
    expect(sets[0][4] & 0x07).toBe(4);
    expect(sets[1][4] & 0x07).toBe(4);
    // Upper bits of REG1 preserved from the ECG preset (0x02 → 0x00 after mask, |4).
    expect(sets[0][4]).toBe(((ecg1[0] >> 3) << 3) | 4);

    // The stored device banks match what was written (read-back succeeded).
    expect(dev.banks[0][4]).toBe(ecg1[4]);
  });

  it('writeExgConfig throws when the read-back does not match', async () => {
    const dev = exgDevice();
    dev.corruptChip = 1; // CHIP2 read-back will differ in a writable register
    const { client } = await connected(dev);
    client.samplingRateHz = 512;
    await expect(
      client.writeExgConfig(
        Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg1),
        Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg2),
      ),
    ).rejects.toThrow(/read-back mismatch/i);
  });

  it('applyExgPresetLive(ecg,16bit) writes ECG banks, sets the EXG bitmap last, and the re-inquiry reflects EXG', async () => {
    const dev = exgDevice();
    const { t, client } = await connected(dev);
    await client.inquiry(); // seed samplingRateHz (51.2) + enabledSensors (GYRO)
    expect(client.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);

    await client.applyExgPresetLive('ecg', '16bit');

    // The written banks are the ECG preset (detect confirms the input selections).
    expect(detectExgPreset(dev.banks[0], dev.banks[1])).toBe('ecg');

    // SET_EXG for both chips came BEFORE the SET_SENSORS (enabled sensors last).
    const ops = t.writes.map((w) => w.bytes[0]);
    const lastSetExg = ops.lastIndexOf(SET_EXG);
    const setSensorsIdx = ops.indexOf(OPCODES.SET_SENSORS_COMMAND);
    expect(lastSetExg).toBeLessThan(setSensorsIdx);

    // SET_SENSORS carried EXG1_16BIT | EXG2_16BIT | (kept) GYRO, conflicts cleared.
    const setSensors = t.writes.find((w) => w.bytes[0] === OPCODES.SET_SENSORS_COMMAND)!;
    const mask = setSensors.bytes[1] | (setSensors.bytes[2] << 8) | (setSensors.bytes[3] << 16);
    expect(mask & SensorBitmapShimmer3.SENSOR_EXG1_16BIT).toBeTruthy();
    expect(mask & SensorBitmapShimmer3.SENSOR_EXG2_16BIT).toBeTruthy();

    // The auto re-inquiry after setSensors reflects the EXG channels.
    expect(client.enabledSensors & SensorBitmapShimmer3.SENSOR_EXG1_16BIT).toBeTruthy();
    expect(client.enabledSensors & SensorBitmapShimmer3.SENSOR_EXG2_16BIT).toBeTruthy();
  });

  it('rejects EXG GET/SET/apply while streaming', async () => {
    const dev = exgDevice();
    const { client } = await connected(dev);
    await client.inquiry();
    await client.startStreaming();

    await expect(client.readExgConfig()).rejects.toThrow(/streaming/i);
    await expect(client.writeExgConfig(new Uint8Array(10), new Uint8Array(10))).rejects.toThrow(
      /streaming/i,
    );
    await expect(client.applyExgPresetLive('ecg', '16bit')).rejects.toThrow(/streaming/i);
  });

  it("applyExgPresetLive('off') writes NO EXG registers and only clears the EXG bitmap", async () => {
    // The chip enforces must-be bits on write, so the old off-path (writing
    // zeroed banks) would fail read-back-verify. The correct disable never writes.
    const dev = exgDevice({ enforceMustBe: true });
    const { t, client } = await connected(dev);
    client.enabledSensors =
      SensorBitmapShimmer3.SENSOR_GYRO |
      SensorBitmapShimmer3.SENSOR_EXG1_16BIT |
      SensorBitmapShimmer3.SENSOR_EXG2_16BIT;

    const setExgBefore = t.writes.filter((w) => w.bytes[0] === SET_EXG).length;
    await expect(client.applyExgPresetLive('off', '16bit')).resolves.toBeUndefined();

    // No SET_EXG (0x61) traffic during the disable.
    expect(t.writes.filter((w) => w.bytes[0] === SET_EXG).length).toBe(setExgBefore);

    // SET_SENSORS carried the EXG bits cleared but GYRO retained.
    const setSensors = t.writes.filter((w) => w.bytes[0] === OPCODES.SET_SENSORS_COMMAND).pop()!;
    const mask = setSensors.bytes[1] | (setSensors.bytes[2] << 8) | (setSensors.bytes[3] << 16);
    expect(mask & SensorBitmapShimmer3.SENSOR_EXG1_16BIT).toBe(0);
    expect(mask & SensorBitmapShimmer3.SENSOR_EXG2_16BIT).toBe(0);
    expect(mask & SensorBitmapShimmer3.SENSOR_GYRO).toBeTruthy();
  });

  it('writeExgConfig of zeroed banks against a must-be-enforcing chip throws (proves the old off-path would fail)', async () => {
    const dev = exgDevice({ enforceMustBe: true });
    const { client } = await connected(dev);
    client.samplingRateHz = 512;
    await expect(client.writeExgConfig(new Uint8Array(10), new Uint8Array(10))).rejects.toThrow(
      /read-back mismatch/i,
    );
  });
});
