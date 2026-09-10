/**
 * ExG (ADS1292R) counts → millivolts.
 *
 * The conversion needs two things out of the chip's own register bank — the
 * per-channel PGA gain and the reference voltage — so it lives beside the
 * register codec rather than with the kinematic calibration, which is
 * per-device rather than per-configuration.
 *
 * **The 16-bit mode is not a 16-bit conversion, and this is the part that gets
 * ported wrongly.** The firmware builds the 16-bit sample from bits **22:7** of
 * the chip's 24-bit conversion — its own header says so, "drops 7 least
 * significant bits and most significant bit"
 * (`Shimmer_Driver/EXG/exg.h:134`; the bit-shuffle is `exg.c:288-291` for chip 1
 * and `:261-266` for chip 2). The word is therefore the 24-bit value over 128
 * with bit 22 as its sign, and the full-scale denominator has to account for
 * it. Using `2^15 - 1` alone reports values **exactly twice too large**. The
 * Java driver's live path gets this right by doubling the gain instead
 * (`ShimmerObject.java:1856`), which is the same arithmetic; note that
 * `SensorEXG.computeCalConstantForChannel` (:3121-3132) does **not** double,
 * and disagrees with it.
 *
 * A consequence worth knowing: 16-bit mode halves the usable input range to
 * ±V_REF / (2·gain). Past that, bit 22 no longer agrees with bit 23, and the
 * two chips wrap differently — chip 1 takes bit 22 as the sign while chip 2
 * keeps bit 23 and drops bit 22 — so a saturated CH1 reads differently on the
 * two chips for the same input.
 */

import { GAIN_VALUES, readExgField } from './registers.js';
import type { ExgBanks } from './knobs.js';

/**
 * The ADS1292R's two reference voltages, selected by `CONFIG2` bit 4
 * (`VREF_4V`): 0 → 2.42 V, 1 → 4.033 V.
 *
 * The datasheet rounds these to 2.4 V and 4 V and the chip header follows it
 * (`Shimmer_Driver/EXG/ads1292.h:219,235-238`); the Java driver has always used
 * the unrounded 2.42 V in its conversion constants
 * (`ShimmerObject.java:721-724`), so these are the Java figures — a recording
 * from this SDK and one from Consensys agree to the last decimal.
 *
 * The firmware's own defaults write `CONFIG2 = 0x80`, i.e. bit 4 clear, so
 * 2.42 V is what an untouched sensor uses (`Configuration/shimmer_config.c`,
 * the ECG default set).
 */
export const EXG_VREF_VOLTS: readonly [number, number] = Object.freeze([2.42, 4.033]);

/** Which resolution the enabled ExG sensor bits selected. */
export type ExgSampleResolution = '24bit' | '16bit';

/** Gain when the bank says setting 7, which the chip does not define. */
const FALLBACK_GAIN = 6;

/**
 * The gain the bank selects for one channel, or {@link FALLBACK_GAIN} when the
 * setting is the undefined 7 (Java's `convertEXGGainSettingToValue` answers -1
 * there, `SensorEXG.java:2637-2656`; a negative gain would flip the signal, so
 * this SDK falls back to the chip's own default instead).
 */
function gainFor(bank: Uint8Array, channel: 1 | 2): number {
  const setting = readExgField(bank, channel === 1 ? 'ch1Gain' : 'ch2Gain');
  return GAIN_VALUES[setting] ?? FALLBACK_GAIN;
}

/** The reference voltage the bank selects. */
function vrefFor(bank: Uint8Array): number {
  return EXG_VREF_VOLTS[readExgField(bank, 'voltageReference') === 1 ? 1 : 0];
}

/**
 * The millivolts-per-count factor for one ExG channel.
 *
 * @param bank       That chip's 10-byte register bank, or `null` when the host
 *   has not read it. With `null` the chip's own defaults are assumed — gain 6,
 *   2.42 V — which is what the firmware writes and what the Java driver
 *   hard-codes; a caller that cares should read the bank
 *   (`Shimmer3RClient.readExgConfig()`) and say so to its user.
 * @param channel    1 or 2.
 * @param resolution Which sample width the sensor bitmap selected.
 */
export function exgChannelMillivoltFactor(
  bank: Uint8Array | null,
  channel: 1 | 2,
  resolution: ExgSampleResolution,
): number {
  const gain = bank ? gainFor(bank, channel) : FALLBACK_GAIN;
  const vref = bank ? vrefFor(bank) : EXG_VREF_VOLTS[0];
  return resolution === '24bit'
    ? (vref * 1000) / gain / (2 ** 23 - 1)
    : (vref * 1000) / (2 * gain * (2 ** 15 - 1));
}

/**
 * Convert one ExG sample to millivolts.
 *
 * `sample` must already be sign-extended — the stream decoder does that from
 * the channel's own width.
 */
export function calibrateExgSample(
  sample: number,
  bank: Uint8Array | null,
  channel: 1 | 2,
  resolution: ExgSampleResolution,
): number {
  return sample * exgChannelMillivoltFactor(bank, channel, resolution);
}

/**
 * What a host should show about the ExG conversion in force: the reference
 * voltage and both channels' gains, per chip.
 */
export interface ExgCalibrationSummary {
  vrefVolts: number;
  gainCh1: number;
  gainCh2: number;
}

/** Summarise one chip's bank; the chip defaults when `bank` is `null`. */
export function summariseExgCalibration(bank: Uint8Array | null): ExgCalibrationSummary {
  return {
    vrefVolts: bank ? vrefFor(bank) : EXG_VREF_VOLTS[0],
    gainCh1: bank ? gainFor(bank, 1) : FALLBACK_GAIN,
    gainCh2: bank ? gainFor(bank, 2) : FALLBACK_GAIN,
  };
}

/** Summarise both chips. */
export function summariseExgBanks(banks: ExgBanks | null): {
  chip1: ExgCalibrationSummary;
  chip2: ExgCalibrationSummary;
} {
  return {
    chip1: summariseExgCalibration(banks?.exg1 ?? null),
    chip2: summariseExgCalibration(banks?.exg2 ?? null),
  };
}
