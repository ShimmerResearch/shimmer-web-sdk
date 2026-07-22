import { describe, it, expect } from 'vitest';
import { Shimmer3Client } from '../../src/devices/shimmer3/Shimmer3Client.js';
import { OPCODES } from '../../src/devices/shimmer3r/constants.js';
import { SensorBitmapShimmer3 } from '../../src/devices/shimmer3r/SensorBitmap.js';
import { LoopbackTransport } from '../../src/core/transport/LoopbackTransport.js';
import { EXG_PRESET_ARRAYS, detectExgPreset } from '../../src/devices/exg/index.js';

// EX3: live EXG GET/SET over the (unframed) RFCOMM byte stream for classic
// Shimmer3. Same LiteProtocol command flow as Shimmer3R, but the classic client
// writes the register banks VERBATIM (no oversampling-ratio injection).

const ACK = OPCODES.ACK_COMMAND_PROCESSED; // 0xFF
const INQ_RSP = OPCODES.INQUIRY_RESPONSE; // 0x02
const DEVVER = OPCODES.DEVICE_VERSION_RESPONSE; // 0x25
const FWVER = OPCODES.FW_VERSION_RESPONSE; // 0x2F
const SET_EXG = OPCODES.SET_EXG_REGS_COMMAND; // 0x61
const EXG_RSP = OPCODES.EXG_REGS_RESPONSE; // 0x62
const GET_EXG = OPCODES.GET_EXG_REGS_COMMAND; // 0x63

// Classic-Shimmer3 inquiry layout (numChannels @7, channels @9).
const GYRO_INQ = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x03, 0x01, 0x0a, 0x0b, 0x0c];
const EXG_INQ = [INQ_RSP, 0x80, 0x02, 0x00, 0x00, 0x00, 0x05, 0x04, 0x01, 0x23, 0x24, 0x25, 0x26];

interface ExgDevice {
  banks: [Uint8Array, Uint8Array];
  handler: (bytes: Uint8Array, tr: LoopbackTransport) => void;
  corruptChip?: 0 | 1;
}

function exgDevice(init?: { banks?: [number[], number[]] }): ExgDevice {
  const dev: ExgDevice = {
    banks: [
      new Uint8Array(init?.banks?.[0] ?? new Array(10).fill(0)),
      new Uint8Array(init?.banks?.[1] ?? new Array(10).fill(0)),
    ],
    handler: () => {},
  };
  let inquiry = GYRO_INQ;
  dev.handler = (bytes, tr) => {
    const op = bytes[0];
    if (op === OPCODES.GET_DEVICE_VERSION_COMMAND) setTimeout(() => tr.notify([DEVVER, 3]), 0);
    else if (op === OPCODES.GET_FW_VERSION_COMMAND)
      setTimeout(() => tr.notify([FWVER, 3, 0, 0, 0, 15, 0]), 0);
    else if (op === GET_EXG) {
      const chip = bytes[1] as 0 | 1;
      let bank = dev.banks[chip];
      if (dev.corruptChip === chip) {
        bank = new Uint8Array(bank);
        bank[3] ^= 0x10; // flip a writable-register bit
      }
      // ACK then response, as one coalesced chunk (drainControl re-frames it).
      setTimeout(() => tr.notify([ACK, EXG_RSP, 10, ...bank]), 0);
    } else if (op === SET_EXG) {
      const chip = bytes[1] as 0 | 1;
      dev.banks[chip] = bytes.slice(4, 4 + 10);
      setTimeout(() => tr.notify([ACK]), 0);
    } else if (op === OPCODES.SET_SENSORS_COMMAND) {
      inquiry = EXG_INQ;
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
): Promise<{ t: LoopbackTransport; client: Shimmer3Client }> {
  const t = new LoopbackTransport({ capabilities: { framed: false }, deviceName: 'Shimmer3-EXG' });
  t.setOnWrite((bytes, tr) => dev.handler(bytes, tr));
  const client = new Shimmer3Client({ debug: false, transport: t });
  await client.connect();
  return { t, client };
}

describe('Shimmer3Client EXG live GET/SET', () => {
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

  it('writeExgConfig sends SET {0x61,chip,0,10,...} VERBATIM (no oversampling injection) and read-back-verifies', async () => {
    const dev = exgDevice();
    const { t, client } = await connected(dev);

    const ecg1 = Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg1);
    const ecg2 = Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg2);
    await client.writeExgConfig(ecg1, ecg2);

    const sets = t.writes.filter((w) => w.bytes[0] === SET_EXG).map((w) => w.bytes);
    expect(sets.length).toBe(2);
    // Classic writes the banks verbatim — REG1 (byte 4) is untouched.
    expect(Array.from(sets[0])).toEqual([0x61, 0, 0, 10, ...EXG_PRESET_ARRAYS.ecg.exg1]);
    expect(Array.from(sets[1])).toEqual([0x61, 1, 0, 10, ...EXG_PRESET_ARRAYS.ecg.exg2]);
  });

  it('writeExgConfig throws when the read-back does not match', async () => {
    const dev = exgDevice();
    dev.corruptChip = 0;
    const { client } = await connected(dev);
    await expect(
      client.writeExgConfig(
        Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg1),
        Uint8Array.from(EXG_PRESET_ARRAYS.ecg.exg2),
      ),
    ).rejects.toThrow(/read-back mismatch/i);
  });

  it('applyExgPresetLive(ecg,16bit) writes ECG banks, sets the EXG bitmap last, re-inquiry reflects EXG', async () => {
    const dev = exgDevice();
    const { t, client } = await connected(dev);
    await client.inquiry();
    expect(client.enabledSensors).toBe(SensorBitmapShimmer3.SENSOR_GYRO);

    await client.applyExgPresetLive('ecg', '16bit');

    expect(detectExgPreset(dev.banks[0], dev.banks[1])).toBe('ecg');

    const ops = t.writes.map((w) => w.bytes[0]);
    expect(ops.lastIndexOf(SET_EXG)).toBeLessThan(ops.indexOf(OPCODES.SET_SENSORS_COMMAND));

    const setSensors = t.writes.find((w) => w.bytes[0] === OPCODES.SET_SENSORS_COMMAND)!;
    const mask = setSensors.bytes[1] | (setSensors.bytes[2] << 8) | (setSensors.bytes[3] << 16);
    expect(mask & SensorBitmapShimmer3.SENSOR_EXG1_16BIT).toBeTruthy();
    expect(mask & SensorBitmapShimmer3.SENSOR_EXG2_16BIT).toBeTruthy();

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
});
