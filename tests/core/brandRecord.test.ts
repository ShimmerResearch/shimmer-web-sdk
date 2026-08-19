import { describe, it, expect } from 'vitest';
import {
  BRAND_RECORD_HOST_OFFSET,
  BRAND_RECORD_SIZE,
  BRAND_RECORD_MAGIC,
  BRAND_PLATFORM,
  brandNameProblem,
  parseBrandRecord,
  buildBrandRecord,
  buildBlankBrandRecord,
} from '../../src/devices/brandRecord.js';

describe('brandRecord', () => {
  it('places the record where the firmware expects it', () => {
    // Absolute EEPROM 1968 == host offset 1952 (host offsets skip page 0);
    // 4 pages directly below the Bluetooth-details page (abs 2032).
    expect(BRAND_RECORD_HOST_OFFSET).toBe(1952);
    expect(BRAND_RECORD_SIZE).toBe(64);
  });

  it('round-trips a customer brand', () => {
    const bytes = buildBrandRecord({
      btClassic: 'OUTPUT',
      ble: 'OUTPUT',
      usb: 'OUTPUT Sports',
      customerBranded: true,
    });
    expect(bytes.length).toBe(BRAND_RECORD_SIZE);
    const rec = parseBrandRecord(bytes);
    expect(rec.valid).toBe(true);
    expect(rec.invalidReason).toBeUndefined();
    expect(rec.btClassic).toBe('OUTPUT');
    expect(rec.ble).toBe('OUTPUT');
    expect(rec.usb).toBe('OUTPUT Sports');
    expect(rec.customerBranded).toBe(true);
    expect(rec.seededPlatform).toBe(BRAND_PLATFORM.UNKNOWN);
  });

  it('encodes the header exactly as gEepromBrandDetails does (little-endian)', () => {
    const bytes = buildBrandRecord({
      btClassic: 'Shimmer3',
      ble: 'S3BLE',
      usb: 'Shimmer',
      customerBranded: false,
      seededPlatform: BRAND_PLATFORM.SHIMMER3,
    });
    expect(bytes[0]).toBe(BRAND_RECORD_MAGIC & 0xff); // 0x42 'B'
    expect(bytes[1]).toBe(BRAND_RECORD_MAGIC >> 8); // 0x53 'S'
    expect(bytes[2]).toBe(1); // layoutVer
    expect(bytes[3]).toBe(BRAND_PLATFORM.SHIMMER3 << 1); // flags: not customer-branded
    expect(bytes[4]).toBe(8); // btClassicLen
    expect(bytes[5]).toBe(5); // bleLen
    expect(bytes[6]).toBe(7); // usbLen
    expect(String.fromCharCode(...bytes.slice(7, 15))).toBe('Shimmer3');
    expect(String.fromCharCode(...bytes.slice(23, 28))).toBe('S3BLE');
    expect(String.fromCharCode(...bytes.slice(33, 40))).toBe('Shimmer');
  });

  it('rejects a corrupted record and reports why', () => {
    const bytes = buildBrandRecord({
      btClassic: 'Shimmer3R',
      ble: 'Shimmer3R',
      usb: 'Shimmer',
      customerBranded: false,
      seededPlatform: BRAND_PLATFORM.SHIMMER3R,
    });
    bytes[62] ^= 0xff; // flip a CRC byte
    const rec = parseBrandRecord(bytes);
    expect(rec.valid).toBe(false);
    expect(rec.invalidReason).toBe('CRC mismatch');
    // Best-effort fields still decoded for display
    expect(rec.btClassic).toBe('Shimmer3R');
  });

  it('reports a blank (erased) record distinctly', () => {
    const rec = parseBrandRecord(buildBlankBrandRecord());
    expect(rec.valid).toBe(false);
    expect(rec.invalidReason).toBe('blank (erased) record');
  });

  it('mirrors the firmware character rules', () => {
    expect(brandNameProblem('Shimmer3', 16)).toBeNull();
    expect(brandNameProblem('', 16)).toMatch(/empty/);
    expect(brandNameProblem('ABCDEFGHIJKLMNOPQ', 16)).toMatch(/longer/);
    expect(brandNameProblem('A,B', 16)).toMatch(/comma/);
    expect(brandNameProblem('Café', 16)).toMatch(/unsupported/);
    expect(() =>
      buildBrandRecord({ btClassic: 'A,B', ble: 'X', usb: 'Y', customerBranded: true }),
    ).toThrow(/comma/);
  });
});

describe('brandRecord seededPlatform validation', () => {
  it('rejects out-of-range seededPlatform instead of silently masking it', () => {
    const base = { btClassic: 'X', ble: 'X', usb: 'X', customerBranded: false };
    expect(() => buildBrandRecord({ ...base, seededPlatform: 99 })).toThrow(/seededPlatform/);
    expect(() => buildBrandRecord({ ...base, seededPlatform: -1 })).toThrow(/seededPlatform/);
    expect(() => buildBrandRecord({ ...base, seededPlatform: 1.5 })).toThrow(/seededPlatform/);
    // All in-range values encode cleanly
    for (const p of Object.values(BRAND_PLATFORM)) {
      expect(
        parseBrandRecord(buildBrandRecord({ ...base, seededPlatform: p })).seededPlatform,
      ).toBe(p);
    }
  });
});
