import { SensorBase } from './SensorBase.js';
import { u24le } from '../protocol.js';
import { OP_IDX } from '../constants.js';
import { isVerisenseLightDarkChannelEnabled } from '../operationalConfig.js';

/** Per-channel raw ambient-light counts (24-bit) plus the derived illuminance
 * (lux) and correlated colour temperature (CCT, Kelvin). Channel order matches
 * the firmware VD6283 AlsResults block: RED, VISIBLE, BLUE, GREEN, IR, CLEAR.
 *
 * The second slot is shared: the VD6283 routes EITHER the visible/clear reading
 * OR the dark (covered-photodiode) baseline onto it, selected by the op-config
 * dark-channel bit. They are mutually exclusive, so exactly one of `VISIBLE` /
 * `DARK` is a number per sample and the other is `null`. */
export interface VD6283Sample {
  RED: number;
  /** Visible/clear channel count, or `null` when the dark channel is enabled
   * (the chip then routes the dark baseline onto this slot — see `DARK`). */
  VISIBLE: number | null;
  BLUE: number;
  GREEN: number;
  IR: number;
  CLEAR: number;
  /** Dark/covered-photodiode baseline count, or `null` when the dark channel is
   * disabled (the slot then carries the visible reading — see `VISIBLE`). */
  DARK: number | null;
  /** Illuminance in lux (XYZ Y component; clamped to >= 0). */
  lux: number;
  /** Correlated colour temperature in Kelvin (0 if undefined). */
  cct: number;
}

/** Slow-sensor sample-rate index -> Hz (matches firmware slowSensorRateMs). This
 * is the configured (target) rate the firmware polls at; the sensor's exposure
 * may prevent reaching it, which surfaces as packet loss against this rate. */
const SLOW_SENSOR_RATE_HZ = [0, 0.5, 1, 2, 5, 10, 20];

/** Op-config index -> exposure µs (matches firmware vd6283_exposureIndexToUs). */
const EXPOSURE_US_TABLE = [100000, 1600, 6400, 12800, 25600, 51200, 102400, 204800];
/** Op-config index -> 8.8 fixed-point gain (matches firmware vd6283_gainIndexToValue). */
const GAIN_8P8_TABLE = [0x0100, 0x01ab, 0x0280, 0x0500, 0x0a00, 0x1900, 0x3200, 0x42ab];

/** Reference exposure (firmware VD6283TX_DEFAULT_EXPO). */
const DEFAULT_EXPO_US = 100800;
/** ALS-counts -> XYZ matrix (firmware App_vd6283tx.c). Rows are X, Y, Z. */
const XYZ_MATRIX = [
  [0.20557, 0.4167, -0.143816],
  [-0.028752, 0.506372, -0.120614],
  [-0.552625, 0.335866, 0.494781],
];

/**
 * Decoder for the VD6283TX45 ambient light sensor (Verisense sensor id = 7).
 *
 * Data block payload = N samples x 18 bytes (6 channels x 24-bit LE counts).
 * In addition to the raw channel counts, each sample carries the derived lux
 * and CCT, computed from the RED/GREEN/BLUE channels with the configured gain
 * and exposure (ported from firmware App_vd6283tx.c).
 */
export class SensorVD6283 extends SensorBase {
  static readonly NUM_CHANNELS = 6;
  static readonly BYTES_PER_SAMPLE = 18;

  private exposureUs = EXPOSURE_US_TABLE[0];
  private gain8p8 = GAIN_8P8_TABLE[0];
  /** Op-config dark-channel bit (LIGHT_CONFIG bit 1): when set the shared second
   * slot carries the dark baseline (`DARK`) instead of the visible reading. */
  private darkEnabled = false;

  constructor() {
    super();
    this.samplingRateHz = 1;
  }

  /** Normalise a raw channel count for the XYZ transform (gain + exposure). */
  private normalizeForXyz(meas: number): number {
    const expoScale = DEFAULT_EXPO_US / this.exposureUs;
    // Firmware divides by 256 (16.8 / 8.8 fixed-point); float division here is
    // a touch more precise than the firmware's integer division.
    return (expoScale * (meas / 256)) / (this.gain8p8 / 256 || 1);
  }

  /** Compute illuminance (lux) and CCT (K) from RED/GREEN/BLUE counts. */
  private computeLuxCct(red: number, green: number, blue: number): { lux: number; cct: number } {
    const r = this.normalizeForXyz(red);
    const g = this.normalizeForXyz(green);
    const b = this.normalizeForXyz(blue);

    const X = XYZ_MATRIX[0][0] * r + XYZ_MATRIX[0][1] * g + XYZ_MATRIX[0][2] * b;
    const Y = XYZ_MATRIX[1][0] * r + XYZ_MATRIX[1][1] * g + XYZ_MATRIX[1][2] * b;
    const Z = XYZ_MATRIX[2][0] * r + XYZ_MATRIX[2][1] * g + XYZ_MATRIX[2][2] * b;

    const lux = Y < 0 ? 0 : Y;
    const norm = X + Y + Z;
    let cct = 0;
    if (norm !== 0) {
      const x = X / norm;
      const y = Y / norm;
      const n = (x - 0.332) / (0.1858 - y);
      cct = 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33;
    }
    return { lux, cct };
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): VD6283Sample[] {
    if (!sensorPayloadBytes?.length) return [];
    const n = Math.floor(sensorPayloadBytes.length / SensorVD6283.BYTES_PER_SAMPLE);
    const out: VD6283Sample[] = [];

    for (let i = 0; i < n; i++) {
      const base = i * SensorVD6283.BYTES_PER_SAMPLE;
      const RED = u24le(sensorPayloadBytes, base + 0);
      // Slot 1 is visible-or-dark depending on the configured dark-channel bit.
      const slot1 = u24le(sensorPayloadBytes, base + 3);
      const VISIBLE = this.darkEnabled ? null : slot1;
      const DARK = this.darkEnabled ? slot1 : null;
      const BLUE = u24le(sensorPayloadBytes, base + 6);
      const GREEN = u24le(sensorPayloadBytes, base + 9);
      const IR = u24le(sensorPayloadBytes, base + 12);
      const CLEAR = u24le(sensorPayloadBytes, base + 15);
      // lux/CCT derive from RED/GREEN/BLUE, so the dark-channel selection (which
      // only affects slot 1) leaves them valid in either mode.
      const { lux, cct } = this.computeLuxCct(RED, GREEN, BLUE);
      out.push({ RED, VISIBLE, BLUE, GREEN, IR, CLEAR, DARK, lux, cct });
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    this.enabled = (op[OP_IDX.GEN_CFG_3] & (1 << 3)) !== 0;
    const rateIdx = op[OP_IDX.LIGHT_SAMPLE_RATE_INDEX] ?? 0;
    // Report the configured rate; loss is measured against it so a long exposure
    // (or any firmware/hardware shortfall) that prevents reaching it shows up.
    this.samplingRateHz = SLOW_SENSOR_RATE_HZ[rateIdx] || 1;

    const expoIdx = op[OP_IDX.LIGHT_EXPOSURE_INDEX] ?? 0;
    const gainIdx = op[OP_IDX.LIGHT_GAIN_INDEX] ?? 0;
    this.exposureUs = EXPOSURE_US_TABLE[expoIdx] ?? EXPOSURE_US_TABLE[0];
    this.gain8p8 = GAIN_8P8_TABLE[gainIdx] ?? GAIN_8P8_TABLE[0];

    // LIGHT_CONFIG bit 1 selects the dark channel on slot 1 (see VD6283Sample).
    this.darkEnabled = isVerisenseLightDarkChannelEnabled(op);
  }
}
