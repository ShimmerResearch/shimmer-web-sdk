import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';

type AccelRange = '2G' | '4G' | '8G' | '16G';
type GyroRange = '250DPS' | '500DPS' | '1000DPS' | '2000DPS';

export interface LSM6DS3Sample {
  accel: { raw: [number, number, number]; cal: [number, number, number]; units: string } | null;
  gyro: { raw: [number, number, number]; cal: [number, number, number]; units: string } | null;
}

/**
 * Decoder for the LSM6DS3 combined accelerometer + gyroscope (Verisense sensor id = 3).
 *
 * Sensitivity values mirror the C# `SensorLSM6DS3.cs` implementation.
 */
export class SensorLSM6DS3 extends SensorBase {
  offset: [number, number, number] = [0, 0, 0];

  align: [[number, number, number], [number, number, number], [number, number, number]] = [
    [0, 0, 1],
    [-1, 0, 0],
    [0, -1, 0],
  ];

  private readonly accSensByRange: Record<AccelRange, [number, number, number]> = {
    '2G': [1671.665922915, 1671.665922915, 1671.665922915],
    '4G': [835.832961457, 835.832961457, 835.832961457],
    '8G': [417.916480729, 417.916480729, 417.916480729],
    '16G': [208.958240364, 208.958240364, 208.958240364],
  };

  private readonly gyroSensByRange: Record<GyroRange, [number, number, number]> = {
    '250DPS': [114.285714286, 114.285714286, 114.285714286],
    '500DPS': [57.142857143, 57.142857143, 57.142857143],
    '1000DPS': [28.571428571, 28.571428571, 28.571428571],
    '2000DPS': [14.285714286, 14.285714286, 14.285714286],
  };

  accRange: AccelRange = '2G';
  gyroRange: GyroRange = '250DPS';
  accEnabled = true;
  gyroEnabled = true;

  constructor() {
    super();
    this.samplingRateHz = 50;
  }

  setAccelEnabled(v: boolean): void {
    this.accEnabled = !!v;
  }
  setGyroEnabled(v: boolean): void {
    this.gyroEnabled = !!v;
  }
  setAccelRange(r: AccelRange): void {
    if (this.accSensByRange[r]) this.accRange = r;
  }
  setGyroRange(r: GyroRange): void {
    if (this.gyroSensByRange[r]) this.gyroRange = r;
  }

  private _applyAlignAndOffset(raw3: [number, number, number]): [number, number, number] {
    const v: [number, number, number] = [
      raw3[0] - this.offset[0],
      raw3[1] - this.offset[1],
      raw3[2] - this.offset[2],
    ];
    const a = this.align;
    return [
      a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
      a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
      a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
    ];
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): LSM6DS3Sample[] {
    let bytesPerSample = 6;
    if (this.gyroEnabled && this.accEnabled) bytesPerSample = 12;

    const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
    const out: LSM6DS3Sample[] = [];

    for (let i = 0; i < n; i++) {
      const base = i * bytesPerSample;
      let gyroRaw: [number, number, number] | null = null;
      let accRaw: [number, number, number] | null = null;

      if (this.gyroEnabled && this.accEnabled) {
        gyroRaw = [
          i16le(sensorPayloadBytes, base + 0),
          i16le(sensorPayloadBytes, base + 2),
          i16le(sensorPayloadBytes, base + 4),
        ];
        accRaw = [
          i16le(sensorPayloadBytes, base + 6),
          i16le(sensorPayloadBytes, base + 8),
          i16le(sensorPayloadBytes, base + 10),
        ];
      } else if (this.gyroEnabled) {
        gyroRaw = [
          i16le(sensorPayloadBytes, base + 0),
          i16le(sensorPayloadBytes, base + 2),
          i16le(sensorPayloadBytes, base + 4),
        ];
      } else if (this.accEnabled) {
        accRaw = [
          i16le(sensorPayloadBytes, base + 0),
          i16le(sensorPayloadBytes, base + 2),
          i16le(sensorPayloadBytes, base + 4),
        ];
      }

      let accCal: [number, number, number] | null = null;
      let gyroCal: [number, number, number] | null = null;

      if (accRaw) {
        const aligned = this._applyAlignAndOffset(accRaw);
        const s = this.accSensByRange[this.accRange];
        accCal = [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
      }
      if (gyroRaw) {
        const aligned = this._applyAlignAndOffset(gyroRaw);
        const s = this.gyroSensByRange[this.gyroRange];
        gyroCal = [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
      }

      out.push({
        accel: accRaw && accCal ? { raw: accRaw, cal: accCal, units: 'm/s^2' } : null,
        gyro: gyroRaw && gyroCal ? { raw: gyroRaw, cal: gyroCal, units: 'deg/s' } : null,
      });
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    this.accEnabled = (op[OP_IDX.GEN_CFG_0] & 0b01000000) !== 0;
    this.gyroEnabled = (op[OP_IDX.GEN_CFG_0] & 0b00100000) !== 0;

    const cfg4 = op[OP_IDX.GYRO_ACCEL2_CFG_4];
    const accelRateCfg = (cfg4 >> 4) & 0x0f;

    const cfg5 = op[OP_IDX.GYRO_ACCEL2_CFG_5];
    const accelRangeCfg = (cfg5 >> 2) & 0x03;
    const gyroRangeCfg = (cfg5 >> 4) & 0x03;

    const accelRangeMap: Record<number, AccelRange> = { 0: '2G', 1: '4G', 2: '8G', 3: '16G' };
    const gyroRangeMap: Record<number, GyroRange> = {
      0: '250DPS',
      1: '500DPS',
      2: '1000DPS',
      3: '2000DPS',
    };

    this.setAccelRange(accelRangeMap[accelRangeCfg] ?? this.accRange);
    this.setGyroRange(gyroRangeMap[gyroRangeCfg] ?? this.gyroRange);

    const hzByCfg: Record<number, number | null> = {
      0: null,
      1: 12.5,
      2: 26,
      3: 52,
      4: 104,
      5: 208,
      6: 416,
      7: 833,
      8: 1660,
    };
    const hz = hzByCfg[accelRateCfg];
    if (hz) this.samplingRateHz = hz;
  }
}
