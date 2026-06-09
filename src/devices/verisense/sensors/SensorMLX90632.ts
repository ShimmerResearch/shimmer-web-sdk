import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';

/** One skin-temperature sample. Object = skin temperature, ambient = sensor
 * ambient, both in degrees Celsius. */
export interface MLX90632Sample {
  object: { raw: number; cal: number; units: string };
  ambient: { raw: number; cal: number; units: string };
}

/** MLX90632 refresh-rate code (op-config byte 76 bits 3:1) -> refresh Hz. The
 * single skin-temp rate setting is stored as this code; the output (sample) rate
 * is refresh / sub-measurements (medical = 2, extended = 3). */
const MLX_REFRESH_HZ = [0.5, 1, 2, 4, 8, 16, 32, 64];

/**
 * Decoder for the MLX90632 skin temperature sensor (Verisense sensor id = 9).
 *
 * Data block payload = N samples x 4 bytes: object int16 then ambient int16,
 * each in centi-degrees Celsius (value / 100 = degrees C).
 */
export class SensorMLX90632 extends SensorBase {
  static readonly BYTES_PER_SAMPLE = 4;

  constructor() {
    super();
    this.samplingRateHz = 1;
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): MLX90632Sample[] {
    if (!sensorPayloadBytes?.length) return [];
    const n = Math.floor(sensorPayloadBytes.length / SensorMLX90632.BYTES_PER_SAMPLE);
    const out: MLX90632Sample[] = [];

    for (let i = 0; i < n; i++) {
      const base = i * SensorMLX90632.BYTES_PER_SAMPLE;
      const objRaw = i16le(sensorPayloadBytes, base + 0);
      const ambRaw = i16le(sensorPayloadBytes, base + 2);
      out.push({
        object: { raw: objRaw, cal: objRaw / 100, units: 'degC' },
        ambient: { raw: ambRaw, cal: ambRaw / 100, units: 'degC' },
      });
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    this.enabled = (op[OP_IDX.GEN_CFG_3] & (1 << 4)) !== 0;
    // Single skin-temp rate: stored as the MLX90632 refresh-rate code (byte 76
    // bits 3:1). The output (sample) rate the firmware delivers is the refresh
    // rate divided by the sub-measurement count (medical = 2, extended = 3).
    const cfg = op[OP_IDX.SKIN_TEMP_CONFIG] ?? 0;
    const isExtended = (cfg & 0x01) !== 0;
    const refreshCode = (cfg >> 1) & 0x07;
    const refreshHz = MLX_REFRESH_HZ[refreshCode] ?? 16;
    this.samplingRateHz = refreshHz / (isExtended ? 3 : 2);
  }
}
