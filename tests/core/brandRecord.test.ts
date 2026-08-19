import { describe, it, expect } from 'vitest';
import {
  BRAND_RECORD_HOST_OFFSET,
  BRAND_RECORD_SIZE,
  BRAND_RECORD_MAGIC,
  BRAND_RECORD_LAYOUT_VER,
  BRAND_PLATFORM,
  brandNameProblem,
  parseBrandRecord,
  buildBrandRecord,
  buildBlankBrandRecord,
} from '../../src/devices/brandRecord.js';

describe('brandRecord', () => {
  it('places the record where the firmware expects it', () => {
    // Absolute EEPROM 1952 == host offset 1936 (host offsets skip page 0);
    // 5 pages directly below the Bluetooth-details page (abs 2032).
    expect(BRAND_RECORD_HOST_OFFSET).toBe(1936);
    expect(BRAND_RECORD_SIZE).toBe(80);
  });

  it('round-trips a customer brand', () => {
    const bytes = buildBrandRecord({
      btClassic: 'Acme',
      ble: 'Acme',
      usbProduct: 'Acme',
      usbManufacturer: 'Acme Health Ltd.',
    });
    expect(bytes.length).toBe(BRAND_RECORD_SIZE);
    const rec = parseBrandRecord(bytes);
    expect(rec.valid).toBe(true);
    expect(rec.invalidReason).toBeUndefined();
    expect(rec.btClassic).toBe('Acme');
    expect(rec.ble).toBe('Acme');
    expect(rec.usbProduct).toBe('Acme');
    expect(rec.usbManufacturer).toBe('Acme Health Ltd.');
    expect(rec.seededPlatform).toBe(BRAND_PLATFORM.UNKNOWN);
  });

  it('encodes the header exactly as gEepromBrandDetails does (little-endian)', () => {
    const bytes = buildBrandRecord({
      btClassic: 'Shimmer3',
      ble: 'S3BLE',
      usbProduct: 'Shimmer',
      usbManufacturer: 'Shimmer Research Ltd.',
      seededPlatform: BRAND_PLATFORM.SHIMMER3,
    });
    expect(bytes[0]).toBe(BRAND_RECORD_MAGIC & 0xff); // 0x42 'B'
    expect(bytes[1]).toBe(BRAND_RECORD_MAGIC >> 8); // 0x53 'S'
    expect(bytes[2]).toBe(BRAND_RECORD_LAYOUT_VER); // layoutVer (2)
    expect(bytes[3]).toBe(BRAND_PLATFORM.SHIMMER3 << 1); // flags: bit0 reserved/clear
    expect(bytes[4]).toBe(8); // btClassicLen
    expect(bytes[5]).toBe(5); // bleLen
    expect(bytes[6]).toBe(7); // usbProductLen
    expect(bytes[7]).toBe(21); // usbManufacturerLen ("Shimmer Research Ltd.")
    expect(String.fromCharCode(...bytes.slice(8, 16))).toBe('Shimmer3');
    expect(String.fromCharCode(...bytes.slice(24, 29))).toBe('S3BLE');
    expect(String.fromCharCode(...bytes.slice(34, 41))).toBe('Shimmer');
    expect(String.fromCharCode(...bytes.slice(50, 71))).toBe('Shimmer Research Ltd.');
  });

  it('rejects a corrupted record and reports why', () => {
    const bytes = buildBrandRecord({
      btClassic: 'Shimmer3R',
      ble: 'Shimmer3R',
      usbProduct: 'Shimmer',
      usbManufacturer: 'Shimmer Research Ltd.',
      seededPlatform: BRAND_PLATFORM.SHIMMER3R,
    });
    bytes[78] ^= 0xff; // flip a CRC byte
    const rec = parseBrandRecord(bytes);
    expect(rec.valid).toBe(false);
    expect(rec.invalidReason).toBe('CRC mismatch');
    // Best-effort fields still decoded for display
    expect(rec.btClassic).toBe('Shimmer3R');
  });

  it('accepts a manufacturer string too long for the old shared USB field', () => {
    // The single 16-char usb field could not hold the stock manufacturer string;
    // this is the whole reason v2 split product from manufacturer.
    const rec = parseBrandRecord(
      buildBrandRecord({
        btClassic: 'Acme',
        ble: 'Acme',
        usbProduct: 'Acme',
        usbManufacturer: 'Shimmer Research Ltd.',
      }),
    );
    expect(rec.valid).toBe(true);
    expect(rec.usbManufacturer).toBe('Shimmer Research Ltd.');
    expect(rec.usbManufacturer.length).toBeGreaterThan(16);
  });

  it('rejects a v1 record so firmware re-seeds it', () => {
    const bytes = buildBrandRecord({
      btClassic: 'Acme',
      ble: 'Acme',
      usbProduct: 'Acme',
      usbManufacturer: 'Acme Ltd.',
    });
    bytes[2] = 1; // downgrade layoutVer
    const rec = parseBrandRecord(bytes);
    expect(rec.valid).toBe(false);
    expect(rec.invalidReason).toMatch(/layout version 1/);
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
      buildBrandRecord({ btClassic: 'A,B', ble: 'X', usbProduct: 'Y', usbManufacturer: 'Z' }),
    ).toThrow(/comma/);
  });
});

describe('brandRecord seededPlatform validation', () => {
  it('rejects out-of-range seededPlatform instead of silently masking it', () => {
    const base = { btClassic: 'X', ble: 'X', usbProduct: 'X', usbManufacturer: 'X' };
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
