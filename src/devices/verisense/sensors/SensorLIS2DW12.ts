import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';
import { normalizeOperationalConfig } from '../protocol.js';

type AccelRange = '2G' | '4G' | '8G' | '16G';

export interface LIS2DW12Sample {
  raw: [number, number, number];
  cal: [number, number, number];
  units: { cal: string };
}

/**
 * Decoder for the LIS2DW12 low-power accelerometer (Verisense sensor id = 2).
 *
 * Sensitivity values are given in raw-LSB / (m/s²) per axis — matching
 * the C# `SensorLIS2DW12.cs` implementation.
 */
export class SensorLIS2DW12 extends SensorBase {
  offset: [number, number, number] = [0, 0, 0];

  align: [[number, number, number], [number, number, number], [number, number, number]] = [
    [0, 0, 1],
    [1, 0, 0],
    [0, 1, 0],
  ];

  private readonly sensitivityByRange: Record<AccelRange, [number, number, number]> = {
    '2G': [1671.665922915, 1671.665922915, 1671.665922915],
    '4G': [835.832961457, 835.832961457, 835.832961457],
    '8G': [417.916480729, 417.916480729, 417.916480729],
    '16G': [208.958240364, 208.958240364, 208.958240364],
  };

  range: AccelRange = '2G';

  constructor() {
    super();
    this.samplingRateHz = 50;
  }

  setRange(rangeStr: AccelRange): void {
    if (this.sensitivityByRange[rangeStr]) this.range = rangeStr;
  }

  // --- Functional OpConfig helpers (returns new Uint8Array, does not mutate) ---

  setEnabled(enabled: boolean, opConfigBytes?: Uint8Array | null): Uint8Array | boolean {
    if (opConfigBytes == null) {
      this.enabled = enabled;
      return this.enabled;
    }
    const op = normalizeOperationalConfig(opConfigBytes)!;
    const out = new Uint8Array(op);
    const idx = OP_IDX.GEN_CFG_0;
    out[idx] = enabled ? (out[idx] | 0x80) & 0xff : out[idx] & 0x7f & 0xff;
    return out;
  }

  setAccelEnabled(enabled: boolean, opConfigBytes?: Uint8Array | null): Uint8Array | boolean {
    return this.setEnabled(enabled, opConfigBytes);
  }

  patchAccelRange(rangeCfg: number, op: Uint8Array): Uint8Array {
    const out = new Uint8Array(op);
    const i = OP_IDX.ACCEL1_CFG_1;
    out[i] = (out[i] & 0b11001111) | ((rangeCfg & 0x03) << 4);
    return out;
  }

  patchAccelSamplingRate(rateCfg: number, op: Uint8Array): Uint8Array {
    const out = new Uint8Array(op);
    const i = OP_IDX.ACCEL1_CFG_0;
    out[i] = (out[i] & 0b00001111) | ((rateCfg & 0x0f) << 4);
    return out;
  }

  private _calibrate(raw: [number, number, number]): [number, number, number] {
    const v: [number, number, number] = [
      raw[0] - this.offset[0],
      raw[1] - this.offset[1],
      raw[2] - this.offset[2],
    ];
    const a = this.align;
    const aligned: [number, number, number] = [
      a[0][0] * v[0] + a[0][1] * v[1] + a[0][2] * v[2],
      a[1][0] * v[0] + a[1][1] * v[1] + a[1][2] * v[2],
      a[2][0] * v[0] + a[2][1] * v[1] + a[2][2] * v[2],
    ];
    const s = this.sensitivityByRange[this.range];
    return [aligned[0] / s[0], aligned[1] / s[1], aligned[2] / s[2]];
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): LIS2DW12Sample[] {
    const BYTES_PER_SAMPLE = 6;
    const n = Math.floor(sensorPayloadBytes.length / BYTES_PER_SAMPLE);
    const out: LIS2DW12Sample[] = [];

    for (let i = 0; i < n; i++) {
      const off = i * BYTES_PER_SAMPLE;
      const raw: [number, number, number] = [
        i16le(sensorPayloadBytes, off + 0),
        i16le(sensorPayloadBytes, off + 2),
        i16le(sensorPayloadBytes, off + 4),
      ];
      const cal = this._calibrate(raw);
      out.push({ raw, cal, units: { cal: 'm/s^2' } });
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    const gen0 = op[OP_IDX.GEN_CFG_0];
    const cfg0 = op[OP_IDX.ACCEL1_CFG_0];
    const cfg1 = op[OP_IDX.ACCEL1_CFG_1];

    if (gen0 == null || cfg0 == null || cfg1 == null) {
      console.warn('[LIS2DW12] Missing required bytes; cannot apply config.');
      return;
    }

    this.enabled = ((gen0 >> 7) & 0x01) === 1;

    const rangeSetting = (cfg1 >> 4) & 0x03;
    const modeSetting = (cfg0 >> 2) & 0x03;
    const rateSetting = (cfg0 >> 4) & 0x0f;

    const rangeMap: Record<number, AccelRange> = { 0: '2G', 1: '4G', 2: '8G', 3: '16G' };
    this.setRange(rangeMap[rangeSetting] ?? '2G');

    const lowPowerHzByCfg: Record<number, number> = {
      1: 1.6,
      2: 12.5,
      3: 25,
      4: 50,
      5: 100,
      6: 200,
    };
    const highPerfHzByCfg: Record<number, number> = {
      1: 12.5,
      3: 25,
      4: 50,
      5: 100,
      6: 200,
      7: 400,
      8: 800,
      9: 1600,
    };

    const isLowPower = modeSetting === 0;
    const hz = isLowPower ? lowPowerHzByCfg[rateSetting] : highPerfHzByCfg[rateSetting];
    if (hz) this.samplingRateHz = hz;
  }
}
