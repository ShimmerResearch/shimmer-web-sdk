/**
 * GSR: one raw ADC word → skin resistance, conductance, and the range that
 * produced them.
 *
 * The maths already lived in `devices/shimmer3r/calibration.ts`; what lived in
 * three places was the *sequence* around it — mask off the range bits, resolve
 * auto-range from the sample, apply the range-3 floor, clamp, invert. Both
 * streaming clients and the SD-log decoder each had their own copy, and they
 * had begun to drift. This is that sequence, once.
 *
 * Ported from `SensorGSR.processDataCustom` (:326-358) and
 * `nudgeGsrResistance` (:415-421).
 */

import { CHANNEL_UNITS } from '../../core/units.js';
import type { ObjectCluster } from '../../core/ObjectCluster.js';
import {
  calibrateGsrDataToResistanceFromAmplifierEq,
  nudgeGsrResistance,
} from '../shimmer3r/calibration.js';
import { GSR_NAME, GSR_UNCAL_LIMIT_RANGE3 } from '../shimmer3r/constants.js';

/** `'GSR_RESISTANCE'` — skin resistance in kΩ, Java's `GSR_RESISTANCE`. */
export const GSR_RESISTANCE_NAME = 'GSR_RESISTANCE';

/**
 * `'GSR_RANGE'` — which of the four feedback resistors produced this sample.
 *
 * Worth recording rather than inferring: on auto-range the firmware reports it
 * per sample in the top two bits, it changes mid-recording, and a step in the
 * conductance trace at a range boundary is a switching artefact rather than a
 * physiological event (`SHIMMER3_GSR_AUTORANGE.md` §4).
 */
export const GSR_RANGE_NAME = 'GSR_RANGE';

/** What one GSR sample resolves to. */
export interface CalibratedGsr {
  /** The resistor actually in circuit for this sample, 0-3. */
  range: number;
  /** Skin resistance in kΩ, clamped to what the range can measure. */
  resistanceKOhms: number;
  /** Skin conductance in µS. */
  conductanceUSiemens: number;
}

/**
 * Resolve the range for one sample.
 *
 * A configured range of 0-3 is used as-is. Range 4 is auto, and then the
 * firmware puts the resistor it chose in bits 14-15 of the sample itself, so it
 * has to be read per sample and not once per trial
 * (`SHIMMER3_STREAMING_DATA_FORMAT.md` §8, rule 7).
 */
export function gsrRangeForSample(rawSample: number, gsrRangeSetting: number): number {
  return gsrRangeSetting === 4 ? (rawSample >> 14) & 0x03 : gsrRangeSetting;
}

/**
 * Calibrate one raw GSR word.
 *
 * @param rawSample        The 16-bit `GSR` channel value, range bits included.
 * @param gsrRangeSetting  The configured range: 0-3 fixed, 4 auto.
 */
export function calibrateGsrSample(rawSample: number, gsrRangeSetting: number): CalibratedGsr {
  const range = gsrRangeForSample(rawSample, gsrRangeSetting);
  let adc12 = rawSample & 0x0fff;
  // On the largest range the amplifier is non-linear below this count, and the
  // firmware's own conversion floors it rather than extrapolating.
  if (range === 3 && adc12 < GSR_UNCAL_LIMIT_RANGE3) adc12 = GSR_UNCAL_LIMIT_RANGE3;
  const resistanceKOhms = nudgeGsrResistance(
    calibrateGsrDataToResistanceFromAmplifierEq(adc12, range),
    gsrRangeSetting,
  );
  return {
    range,
    resistanceKOhms,
    conductanceUSiemens: 1000 / resistanceKOhms,
  };
}

/**
 * Add the calibrated GSR fields to a decoded frame, if it carries a GSR
 * channel. No-op otherwise.
 *
 * Three fields, because they answer different questions and two of them cannot
 * be recovered from the third alone: conductance under the channel's own name
 * (what a host plots, and what this SDK has always emitted there), resistance
 * because that is what the amplifier measures and what some analyses want, and
 * the range because on auto-range it changes underneath the data.
 */
export function calibrateGsrChannel(oc: ObjectCluster, gsrRangeSetting: number): void {
  const raw = oc.get(GSR_NAME, 'raw')?.value;
  if (raw === undefined || raw === null || !Number.isFinite(raw)) return;
  const { range, resistanceKOhms, conductanceUSiemens } = calibrateGsrSample(raw, gsrRangeSetting);
  oc.add(GSR_NAME, conductanceUSiemens, CHANNEL_UNITS.MICRO_SIEMENS, 'cal');
  oc.add(GSR_RESISTANCE_NAME, resistanceKOhms, CHANNEL_UNITS.KOHMS, 'cal');
  oc.add(GSR_RANGE_NAME, range, CHANNEL_UNITS.NO_UNITS, 'cal');
}

export { GSR_NAME };
