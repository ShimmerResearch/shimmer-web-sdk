import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';

/**
 * One algorithm-hub sample: accel + WHRM algorithm output. The raw MAX86176 PPG
 * is no longer carried here - it streams separately under the PPG sensor id (4),
 * see SensorPPG hub mode.
 */
export interface MAX32674Sample {
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
 * Data block payload = [sampleCount:1] then sampleCount x 14 bytes:
 *   accel x,y,z : 3 x i16 (6) | hr u16 (2) | hr_conf u8 (1) |
 *   spo2 u16 (2) | spo2_conf u8 (1) | activity u8 (1) | scd_contact u8 (1)
 *
 * Raw PPG is reported separately under the PPG sensor id (4).
 */
export class SensorMAX32674 extends SensorBase {
  static readonly BYTES_PER_SAMPLE = 14;

  constructor() {
    super();
    // Approximate; the hub reports at the configured algorithm report rate.
    this.samplingRateHz = 25;
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): MAX32674Sample[] {
    if (!sensorPayloadBytes?.length) return [];

    const count = sensorPayloadBytes[0] ?? 0;
    const maxByLength = Math.floor(
      (sensorPayloadBytes.length - 1) / SensorMAX32674.BYTES_PER_SAMPLE,
    );
    const n = Math.min(count, maxByLength);

    const out: MAX32674Sample[] = [];
    for (let i = 0; i < n; i++) {
      const base = 1 + i * SensorMAX32674.BYTES_PER_SAMPLE;
      out.push({
        accel: {
          raw: [
            i16le(sensorPayloadBytes, base + 0),
            i16le(sensorPayloadBytes, base + 2),
            i16le(sensorPayloadBytes, base + 4),
          ],
        },
        hr: u16le(sensorPayloadBytes, base + 6),
        hrConfidence: sensorPayloadBytes[base + 8] ?? 0,
        spo2: u16le(sensorPayloadBytes, base + 9),
        spo2Confidence: sensorPayloadBytes[base + 11] ?? 0,
        activityClass: sensorPayloadBytes[base + 12] ?? 0,
        scdContactState: sensorPayloadBytes[base + 13] ?? 0,
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
