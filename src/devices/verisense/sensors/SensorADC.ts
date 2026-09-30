import { SensorBase } from './SensorBase.js';
import { i16le } from '../protocol.js';
import { OP_IDX } from '../constants.js';
import { normalizeOperationalConfig } from '../protocol.js';
import { getVerisenseStreamingBatteryVoltageMultiplier } from '../hardwareModels.js';

export interface ADCGSRSample {
  raw: number;
  adc12: number;
  range: number;
  volts: number;
  /**
   * Skin resistance. A fixed range clamps it to that range's window; auto-range
   * only floors it at 8 kΩ, so it can exceed 4.7 MΩ: an open circuit reads
   * hundreds of MΩ or more (DEV-1068).
   */
  kOhms: number;
  uS: number;
  /**
   * `'Disconnected'` at or below `LIMIT_MIN_VALID_USIEMENS` (0.03 µS). Only
   * auto-range can get there: a fixed range pins the resistance to its own
   * window, and the top of range 3, 4.7 MΩ, is 0.213 µS. The Java driver and
   * the C# API behave the same way.
   */
  connectivity: 'Connected' | 'Disconnected';
}

export interface ADCBatterySample {
  /** Full 16-bit packed ADC/flags word from payload. */
  raw16: number;
  /** 12-bit ADC value extracted from `raw16`. */
  adc12: number;
  mV: number;
  usbPluggedIn: boolean;
  chargerStatusBits: number;
  chargerStatus: string;
}

export interface ADCPayloadSample {
  gsr: ADCGSRSample | null;
  batt: ADCBatterySample | null;
}

type HardwareIdentifier = 'VERISENSE_PULSE_PLUS' | 'VERISENSE_GSR_PLUS' | string;

/**
 * Decoder for grouped ADC channels (Verisense sensor id = 1).
 *
 * Includes GSR plus battery/ADC channels carried in the same packet source.
 * Implements C# `SensorGSR.cs` including:
 * - Per-hardware reference resistor selection (SR68 vs Shimmer3 resistors).
 * - Auto-range decoding from the raw ADC value's upper bits.
 * - Range-3 clamping threshold that differs by hardware.
 * - Conductance (uS) output with connectivity detection.
 */
export class SensorADC extends SensorBase {
  readonly LIMIT_MIN_VALID_USIEMENS = 0.03;
  /**
   * Range-3 codes below this are raised to it before calibration so that an
   * open circuit reads as open, which only works if the limit is above the
   * amplifier reference. 1138 is the first code above 0.5 V at the gen-2 1.8 V
   * full scale (0.5 V = code 1137.5), so it also clears the 0.4986 V this decode
   * divides by (code 1134.3). The Java driver divides by 0.5 V, and 1138 is
   * correct under both. It was 1134, the last code below 0.4986 V: that decoded
   * to a negative resistance, nudged to 8 kΩ, so an open circuit read 125 µS
   * (DEV-1067).
   */
  readonly GSR_UNCAL_LIMIT_RANGE3_SR68 = 1138;
  readonly GSR_UNCAL_LIMIT_RANGE3_SR62 = 683;

  private readonly SHIMMER3_REF_KOHMS = [40.2, 287.0, 1000.0, 3300.0];
  private readonly SR68_REF_KOHMS = [21.0, 150.0, 562.0, 1740.0];

  /**
   * ADC sample-rate code → divisor of the 32768 Hz clock. Mirrors the firmware
   * `samplingRateInTicksArray` (hal_adc.c): the sampling timer fires every
   * `divisor` ticks, producing one sample set per fire, so the streamed output
   * rate = 32768 / divisor. Oversampling uses SAADC burst mode and therefore
   * does NOT divide the output rate. Index 0 = "Off".
   */
  private static readonly ADC_RATE_DIVISORS = [
    0, 1, 2, 4, 5, 8, 10, 16, 20, 25, 32, 40, 50, 64, 80, 100, 128, 160, 200, 256, 320, 400, 512,
    640, 800, 1024, 1280, 1600, 2048, 2560, 3200, 4096, 5120, 6400, 8192, 10240, 12800, 16384,
    20480, 25600, 32768, 40960, 51200,
  ] as const;

  gsrEnabled = true;
  battEnabled = false;
  /** GSR range 0-3 (fixed) or 4 (auto-range). */
  gsrRangeSetting = 4;
  hardwareIdentifier: HardwareIdentifier = 'VERISENSE_PULSE_PLUS';
  hwRevisionMajor: number | null = null;
  hwRevisionMinor: number | null = null;
  hwRevisionInternal: number | null = null;

  // Decoded from opConfig for debug/display
  gsrRateSettingRaw = 0;
  gsrRangeSettingRaw = 0;
  gsrOversamplingRateSettingRaw = 0;

  constructor() {
    super();
    this.samplingRateHz = 50;
  }

  setHardwareIdentifier(idStr: HardwareIdentifier): void {
    this.hardwareIdentifier = idStr;
  }

  setHardwareRevision(revHwMajor: number, revHwMinor: number, revHwInternal = 0): void {
    this.hwRevisionMajor = Number.isFinite(revHwMajor) ? Math.trunc(revHwMajor) : null;
    this.hwRevisionMinor = Number.isFinite(revHwMinor) ? Math.trunc(revHwMinor) : null;
    this.hwRevisionInternal = Number.isFinite(revHwInternal) ? Math.trunc(revHwInternal) : null;
  }

  setGsrRangeSetting(v: number): void {
    this.gsrRangeSetting = v;
  }

  private getBatteryVoltageMultiplier(): number {
    if (this.hwRevisionMajor != null && this.hwRevisionMinor != null) {
      return getVerisenseStreamingBatteryVoltageMultiplier(
        this.hwRevisionMajor,
        this.hwRevisionMinor,
      );
    }

    // Backward-compatible fallback when production config revision is unavailable.
    if (this.hardwareIdentifier === 'VERISENSE_GSR_PLUS') return 2.0;
    return 1.0;
  }

  /**
   * Whether this board uses the SR62 (Verisense GSR+) Shimmer3-style analog
   * front end: 3.0 V SAADC reference, 40.2/287/1000/3300 kΩ GSR feedback
   * resistors, 0.5 V GSR reference and range-3 uncal limit 683. Every other
   * GSR-capable board (SR61 >= 5, SR68 >= 5 — firmware
   * `ShimBrd_isGsrSupportedForHwVersion`) carries the second-generation DC
   * front end: 1.8 V reference, 21/150/562/1740 kΩ, 0.4986 V, limit 1138.
   *
   * Mirrors the firmware's `selectFeedbackResistorsFromHwVersion` (hal_gsr.c),
   * which keys the choice on the major revision alone (SR62 vs everything
   * else). Prefers the production-config hardware revision; falls back to the
   * caller-supplied hardware identifier when no revision has been read yet.
   * Previously this was keyed only on the `VERISENSE_PULSE_PLUS` identifier
   * string, so an SR61-5/6 presenting its true identity decoded ~1.91× high
   * (DEV-874).
   */
  private usesSr62GsrFrontEnd(): boolean {
    if (this.hwRevisionMajor != null) {
      return this.hwRevisionMajor === 62;
    }
    return this.hardwareIdentifier === 'VERISENSE_GSR_PLUS';
  }

  setEnabled(
    arg1: boolean | { gsr?: boolean; batt?: boolean },
    opConfigBytes?: Uint8Array | null,
  ): Uint8Array | Record<string, boolean> {
    if (opConfigBytes != null) {
      const desired =
        typeof arg1 === 'boolean' ? { gsr: arg1 } : arg1 && typeof arg1 === 'object' ? arg1 : {};
      return this._patchEnabled(desired, opConfigBytes);
    }

    const obj =
      typeof arg1 === 'boolean' ? { gsr: arg1 } : arg1 && typeof arg1 === 'object' ? arg1 : {};

    if (typeof obj.gsr === 'boolean') this.gsrEnabled = obj.gsr;
    if (typeof obj.batt === 'boolean') this.battEnabled = obj.batt;

    return { gsr: this.gsrEnabled, batt: this.battEnabled };
  }

  private _patchEnabled(
    { gsr, batt }: { gsr?: boolean; batt?: boolean },
    opConfigBytes: Uint8Array,
  ): Uint8Array {
    const op = normalizeOperationalConfig(opConfigBytes)!;
    const out = new Uint8Array(op);

    if (typeof gsr === 'boolean') {
      const idx = OP_IDX.GEN_CFG_1;
      out[idx] = gsr ? (out[idx] | 0x80) & 0xff : out[idx] & 0x7f & 0xff;
    }
    if (typeof batt === 'boolean') {
      const idx = OP_IDX.GEN_CFG_2;
      out[idx] = batt ? (out[idx] | 0x02) & 0xff : out[idx] & 0xfd & 0xff;
    }

    return out;
  }

  patchGsrRange(rangeCfg: number, op: Uint8Array): Uint8Array {
    const out = new Uint8Array(op);
    const i = OP_IDX.ADC_CHANNEL_SETTINGS_1;
    out[i] = (out[i] & 0b11111000) | (rangeCfg & 0x07);
    return out;
  }

  patchGsrSamplingRate(rateCfg: number, op: Uint8Array): Uint8Array {
    const out = new Uint8Array(op);
    const i = OP_IDX.ADC_CHANNEL_SETTINGS_0;
    out[i] = (out[i] & 0b11000000) | (rateCfg & 0x3f);
    return out;
  }

  patchGsrOversampling(overCfg: number, op: Uint8Array): Uint8Array {
    const out = new Uint8Array(op);
    const i = OP_IDX.ADC_CHANNEL_SETTINGS_1;
    out[i] = (out[i] & 0b00001111) | ((overCfg & 0x0f) << 4);
    return out;
  }

  calibrateAdcToVolts(uncal12bit: number): number {
    const adcRange = 2 ** 12 - 1;
    let refVoltage = 1.8 / 4.0;
    if (this.usesSr62GsrFrontEnd()) {
      refVoltage = 3.0 / 4.0;
    }
    const adcScaling = 1.0 / 4.0;
    return (uncal12bit * refVoltage) / adcRange / adcScaling;
  }

  calibrateGsrToKOhmsUsingAmplifierEq(volts: number, range: number): number {
    let rFeedback = this.SR68_REF_KOHMS[range];
    let gsrRefVoltage = 0.4986;
    if (this.usesSr62GsrFrontEnd()) {
      rFeedback = this.SHIMMER3_REF_KOHMS[range];
      gsrRefVoltage = 0.5;
    }
    return rFeedback / (volts / gsrRefVoltage - 1.0);
  }

  /**
   * Clamp a decoded resistance to what the circuit can measure. A fixed range
   * clamps both ends, to that range's window. Auto-range only floors it at
   * 8 kΩ, the smallest resistance any range can measure, and leaves the top
   * open, as the Java driver's `SensorGSR.nudgeGsrResistance` and the C#
   * `SensorGSR.NudgeGSRResistance` do (ASM-2156).
   *
   * `connectivity` depends on that open top. An open circuit on range 3
   * decodes to about 536 MΩ on gen-2 hardware (0.0019 µS), far below the
   * 0.03 µS threshold, but auto-range used to be capped at 4.7 MΩ too, which is
   * 0.213 µS, so `connectivity` could never say `'Disconnected'` (DEV-1068).
   * That cap was the first fix proposed under ASM-2156, withdrawn there for
   * this reason.
   */
  nudgeGsrResistance(kOhms: number): number {
    const limitsByRange: Record<number, [number, number]> = {
      0: [8.0, 63.0],
      1: [63.0, 220.0],
      2: [220.0, 680.0],
      3: [680.0, 4700.0],
    };
    if (this.gsrRangeSetting === 4) return Math.max(kOhms, limitsByRange[0][0]);
    const lim = limitsByRange[this.gsrRangeSetting] ?? [8.0, 4700.0];
    return Math.min(Math.max(kOhms, lim[0]), lim[1]);
  }

  kOhmToUSiemens(kOhms: number): number {
    return 1000.0 / kOhms;
  }

  /**
   * Convert the 6-bit ADC sample-rate code to the streamed output rate in Hz,
   * or null for "Off"/unknown codes. Used for per-sample timestamp spacing.
   */
  decodeAdcSampleRateHz(rateCode: number): number | null {
    const divisor = SensorADC.ADC_RATE_DIVISORS[rateCode];
    if (!divisor) return null;
    return SensorBase.CLOCK_FREQ / divisor;
  }

  override parsePayload(sensorPayloadBytes: Uint8Array): ADCPayloadSample[] {
    const bytesPerSample = this.gsrEnabled && this.battEnabled ? 4 : 2;
    const n = Math.floor(sensorPayloadBytes.length / bytesPerSample);
    const out: ADCPayloadSample[] = [];

    for (let i = 0; i < n; i++) {
      const base = i * bytesPerSample;
      let batt: ADCBatterySample | null = null;
      let gsr: ADCGSRSample | null = null;

      const gsrStart = this.battEnabled && this.gsrEnabled ? 2 : 0;

      if (this.gsrEnabled) {
        const gsrraw = i16le(sensorPayloadBytes, base + gsrStart);
        let adc12 = gsrraw & 0x0fff;

        let currentRange = this.gsrRangeSetting;
        if (currentRange === 4) currentRange = (gsrraw >> 14) & 0x03;

        if (currentRange === 3) {
          const limit = this.usesSr62GsrFrontEnd()
            ? this.GSR_UNCAL_LIMIT_RANGE3_SR62
            : this.GSR_UNCAL_LIMIT_RANGE3_SR68;
          if (adc12 < limit) adc12 = limit;
        }

        const volts = this.calibrateAdcToVolts(adc12);
        let kOhms = this.calibrateGsrToKOhmsUsingAmplifierEq(volts, currentRange);
        kOhms = this.nudgeGsrResistance(kOhms);
        const uS = this.kOhmToUSiemens(kOhms);
        const connectivity = uS > this.LIMIT_MIN_VALID_USIEMENS ? 'Connected' : 'Disconnected';

        gsr = { raw: gsrraw, adc12, range: currentRange, volts, kOhms, uS, connectivity };
      }

      if (this.battEnabled) {
        const raw16 = i16le(sensorPayloadBytes, base) & 0xffff;
        const adc12 = raw16 & 0x0fff;
        const usbPluggedIn = ((raw16 >> 15) & 0x01) === 1;
        const chargerStatusBits = (raw16 >> 13) & 0x03;

        let mv = this.calibrateAdcToVolts(adc12) * 1000.0;
        mv *= this.getBatteryVoltageMultiplier();

        const chargerStatusMap: Record<number, string> = {
          0: 'Power-Down/Suspended',
          1: 'Charging',
          2: 'Charging Complete',
          3: 'Bad Battery/LDO',
        };

        batt = {
          raw16,
          adc12,
          mV: mv,
          usbPluggedIn,
          chargerStatusBits,
          chargerStatus: chargerStatusMap[chargerStatusBits] ?? 'Unknown',
        };
      }

      out.push({ gsr, batt });
    }

    return out;
  }

  override applyOperationalConfig(op: Uint8Array): void {
    const gen1 = op[OP_IDX.GEN_CFG_1] ?? 0;
    const gen2 = op[OP_IDX.GEN_CFG_2] ?? 0;

    this.gsrEnabled = ((gen1 >> 7) & 0x01) === 1;
    this.battEnabled = (gen2 & 0b00000010) !== 0;

    const rateCfg = (op[OP_IDX.ADC_CHANNEL_SETTINGS_0] ?? 0) & 0x3f;
    const cfg1 = (op[OP_IDX.ADC_CHANNEL_SETTINGS_1] ?? 0) & 0xff;
    const rangeCfg = cfg1 & 0x07;
    const oversamplingCfg = (cfg1 >> 4) & 0x0f;

    this.gsrRateSettingRaw = rateCfg;
    this.gsrRangeSettingRaw = rangeCfg;
    this.gsrOversamplingRateSettingRaw = oversamplingCfg;

    // Drive per-sample timestamp spacing from the configured ADC rate. Without
    // this, samplingRateHz stays at the constructor default (50 Hz); when the
    // real rate differs, computeSampleTimestamps mis-spaces samples and
    // consecutive blocks overlap on the time axis (the GSR "zigzag").
    const rateHz = this.decodeAdcSampleRateHz(rateCfg);
    if (rateHz) this.samplingRateHz = rateHz;

    if (rangeCfg >= 0 && rangeCfg <= 4) {
      this.gsrRangeSetting = rangeCfg;
    }
  }
}
