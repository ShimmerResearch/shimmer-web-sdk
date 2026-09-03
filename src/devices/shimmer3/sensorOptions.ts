/**
 * Configuration option tables for the Shimmer3 / Shimmer3R families.
 *
 * Every table is the set of values a firmware config field will accept, paired
 * with the label the Shimmer software has shown for it since Consensys. They
 * are ported VERBATIM from the Java driver
 * (`Shimmer-Java-Android-API/ShimmerDriver/.../com/shimmerresearch/`), values
 * and labels alike, with a `file:line` citation above each one.
 *
 * Verbatim matters more here than tidiness. These are the strings a researcher
 * recorded in a trial log next to their data, so a host that renames "Ultra
 * High" to "Very High" makes two records of the same setting disagree — and the
 * config values are register encodings, several of which are neither
 * contiguous nor monotonic. Where the Java list looks wrong (a duplicated
 * label, a gap in the values, a config array longer than its labels) that
 * oddity is reproduced and the comment says why, because the firmware is what
 * the Java list describes.
 *
 * The two families share this file because they share the command set: a table
 * belongs to a CHIP, not to a platform, and which chip answers is what changed
 * between a Shimmer3 (MPU9X50, LSM303DLHC/AH, BMP180/280) and a Shimmer3R
 * (LSM6DSV, LIS2DW12, LIS2MDL/LIS3MDL, ADXL371, BMP390/581).
 */

import { SHIMMER3_SAMPLING_CLOCK_FREQ } from './protocol.js';
import { SensorBitmapShimmer3, type SensorBitmapShimmer3Key } from '../shimmer3r/SensorBitmap.js';

/**
 * One selectable option: `[configValue, label]`.
 *
 * Same shape as `VerisenseOperationalFieldOption`, so a UI that renders one
 * family's options renders the other's unchanged.
 */
export type Shimmer3SensorOption = readonly [number, string];

// The characters the Java labels are built from (`UtilShimmer.java:59-64`):
// UNICODE_PLUS_MINUS "±", UNICODE_MICRO "µ", UNICODE_OHMS "Ω".
// Note that several older lists spell the sign as ASCII "+/-" instead; the
// inconsistency is in the Java source and is preserved.

// ---------------------------------------------------------------------------
// LSM6DSV — Shimmer3R low-noise accelerometer + gyroscope
// ---------------------------------------------------------------------------

/** `SensorLSM6DSV.java:61-67` (ListofLSM6DSVAccelRange[ConfigValues]). */
export const SHIMMER3_LSM6DSV_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '± 2g'],
  [1, '± 4g'],
  [2, '± 8g'],
  [3, '± 16g'],
];

/** `SensorLSM6DSV.java:274-275` (ListofGyroRange / ListofLSM6DSVGyroRangeConfigValues). */
export const SHIMMER3_LSM6DSV_GYRO_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 125dps'],
  [1, '+/- 250dps'],
  [2, '+/- 500dps'],
  [3, '+/- 1000dps'],
  [4, '+/- 2000dps'],
  [5, '+/- 4000dps'],
];

/**
 * `SensorLSM6DSV.java:276-278` (ListofLSM6DSVGyroRate / …ConfigValues).
 *
 * One rate drives both halves of the chip — the Java field is
 * `mLSM6DSVGyroAccelRate` — so there is no separate accelerometer table.
 *
 * The Java config-value array runs 0-13 while the label array stops at 12, so
 * its last entry pairs with nothing; only the 13 labelled values are listed
 * here.
 */
export const SHIMMER3_LSM6DSV_ACCEL_GYRO_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [1, '1.875Hz'],
  [2, '7.5Hz'],
  [3, '12.0Hz'],
  [4, '30.0Hz'],
  [5, '60.0Hz'],
  [6, '120.0Hz'],
  [7, '240.0Hz'],
  [8, '480.0Hz'],
  [9, '960.0Hz'],
  [10, '1920.0Hz'],
  [11, '3840.0Hz'],
  [12, '7680.0Hz'],
];

// ---------------------------------------------------------------------------
// LIS2DW12 — Shimmer3R wide-range accelerometer
// ---------------------------------------------------------------------------

/** `SensorLIS2DW12.java:117-122, 236` (ListofLIS2DW12AccelRange[ConfigValues]). */
export const SHIMMER3_LIS2DW12_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '± 2g'],
  [1, '± 4g'],
  [2, '± 8g'],
  [3, '± 16g'],
];

/**
 * High-performance-mode rates, `SensorLIS2DW12.java:238-239`.
 *
 * Values 1 and 2 both read "12.5Hz": in high-performance mode the chip's
 * lowest two ODR codes land on the same output rate. Reproduced from the Java
 * list rather than de-duplicated, because both codes are writable.
 */
export const SHIMMER3_LIS2DW12_ACCEL_RATE_HPM_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [1, '12.5Hz'],
  [2, '12.5Hz'],
  [3, '25.0Hz'],
  [4, '50.0Hz'],
  [5, '100.0Hz'],
  [6, '200.0Hz'],
  [7, '400.0Hz'],
  [8, '800.0Hz'],
  [9, '1600.0Hz'],
];

/**
 * Low-power-mode rates, `SensorLIS2DW12.java:241-242`.
 *
 * Values 6-9 all read "200.0Hz" — low-power mode cannot go faster, so the
 * higher ODR codes saturate. Again as the Java list has it.
 */
export const SHIMMER3_LIS2DW12_ACCEL_RATE_LPM_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [1, '1.6Hz'],
  [2, '12.5Hz'],
  [3, '25.0Hz'],
  [4, '50.0Hz'],
  [5, '100.0Hz'],
  [6, '200.0Hz'],
  [7, '200.0Hz'],
  [8, '200.0Hz'],
  [9, '200.0Hz'],
];

// ---------------------------------------------------------------------------
// ADXL371 — Shimmer3R alternate (high-g) accelerometer
// ---------------------------------------------------------------------------

/** `SensorADXL371.java:179-180` (ListofADXL371AccelRate[ConfigValues]). */
export const SHIMMER3_ADXL371_ACCEL_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '320Hz'],
  [1, '640Hz'],
  [2, '1280Hz'],
  [3, '2560Hz'],
];

/**
 * `SensorADXL371.java:181-182` (ListofADXL371AccelRange[ConfigValues]).
 * A single fixed range — the option exists so the UI can show it, not choose.
 */
export const SHIMMER3_ADXL371_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 200g'],
];

// ---------------------------------------------------------------------------
// LIS2MDL — Shimmer3R magnetometer
// ---------------------------------------------------------------------------

/** `SensorLIS2MDL.java:147-148` (ListofLIS2MDLMagRate[ConfigValues]). */
export const SHIMMER3_LIS2MDL_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '10.0Hz'],
  [1, '20.0Hz'],
  [2, '50.0Hz'],
  [3, '100.0Hz'],
];

/** `SensorLIS2MDL.java:150-151` (ListofLIS2MDLMagRange[ConfigValues]) — fixed range. */
export const SHIMMER3_LIS2MDL_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 49.152Ga'],
];

// ---------------------------------------------------------------------------
// LIS3MDL — Shimmer3R alternate magnetometer
// ---------------------------------------------------------------------------

/**
 * `SensorLIS3MDL.java:177-178` (ListofLIS3MDLAltMagRate[ConfigValues]).
 *
 * These config values are raw CTRL_REG1 codes, not indexes: 0x01, 0x11, 0x21,
 * 0x31, 0x3E, 0x3A, 0x08. They are neither contiguous nor monotonic — 0x3E
 * (80Hz) is numerically above 0x3A (20Hz), and 0x08 (10Hz) is below all of
 * them. Keep them exactly as they are; deriving them from the label order
 * would write the wrong register.
 */
export const SHIMMER3_LIS3MDL_ALT_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0x01, '1000Hz'],
  [0x11, '560Hz'],
  [0x21, '300Hz'],
  [0x31, '155Hz'],
  [0x3e, '80Hz'],
  [0x3a, '20Hz'],
  [0x08, '10Hz'],
];

/** `SensorLIS3MDL.java:179-180` (ListofLIS3MDLAltMagRange[ConfigValues]). */
export const SHIMMER3_LIS3MDL_ALT_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 4Ga'],
  [1, '+/- 8Ga'],
  [2, '+/- 12Ga'],
  [3, '+/- 16Ga'],
];

// ---------------------------------------------------------------------------
// Pressure / temperature
// ---------------------------------------------------------------------------

/** `SensorBMP390.java:124-125` (ListofPressureResolutionBMP390[ConfigValues]). */
export const SHIMMER3_BMP390_PRESSURE_OVERSAMPLING_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Ultra Low'],
  [1, 'Low'],
  [2, 'Standard'],
  [3, 'High'],
  [4, 'Ultra High'],
  [5, 'Highest'],
];

/** `SensorBMP390.java:126-127` (ListofPressureRateBMP390[ConfigValues]). */
export const SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '200.0Hz'],
  [1, '100.0Hz'],
  [2, '50.0Hz'],
  [3, '25.0Hz'],
  [4, '12.5Hz'],
  [5, '6.25Hz'],
  [6, '3.1Hz'],
  [7, '1.5Hz'],
  [8, '0.78Hz'],
  [9, '0.39Hz'],
  [10, '0.2Hz'],
  [11, '0.1Hz'],
  [12, '0.05Hz'],
  [13, '0.02Hz'],
  [14, '0.01Hz'],
  [15, '0.006Hz'],
  [16, '0.003Hz'],
  [17, '0.0015Hz'],
];

/** `SensorBMP581.java:107-108` (ListofPressureResolutionBMP581[ConfigValues]). */
export const SHIMMER3_BMP581_PRESSURE_OVERSAMPLING_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Lowest Power'],
  [1, 'Low'],
  [2, 'Standard'],
  [3, 'High'],
  [4, 'High Res'],
  [5, 'Very High Res'],
  [6, 'Ultra High Res'],
  [7, 'Highest Res'],
];

/**
 * `SensorBMP581.java:109-110` — the Java source aliases the BMP390 arrays
 * rather than copying them, so this aliases the table for the same reason: one
 * definition, and the two cannot drift apart.
 */
export const SHIMMER3_BMP581_PRESSURE_RATE_OPTIONS = SHIMMER3_BMP390_PRESSURE_RATE_OPTIONS;

/** `SensorBMP180.java:107-108` (ListofPressureResolution[ConfigValues]). */
export const SHIMMER3_BMP180_PRESSURE_RESOLUTION_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Low'],
  [1, 'Standard'],
  [2, 'High'],
  [3, 'Very High'],
];

/**
 * `SensorBMP280.java:112-113` (ListofPressureResolutionBMP280[ConfigValues]).
 * The top label reads "Ultra High" where the BMP180's reads "Very High"; the
 * difference is in the Java source and is kept.
 */
export const SHIMMER3_BMP280_PRESSURE_RESOLUTION_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Low'],
  [1, 'Standard'],
  [2, 'High'],
  [3, 'Ultra High'],
];

// ---------------------------------------------------------------------------
// GSR
// ---------------------------------------------------------------------------

/**
 * `SensorGSR.java:115-127` (ListofGSRRangeResistance / ListofGSRRangeConfigValues).
 * The same four hardware ranges the Shimmer software labels by resistance.
 */
export const SHIMMER3_GSR_RANGE_RESISTANCE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '8kΩ to 63kΩ'],
  [1, '63kΩ to 220kΩ'],
  [2, '220kΩ to 680kΩ'],
  [3, '680kΩ to 4.7MΩ'],
  [4, 'Auto Range'],
];

/**
 * `SensorGSR.java:121-127` (ListofGSRRangeConductance / ListofGSRRangeConfigValues).
 * The identical ranges expressed as conductance, which is why the numbers run
 * downwards. Offer whichever unit the study reports in — the config value is
 * the same either way.
 */
export const SHIMMER3_GSR_RANGE_CONDUCTANCE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '125µS to 15.9µS'],
  [1, '15.9µS to 4.5µS'],
  [2, '4.5µS to 1.5µS'],
  [3, '1.5µS to 0.2µS'],
  [4, 'Auto Range'],
];

// ---------------------------------------------------------------------------
// LSM303DLHC — classic Shimmer3 wide-range accelerometer + magnetometer
// ---------------------------------------------------------------------------

/** `SensorLSM303.java:83-86` labels, `SensorLSM303DLHC.java:325` values. */
export const SHIMMER3_LSM303DLHC_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '± 2g'],
  [1, '± 4g'],
  [2, '± 8g'],
  [3, '± 16g'],
];

/**
 * High-resolution-mode rates, `SensorLSM303DLHC.java:327-328`.
 *
 * The values skip 8: that ODR code is the low-power-only 1620Hz setting, so in
 * high-resolution mode 1344Hz is code 9. A table generated from label indexes
 * would silently select 1620Hz here.
 */
export const SHIMMER3_LSM303DLHC_ACCEL_RATE_HR_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [1, '1.0Hz'],
  [2, '10.0Hz'],
  [3, '25.0Hz'],
  [4, '50.0Hz'],
  [5, '100.0Hz'],
  [6, '200.0Hz'],
  [7, '400.0Hz'],
  [9, '1344.0Hz'],
];

/**
 * Low-power-mode rates, `SensorLSM303DLHC.java:330-331`. 1620Hz and 5376Hz are
 * available in low-power mode only (the Java comment says as much).
 */
export const SHIMMER3_LSM303DLHC_ACCEL_RATE_LPM_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [1, '1.0Hz'],
  [2, '10.0Hz'],
  [3, '25.0Hz'],
  [4, '50.0Hz'],
  [5, '100.0Hz'],
  [6, '200.0Hz'],
  [7, '400.0Hz'],
  [8, '1620.0Hz'],
  [9, '5376.0Hz'],
];

/**
 * `SensorLSM303DLHC.java:357-358` (ListofLSM303DLHCMagRange[ConfigValues]).
 * Values start at 1 — the Java comment reads "no '0' option" — so the first
 * label is NOT config value 0.
 */
export const SHIMMER3_LSM303DLHC_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [1, '+/- 1.3Ga'],
  [2, '+/- 1.9Ga'],
  [3, '+/- 2.5Ga'],
  [4, '+/- 4.0Ga'],
  [5, '+/- 4.7Ga'],
  [6, '+/- 5.6Ga'],
  [7, '+/- 8.1Ga'],
];

/** `SensorLSM303DLHC.java:354-355` (ListofLSM303DLHCMagRate[ConfigValues]). */
export const SHIMMER3_LSM303DLHC_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '0.75Hz'],
  [1, '1.5Hz'],
  [2, '3.0Hz'],
  [3, '7.5Hz'],
  [4, '15.0Hz'],
  [5, '30.0Hz'],
  [6, '75.0Hz'],
  [7, '220.0Hz'],
];

// ---------------------------------------------------------------------------
// LSM303AH — later classic-Shimmer3 (new-IMU) accelerometer + magnetometer
// ---------------------------------------------------------------------------

/**
 * `SensorLSM303.java:83-86` labels, `SensorLSM303AH.java:174` values.
 *
 * The values are `{0, 2, 3, 1}`: this chip's FS bits do not run in range
 * order, so ±4g is code 2, ±8g code 3 and ±16g code 1. Pairing labels with
 * their index — the obvious "simplification" — swaps ±4g with ±16g and
 * miscalibrates every sample by a factor of four.
 */
export const SHIMMER3_LSM303AH_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '± 2g'],
  [2, '± 4g'],
  [3, '± 8g'],
  [1, '± 16g'],
];

/** High-resolution-mode rates, `SensorLSM303AH.java:176-177`. */
export const SHIMMER3_LSM303AH_ACCEL_RATE_HR_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [1, '12.5Hz'],
  [2, '25.0Hz'],
  [3, '50.0Hz'],
  [4, '100.0Hz'],
  [5, '200.0Hz'],
  [6, '400.0Hz'],
  [7, '800.0Hz'],
  [8, '1600.0Hz'],
  [9, '3200.0Hz'],
  [10, '6400.0Hz'],
];

/**
 * Low-power-mode rates, `SensorLSM303AH.java:179-180`.
 * Values jump from 0 straight to 8-15: low-power ODR codes live in the upper
 * half of the field, so only "Power-down" is shared with the table above.
 */
export const SHIMMER3_LSM303AH_ACCEL_RATE_LPM_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, 'Power-down'],
  [8, '1.0Hz'],
  [9, '12.5Hz'],
  [10, '25.0Hz'],
  [11, '50.0Hz'],
  [12, '100.0Hz'],
  [13, '200.0Hz'],
  [14, '400.0Hz'],
  [15, '800.0Hz'],
];

/** `SensorLSM303AH.java:202-203` (ListofLSM303AHMagRate[ConfigValues]). */
export const SHIMMER3_LSM303AH_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '10.0Hz'],
  [1, '20.0Hz'],
  [2, '50.0Hz'],
  [3, '100.0Hz'],
];

/** `SensorLSM303AH.java:205-206` (ListofLSM303AHMagRange[ConfigValues]) — fixed range. */
export const SHIMMER3_LSM303AH_MAG_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 49.152Ga'],
];

// ---------------------------------------------------------------------------
// MPU9X50 — classic Shimmer3 gyroscope + alternate accelerometer/magnetometer
// ---------------------------------------------------------------------------

/**
 * `SensorMPU9X50.java:366-367` (ListofGyroRange / ListofMPU9X50GyroRangeConfigValues).
 * Four ranges, where the Shimmer3R's LSM6DSV offers six — the reason a caller
 * must know which platform it is configuring before validating a gyro range.
 */
export const SHIMMER3_MPU9X50_GYRO_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 250dps'],
  [1, '+/- 500dps'],
  [2, '+/- 1000dps'],
  [3, '+/- 2000dps'],
];

/** `SensorMPU9X50.java:369-370` (ListofMPU9X50AccelRange[ConfigValues]). */
export const SHIMMER3_MPU9X50_ACCEL_RANGE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '+/- 2g'],
  [1, '+/- 4g'],
  [2, '+/- 8g'],
  [3, '+/- 16g'],
];

/** `SensorMPU9X50.java:371-372` (ListofMPU9X50MagRate[ConfigValues]). */
export const SHIMMER3_MPU9X50_MAG_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '10.0Hz'],
  [1, '20.0Hz'],
  [2, '40.0Hz'],
  [3, '50.0Hz'],
  [4, '100.0Hz'],
];

// ---------------------------------------------------------------------------
// Bluetooth
// ---------------------------------------------------------------------------

/**
 * `Configuration.java:649-650`
 * (Shimmer3.ListofBluetoothBaudRates[ConfigValues]).
 *
 * 115200 is config value 0 and heads the list, so the labels are NOT in
 * ascending rate order. That is the firmware's default-first ordering, kept as
 * it is.
 */
export const SHIMMER3_BT_BAUD_RATE_OPTIONS: readonly Shimmer3SensorOption[] = [
  [0, '115200'],
  [1, '1200'],
  [2, '2400'],
  [3, '4800'],
  [4, '9600'],
  [5, '19200'],
  [6, '38400'],
  [7, '57600'],
  [8, '230400'],
  [9, '460800'],
  [10, '921600'],
];

// ---------------------------------------------------------------------------
// Sampling rate
// ---------------------------------------------------------------------------

/**
 * The sampling rates the Shimmer software offers for a Shimmer3 / Shimmer3R.
 *
 * NOT ported from the Java driver: it has no such list. Java holds a sampling
 * rate as a double and converts it to a divisor on the way out, so the picker
 * values live in the Consensys UI rather than in the driver.
 * (`Configuration.java:2365` is the ShimmerGqBle divider list — a different
 * device, and dividers rather than rates.) These are the conventional Shimmer3
 * rates: the ones that divide 32768 exactly, plus 1Hz and the 10.2 / 51.2 /
 * 102.4 / 204.8 family every Shimmer trial has used.
 *
 * Any positive rate is legal — the firmware takes a divisor, not an index — so
 * treat this as a picker's contents, not a validation set.
 */
export const SHIMMER3_SAMPLING_RATES_HZ: readonly number[] = [
  1, 10.2, 51.2, 102.4, 204.8, 256, 512, 1024, 2048,
];

/**
 * Convert a sampling rate to the 16-bit divisor SET_SAMPLING_RATE_COMMAND
 * carries: `floor(32768 / rateHz)`, clamped to 1…0xFFFF.
 *
 * Mirrors `Shimmer3RClient.setSamplingRate` (and Java's
 * `ShimmerObject#setSamplingRateShimmer`). The floor is why a requested rate
 * and the applied one differ: run the result back through
 * {@link divisorToSamplingRate} to find out what the device will actually do
 * before telling a user it is sampling at their number.
 */
export function samplingRateToDivisor(rateHz: number): number {
  if (!Number.isFinite(rateHz) || rateHz <= 0) {
    throw new Error('Sampling rate must be a positive number (Hz)');
  }
  return Math.max(1, Math.min(0xffff, Math.floor(SHIMMER3_SAMPLING_CLOCK_FREQ / rateHz)));
}

/** The rate a given divisor actually produces: `32768 / divisor`. */
export function divisorToSamplingRate(divisor: number): number {
  if (!Number.isFinite(divisor) || divisor <= 0) {
    throw new Error('Sampling-rate divisor must be a positive number');
  }
  return SHIMMER3_SAMPLING_CLOCK_FREQ / divisor;
}

// ---------------------------------------------------------------------------
// Sensor labels
// ---------------------------------------------------------------------------

/** A friendly name for one bit of the Shimmer3 sensor-enable bitmap. */
export interface Shimmer3SensorLabel {
  /** Display name, following the Shimmer software's own vocabulary. */
  readonly label: string;
  /**
   * True when a Shimmer3R serves this bit.
   *
   * It is true for every bit, and that is the finding rather than an oversight:
   * the enable bitmap is identical across the two platforms. What changed
   * between them is which chip answers a bit — SENSOR_GYRO is an MPU9X50 on a
   * Shimmer3 and an LSM6DSV on a Shimmer3R — which is why the option tables
   * above come in per-chip pairs while this map does not. The flag is kept
   * explicit so a caller gates on a stated fact instead of assuming, and so a
   * future divergence has one place to land.
   */
  readonly shimmer3r: boolean;
}

/**
 * Friendly labels for the sensor-enable bits, keyed by
 * {@link SensorBitmapShimmer3}.
 *
 * The ADC channels are the one place the two platforms disagree on wording, not
 * on availability: a Shimmer3's external channels are named for the MSP430 pins
 * (A7 / A6 / A15) and a Shimmer3R's are numbered 0-2 (`SensorADC.java:425-453`,
 * `Sensing/shimmer_sensing.h:105-122`). The labels below give both, because a
 * host that shows only one set leaves half its users unable to find their
 * channel.
 */
export const SHIMMER3_SENSOR_LABELS: Readonly<
  Record<SensorBitmapShimmer3Key, Shimmer3SensorLabel>
> = Object.freeze({
  SENSOR_A_ACCEL: { label: 'Low-Noise Accelerometer', shimmer3r: true },
  SENSOR_GYRO: { label: 'Gyroscope', shimmer3r: true },
  SENSOR_MAG: { label: 'Magnetometer', shimmer3r: true },
  SENSOR_GSR: { label: 'GSR', shimmer3r: true },

  SENSOR_VBATT: { label: 'Battery Voltage', shimmer3r: true },
  SENSOR_D_ACCEL: { label: 'Wide-Range Accelerometer', shimmer3r: true },
  SENSOR_PRESSURE: { label: 'Pressure & Temperature', shimmer3r: true },
  SENSOR_EXG1_24BIT: { label: 'ExG Chip 1 (24-bit)', shimmer3r: true },
  SENSOR_EXG2_24BIT: { label: 'ExG Chip 2 (24-bit)', shimmer3r: true },
  SENSOR_EXG1_16BIT: { label: 'ExG Chip 1 (16-bit)', shimmer3r: true },
  SENSOR_EXG2_16BIT: { label: 'ExG Chip 2 (16-bit)', shimmer3r: true },
  SENSOR_BRIDGE_AMP: { label: 'Bridge Amplifier', shimmer3r: true },
  SENSOR_ACCEL_ALT: { label: 'Alternate Accelerometer', shimmer3r: true },
  SENSOR_MAG_ALT: { label: 'Alternate Magnetometer', shimmer3r: true },

  SENSOR_EXT_A0: { label: 'External ADC A7 (Shimmer3R: 0)', shimmer3r: true },
  SENSOR_EXT_A1: { label: 'External ADC A6 (Shimmer3R: 1)', shimmer3r: true },
  SENSOR_EXT_A2: { label: 'External ADC A15 (Shimmer3R: 2)', shimmer3r: true },
  SENSOR_INT_A3: { label: 'Internal ADC A1 (Shimmer3R: 3)', shimmer3r: true },
  SENSOR_INT_A0: { label: 'Internal ADC A12 (Shimmer3R: 0)', shimmer3r: true },
  SENSOR_INT_A1: { label: 'Internal ADC A13 (Shimmer3R: 1)', shimmer3r: true },
  SENSOR_INT_A2: { label: 'Internal ADC A14 (Shimmer3R: 2)', shimmer3r: true },
} as const);

/** Label for one sensor-enable bit, or null when the bit is not a known sensor. */
export function shimmer3SensorLabel(mask: number): string | null {
  for (const [key, bit] of Object.entries(SensorBitmapShimmer3)) {
    if (bit === mask) return SHIMMER3_SENSOR_LABELS[key as SensorBitmapShimmer3Key].label;
  }
  return null;
}
