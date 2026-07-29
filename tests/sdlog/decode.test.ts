import { describe, it, expect } from 'vitest';
import {
  decodeSdLogFile,
  decodeSdLogValue,
  decodeSdSession,
  SdLogFormatError,
  SDLOG_CLOCK_FREQ,
  SDLogHeaderBitmask as BM,
} from '../../src/devices/sdlog/index.js';
import {
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
} from '../../src/devices/shimmer3r/calibration.js';
import { buildFile, buildPacket, buildSdLogHeader, encodeValue } from './fixtures.js';

const ticksToMs = (ticks: number): number => (ticks / SDLOG_CLOCK_FREQ) * 1000;

const expectCode = (fn: () => unknown, code: string): void => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(SdLogFormatError);
    expect((e as SdLogFormatError).code).toBe(code);
    return;
  }
  expect.unreachable(`expected SdLogFormatError(${code})`);
};

describe('decodeSdLogValue — every datatype', () => {
  const cases: Array<[string, number[], number]> = [
    ['u8', [0xfe], 0xfe],
    ['u12', [0x34, 0x02], 0x0234],
    ['u14', [0xff, 0x3f], 0x3fff],
    ['u16', [0x01, 0xff], 0xff01],
    ['u16r', [0xff, 0x01], 0xff01],
    ['i16', [0xff, 0x7f], 32767],
    ['i16', [0x00, 0x80], -32768],
    ['i16', [0xfe, 0xff], -2],
    ['i16r', [0xff, 0xfe], -2],
    ['i16r', [0x12, 0x34], 0x1234],
    ['u24', [0x01, 0x02, 0x03], 0x030201],
    ['u24r', [0x01, 0x02, 0x03], 0x010203],
    ['i24r', [0xff, 0xff, 0xfd], -3],
    ['i24r', [0x7f, 0xff, 0xff], 8388607],
    ['u32r', [0x80, 0x00, 0x00, 0x01], 0x80000001],
    ['i32r', [0xff, 0xff, 0xff, 0xfc], -4],
    ['i32r', [0x7f, 0xff, 0xff, 0xff], 2147483647],
    ['i12*>', [0x7f, 0xf0], 2047],
    ['i12*>', [0x80, 0x00], -2048],
    ['i12*>', [0xff, 0xf0], -1],
    ['i12*>', [0x12, 0x30], 0x123],
  ];
  it.each(cases)('%s %j → %d', (type, bytes, expected) => {
    expect(decodeSdLogValue(new Uint8Array(bytes), 0, type as never)).toBe(expected);
  });

  it('round-trips every fixture encoding', () => {
    const samples: Array<[string, number]> = [
      ['u8', 200],
      ['u12', 4095],
      ['u14', 16383],
      ['u16', 65535],
      ['u16r', 51234],
      ['i16', -12345],
      ['i16r', -321],
      ['u24', 0xfedcba],
      ['u24r', 0xabcdef],
      ['i24r', -99999],
      ['u32r', 4000000000],
      ['i32r', -2000000000],
      ['i12*>', -1234],
    ];
    for (const [type, value] of samples) {
      const enc = new Uint8Array(encodeValue(type as never, value));
      expect(decodeSdLogValue(enc, 0, type as never), type).toBe(value);
    }
  });
});

describe('decodeSdLogFile — Shimmer3 basic decoding', () => {
  const enabled = BM.ACCEL_LN | BM.GSR;
  const initialTs = 1000;

  const makeFile = (rtc: bigint): Uint8Array => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5], // u24 timestamps
      enabledSensors: enabled,
      gsrRange: 1,
      initialTimestampTicks: initialTs,
      rtcDifferenceTicks: rtc,
      // All-0xFF calibration blocks → no per-device calibration, so the LN accel
      // channels use the range-selected DEFAULT (Kionix KXRB 2g).
      calibFill: () => 0xff,
    });
    const gsrRaw = 2000;
    const pkt = (ts: number, ax: number): number[] =>
      buildPacket(ts, 3, [
        ...encodeValue('u12', ax),
        ...encodeValue('u12', 101),
        ...encodeValue('u12', 102),
        ...encodeValue('u16', gsrRaw),
      ]);
    return buildFile(header, pkt(100, 11), pkt(612, 12), pkt(1124, 13));
  };

  it('decodes values aligned 1:1 with header.channels', () => {
    const { header, records, truncated } = decodeSdLogFile(makeFile(0n));
    expect(truncated).toBe(false);
    expect(header.channels.map((c) => c.name)).toEqual([
      'LN_ACCEL_X',
      'LN_ACCEL_Y',
      'LN_ACCEL_Z',
      'GSR',
    ]);
    // LN accel channels are now emitted calibrated (m/(s^2)).
    expect(header.channels.slice(0, 3).every((c) => c.calibrated && c.unit === 'm/(s^2)')).toBe(
      true,
    );
    // Default Kionix KXRB 2g calibration (SensorKionixKXRB52042):
    //   offset = [2047,2047,2047], sens = diag(83),
    //   align  = [[0,-1,0],[-1,0,0],[0,0,-1]] (an involution → inv(align)=align)
    //   M = inv(align)·inv(diag(83)) = [[0,-1/83,0],[-1/83,0,0],[0,0,-1/83]]
    // Packet 0 raw = [11,101,102]; d = raw − offset = [-2036,-1946,-1945].
    //   Cx = -d1/83 = 1946/83, Cy = -d0/83 = 2036/83, Cz = -d2/83 = 1945/83.
    expect(records).toHaveLength(3);
    expect(records[0].values[0]).toBeCloseTo(1946 / 83, 10);
    expect(records[0].values[1]).toBeCloseTo(2036 / 83, 10);
    expect(records[0].values[2]).toBeCloseTo(1945 / 83, 10);
    // Packet 1 raw X = 12 → d0 = 12-2047 = -2035 → Cy = 2035/83.
    expect(records[1].values[1]).toBeCloseTo(2035 / 83, 10);
    // Packet 2 raw X = 13 → d0 = 13-2047 = -2034 → Cy = 2034/83.
    expect(records[2].values[1]).toBeCloseTo(2034 / 83, 10);

    // GSR calibrated through the SDK's amplifier-equation path (range 1).
    const expectedGsr =
      (1.0 / nudgeGsrResistance(calibrateGsrDataToResistanceFromAmplifierEq(2000 & 0xfff, 1), 1)) *
      1000;
    expect(records[0].values[3]).toBeCloseTo(expectedGsr, 10);
  });

  it('computes timestampMs as initialTs + (unwrapped - first raw ts), Java-style', () => {
    const { records } = decodeSdLogFile(makeFile(0n));
    // First packet lands exactly on the header's initial timestamp; later
    // packets advance by the elapsed ticks since the first packet.
    expect(records[0].timestampMs).toBeCloseTo(ticksToMs(initialTs), 10);
    expect(records[1].timestampMs).toBeCloseTo(ticksToMs(initialTs + 512), 10);
    expect(records[2].timestampMs).toBeCloseTo(ticksToMs(initialTs + 1024), 10);
    expect(records[0].wallClockMs).toBeNull(); // RTC difference unset
  });

  it('emits wallClockMs when the RTC difference is set', () => {
    const rtc = 55605813443136n; // ~2023 in ticks
    const { records } = decodeSdLogFile(makeFile(rtc));
    expect(records[0].wallClockMs).toBeCloseTo(ticksToMs(initialTs + Number(rtc)), 6);
    expect(records[1].wallClockMs).toBeCloseTo(ticksToMs(initialTs + 512 + Number(rtc)), 6);
  });

  it('uses the TCXO sampling clock for wallClockMs but 32768 for timestampMs', () => {
    // TCXO set (byte 17 bit 4) without the 20 MHz EXG-unified rev-1.1 board →
    // getSamplingClockFreq() = 255765.625 Hz for the RTC conversion only.
    const rtc = 55605813443136n;
    const tcxoFreq = 255765.625;
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: enabled,
      gsrRange: 1,
      initialTimestampTicks: initialTs,
      rtcDifferenceTicks: rtc,
      tcxo: true,
    });
    const gsrRaw = 2000;
    const pkt = (ts: number, ax: number): number[] =>
      buildPacket(ts, 3, [
        ...encodeValue('u12', ax),
        ...encodeValue('u12', 101),
        ...encodeValue('u12', 102),
        ...encodeValue('u16', gsrRaw),
      ]);
    const file = buildFile(header, pkt(100, 11), pkt(612, 12));
    const { header: h, records } = decodeSdLogFile(file);
    expect(h.tcxo).toBe(true);
    // Device clock still divides by 32768 (getRtcClockFreq).
    expect(records[0].timestampMs).toBeCloseTo(ticksToMs(initialTs), 10);
    // Wall clock divides by the TCXO frequency.
    expect(records[0].wallClockMs).toBeCloseTo(((initialTs + Number(rtc)) / tcxoFreq) * 1000, 3);
    expect(records[1].wallClockMs).toBeCloseTo(
      ((initialTs + 512 + Number(rtc)) / tcxoFreq) * 1000,
      3,
    );
  });

  it('uses the 20 MHz TCXO clock for the EXG-unified rev-1.1 board', () => {
    const rtc = 55605813443136n;
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 13, 1], // >= 0.12.4 so the expansion board is stored in-header
      enabledSensors: enabled,
      gsrRange: 1,
      initialTimestampTicks: initialTs,
      rtcDifferenceTicks: rtc,
      tcxo: true,
      expansionBoard: [47, 1, 1], // EXG_UNIFIED rev 1 revSpecial 1 → 312500 Hz
    });
    const gsrRaw = 2000;
    const file = buildFile(
      header,
      buildPacket(100, 3, [
        ...encodeValue('u12', 11),
        ...encodeValue('u12', 101),
        ...encodeValue('u12', 102),
        ...encodeValue('u16', gsrRaw),
      ]),
    );
    const { records } = decodeSdLogFile(file);
    expect(records[0].wallClockMs).toBeCloseTo(((initialTs + Number(rtc)) / 312500.0) * 1000, 3);
  });

  it('drops a trailing partial packet', () => {
    const full = makeFile(0n);
    const truncatedFile = full.slice(0, full.length - 3);
    const { records } = decodeSdLogFile(truncatedFile);
    expect(records).toHaveLength(2);
  });

  it('honors maxRecords and reports truncation', () => {
    const limited = decodeSdLogFile(makeFile(0n), { maxRecords: 2 });
    expect(limited.records).toHaveLength(2);
    expect(limited.truncated).toBe(true);
    const exact = decodeSdLogFile(makeFile(0n), { maxRecords: 3 });
    expect(exact.records).toHaveLength(3);
    expect(exact.truncated).toBe(false);
  });

  it('throws NO_DATA for a header-only file', () => {
    expectCode(() => decodeSdLogFile(buildSdLogHeader({ enabledSensors: enabled })), 'NO_DATA');
  });
});

describe('decodeSdLogFile — timestamp rollover unwrapping', () => {
  it('unwraps across a 16-bit rollover (SDLog 0.9.x → u16 timestamps)', () => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 9, 0],
      enabledSensors: BM.GSR,
      initialTimestampTicks: 0,
    });
    const pkt = (ts: number): number[] => buildPacket(ts, 2, encodeValue('u16', 0));
    const file = buildFile(header, pkt(65530), pkt(65535), pkt(4), pkt(9), pkt(2));
    const { header: h, records } = decodeSdLogFile(file);
    expect(h.timestampBytes).toBe(2);
    // Elapsed ticks relative to the first packet (raw 65530).
    const ticks = records.map((r) => (r.timestampMs / 1000) * SDLOG_CLOCK_FREQ);
    expect(ticks[0]).toBeCloseTo(0, 6);
    expect(ticks[1]).toBeCloseTo(5, 6);
    expect(ticks[2]).toBeCloseTo(65536 + 4 - 65530, 6); // first rollover
    expect(ticks[3]).toBeCloseTo(65536 + 9 - 65530, 6);
    expect(ticks[4]).toBeCloseTo(2 * 65536 + 2 - 65530, 6); // second rollover
  });

  it('unwraps across a 24-bit rollover (u24 timestamps)', () => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: BM.GSR,
    });
    const pkt = (ts: number): number[] => buildPacket(ts, 3, encodeValue('u16', 0));
    const file = buildFile(header, pkt(16777200), pkt(10));
    const { records } = decodeSdLogFile(file);
    const ticks = records.map((r) => (r.timestampMs / 1000) * SDLOG_CLOCK_FREQ);
    expect(ticks[0]).toBeCloseTo(0, 6);
    expect(ticks[1]).toBeCloseTo(16777216 + 10 - 16777200, 6);
  });
});

describe('decodeSdLogFile — sync-when-logging block framing', () => {
  // Three external-ADC channels (u12, uncalibrated) → packet = 3 (ts) + 6 = 9
  // bytes; samplesPerBlock = floor((512 - 9) / 9) = 55. Deliberately NOT
  // inertial channels, so raw values pass through unchanged and these tests
  // assert framing/alignment rather than calibration.
  const enabled = BM.EXT_EXP_A7 | BM.EXT_EXP_A6 | BM.EXT_EXP_A15;
  const SAMPLES_PER_BLOCK = 55;

  const syncFile = (totalPackets: number): Uint8Array => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: enabled,
      syncWhenLogging: true,
    });
    const chunks: number[][] = [];
    for (let i = 0; i < totalPackets; i++) {
      if (i % SAMPLES_PER_BLOCK === 0) {
        // 9-byte timestamp-offset field — junk pattern the decoder must skip.
        chunks.push([0x01, 0xde, 0xad, 0xbe, 0xef, 0x55, 0x66, 0x77, 0x08]);
      }
      chunks.push(
        buildPacket(i, 3, [
          ...encodeValue('u12', 1000 + i),
          ...encodeValue('u12', 2000 + i),
          ...encodeValue('u12', 3000 + i),
        ]),
      );
    }
    return buildFile(header, ...chunks);
  };

  it('strips the 9-byte offset before the first packet of every 512-byte block', () => {
    const total = SAMPLES_PER_BLOCK + 3; // spans two blocks
    const { records } = decodeSdLogFile(syncFile(total));
    expect(records).toHaveLength(total);
    // Alignment must survive the block boundary: check the packets around it.
    for (const i of [0, 1, SAMPLES_PER_BLOCK - 1, SAMPLES_PER_BLOCK, SAMPLES_PER_BLOCK + 2]) {
      expect(records[i].values).toEqual([1000 + i, 2000 + i, 3000 + i]);
      expect(records[i].timestampMs).toBeCloseTo(ticksToMs(i), 10);
    }
  });

  it('decodes exactly three full blocks without shear', () => {
    const total = SAMPLES_PER_BLOCK * 3;
    const { records } = decodeSdLogFile(syncFile(total));
    expect(records).toHaveLength(total);
    expect(records[total - 1].values[0]).toBe(1000 + total - 1);
  });

  it('does not apply block framing when the sync bit is clear', () => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: enabled,
      syncWhenLogging: false,
    });
    const file = buildFile(
      header,
      buildPacket(0, 3, [
        ...encodeValue('u12', 1),
        ...encodeValue('u12', 2),
        ...encodeValue('u12', 3),
      ]),
    );
    const { records } = decodeSdLogFile(file);
    expect(records[0].values).toEqual([1, 2, 3]);
  });

  it('does not frame LogAndStream on Shimmer3 below 0.16.11 even with the bit set', () => {
    const header = buildSdLogHeader({
      fwId: 3,
      fwVersion: [0, 9, 0],
      enabledSensors: enabled,
      syncWhenLogging: true,
    });
    const file = buildFile(
      header,
      buildPacket(0, 3, [
        ...encodeValue('u12', 7),
        ...encodeValue('u12', 8),
        ...encodeValue('u12', 9),
      ]),
    );
    const { records } = decodeSdLogFile(file);
    expect(records[0].values).toEqual([7, 8, 9]);
  });
});

describe('decodeSdLogFile — Shimmer3R end-to-end', () => {
  it('decodes battery (i16), high-g (i12*>) and GSR channels', () => {
    const header = buildSdLogHeader({
      hw: 10,
      fwId: 3,
      fwVersion: [0, 1, 0],
      signalIds: [0x03, 0x14, 0x15, 0x16, 0x1c],
      gsrRange: 4, // auto-range: range travels in GSR raw bits 14-15
      initialTimestampTicks: 42,
      // All-0xFF calibration blocks → high-g accel uses the ADXL371 DEFAULT.
      calibFill: () => 0xff,
    });
    const gsrRaw = (2 << 14) | 1500; // auto-range says range 2, adc 1500
    const file = buildFile(
      header,
      buildPacket(7, 3, [
        ...encodeValue('i16', -1234),
        ...encodeValue('i12*>', -100),
        ...encodeValue('i12*>', 0),
        ...encodeValue('i12*>', 2047),
        ...encodeValue('u16', gsrRaw),
      ]),
    );
    const { header: h, records } = decodeSdLogFile(file);
    expect(h.timestampBytes).toBe(3);
    expect(records).toHaveLength(1);
    // BATTERY (i16, uncalibrated) passes through unchanged: -1234.
    // High-g accel (ADXL371 default, SensorADXL371): offset=[10,10,10],
    //   sens=diag(1), align=[[0,1,0],[1,0,0],[0,0,-1]] (involution → inv=align)
    //   M = align. raw=[-100,0,2047]; d = raw − 10 = [-110,-10,2037].
    //   Cx = d1 = -10, Cy = d0 = -110, Cz = -d2 = -2037.
    expect(records[0].values.slice(0, 4)).toEqual([-1234, -10, -110, -2037]);
    // High-g channels emitted calibrated (m/(s^2)).
    expect(h.channels.slice(1, 4).every((c) => c.calibrated && c.unit === 'm/(s^2)')).toBe(true);
    const expectedGsr =
      (1.0 / nudgeGsrResistance(calibrateGsrDataToResistanceFromAmplifierEq(1500, 2), 4)) * 1000;
    expect(records[0].values[4]).toBeCloseTo(expectedGsr, 10);
    // First packet lands on the header's initial timestamp (Java-exact math).
    expect(records[0].timestampMs).toBeCloseTo(ticksToMs(42), 10);
  });
});

describe('decodeSdSession — multi-file continuation', () => {
  const enabled = BM.GSR;

  const sessionFile = (initialTs: number, firstTick: number, count: number): Uint8Array => {
    const header = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: enabled,
      initialTimestampTicks: initialTs,
    });
    const packets: number[][] = [];
    for (let i = 0; i < count; i++) {
      packets.push(buildPacket(firstTick + i * 512, 3, encodeValue('u16', i)));
    }
    return buildFile(header, ...packets);
  };

  it('concatenates files in numeric order with per-file absolute time', () => {
    // Modern firmware writes each file's full clock at its first packet into
    // that file's header (initialTs), so absolute time is continuous across
    // the boundary: file 000 covers ticks 100..1124, file 001 starts at 1636.
    const f0 = sessionFile(100, 100, 3);
    const f1 = sessionFile(1636, 1636, 2);
    const { records, truncated } = decodeSdSession([
      { name: '001', bytes: f1 }, // deliberately out of order
      { name: '000', bytes: f0 },
    ]);
    expect(truncated).toBe(false);
    expect(records).toHaveLength(5);
    const ticks = records.map((r) => Math.round((r.timestampMs / 1000) * SDLOG_CLOCK_FREQ));
    expect(ticks).toEqual([100, 612, 1124, 1636, 2148]);
    // Strictly increasing across the file boundary.
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1]);
  });

  it('ignores files whose names contain a dot', () => {
    const f0 = sessionFile(0, 0, 2);
    const { records } = decodeSdSession([
      { name: '000', bytes: f0 },
      { name: 'header.txt', bytes: new Uint8Array([1, 2, 3]) },
    ]);
    expect(records).toHaveLength(2);
  });

  it('applies maxRecords across files', () => {
    const f0 = sessionFile(0, 0, 3);
    const f1 = sessionFile(2000, 2000, 3);
    const res = decodeSdSession(
      [
        { name: '000', bytes: f0 },
        { name: '001', bytes: f1 },
      ],
      { maxRecords: 4 },
    );
    expect(res.records).toHaveLength(4);
    expect(res.truncated).toBe(true);
  });

  it('rejects duplicate file numbers', () => {
    const f = sessionFile(0, 0, 1);
    expectCode(
      () =>
        decodeSdSession([
          { name: '000', bytes: f },
          { name: '000', bytes: f },
        ]),
      'INCONSISTENT_SESSION',
    );
  });

  it('rejects mismatched headers (MAC / rate / sensors / trial id)', () => {
    const f0 = sessionFile(0, 0, 1);
    const otherMac = buildFile(
      buildSdLogHeader({
        fwId: 2,
        fwVersion: [0, 11, 5],
        enabledSensors: enabled,
        mac: [1, 2, 3, 4, 5, 6],
      }),
      buildPacket(0, 3, encodeValue('u16', 0)),
    );
    expectCode(
      () =>
        decodeSdSession([
          { name: '000', bytes: f0 },
          { name: '001', bytes: otherMac },
        ]),
      'INCONSISTENT_SESSION',
    );

    const otherSensors = buildFile(
      buildSdLogHeader({ fwId: 2, fwVersion: [0, 11, 5], enabledSensors: BM.GSR | BM.ACCEL_LN }),
      buildPacket(0, 3, [
        ...encodeValue('u12', 0),
        ...encodeValue('u12', 0),
        ...encodeValue('u12', 0),
        ...encodeValue('u16', 0),
      ]),
    );
    expectCode(
      () =>
        decodeSdSession([
          { name: '000', bytes: f0 },
          { name: '001', bytes: otherSensors },
        ]),
      'INCONSISTENT_SESSION',
    );
  });

  it('rejects non-numeric dot-free names and empty inputs', () => {
    expectCode(() => decodeSdSession([]), 'NO_DATA');
    expectCode(
      () => decodeSdSession([{ name: 'notes', bytes: sessionFile(0, 0, 1) }]),
      'BAD_HEADER',
    );
  });

  it('throws NO_DATA when every file is header-only', () => {
    expectCode(
      () =>
        decodeSdSession([{ name: '000', bytes: buildSdLogHeader({ enabledSensors: enabled }) }]),
      'NO_DATA',
    );
  });

  it('skips a header-only file but keeps the rest of the session', () => {
    const headerOnly = buildSdLogHeader({
      fwId: 2,
      fwVersion: [0, 11, 5],
      enabledSensors: enabled,
    });
    const f1 = sessionFile(0, 0, 2);
    const { records } = decodeSdSession([
      { name: '000', bytes: headerOnly },
      { name: '001', bytes: f1 },
    ]);
    expect(records).toHaveLength(2);
  });
});
