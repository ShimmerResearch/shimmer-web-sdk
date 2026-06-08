import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';

/** One skin-temperature sample. Object = skin temperature, ambient = sensor
 * ambient, both in degrees Celsius. */
export interface MLX90632Sample {
  object: { raw: number; cal: number; units: string };
  ambient: { raw: number; cal: number; units: string };
}

/** Slow-sensor sample-rate index -> Hz (matches firmware slowSensorRateMs). */
const SLOW_SENSOR_RATE_HZ = [0, 0.5, 1, 2, 5, 10, 20];

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
    const rateIdx = op[OP_IDX.SKIN_TEMP_SAMPLE_RATE_INDEX] ?? 0;
    this.samplingRateHz = SLOW_SENSOR_RATE_HZ[rateIdx] || 1;
  }
}
