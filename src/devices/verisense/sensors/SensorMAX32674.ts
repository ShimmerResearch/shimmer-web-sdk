import { SensorBase } from './SensorBase.js';
import { i16le, u24le } from '../protocol.js';
import { OP_IDX } from '../constants.js';

/** One algorithm-hub sample: raw MAX86176 PPG + accel + WHRM algorithm output. */
export interface MAX32674Sample {
  /** 6 raw PPG LED channel counts (24-bit). */
  ppg: [number, number, number, number, number, number];
  accel: { raw: [number, number, number] };
  /** Heart rate (bpm) and confidence (0-100). */
  hr: number;
  hrConfidence: number;
  /** SpO2 (%) and confidence; 0 until SpO2 mode is enabled. */
  spo2: number;
  spo2Confidence: number;
  activityClass: number;
  scdContactState: number;
}

function u16le(bytes: Uint8Array, off: number): number {
  return (bytes[off] & 0xff) | ((bytes[off + 1] & 0xff) << 8);
}

/**
 * Decoder for the MAX32674 algorithm hub (Verisense sensor id = 8).
 *
 * Data block payload = [sampleCount:1] then sampleCount x 32 bytes:
 *   ppg led1..led6 : 6 x u24 (18) | accel x,y,z : 3 x i16 (6) |
 *   hr u16 (2) | hr_conf u8 (1) | spo2 u16 (2) | spo2_conf u8 (1) |
 *   activity u8 (1) | scd_contact u8 (1)
 */
export class SensorMAX32674 extends SensorBase {
  static readonly BYTES_PER_SAMPLE = 32;

  constructor() {
    super();
    // Approximate; the hub reports at the configured PPG report rate.
    this.samplingRateHz = 25;
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): MAX32674Sample[] {
    if (!sensorPayloadBytes?.length) return [];

    const count = sensorPayloadBytes[0] ?? 0;
    const maxByLength = Math.floor((sensorPayloadBytes.length - 1) / SensorMAX32674.BYTES_PER_SAMPLE);
    const n = Math.min(count, maxByLength);

    const out: MAX32674Sample[] = [];
    for (let i = 0; i < n; i++) {
      const base = 1 + i * SensorMAX32674.BYTES_PER_SAMPLE;
      out.push({
        ppg: [
          u24le(sensorPayloadBytes, base + 0),
          u24le(sensorPayloadBytes, base + 3),
          u24le(sensorPayloadBytes, base + 6),
          u24le(sensorPayloadBytes, base + 9),
          u24le(sensorPayloadBytes, base + 12),
          u24le(sensorPayloadBytes, base + 15),
        ],
        accel: {
          raw: [
            i16le(sensorPayloadBytes, base + 18),
            i16le(sensorPayloadBytes, base + 20),
            i16le(sensorPayloadBytes, base + 22),
          ],
        },
        hr: u16le(sensorPayloadBytes, base + 24),
        hrConfidence: sensorPayloadBytes[base + 26] ?? 0,
        spo2: u16le(sensorPayloadBytes, base + 27),
        spo2Confidence: sensorPayloadBytes[base + 29] ?? 0,
        activityClass: sensorPayloadBytes[base + 30] ?? 0,
        scdContactState: sensorPayloadBytes[base + 31] ?? 0,
      });
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    this.enabled = (op[OP_IDX.GEN_CFG_3] & (1 << 5)) !== 0;
    // samplingRateHz is left at its default; the hub report period mapping is
    // hardware-specific and not derived from a single op-config byte.
  }
}
