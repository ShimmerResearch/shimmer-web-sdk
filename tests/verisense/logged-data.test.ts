import { describe, it, expect } from 'vitest';
import {
  decodeVerisenseLoggedData,
  splitVerisenseLoggedPages,
  findLoggedPayloadIndexGaps,
  verifyLoggedPageCrc,
  resolveLoggedBlockSize,
  loggedFooterLength,
  loggedPayloadConfigLength,
  loggedExtendedConfigBytes,
  LOGGED_DATABLOCK_SENSOR_ID,
  LOGGED_ADC_BLOCK_BYTES,
  LOGGED_LIS2DW12_BLOCK_BYTES,
  LOGGED_PAGE_FIXED_OVERHEAD,
} from '../../src/devices/verisense/loggedData.js';
import { crc16_ccitt_false } from '../../src/devices/verisense/protocolUtils.js';

// ---------------------------------------------------------------------------
// Fixture builders — construct synthetic flash transfers from the documented
// page layout (index + length + config + [datablocks + footer] + CRC), using the
// SAME per-sample byte encodings the streaming decoders consume so the decode is
// a genuine round-trip against the spec.
// ---------------------------------------------------------------------------

const DESIGN_VERSION = 9; // default the decoder targets: extended config + v9 footer
const CONFIG_LEN = loggedPayloadConfigLength(DESIGN_VERSION, true); // 24

const u16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff];
const u24 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff];
const u32 = (v: number): number[] => [
  v & 0xff,
  (v >> 8) & 0xff,
  (v >> 16) & 0xff,
  (v >> 24) & 0xff,
];
const i16 = (v: number): number[] => u16(v & 0xffff);

/** An extended payload config (bit 0x10 set) of the exact length the decoder expects. */
function makeConfig(fw = { major: 1, minor: 2, internal: 85 }): number[] {
  const cfg = new Array<number>(CONFIG_LEN).fill(0);
  cfg[0] = 0x10; // extended-config bit
  cfg[2] = fw.major;
  cfg[3] = fw.minor;
  cfg[4] = fw.internal & 0xff;
  cfg[5] = (fw.internal >> 8) & 0xff;
  return cfg;
}

/** A v9 footer: RTC minutes(4) + ticks(3) + temperature(2) + battery(2). */
function makeFooter(minutes: number, ticks: number, temp: number, batt: number): number[] {
  return [...u32(minutes), ...u24(ticks), ...i16(temp), ...u16(batt & 0x0fff)];
}

/** One data block: [sensorId(1)][endTick u24(3)][fifo bytes]. */
function makeBlock(sensorId: number, endTick: number, fifo: number[]): number[] {
  return [sensorId, ...u24(endTick), ...fifo];
}

/** Assemble a full page and append the correct CRC. */
function makePage(payloadIndex: number, config: number[], ramBlock: number[]): Uint8Array {
  const payloadLength = config.length + ramBlock.length;
  const bodyNoCrc = [...u16(payloadIndex), ...u16(payloadLength), ...config, ...ramBlock];
  const crc = crc16_ccitt_false(Uint8Array.from(bodyNoCrc));
  return Uint8Array.from([...bodyNoCrc, ...u16(crc)]);
}

/** LIS2DW12 FIFO: 32 samples x (x,y,z int16 LE) = 192 bytes. */
function lis2dw12Fifo(samples: Array<[number, number, number]>): number[] {
  const out: number[] = [];
  for (const [x, y, z] of samples) out.push(...i16(x), ...i16(y), ...i16(z));
  return out;
}

const concat = (...arrs: Uint8Array[]): Uint8Array => {
  const total = arrs.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const a of arrs) {
    out.set(a, o);
    o += a.length;
  }
  return out;
};

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------

describe('logged-data layout helpers', () => {
  it('extended config accretion matches the Java per-version additions', () => {
    expect(loggedExtendedConfigBytes(8)).toBe(1 + 4 + 5 + 1 + 2 + 1 + 4); // 18
    expect(loggedExtendedConfigBytes(9)).toBe(18);
    expect(loggedExtendedConfigBytes(12)).toBe(18 + 1); // v12 adds 1
    expect(loggedPayloadConfigLength(9, true)).toBe(2 + 4 + 18); // 24
    expect(loggedPayloadConfigLength(9, false)).toBe(2);
  });

  it('footer length varies by payload design version', () => {
    expect(loggedFooterLength(8)).toBe(8); // no ticks
    expect(loggedFooterLength(9)).toBe(11); // + ticks
    expect(loggedFooterLength(10)).toBe(18); // + microcontroller clock
    expect(loggedFooterLength(11)).toBe(18);
  });

  it('resolves fixed FIFO block sizes and refuses unknown ones', () => {
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.ADC, null)).toBe(
      LOGGED_ADC_BLOCK_BYTES,
    );
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1, null)).toBe(
      LOGGED_LIS2DW12_BLOCK_BYTES,
    );
    // LSM6DS3 needs the op config; PPG/BIOZ/unknown are not sizeable without help.
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.GYRO_ACCEL2, null)).toBeNull();
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.PPG, null)).toBeNull();
    expect(resolveLoggedBlockSize(LOGGED_DATABLOCK_SENSOR_ID.BIOZ, null)).toBeNull();
    // Explicit override wins.
    expect(resolveLoggedBlockSize(99, null, { 99: 42 })).toBe(42);
  });
});

// ---------------------------------------------------------------------------
// Page layer
// ---------------------------------------------------------------------------

describe('splitVerisenseLoggedPages', () => {
  const config = makeConfig();
  const footer = makeFooter(100, 1000, 0, 3000);
  const block = makeBlock(
    LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
    1234,
    lis2dw12Fifo(Array.from({ length: 32 }, () => [1, 2, 3])),
  );

  it('splits a clean multi-page blob at the length field', () => {
    const p0 = makePage(0, config, [...block, ...footer]);
    const p1 = makePage(1, config, [...block, ...footer]);
    const blob = concat(p0, p1);
    const split = splitVerisenseLoggedPages(blob);
    expect(split.pages).toHaveLength(2);
    expect(split.pages[0].payloadIndex).toBe(0);
    expect(split.pages[1].payloadIndex).toBe(1);
    expect(split.truncatedTrailingPage).toBe(false);
    expect(split.trailingByteCount).toBe(0);
    // total span = payloadLength + 6
    expect(split.pages[0].bytes.length).toBe(
      split.pages[0].payloadLength + LOGGED_PAGE_FIXED_OVERHEAD,
    );
  });

  it('flags a truncated trailing page', () => {
    const p0 = makePage(0, config, [...block, ...footer]);
    const p1 = makePage(1, config, [...block, ...footer]);
    const blob = concat(p0, p1).subarray(0, p0.length + 20); // cut mid-second-page
    const split = splitVerisenseLoggedPages(blob);
    expect(split.pages).toHaveLength(1);
    expect(split.truncatedTrailingPage).toBe(true);
    expect(split.trailingByteCount).toBe(20);
  });

  it('stops at the 0xFFFF/0xFFFF erased-flash sentinel', () => {
    const p0 = makePage(0, config, [...block, ...footer]);
    const blob = concat(p0, Uint8Array.from([0xff, 0xff, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00]));
    const split = splitVerisenseLoggedPages(blob);
    expect(split.pages).toHaveLength(1);
    expect(split.truncatedTrailingPage).toBe(false);
  });

  it('detects payload-index gaps and resets', () => {
    const gaps = findLoggedPayloadIndexGaps([
      { payloadIndex: 0 },
      { payloadIndex: 1 },
      { payloadIndex: 5 }, // dropped 2,3,4
      { payloadIndex: 6 },
      { payloadIndex: 2 }, // reset/wrap
    ]);
    expect(gaps).toHaveLength(2);
    expect(gaps[0]).toEqual({ afterPayloadIndex: 1, nextPayloadIndex: 5, missing: 3 });
    expect(gaps[1]).toEqual({ afterPayloadIndex: 6, nextPayloadIndex: 2, missing: 0 });
  });
});

describe('verifyLoggedPageCrc', () => {
  const page = makePage(0, makeConfig(), [
    ...makeBlock(
      LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
      1,
      lis2dw12Fifo(Array.from({ length: 32 }, () => [0, 0, 0])),
    ),
    ...makeFooter(0, 0, 0, 0),
  ]);

  it('accepts a valid page', () => {
    expect(verifyLoggedPageCrc(page)).toBe(true);
  });

  it('rejects a corrupted page', () => {
    const bad = Uint8Array.from(page);
    bad[10] ^= 0xff;
    expect(verifyLoggedPageCrc(bad)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Sample layer — round-trip decode
// ---------------------------------------------------------------------------

describe('decodeVerisenseLoggedData — round trip', () => {
  it('decodes a LIS2DW12 (id 2) block back to the exact raw samples', () => {
    const samples: Array<[number, number, number]> = Array.from({ length: 32 }, (_, i) => [
      i + 1,
      -(i + 1),
      1000 + i,
    ]);
    const page = makePage(3, makeConfig(), [
      ...makeBlock(LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1, 5000, lis2dw12Fifo(samples)),
      ...makeFooter(120, 2048, 0, 3100),
    ]);

    const res = decodeVerisenseLoggedData(page);
    expect(res.pagesTotal).toBe(1);
    expect(res.pagesBad).toBe(0);
    expect(res.recordsSkipped).toBe(0);
    expect(res.bytesUnattributed).toBe(0);

    const accel = res.sensors[LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1];
    expect(accel).toBeDefined();
    expect(accel.samplesDecoded).toBe(32);
    expect(accel.blocks).toBe(1);
    for (let i = 0; i < 32; i++) {
      expect((accel.samples[i] as { raw: [number, number, number] }).raw).toEqual([
        i + 1,
        -(i + 1),
        1000 + i,
      ]);
      // per-sample timestamps are attached (reused streaming timestamp logic)
      expect((accel.samples[i] as { timestamps?: unknown }).timestamps).toBeDefined();
    }
    expect(res.samplesDecoded).toBe(32);
  });

  it('parses the page footer (RTC minutes/ticks, temperature, battery)', () => {
    const page = makePage(0, makeConfig(), [
      ...makeBlock(
        LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
        5000,
        lis2dw12Fifo(Array.from({ length: 32 }, () => [0, 0, 0])),
      ),
      ...makeFooter(120, 16384, 1234, 3100),
    ]);
    const res = decodeVerisenseLoggedData(page);
    expect(res.footers).toHaveLength(1);
    const f = res.footers[0];
    expect(f.rtcMinutes).toBe(120);
    expect(f.rtcTicks).toBe(16384);
    expect(f.temperatureRaw).toBe(1234);
    expect(f.batteryRaw).toBe(3100);
    // (120 min * 60 + 16384/32768 s) * 1000 = 7_200_500 ms
    expect(f.rtcEndMillis).toBeCloseTo((120 * 60 + 16384 / 32768) * 1000, 3);
  });

  it('decodes two sensors in one page (LIS2DW12 + ADC)', () => {
    // ADC default state: GSR enabled, battery disabled -> 2 bytes/sample -> 96 samples.
    const adcFifo = Array.from({ length: LOGGED_ADC_BLOCK_BYTES }, (_, i) => i & 0xff);
    const page = makePage(0, makeConfig(), [
      ...makeBlock(
        LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
        100,
        lis2dw12Fifo(Array.from({ length: 32 }, () => [7, 8, 9])),
      ),
      ...makeBlock(LOGGED_DATABLOCK_SENSOR_ID.ADC, 200, adcFifo),
      ...makeFooter(1, 2, 3, 4),
    ]);
    const res = decodeVerisenseLoggedData(page);
    expect(res.recordsSkipped).toBe(0);
    expect(res.bytesUnattributed).toBe(0);
    expect(res.sensors[LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1].samplesDecoded).toBe(32);
    expect(res.sensors[LOGGED_DATABLOCK_SENSOR_ID.ADC].samplesDecoded).toBe(96);
  });

  it('decodes an LSM6DS3 (id 3) block when its FIFO size is supplied', () => {
    // accel+gyro default -> 12 bytes/sample. Use 5 samples -> 60-byte block.
    const blockBytes = 60;
    const fifo: number[] = [];
    for (let s = 0; s < 5; s++) {
      // gyro xyz then accel xyz (LSM6DS3 stream order)
      fifo.push(
        ...i16(s),
        ...i16(s + 1),
        ...i16(s + 2),
        ...i16(100 + s),
        ...i16(200 + s),
        ...i16(300 + s),
      );
    }
    const page = makePage(0, makeConfig(), [
      ...makeBlock(LOGGED_DATABLOCK_SENSOR_ID.GYRO_ACCEL2, 42, fifo),
      ...makeFooter(0, 0, 0, 0),
    ]);
    const res = decodeVerisenseLoggedData(page, {
      blockSizes: { [LOGGED_DATABLOCK_SENSOR_ID.GYRO_ACCEL2]: blockBytes },
    });
    expect(res.recordsSkipped).toBe(0);
    const s3 = res.sensors[LOGGED_DATABLOCK_SENSOR_ID.GYRO_ACCEL2];
    expect(s3.samplesDecoded).toBe(5);
    const first = s3.samples[0] as { gyro: { raw: number[] }; accel: { raw: number[] } };
    expect(first.gyro.raw).toEqual([0, 1, 2]);
    expect(first.accel.raw).toEqual([100, 200, 300]);
  });
});

// ---------------------------------------------------------------------------
// Never-guess behaviour
// ---------------------------------------------------------------------------

describe('decodeVerisenseLoggedData — never guesses', () => {
  it('skips a CRC-bad page entirely', () => {
    const page = makePage(0, makeConfig(), [
      ...makeBlock(
        LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
        1,
        lis2dw12Fifo(Array.from({ length: 32 }, () => [1, 1, 1])),
      ),
      ...makeFooter(0, 0, 0, 0),
    ]);
    page[8] ^= 0xff; // corrupt a config/data byte
    const res = decodeVerisenseLoggedData(page);
    expect(res.pagesTotal).toBe(1);
    expect(res.pagesBad).toBe(1);
    expect(res.samplesDecoded).toBe(0);
    expect(res.footers).toHaveLength(0);
  });

  it('stops the block walk on an unsized sensor id (BIOZ) without guessing', () => {
    // A BIOZ (id 5) block with no resolvable size: decoder cannot advance safely.
    const page = makePage(0, makeConfig(), [
      ...makeBlock(
        LOGGED_DATABLOCK_SENSOR_ID.BIOZ,
        1,
        Array.from({ length: 64 }, () => 0),
      ),
      ...makeFooter(0, 0, 0, 0),
    ]);
    const res = decodeVerisenseLoggedData(page);
    expect(res.recordsSkipped).toBeGreaterThanOrEqual(1);
    expect(res.pagesWithSkippedRecords).toBe(1);
    expect(res.samplesDecoded).toBe(0);
  });

  it('catches a wrong footer length instead of silently mis-decoding (boundary guard)', () => {
    // A valid v9 page (footer 11).
    const page = makePage(0, makeConfig(), [
      ...makeBlock(
        LOGGED_DATABLOCK_SENSOR_ID.ACCEL_1,
        1,
        lis2dw12Fifo(Array.from({ length: 32 }, () => [1, 1, 1])),
      ),
      ...makeFooter(0, 0, 0, 0),
    ]);
    // Correct version: clean walk, lands exactly on the footer boundary.
    const ok = decodeVerisenseLoggedData(page, { payloadDesignVersion: 9 });
    expect(ok.bytesUnattributed).toBe(0);
    expect(ok.pagesWithSkippedRecords).toBe(0);
    expect(ok.samplesDecoded).toBe(32);

    // Footer assumed too SMALL (v8 = 8 bytes): the walk lands short of the real
    // footer, so the leftover bytes are flagged rather than mis-decoded.
    const tooSmall = decodeVerisenseLoggedData(page, { payloadDesignVersion: 8 });
    expect(tooSmall.bytesUnattributed).toBeGreaterThan(0);
    expect(tooSmall.pagesWithSkippedRecords).toBe(1);

    // Footer assumed too LARGE (v10 = 18 bytes): the block overruns the shrunken
    // data region and is skipped, so nothing is mis-attributed.
    const tooLarge = decodeVerisenseLoggedData(page, { payloadDesignVersion: 10 });
    expect(tooLarge.pagesWithSkippedRecords).toBe(1);
    expect(tooLarge.samplesDecoded).toBe(0);
  });

  it('leaves samples empty for a known sensor id whose block size is unavailable', () => {
    // A PPG (id 4) block with no op-config and no override -> not sizeable.
    const page = makePage(0, makeConfig(), [
      ...makeBlock(
        LOGGED_DATABLOCK_SENSOR_ID.PPG,
        1,
        Array.from({ length: 51 }, () => 0),
      ),
      ...makeFooter(0, 0, 0, 0),
    ]);
    const res = decodeVerisenseLoggedData(page);
    expect(res.samplesDecoded).toBe(0);
    expect(res.recordsSkipped).toBeGreaterThanOrEqual(1);
  });
});
