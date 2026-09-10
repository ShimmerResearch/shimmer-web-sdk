import { describe, expect, it } from 'vitest';
import {
  PRESSURE_COEFFICIENT_BYTES,
  parsePressureCalibrationResponse,
} from '../../src/devices/pressure/index.js';

const payload = (id: number, coeffs: number[]): Uint8Array => Uint8Array.from([id, ...coeffs]);
const filled = (n: number, byte: number): number[] => Array.from({ length: n }, () => byte);
const ramp = (n: number): number[] => Array.from({ length: n }, (_, i) => (i + 3) & 0xff);

describe('parsePressureCalibrationResponse', () => {
  it('names each part from its id byte', () => {
    expect(parsePressureCalibrationResponse(payload(0, ramp(22))).sensor).toBe('bmp180');
    expect(parsePressureCalibrationResponse(payload(1, ramp(24))).sensor).toBe('bmp280');
    expect(parsePressureCalibrationResponse(payload(2, ramp(21))).sensor).toBe('bmp390');
    expect(parsePressureCalibrationResponse(payload(3, [])).sensor).toBe('bmp581');
  });

  it('treats a BMP581 with no coefficient block as calibrated', () => {
    // The firmware sends the id alone, deliberately, so a host can tell this
    // from an older firmware's NACK (shimmer_bt_uart.c:2067-2077).
    const out = parsePressureCalibrationResponse(payload(3, []));
    expect(out.calibrated).toBe(true);
    expect(out.coefficients).toBeNull();
    expect(out.raw.length).toBe(0);
  });

  it('parses a real block and keeps the raw bytes', () => {
    const coeffs = ramp(21);
    const out = parsePressureCalibrationResponse(payload(2, coeffs));
    expect(out.calibrated).toBe(true);
    expect(out.coefficients).not.toBeNull();
    expect([...out.raw]).toEqual(coeffs);
  });

  it('reports a blank block as not calibrated, for all three fill patterns', () => {
    // 0xFF is erased flash, 0x00 an unwritten block, and 0x01 the filler the
    // classic Shimmer3 firmware sends when asked for the wrong part's
    // coefficients (shimmer_bt_uart.c:2033-2037).
    for (const fill of [0x00, 0xff, 0x01]) {
      const out = parsePressureCalibrationResponse(payload(2, filled(21, fill)));
      expect(out.calibrated, `fill 0x${fill.toString(16)}`).toBe(false);
      expect(out.coefficients).toBeNull();
      // The bytes are still handed back — a support engineer wants to see them.
      expect(out.raw.length).toBe(21);
    }
  });

  it('rejects an empty payload', () => {
    expect(() => parsePressureCalibrationResponse(new Uint8Array(0))).toThrow(RangeError);
  });

  it('rejects an unknown sensor id', () => {
    expect(() => parsePressureCalibrationResponse(payload(9, ramp(21)))).toThrow(
      /unknown sensor id 9/,
    );
  });

  it('rejects a block that is not the length that part sends', () => {
    expect(() => parsePressureCalibrationResponse(payload(2, ramp(20)))).toThrow(
      /carried 20 coefficient byte\(s\); expected 21/,
    );
    // A BMP581 that sent coefficients would mean the reply is not what it says.
    expect(() => parsePressureCalibrationResponse(payload(3, ramp(4)))).toThrow(RangeError);
  });

  it('states each part’s block length', () => {
    expect(PRESSURE_COEFFICIENT_BYTES).toEqual({
      bmp180: 22,
      bmp280: 24,
      bmp390: 21,
      bmp581: 0,
    });
  });
});
