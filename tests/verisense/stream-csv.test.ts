import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  VERISENSE_STREAM_CSV_TIME_COLUMNS,
  createVerisenseStreamRecorder,
  verisenseStreamCsvKey,
  verisenseStreamCsvLayout,
} from '../../src/devices/verisense/streamCsv.js';
import type { StreamPacket } from '../../src/devices/verisense/VerisenseTypes.js';
import type { SensorBase } from '../../src/devices/verisense/sensors/SensorBase.js';
import { SensorADC } from '../../src/devices/verisense/sensors/SensorADC.js';
import { SensorLIS2DW12 } from '../../src/devices/verisense/sensors/SensorLIS2DW12.js';
import { SensorLSM6DS3 } from '../../src/devices/verisense/sensors/SensorLSM6DS3.js';
import { SensorLSM6DSV } from '../../src/devices/verisense/sensors/SensorLSM6DSV.js';
import { SensorPPG } from '../../src/devices/verisense/sensors/SensorPPG.js';
import { SensorVD6283 } from '../../src/devices/verisense/sensors/SensorVD6283.js';
import { SensorMLX90632 } from '../../src/devices/verisense/sensors/SensorMLX90632.js';
import { FakeDirectory, blobText } from '../core/fakeFileSystem.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Build a `data` packet the way VerisenseClient._handleStreamingPayload does:
 * unwrap the header tick, decode, timestamp each sample back from the tick.
 */
function packet(
  sensor: SensorBase,
  sensorId: number,
  payload: Uint8Array,
  tick: number,
  hostMs = 1_790_000_000_000,
): StreamPacket {
  const tsInfo = sensor.getTimestampUnwrappedMillis(tick, hostMs);
  const decoded = sensor.parsePayload(payload);
  const ts = sensor.computeSampleTimestamps(decoded, {
    tsLastSampleMillis: tsInfo.shimmerMillis,
    systemTsLastSampleMillis: hostMs,
    systemOffsetFirstTime: tsInfo.systemOffsetFirstTime,
  });
  return {
    sensorId,
    tick_u24: tick,
    decoded: decoded.map((s, i) => ({ ...(s as object), timestamps: ts[i] })),
    rawPayload: payload,
    crcOk: true,
  };
}

/** Three tagged LSM6DSV FIFO entries per call: accel, gyro, mag. */
function lsm6dsvPayload(): Uint8Array {
  return new Uint8Array([
    3, 0x00, 0x10, 0x01, 0x00, 0x02, 0x00, 0x03, 0x00, 0x08, 0x04, 0x00, 0x05, 0x00, 0x06, 0x00,
    0x70, 0x07, 0x00, 0x08, 0x00, 0x09, 0x00,
  ]);
}

const TIME_HEADERS = VERISENSE_STREAM_CSV_TIME_COLUMNS.map((c) => c.header);

function headersOf(sensorId: number, sample: unknown): string[] {
  const l = verisenseStreamCsvLayout(sensorId, sample);
  if (!l) throw new Error('no layout');
  return l.columns.map((c) => c.header);
}

describe('verisenseStreamCsvLayout', () => {
  it('lays out every sensor id the client decodes', () => {
    const adc = new SensorADC();
    adc.gsrEnabled = true;
    adc.battEnabled = true;
    const [adcSample] = adc.parsePayload(new Uint8Array(4));
    expect(headersOf(1, adcSample)).toEqual([
      'GSR_raw',
      'GSR_adc12',
      'GSR_range',
      'GSR_V',
      'GSR_kOhm',
      'GSR_uS',
      'GSR_connectivity',
      'Batt_raw16',
      'Batt_adc12',
      'Batt_mV',
      'Batt_usbPluggedIn',
      'Batt_chargerStatusBits',
      'Batt_chargerStatus',
    ]);
    expect(verisenseStreamCsvLayout(1, adcSample)?.label).toBe('GSR_Batt');

    const [acc1] = new SensorLIS2DW12().parsePayload(new Uint8Array(6));
    const l2 = verisenseStreamCsvLayout(2, acc1)!;
    expect(l2.label).toBe('Accel1');
    expect(l2.columns.map((c) => c.header)).toEqual([
      'Accel1_X_raw',
      'Accel1_Y_raw',
      'Accel1_Z_raw',
      'Accel1_X_cal',
      'Accel1_Y_cal',
      'Accel1_Z_cal',
    ]);
    expect(l2.columns[3].unit).toBe('m/s^2');

    const ds3 = new SensorLSM6DS3();
    ds3.accEnabled = true;
    ds3.gyroEnabled = true;
    const [imu] = ds3.parsePayload(new Uint8Array(12));
    const l3 = verisenseStreamCsvLayout(3, imu)!;
    expect(l3.label).toBe('Accel2_Gyro');
    expect(l3.columns).toHaveLength(12);
    expect(l3.columns.find((c) => c.header === 'Gyro_X_cal')?.unit).toBe('deg/s');

    const ppg = new SensorPPG();
    ppg.setChannels({ RED: true, IR: true });
    const [ppgSample] = ppg.parsePayload(new Uint8Array(6));
    expect(headersOf(4, ppgSample)).toEqual([
      'PPG_RED_raw',
      'PPG_RED_cal',
      'PPG_IR_raw',
      'PPG_IR_cal',
    ]);

    const hub = new SensorPPG();
    hub.setHubMode(true);
    const [hubSample] = hub.parsePayload(new Uint8Array(9));
    expect(headersOf(4, hubSample)).toEqual(['PPG_GREEN', 'PPG_IR', 'PPG_RED']);

    const dsv = new SensorLSM6DSV().parsePayload(lsm6dsvPayload());
    expect(dsv.map((s) => verisenseStreamCsvKey(6, s))).toEqual(['6:accel', '6:gyro', '6:mag']);
    expect(dsv.map((s) => verisenseStreamCsvLayout(6, s)?.label)).toEqual([
      'Accel2',
      'Gyro',
      'Mag',
    ]);
    expect(verisenseStreamCsvLayout(6, dsv[2])!.columns[3]).toEqual({
      header: 'Mag_X_cal',
      unit: 'uT',
    });

    const [light] = new SensorVD6283().parsePayload(new Uint8Array(18));
    expect(headersOf(7, light)).toEqual([
      'Light_RED',
      'Light_VISIBLE',
      'Light_DARK',
      'Light_BLUE',
      'Light_GREEN',
      'Light_IR',
      'Light_CLEAR',
      'Lux',
      'CCT',
    ]);

    const algo = {
      accel: { raw: [1, 2, 3] },
      hr: 72,
      hrConfidence: 90,
      spo2: 98,
      spo2Confidence: 80,
      activityClass: 0,
      scdContactState: 3,
    };
    const l8 = verisenseStreamCsvLayout(8, algo)!;
    expect(l8.label).toBe('AlgoHub');
    expect(l8.row(algo)).toEqual([1, 2, 3, 72, 90, 98, 80, 0, 3]);

    const [temp] = new SensorMLX90632().parsePayload(new Uint8Array(4));
    expect(headersOf(9, temp)).toEqual(['Object_raw', 'Object_cal', 'Ambient_raw', 'Ambient_cal']);
    expect(verisenseStreamCsvLayout(9, temp)!.columns[1].unit).toBe('degC');
  });

  it('leaves out channels the first sample does not carry', () => {
    const adc = new SensorADC();
    adc.gsrEnabled = false;
    adc.battEnabled = true;
    const [battOnly] = adc.parsePayload(new Uint8Array(2));
    const l = verisenseStreamCsvLayout(1, battOnly)!;
    expect(l.label).toBe('Batt');
    expect(l.columns.every((c) => c.header.startsWith('Batt_'))).toBe(true);
  });

  it('writes booleans as 1/0 and a missing VISIBLE/DARK slot as an empty cell', () => {
    const adc = new SensorADC();
    adc.gsrEnabled = false;
    adc.battEnabled = true;
    const [b] = adc.parsePayload(new Uint8Array([0xbc, 0xca])); // USB bit set
    const l = verisenseStreamCsvLayout(1, b)!;
    expect(l.row(b)[l.columns.findIndex((c) => c.header === 'Batt_usbPluggedIn')]).toBe(1);

    const [light] = new SensorVD6283().parsePayload(new Uint8Array(18));
    const l7 = verisenseStreamCsvLayout(7, light)!;
    const row = l7.row(light);
    const visible = row[1];
    const dark = row[2];
    // Exactly one of the two carries the slot's reading.
    expect([visible, dark].filter((v) => v === '')).toHaveLength(1);
  });

  it('returns null for an unknown sensor or an empty sample', () => {
    expect(verisenseStreamCsvLayout(5, {})).toBeNull();
    expect(verisenseStreamCsvLayout(1, { gsr: null, batt: null })).toBeNull();
    expect(verisenseStreamCsvKey(6, { accel: null, gyro: null, mag: null })).toBeNull();
  });
});

describe('createVerisenseStreamRecorder', () => {
  function stubPicker(root: FakeDirectory) {
    vi.stubGlobal(
      'showDirectoryPicker',
      vi.fn(async () => root),
    );
  }

  it('writes one file per stream into a session folder, with the tick on the measured row', async () => {
    const root = new FakeDirectory();
    stubPicker(root);
    const rec = createVerisenseStreamRecorder({ sessionNameFn: () => 'Verisense_B10F_test' });
    expect(await rec.start()).toBe(true);
    expect(rec.active).toBe(true);

    const acc = new SensorLIS2DW12();
    acc.samplingRateHz = 50;
    // Two packets of 3 samples; each header tick measures the packet's last one.
    expect(rec.push(packet(acc, 2, new Uint8Array(18), 32768))).toBe(true);
    expect(rec.push(packet(acc, 2, new Uint8Array(18), 32768 + 1966))).toBe(true);

    const dsv = new SensorLSM6DSV();
    const op = new Uint8Array(72);
    op[1] = 0b01100000; // accel2En + gyroEn
    op[4] = 0b00000100; // magEn
    op[18] = 0x05; // accel 60 Hz
    op[19] = 0x05; // gyro 60 Hz
    dsv.applyOperationalConfig(op);
    rec.push(packet(dsv, 6, lsm6dsvPayload(), 65536));

    expect(rec.progress().map((p) => [p.label, p.rows])).toEqual([
      ['Accel1', 6],
      ['Accel2', 1],
      ['Gyro', 1],
      ['Mag', 1],
    ]);

    const r = await rec.stop();
    expect(rec.active).toBe(false);
    expect(r.complete).toBe(true);
    expect(r.toFolder).toBe(true);
    expect(r.sessionName).toBe('Verisense_B10F_test');
    expect(r.files.map((f) => [f.key, f.rows])).toEqual([
      ['2', 6],
      ['6:accel', 1],
      ['6:gyro', 1],
      ['6:mag', 1],
    ]);

    const session = root.dirs.get('Verisense_B10F_test')!;
    expect([...session.files.keys()]).toEqual([
      'Verisense_B10F_test_Accel1.csv',
      'Verisense_B10F_test_Accel2.csv',
      'Verisense_B10F_test_Gyro.csv',
      'Verisense_B10F_test_Mag.csv',
    ]);

    const accel = session.files.get('Verisense_B10F_test_Accel1.csv')!;
    expect(accel.closed).toBe(true);
    const lines = accel.lines();
    expect(lines[0].split(',').slice(0, 4)).toEqual([...TIME_HEADERS, 'Accel1_X_raw']);
    expect(lines[1].split(',').slice(0, 3)).toEqual(['ms', 'ms', 'ticks']);
    const rows = lines.slice(2).map((l) => l.split(','));
    expect(rows).toHaveLength(6);
    // PacketTick only on the last row of each packet ...
    expect(rows.map((c) => c[2])).toEqual(['', '', '32768', '', '', String(32768 + 1966)]);
    // ... and that row's DeviceTime_ms IS the tick, not an interpolation.
    expect(Number(rows[2][1])).toBeCloseTo((32768 / 32768) * 1000, 3);
    expect(Number(rows[5][1])).toBeCloseTo(((32768 + 1966) / 32768) * 1000, 3);
    // The rows between are placed back at the configured 50 Hz (20 ms).
    expect(Number(rows[2][1]) - Number(rows[1][1])).toBeCloseTo(20, 3);
    // Device time never runs backwards across the packet boundary.
    const t = rows.map((c) => Number(c[1]));
    for (let i = 1; i < t.length; i++) expect(t[i]).toBeGreaterThan(t[i - 1]);

    // id 6: each sub-stream's only row in this packet is its measured one.
    for (const name of ['Accel2', 'Gyro', 'Mag']) {
      const [, , row] = session.files.get(`Verisense_B10F_test_${name}.csv`)!.lines();
      const cells = row.split(',');
      expect(cells[2]).toBe('65536');
      expect(Number(cells[1])).toBeCloseTo((65536 / 32768) * 1000, 3);
    }
  });

  it('opens a late stream when its first sample arrives', async () => {
    const root = new FakeDirectory();
    stubPicker(root);
    const rec = createVerisenseStreamRecorder({ sessionNameFn: () => 's' });
    await rec.start();
    const acc = new SensorLIS2DW12();
    rec.push(packet(acc, 2, new Uint8Array(6), 100));
    expect(rec.progress()).toHaveLength(1);
    const temp = new SensorMLX90632();
    rec.push(packet(temp, 9, new Uint8Array(4), 200));
    expect(rec.progress().map((p) => p.label)).toEqual(['Accel1', 'SkinTemp']);
    await rec.stop();
    expect([...root.dirs.get('s')!.files.keys()]).toEqual(['s_Accel1.csv', 's_SkinTemp.csv']);
  });

  it('resolves false when the folder picker is cancelled', async () => {
    vi.stubGlobal('showDirectoryPicker', async () => {
      throw Object.assign(new Error('cancelled'), { name: 'AbortError' });
    });
    const rec = createVerisenseStreamRecorder();
    expect(await rec.start()).toBe(false);
    expect(rec.active).toBe(false);
    expect(rec.push(packet(new SensorLIS2DW12(), 2, new Uint8Array(6), 1))).toBe(false);
  });

  it('ends the whole session when one file fails, closing the others', async () => {
    const root = new FakeDirectory();
    root.onNewFile = (name, w) => {
      if (name.endsWith('_SkinTemp.csv')) w.failWriteAt = 0;
    };
    stubPicker(root);
    const onError = vi.fn();
    const rec = createVerisenseStreamRecorder({
      sessionNameFn: () => 'f',
      onError,
      log: () => {},
    });
    await rec.start();
    rec.push(packet(new SensorLIS2DW12(), 2, new Uint8Array(6), 1));
    rec.push(packet(new SensorMLX90632(), 9, new Uint8Array(4), 2));
    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(rec.active).toBe(false);

    const info = onError.mock.calls[0][0];
    expect(info.complete).toBe(false);
    expect(info.error).toBe('disk full');
    const byLabel = Object.fromEntries(info.files.map((f: { label: string }) => [f.label, f]));
    expect(byLabel.Accel1.complete).toBe(true);
    expect(byLabel.SkinTemp.complete).toBe(false);
    // The healthy file was committed, not left locked.
    expect(root.dirs.get('f')!.files.get('f_Accel1.csv')!.closed).toBe(true);

    const r = await rec.stop();
    expect(r.complete).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('buffers in memory without a folder picker and hands every file over at once', async () => {
    const downloadFiles = vi.fn();
    const rec = createVerisenseStreamRecorder({
      sessionNameFn: () => 'mem',
      downloadFiles,
    });
    expect(await rec.start()).toBe(true);
    rec.push(packet(new SensorLIS2DW12(), 2, new Uint8Array(6), 1));
    rec.push(packet(new SensorMLX90632(), 9, new Uint8Array(4), 2));
    const r = await rec.stop();
    expect(r.toFolder).toBe(false);
    expect(r.complete).toBe(true);
    expect(downloadFiles).toHaveBeenCalledTimes(1);
    const files = downloadFiles.mock.calls[0][0] as { fileName: string; blob: Blob }[];
    expect(files.map((f) => f.fileName)).toEqual(['mem_Accel1.csv', 'mem_SkinTemp.csv']);
    const text = await blobText(files[1].blob);
    expect(text.split('\r\n')[0]).toBe(
      'HostTime_ms,DeviceTime_ms,PacketTick,Object_raw,Object_cal,Ambient_raw,Ambient_cal',
    );
  });
});
