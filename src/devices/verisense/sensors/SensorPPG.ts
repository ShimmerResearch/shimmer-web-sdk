import { SensorBase } from './SensorBase.js';
import { OP_IDX } from '../constants.js';
import { normalizeOperationalConfig } from '../protocol.js';

export interface PPGChannelSample {
  raw: number;
  cal: number;
  units: { raw: string; cal: string };
}

export interface PPGSample {
  RED?: PPGChannelSample;
  IR?: PPGChannelSample;
  GREEN?: PPGChannelSample;
  BLUE?: PPGChannelSample;
}

type PPGChannel = 'RED' | 'IR' | 'GREEN' | 'BLUE';

/**
 * Decoder for the PPG sensor (Verisense sensor id = 4).
 *
 * Calibration constants mirror C# `SensorPPG.cs`.
 */
export class SensorPPG extends SensorBase {
  red = false;
  ir = false;
  green = false;
  blue = false;

  private readonly adcLsb = [7.8125, 15.625, 31.25, 62.5];
  private readonly adcBitShift = [2 ** 7, 2 ** 6, 2 ** 5, 2 ** 4];
  adcResolutionIndex = 0; // 0..3

  constructor() {
    super();
    this.samplingRateHz = 50;
  }

  setChannels(channels: Partial<Record<PPGChannel, boolean>>): void {
    if (typeof channels.RED === 'boolean') this.red = channels.RED;
    if (typeof channels.IR === 'boolean') this.ir = channels.IR;
    if (typeof channels.GREEN === 'boolean') this.green = channels.GREEN;
    if (typeof channels.BLUE === 'boolean') this.blue = channels.BLUE;
  }

  setAdcResolutionIndex(i: number): void {
    if (i >= 0 && i <= 3) this.adcResolutionIndex = i;
  }

  calibrateValue(uncalValue: number): number {
    const idx = this.adcResolutionIndex;
    return ((uncalValue / this.adcBitShift[idx]) * this.adcLsb[idx]) / 1000.0;
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): PPGSample[] {
    const enabled: PPGChannel[] = [];
    if (this.red) enabled.push('RED');
    if (this.ir) enabled.push('IR');
    if (this.green) enabled.push('GREEN');
    if (this.blue) enabled.push('BLUE');

    const bytesPerSample = enabled.length * 3;
    if (bytesPerSample === 0) return [];

    const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
    const out: PPGSample[] = [];

    for (let i = 0; i < n; i++) {
      const base = i * bytesPerSample;
      let off = 0;
      const sample: PPGSample = {};

      for (const ch of enabled) {
        const b0 = sensorPayloadBytes[base + off + 0];
        const b1 = sensorPayloadBytes[base + off + 1];
        const b2 = sensorPayloadBytes[base + off + 2];
        off += 3;

        let uncal = (b0 | (b1 << 8) | (b2 << 16)) >>> 0;
        uncal &= 0x7ffff;

        sample[ch] = {
          raw: uncal,
          cal: this.calibrateValue(uncal),
          units: { raw: 'counts', cal: 'scaled' },
        };
      }

      out.push(sample);
    }

    return out;
  }

  override applyOperationalConfig(_op: Uint8Array): void {
    // PPG channels are configured by the operational config but the bit
    // mapping is hardware-specific. For now we leave channel flags as-is;
    // callers can use setChannels() directly.
    void normalizeOperationalConfig(_op); // no-op, satisfies lint
  }
}
