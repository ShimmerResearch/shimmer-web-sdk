import { describe, it, expect } from 'vitest';
import {
  matrixInverse3x3,
  matrixMultiply3x3,
  makeKinematicCalibration,
  calibrateVector3,
  parseKinematicCalibBlock,
  generateKinematicCalibBlock,
} from '../../src/devices/calibration/index.js';

describe('matrixInverse3x3', () => {
  it('inverts a hand-computed matrix (det = 1)', () => {
    // A = [[1,2,3],[0,1,4],[5,6,0]] has det 1 and inverse
    //   [[-24,18,5],[20,-15,-4],[-5,4,1]] (standard textbook example).
    const inv = matrixInverse3x3([1, 2, 3, 0, 1, 4, 5, 6, 0]);
    expect(inv).not.toBeNull();
    expect(inv!.map((v) => Math.round(v))).toEqual([-24, 18, 5, 20, -15, -4, -5, 4, 1]);
  });

  it('A · A⁻¹ = identity', () => {
    const A = [2, 0, 1, 1, 3, 2, 1, 0, 1];
    const inv = matrixInverse3x3(A)!;
    const prod = matrixMultiply3x3(A, inv).map((v) => Math.round(v * 1e9) / 1e9);
    expect(prod).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('returns null for a singular matrix', () => {
    expect(matrixInverse3x3([1, 2, 3, 2, 4, 6, 0, 0, 0])).toBeNull();
  });

  it('inverts an involutory sign/permutation matrix to itself', () => {
    // [[0,-1,0],[-1,0,0],[0,0,-1]] is its own inverse (used by LN accel/gyro).
    const m = [0, -1, 0, -1, 0, 0, 0, 0, -1];
    expect(matrixInverse3x3(m)!.map((v) => v + 0)).toEqual(m); // + 0 normalizes -0
  });
});

// helper: normalize -0 → 0 so toEqual([0,...]) matches
const norm = (a: number[]): number[] => a.map((v) => v + 0);
describe('normalization sanity', () => {
  it('norm turns -0 into 0', () => {
    expect(norm([-0])).toEqual([0]);
  });
});

describe('calibrateVector3 — C = M·(U − B)', () => {
  it('identity alignment, unit sensitivity, zero offset → raw / sens', () => {
    const cal = makeKinematicCalibration([0, 0, 0], [2, 4, 8], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(calibrateVector3([10, 20, 40], cal)).toEqual([5, 5, 5]);
  });

  it('LN accel default: raw [2047,2047,2047] → [0,0,0] m/(s^2)', () => {
    // Kionix KXRB: offset 2047, sens 83, align [[0,-1,0],[-1,0,0],[0,0,-1]].
    const cal = makeKinematicCalibration(
      [2047, 2047, 2047],
      [83, 83, 83],
      [0, -1, 0, -1, 0, 0, 0, 0, -1],
    );
    expect(calibrateVector3([2047, 2047, 2047], cal).map((v) => v + 0)).toEqual([0, 0, 0]);
  });

  it('WR accel LSM303DLHC each range: raw = [sens,sens,sens] → [-1,1,-1]', () => {
    // align [[-1,0,0],[0,1,0],[0,0,-1]] (its own inverse), offset 0.
    for (const sens of [1631, 815, 408, 135]) {
      const cal = makeKinematicCalibration(
        [0, 0, 0],
        [sens, sens, sens],
        [-1, 0, 0, 0, 1, 0, 0, 0, -1],
      );
      const c = calibrateVector3([sens, sens, sens], cal);
      expect([Math.round(c[0]), Math.round(c[1]), Math.round(c[2])]).toEqual([-1, 1, -1]);
    }
  });

  it('gyro: align [[0,-1,0],[-1,0,0],[0,0,-1]], sens 131 → raw [0,131,262] gives [-1,0,-2]', () => {
    const cal = makeKinematicCalibration(
      [0, 0, 0],
      [131, 131, 131],
      [0, -1, 0, -1, 0, 0, 0, 0, -1],
    );
    const c = calibrateVector3([0, 131, 262], cal);
    // Cx = -d1/131 = -1, Cy = -d0/131 = 0, Cz = -d2/131 = -2
    expect(c[0]).toBeCloseTo(-1, 10);
    expect(c[1]).toBeCloseTo(0, 10);
    expect(c[2]).toBeCloseTo(-2, 10);
  });

  it('mag with split X/Y vs Z sensitivity (1100/1100/980) → raw [1100,2200,980] gives [-1,2,-1]', () => {
    // LSM303DLHC 1.3 Ga: align [[-1,0,0],[0,1,0],[0,0,-1]], offset 0.
    const cal = makeKinematicCalibration(
      [0, 0, 0],
      [1100, 1100, 980],
      [-1, 0, 0, 0, 1, 0, 0, 0, -1],
    );
    const c = calibrateVector3([1100, 2200, 980], cal);
    // Cx = -1100/1100 = -1, Cy = 2200/1100 = 2, Cz = -980/980 = -1
    expect(c[0]).toBeCloseTo(-1, 10);
    expect(c[1]).toBeCloseTo(2, 10);
    expect(c[2]).toBeCloseTo(-1, 10);
  });
});

describe('parseKinematicCalibBlock — 21-byte block codec', () => {
  it('reads offset/sensitivity big-endian and alignment ÷100', () => {
    // offset x,y,z = 100, 200, -50 (i16 BE); sens = 1000,1000,1000;
    // alignment identity ×100 → 100 on diagonal (i8).
    const b = new Uint8Array([
      0x00,
      0x64, // offset X = 100
      0x00,
      0xc8, // offset Y = 200
      0xff,
      0xce, // offset Z = -50
      0x03,
      0xe8, // sens X = 1000
      0x03,
      0xe8, // sens Y = 1000
      0x03,
      0xe8, // sens Z = 1000
      100,
      0,
      0, // align row 0 = [1,0,0]
      0,
      100,
      0, // align row 1
      0,
      0,
      100, // align row 2
    ]);
    const cal = parseKinematicCalibBlock(b)!;
    expect(cal.offset).toEqual([100, 200, -50]);
    expect(cal.sensitivity).toEqual([1000, 1000, 1000]);
    expect(cal.alignment).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
  });

  it('divides sensitivity by 100 for gyro (stored 13100 → 131)', () => {
    const b = new Uint8Array([
      0,
      0,
      0,
      0,
      0,
      0, // offset 0
      0x33,
      0x2c, // sens X = 13100
      0x33,
      0x2c, // sens Y = 13100
      0x33,
      0x2c, // sens Z = 13100
      100,
      0,
      0,
      0,
      100,
      0,
      0,
      0,
      100, // identity alignment
    ]);
    const cal = parseKinematicCalibBlock(b, { sensitivityScale: 100 })!;
    expect(cal.sensitivity).toEqual([131, 131, 131]);
    // identity align, zero offset → raw / 131
    expect(calibrateVector3([131, 262, 393], cal).map((v) => Math.round(v))).toEqual([1, 2, 3]);
  });

  it('returns null for all-0xFF and all-0x00 sentinel blocks', () => {
    expect(parseKinematicCalibBlock(new Uint8Array(21).fill(0xff))).toBeNull();
    expect(parseKinematicCalibBlock(new Uint8Array(21).fill(0x00))).toBeNull();
  });

  it('returns null for a short block', () => {
    expect(parseKinematicCalibBlock(new Uint8Array(20).fill(0x11))).toBeNull();
  });

  it('round-trips through generateKinematicCalibBlock (accel: scale 1)', () => {
    const offset: [number, number, number] = [2047, -5, 100];
    const sens: [number, number, number] = [83, 84, 85];
    const align = [0, -1, 0, -1, 0, 0, 0, 0, -1];
    const bytes = generateKinematicCalibBlock(offset, sens, align);
    const cal = parseKinematicCalibBlock(bytes)!;
    expect(cal.offset).toEqual(offset);
    expect(cal.sensitivity).toEqual(sens);
    expect(cal.alignment).toEqual(align);
  });

  it('round-trips gyro sensitivity through the ×100 scale', () => {
    const bytes = generateKinematicCalibBlock(
      [0, 0, 0],
      [131, 65.5, 32.8],
      [1, 0, 0, 0, 1, 0, 0, 0, 1],
      {
        sensitivityScale: 100,
      },
    );
    const cal = parseKinematicCalibBlock(bytes, { sensitivityScale: 100 })!;
    expect(cal.sensitivity[0]).toBeCloseTo(131, 6);
    expect(cal.sensitivity[1]).toBeCloseTo(65.5, 6);
    expect(cal.sensitivity[2]).toBeCloseTo(32.8, 6);
  });
});
