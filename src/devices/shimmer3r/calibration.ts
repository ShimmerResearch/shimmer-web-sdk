import { SHIMMER3_GSR_RESISTANCE_MIN_MAX_KOHMS } from './constants.js';

// ---------------------------------------------------------------------------
// ADC helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Shimmer3R 12-bit ADC value to millivolts.
 *
 * @param unCalData  Raw 12-bit ADC sample.
 * @param offset     ADC offset (typically 0).
 * @param vRefP      Reference voltage in volts (typically 3 V for Shimmer3R).
 * @param gain       Amplifier gain (typically 1).
 * @returns Calibrated voltage in millivolts.
 */
export function calibrateU12AdcValue(
  unCalData: number,
  offset: number,
  vRefP: number,
  gain: number,
): number {
  return (unCalData - offset) * (((vRefP * 1000) / gain) / 4095);
}

/**
 * Convert a Shimmer3R ADC channel value to millivolts using the
 * default Shimmer3R ADC parameters (Vref = 3 V, gain = 1, offset = 0).
 *
 * @param unCalData Raw 12-bit ADC sample.
 * @returns Voltage in millivolts.
 */
export function calibrateShimmer3RAdcChannel(unCalData: number): number {
  return calibrateU12AdcValue(unCalData, 0, 3, 1);
}

// ---------------------------------------------------------------------------
// GSR calibration
// ---------------------------------------------------------------------------

/**
 * Convert a raw GSR ADC sample to skin resistance (kΩ) using the
 * Shimmer3R amplifier equation.
 *
 * Reference resistors per range (kΩ): [40.2, 287.0, 1000.0, 3300.0].
 *
 * @param gsrUncalibratedData Raw 12-bit GSR ADC value.
 * @param range               Hardware range index 0–3.
 * @returns Resistance in kΩ.
 */
export function calibrateGsrDataToResistanceFromAmplifierEq(
  gsrUncalibratedData: number,
  range: number,
): number {
  const SHIMMER3_REF_KOHMS = [40.2, 287.0, 1000.0, 3300.0];
  const rFeedback = SHIMMER3_REF_KOHMS[range];
  const volts = calibrateShimmer3RAdcChannel(gsrUncalibratedData) / 1000.0; // mV → V
  const rSource = rFeedback / (volts / 0.5 - 1.0);
  return rSource;
}

/**
 * Clamp a GSR resistance value to the physical limits of a given range.
 *
 * When `gsrRangeSetting === 4` (auto-range) no clamping is applied.
 *
 * @param gsrResistanceKOhms Calibrated resistance in kΩ.
 * @param gsrRangeSetting    Range 0–3 (fixed) or 4 (auto).
 * @returns Clamped resistance in kΩ.
 */
export function nudgeGsrResistance(
  gsrResistanceKOhms: number,
  gsrRangeSetting: number,
): number {
  if (gsrRangeSetting === 4) return gsrResistanceKOhms;
  const [minVal, maxVal] = SHIMMER3_GSR_RESISTANCE_MIN_MAX_KOHMS[gsrRangeSetting];
  return Math.max(minVal, Math.min(maxVal, gsrResistanceKOhms));
}

// ---------------------------------------------------------------------------
// ExG (ADS1292R) oversampling ratio
// ---------------------------------------------------------------------------

/**
 * Determine the ADS1292R oversampling ratio config byte for a given
 * Shimmer3R sampling rate.
 *
 * This value is ORed into the lower 3 bits of ExG config byte index 4.
 *
 * @param samplingRate Shimmer3R sampling rate in Hz (must be ≥ 0).
 * @returns Oversampling ratio index 0–6.
 */
export function getOversamplingRatioADS1292R(samplingRate: number): number {
  if (!Number.isFinite(samplingRate)) {
    throw new TypeError('samplingRate must be a finite number');
  }
  if (samplingRate < 0) {
    throw new RangeError('samplingRate must be non-negative');
  }

  if (samplingRate < 125) return 0;
  if (samplingRate < 250) return 1;
  if (samplingRate < 500) return 2;
  if (samplingRate < 1000) return 3;
  if (samplingRate < 2000) return 4;
  if (samplingRate < 4000) return 5;
  return 6; // ≥ 4000 Hz
}
