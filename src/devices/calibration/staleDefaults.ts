/**
 * A Shimmer3 still holding the pre-2025 KXTC9-2050 default calibration
 * (DEV-1528; the rule was agreed on DEV-1521).
 *
 * The KXTC9-2050 low-noise accelerometer's output is ratiometric to its
 * supply: Kionix specifies 1.65 V at zero g and 660 mV/g at Vdd = 3.3 V, with
 * an offset and a sensitivity ratiometric error. Every Shimmer3 board that
 * carries it runs it from the 3.0 V rail that is also the ADC's reference, so
 * it reads 2047 at zero g and 83 counts per m/s², the KXRB5-2042's figures and
 * this SDK's `shimmer3-new` defaults. Firmware before DEV-4 (log-and-stream-common
 * `8dce5c2`, Feb 2025) wrote 2253 and 92, the 3.3 V figures, into a new-IMU
 * unit's own default calibration record, and a unit first set up then still
 * carries that record. Applied as it stands, it makes the low-noise accel read
 * gravity about 17 % high.
 *
 * The rule is to warn, never to substitute: a host that quietly applied
 * 2047/83 instead would change a customer's calibrated output partway through
 * their use, after nothing more than an update. So the record stays in force,
 * output stays exactly as it was, and the user is told to recalibrate.
 */

import type { KinematicCalibration } from './kinematic.js';

/** The offset the pre-2025 firmware wrote for a KXTC9-2050, per axis. */
export const STALE_KXTC9_DEFAULT_OFFSET = 2253;

/** The sensitivity the pre-2025 firmware wrote for a KXTC9-2050, per axis. */
export const STALE_KXTC9_DEFAULT_SENSITIVITY = 92;

/**
 * The Kionix low-noise accel's default alignment, row-major: the alignment the
 * stale record carries (stored as int8 × 100: 0, −100, 0, −100, 0, 0, 0, 0, −100).
 */
const KIONIX_DEFAULT_ALIGNMENT: readonly number[] = [0, -1, 0, -1, 0, 0, 0, 0, -1];

/** What a host tells the user once per connection or SD file when it finds the record. */
export const STALE_LN_ACCEL_DEFAULT_WARNING =
  "This sensor's low-noise accelerometer still has the pre-2025 default calibration " +
  '(offset 2253, sensitivity 92), which reads about 17 % high on a Shimmer3. Raw data is ' +
  'unaffected. Recalibrate the low-noise accelerometer in Consensys to correct it.';

/**
 * True when a Shimmer3 low-noise accel calibration is exactly the pre-2025
 * KXTC9-2050 default: offset 2253 and sensitivity 92 on every axis, with the
 * Kionix default alignment.
 *
 * Values alone decide it, with no timestamp or board condition: the firmware
 * wrote the record with a zero timestamp, but a host that wrote its own old
 * defaults back to a unit would have stored the same values with a real one,
 * and either way they are wrong for the hardware. A real calibration never
 * lands on exactly these numbers. Callers apply it to a Shimmer3's low-noise
 * accel only; a Shimmer3R's LSM6DSV has nothing to do with it.
 */
export function isStaleKxtc9DefaultCalibration(
  cal: Pick<KinematicCalibration, 'offset' | 'sensitivity' | 'alignment'> | null | undefined,
): boolean {
  if (!cal) return false;
  return (
    cal.offset.length === 3 &&
    cal.offset.every((v) => v === STALE_KXTC9_DEFAULT_OFFSET) &&
    cal.sensitivity.length === 3 &&
    cal.sensitivity.every((v) => v === STALE_KXTC9_DEFAULT_SENSITIVITY) &&
    cal.alignment.length === 9 &&
    cal.alignment.every((v, i) => v === KIONIX_DEFAULT_ALIGNMENT[i])
  );
}
