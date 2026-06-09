import { SensorBase } from './SensorBase.js';
import { normalizeOperationalConfig, u24le } from '../protocol.js';

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
  /**
   * 2nd-generation hub PPG: 3 raw MAX86176 LED channel counts (24-bit), in the
   * order [green, IR, red] (LED1=green, LED2=IR, LED3=red per the board's LED
   * driver wiring). The MAX86176 is reached only via the MAX32674 algorithm hub
   * and measures these 3 LEDs on photodiode PD1 (its PD2 copies are not
   * forwarded).
   */
  leds?: [number, number, number];
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

  /**
   * 2nd-gen hub mode: PPG arrives via the MAX32674 hub as a fixed block of 6 raw
   * MAX86176 LED channels (6 x u24), independent of the RED/IR/GREEN/BLUE enable
   * bits. Set from the connected device's hardware generation (see
   * VerisenseClient). When false, the 1st-gen named-channel layout is used.
   */
  hubMode = false;

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

  setHubMode(enabled: boolean): void {
    this.hubMode = enabled;
  }

  setAdcResolutionIndex(i: number): void {
    if (i >= 0 && i <= 3) this.adcResolutionIndex = i;
  }

  calibrateValue(uncalValue: number): number {
    const idx = this.adcResolutionIndex;
    return ((uncalValue / this.adcBitShift[idx]) * this.adcLsb[idx]) / 1000.0;
  }

  /**
   * 2nd-gen hub PPG block: N samples x (3 x u24 LED channels = green, IR, red),
   * no count prefix (sample count derived from the block length, matching the
   * firmware packer).
   */
  private parseHubPayload(sensorPayloadBytes: Uint8Array): PPGSample[] {
    const bytesPerSample = 9; // 3 channels x 3 bytes
    const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
    const out: PPGSample[] = [];
    for (let i = 0; i < n; i++) {
      const base = i * bytesPerSample;
      out.push({
        leds: [
          u24le(sensorPayloadBytes, base + 0), // green (LED1)
          u24le(sensorPayloadBytes, base + 3), // IR (LED2)
          u24le(sensorPayloadBytes, base + 6), // red (LED3)
        ],
      });
    }
    return out;
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): PPGSample[] {
    if (this.hubMode) {
      return this.parseHubPayload(sensorPayloadBytes);
    }

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
