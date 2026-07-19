import { describe, it, expect } from 'vitest';
import {
  decodeVerisenseLoggedData,
  splitVerisenseLoggedPages,
  findLoggedPayloadIndexGaps,
  verifyLoggedPageCrc,
  resolveLoggedBlockSize,
  loggedFooterLength,
  loggedPayloadConfigLength,
  LOGGED_DATABLOCK_SENSOR_ID,
  LOGGED_LIS2DW12_BLOCK_BYTES,
  LOGGED_ADC_BLOCK_BYTES,
} from '../../src/index.js';
import { crc16_ccitt_false } from '../../src/devices/verisense/protocol.js';
import type { CalibrationSet } from '../../src/devices/verisense/calibration.js';
import { CalibSensorId } from '../../src/devices/verisense/calibration.js';
import type { LIS2DW12Sample } from '../../src/devices/verisense/sensors/SensorLIS2DW12.js';

// ---------------------------------------------------------------------------
// Fixture builders — construct pages exactly as the firmware/Java reference
// would (index + length + config + data blocks + footer + CRC-16/CCITT-FALSE),
// so a round-trip through the decoder is a real end-to-end check.
// ---------------------------------------------------------------------------

const DESIGN_VERSION = 9; // footer = minutes(4)+ticks(3)+temp(2)+batt(2) = 11 bytes
const FOOTER_LEN = loggedFooterLength(DESIGN_VERSION);

/** A single flash data block: [sensorId(1)][tick u24 LE(3)][body]. */
function buildDataBlock(sensorId: number, tick: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + body.length);
  out[0] = sensorId & 0xff;
  out[1] = tick & 0xff;
  out[2] = (tick >> 8) & 0xff;
  out[3] = (tick >> 16) & 0xff;
  out.set(body, 4);
  return out;
}

/** A v9 footer with the given fields (all little-endian). */
function buildFooter(minutes: number, ticks: number, tempRaw: number, battRaw: number): Uint8Array {
  const f = new Uint8Array(FOOTER_LEN);
  f[0] = minutes & 0xff;
  f[1] = (minutes >> 8) & 0xff;
  f[2] = (minutes >> 16) & 0xff;
  f[3] = (minutes >> 24) & 0xff;
  f[4] = ticks & 0xff;
  f[5] = (ticks >> 8) & 0xff;
  f[6] = (ticks >> 16) & 0xff;
  f[7] = tempRaw & 0xff;
  f[8] = (tempRaw >> 8) & 0xff;
  f[9] = battRaw & 0xff;
  f[10] = (battRaw >> 8) & 0xff;
  return f;
}

interface BuildPageOpts {
  payloadIndex: number;
  /** Core config bytes (default 2 bytes, extended-config bit clear → configLen = 2). */
  config?: number[];
  blocks: Uint8Array[];
  footer?: Uint8Array;
  corruptCrc?: boolean;
}

function buildPage(opts: BuildPageOpts): Uint8Array {
  const config = opts.config ?? [0x00, 0x00]; // no extended-config bit set
  const footer = opts.footer ?? buildFooter(100, 1234, 0x0140, 0x0abc);
  const dataBytes = opts.blocks.reduce((n, b) => n + b.length, 0);
  const payloadLength = config.length + dataBytes + footer.length;
  const total = payloadLength + 6; // index(2)+length(2)+crc(2)

  const page = new Uint8Array(total);
  page[0] = opts.payloadIndex & 0xff;
  page[1] = (opts.payloadIndex >> 8) & 0xff;
  page[2] = payloadLength & 0xff;
  page[3] = (payloadLength >> 8) & 0xff;
  let p = 4;
  for (const c of config) page[p++] = c & 0xff;
  for (const b of opts.blocks) {
    page.set(b, p);
    p += b.length;
  }
  page.set(footer, p);

  const crc = crc16_ccitt_false(page.subarray(0, total - 2));
  page[total - 2] = crc & 0xff;
  page[total - 1] = (crc >> 8) & 0xff;
  if (opts.corruptCrc) page[total - 1] ^= 0xff;
  return page;
}

/** 32-sample LIS2DW12 FIFO body (192 bytes), each axis = i16 LE. */
function buildLis2dw12Body(sampleGen: (i: number) => [number, number, number]): Uint8Array {
  const n = LOGGED_LIS2DW12_BLOCK_BYTES / 6; // 32 samples
  const body = new Uint8Array(LOGGED_LIS2DW12_BLOCK_BYTES);
  for (let i = 0; i < n; i++) {
    const [x, y, z] = sampleGen(i);
    const o = i * 6;
    body[o] = x & 0xff;
    body[o + 1] = (x >> 8) & 0xff;
    body[o + 2] = y & 0xff;
    body[o + 3] = (y >> 8) & 0xff;
    body[o + 4] = z & 0xff;
    body[o + 5] = (z >> 8) & 0xff;
  }
  return body;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of arrs) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

// ---------------------------------------------------------------------------

describe('layout helpers', () => {
  it('footer length matches the Java BYTE_COUNT tables', () => {
    expect(loggedFooterLength(8)).toBe(8);
    expect(loggedFooterLength(9)).toBe(11);
    expect(loggedFooterLength(11)).toBe(18);
  });

  it('config length: core-only when not extended, +4 FW ver + extended when set', () => {
    expect(loggedPayloadConfigLength(9, false)).toBe(2);
    // v9 extended = 1+4+5+1+2+1+4 = 18, + 2 core + 4 fwver = 24
    expect(loggedPayloadConfigLength(9, true)).toBe(24);
  });

  it('resolves fixed block sizes for ADC and LIS2DW12, null for unsizable ids', () => {
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.ADC, null)).toBe(
      LOGGED_ADC_BLOCK_BYTES,
    );
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1, null)).toBe(
      LOGGED_LIS2DW12_BLOCK_BYTES,
    );
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.PPG, null)).toBeNull();
    expect(resolveLoggedBlockSize(3, null)).toBeNull(); // LSM6DS3 needs op config
    expect(resolveLoggedBlockSize(99, null, { 99: 48 })).toBe(48); // override wins
  });
});

describe('splitVerisenseLoggedPages', () => {
  it('splits a concatenation at the per-page length field', () => {
    const p0 = buildPage({
      payloadIndex: 0,
      blocks: [
        buildDataBlock(
          2,
          10,
          buildLis2dw12Body(() => [1, 2, 3]),
        ),
      ],
    });
    const p1 = buildPage({
      payloadIndex: 1,
      blocks: [
        buildDataBlock(
          2,
          20,
          buildLis2dw12Body(() => [4, 5, 6]),
        ),
      ],
    });
    const split = splitVerisenseLoggedPages(concat(p0, p1));
    expect(split.pages.map((x) => x.payloadIndex)).toEqual([0, 1]);
    expect(split.truncatedTrailingPage).toBe(false);
    expect(split.trailingByteCount).toBe(0);
  });

  it('empty input yields no pages', () => {
    const split = splitVerisenseLoggedPages(new Uint8Array(0));
    expect(split.pages).toHaveLength(0);
    expect(split.trailingByteCount).toBe(0);
  });
});

describe('decodeVerisenseLoggedData', () => {
  it('decodes a clean multi-sensor page set (LIS2DW12 + ADC)', () => {
    const lisBody = buildLis2dw12Body((i) => [i + 1, -(i + 1), (i + 1) * 2]);
    const adcBody = new Uint8Array(LOGGED_ADC_BLOCK_BYTES); // GSR-only default → 96 samples
    for (let i = 0; i < adcBody.length; i++) adcBody[i] = i & 0xff;

    const page = buildPage({
      payloadIndex: 7,
      blocks: [buildDataBlock(2, 1000, lisBody), buildDataBlock(1, 1050, adcBody)],
    });

    const res = decodeVerisenseLoggedData(page);
    expect(res.pagesTotal).toBe(1);
    expect(res.pagesBad).toBe(0);
    expect(res.recordsSkipped).toBe(0);
    expect(res.truncatedTrailingPage).toBe(false);

    const lis = res.sensors[2];
    expect(lis.samplesDecoded).toBe(32);
    expect(lis.blocks).toBe(1);
    const first = lis.samples[0] as LIS2DW12Sample;
    expect(first.raw).toEqual([1, -1, 2]);
    const fourth = lis.samples[3] as LIS2DW12Sample;
    expect(fourth.raw).toEqual([4, -4, 8]); // exact round-trip of raw i16 axes

    const adc = res.sensors[1];
    expect(adc.samplesDecoded).toBe(96); // 192 bytes / 2 bytes-per-sample (GSR only)
    expect(res.samplesDecoded).toBe(32 + 96);

    // Footer parsed.
    expect(res.footers).toHaveLength(1);
    expect(res.footers[0].payloadIndex).toBe(7);
    expect(res.footers[0].rtcMinutes).toBe(100);
    expect(res.footers[0].rtcTicks).toBe(1234);
    expect(res.footers[0].batteryRaw).toBe(0x0abc & 0x0fff);
  });

  it('counts a CRC-bad page without throwing and decodes nothing from it', () => {
    const good = buildPage({
      payloadIndex: 0,
      blocks: [
        buildDataBlock(
          2,
          10,
          buildLis2dw12Body(() => [1, 1, 1]),
        ),
      ],
    });
    const bad = buildPage({
      payloadIndex: 1,
      blocks: [
        buildDataBlock(
          2,
          20,
          buildLis2dw12Body(() => [2, 2, 2]),
        ),
      ],
      corruptCrc: true,
    });
    const res = decodeVerisenseLoggedData(concat(good, bad));
    expect(res.pagesTotal).toBe(2);
    expect(res.pagesBad).toBe(1);
    expect(res.sensors[2].samplesDecoded).toBe(32); // only the good page
    expect(verifyLoggedPageCrc(good)).toBe(true);
    expect(verifyLoggedPageCrc(bad)).toBe(false);
  });

  it('reports a truncated final page and still decodes the complete ones', () => {
    const full = buildPage({
      payloadIndex: 0,
      blocks: [
        buildDataBlock(
          2,
          10,
          buildLis2dw12Body(() => [3, 3, 3]),
        ),
      ],
    });
    const full2 = buildPage({
      payloadIndex: 1,
      blocks: [
        buildDataBlock(
          2,
          20,
          buildLis2dw12Body(() => [4, 4, 4]),
        ),
      ],
    });
    // Chop the second page in half → declared length overruns the buffer.
    const truncated = full2.subarray(0, Math.floor(full2.length / 2));
    const res = decodeVerisenseLoggedData(concat(full, truncated));
    expect(res.pagesTotal).toBe(1);
    expect(res.truncatedTrailingPage).toBe(true);
    expect(res.trailingByteCount).toBe(truncated.length);
    expect(res.sensors[2].samplesDecoded).toBe(32);
  });

  it('handles empty input', () => {
    const res = decodeVerisenseLoggedData(new Uint8Array(0));
    expect(res.pagesTotal).toBe(0);
    expect(res.samplesDecoded).toBe(0);
    expect(res.pagesBad).toBe(0);
    expect(res.recordsSkipped).toBe(0);
    expect(res.sensors).toEqual({});
  });

  it('skips (does not guess) a datablock whose sensor id cannot be sized', () => {
    // PPG (id 4) has no built-in block size and no override → the page is
    // reported with a skipped record rather than mis-parsed.
    const page = buildPage({
      payloadIndex: 0,
      blocks: [buildDataBlock(4, 10, new Uint8Array(96))],
    });
    const res = decodeVerisenseLoggedData(page);
    expect(res.pagesTotal).toBe(1);
    expect(res.pagesBad).toBe(0);
    expect(res.recordsSkipped).toBe(1);
    expect(res.pagesWithSkippedRecords).toBe(1);
    expect(res.samplesDecoded).toBe(0);
  });

  it('applies calibration when supplied and falls back to datasheet scaling otherwise', () => {
    const body = buildLis2dw12Body(() => [3343, 0, 0]); // ~2 m/s^2 at 2G datasheet sens
    const page = buildPage({ payloadIndex: 0, blocks: [buildDataBlock(2, 10, body)] });

    // Raw fallback (no calibration): cal = alignment(raw) / datasheet sensitivity
    // (2G). The default LIS2DW12 alignment maps input X onto output axis 1.
    const rawRes = decodeVerisenseLoggedData(page, { applyCalibration: false });
    const rawSample = rawRes.sensors[2].samples[0] as LIS2DW12Sample;
    expect(rawSample.raw[0]).toBe(3343);
    expect(rawSample.cal[1]).toBeCloseTo(3343 / 1671.665922915, 6);

    // Custom calibration set: identity align, sens=[2,2,2], bias=0 → cal = raw/2.
    const fakeCal: CalibrationSet = {
      formatVersion: 1,
      hwVerMajor: 0,
      hwVerMinor: 0,
      fwVerMajor: 0,
      fwVerMinor: 0,
      fwVerPatch: 0,
      reserved: 0,
      blocks: [],
      crc16: 0,
      getImu(sensorId: number) {
        if (sensorId === CalibSensorId.LIS2DW12_ACCEL) {
          return { bias: [0, 0, 0], sens: [2, 2, 2], align: [1, 0, 0, 0, 1, 0, 0, 0, 1] };
        }
        return null;
      },
    };
    const calRes = decodeVerisenseLoggedData(page, { calibration: fakeCal });
    const calSample = calRes.sensors[2].samples[0] as LIS2DW12Sample;
    expect(calSample.raw[0]).toBe(3343); // raw unchanged
    expect(calSample.cal[0]).toBeCloseTo(3343 / 2, 6); // calibrated path used
  });

  it('reconstructs per-sample timestamps from the block tick (reusing SensorBase)', () => {
    // LIS2DW12 default sampling rate = 50 Hz → 20 ms per sample.
    const page = buildPage({
      payloadIndex: 0,
      blocks: [
        buildDataBlock(
          2,
          32768,
          buildLis2dw12Body(() => [1, 1, 1]),
        ),
      ],
    });
    const res = decodeVerisenseLoggedData(page);
    const s = res.sensors[2].samples as Array<{ timestamps: { tsMillis: number } }>;
    expect(s).toHaveLength(32);
    const dt = s[31].timestamps.tsMillis - s[30].timestamps.tsMillis;
    expect(dt).toBeCloseTo(1000 / 50, 3); // 20 ms spacing
  });

  it('derives the LSM6DS3 block size from the operational config FIFO threshold', () => {
    // Craft an op config with FIFO threshold = 12 → fifoSizeInChip*2 = 24 bytes
    // = 2 samples (accel+gyro, 12 bytes each). OP_IDX.GYRO_ACCEL2_CFG_0 = 10 (LSB),
    // GYRO_ACCEL2_CFG_1 = 11 (MSB low nibble). GEN_CFG_0 bits enable acc+gyro.
    const op = new Uint8Array(80);
    op[1] = 0b01100000; // GEN_CFG_0: accel + gyro enabled
    op[10] = 12; // FTH LSB → fifoSizeInChip = 12
    op[11] = 0; // FTH MSB nibble = 0
    expect(resolveLoggedBlockSize(3, op)).toBe(24);

    const body = new Uint8Array(24); // 2 samples of 12 bytes
    const page = buildPage({ payloadIndex: 0, blocks: [buildDataBlock(3, 5, body)] });
    const res = decodeVerisenseLoggedData(page, { operationalConfig: op });
    expect(res.recordsSkipped).toBe(0);
    expect(res.sensors[3].samplesDecoded).toBe(2);
  });

  it('stops at the 0xFFFF/0xFFFF erased-flash sentinel', () => {
    const good = buildPage({
      payloadIndex: 0,
      blocks: [
        buildDataBlock(
          LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
          1,
          buildLis2dw12Body(() => [0, 0, 0]),
        ),
      ],
    });
    const blob = concat(good, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0, 0, 0, 0]));
    const split = splitVerisenseLoggedPages(blob);
    expect(split.pages).toHaveLength(1);
    expect(split.truncatedTrailingPage).toBe(false);
  });
});

describe('findLoggedPayloadIndexGaps', () => {
  it('reports dropped-page gaps and resets in the payload-index sequence', () => {
    const gaps = findLoggedPayloadIndexGaps([
      { payloadIndex: 0 },
      { payloadIndex: 1 },
      { payloadIndex: 5 }, // dropped 2,3,4
      { payloadIndex: 6 },
      { payloadIndex: 2 }, // reset / wrap (non-increasing)
    ]);
    expect(gaps).toEqual([
      { afterPayloadIndex: 1, nextPayloadIndex: 5, missing: 3 },
      { afterPayloadIndex: 6, nextPayloadIndex: 2, missing: 0 },
    ]);
  });

  it('treats the u16 wraparound 65535 → 0 as continuity, not a reset', () => {
    const gaps = findLoggedPayloadIndexGaps([
      { payloadIndex: 65534 },
      { payloadIndex: 65535 },
      { payloadIndex: 0 }, // natural u16 wrap — must NOT be flagged
      { payloadIndex: 1 },
    ]);
    expect(gaps).toEqual([]);
  });

  it('still flags a non-wrap reset that happens to land on 0', () => {
    // 6 → 0 is not the 65535→0 wrap, so it is a genuine reset.
    const gaps = findLoggedPayloadIndexGaps([{ payloadIndex: 6 }, { payloadIndex: 0 }]);
    expect(gaps).toEqual([{ afterPayloadIndex: 6, nextPayloadIndex: 0, missing: 0 }]);
  });

  it('is surfaced on the decode result', () => {
    const mkPage = (idx: number): Uint8Array =>
      buildPage({
        payloadIndex: idx,
        blocks: [
          buildDataBlock(
            LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
            idx,
            buildLis2dw12Body(() => [1, 1, 1]),
          ),
        ],
      });
    const res = decodeVerisenseLoggedData(concat(mkPage(0), mkPage(3)));
    expect(res.payloadIndexGaps).toEqual([
      { afterPayloadIndex: 0, nextPayloadIndex: 3, missing: 2 },
    ]);
  });
});

describe('decodeVerisenseLoggedData — boundary guard (never mis-decodes on a wrong footer length)', () => {
  const page = buildPage({
    payloadIndex: 0,
    blocks: [
      buildDataBlock(
        LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
        1,
        buildLis2dw12Body(() => [1, 1, 1]),
      ),
    ],
  });

  it('is clean when the design version matches the page', () => {
    const res = decodeVerisenseLoggedData(page, { payloadDesignVersion: 9 });
    expect(res.bytesUnattributed).toBe(0);
    expect(res.pagesWithSkippedRecords).toBe(0);
    expect(res.sensors[LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1].samplesDecoded).toBe(32);
  });

  it('flags leftover bytes when the assumed footer is too short (v8 vs real v9)', () => {
    const res = decodeVerisenseLoggedData(page, { payloadDesignVersion: 8 });
    expect(res.bytesUnattributed).toBeGreaterThan(0);
    expect(res.pagesWithSkippedRecords).toBe(1);
  });

  it('skips the block (no mis-attribution) when the assumed footer is too long (v10 vs real v9)', () => {
    const res = decodeVerisenseLoggedData(page, { payloadDesignVersion: 10 });
    expect(res.pagesWithSkippedRecords).toBe(1);
    expect(res.samplesDecoded).toBe(0);
  });
});
