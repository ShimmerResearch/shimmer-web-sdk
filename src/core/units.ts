/**
 * The unit vocabulary emitted on {@link SensorField.unit}.
 *
 * These are the Java driver's exact strings (`Configuration.java:117-176`,
 * `CHANNEL_UNITS`), and they are exact on purpose: a recording made by this SDK
 * and one made by Consensys describe the same signal with the same word, so a
 * script that reads a units row does not have to know which tool wrote the
 * file. That is also why the long spellings survive here — `'Degrees Celsius'`
 * rather than `'°C'`, `'m/(s^2)'` rather than `'m/s²'`. A user interface is
 * free to render something prettier (the demo pages do); the recorded string is
 * the interchange format, and it stays ASCII so a CSV cannot depend on the
 * reader's encoding.
 *
 * Two entries deviate from Java, both deliberately:
 *
 * - `TICKS` is lowercase where Java writes `'Ticks'`. This SDK has emitted
 *   `'ticks'` on the timestamp channel since the first release, the demo pages
 *   and their tests hard-code it, and the capitalisation carries no
 *   information.
 * - Java has no name for "this value is raw ADC counts". It writes
 *   `NO_UNITS = 'no_units'` there, and so does this SDK — see {@link NO_UNITS}
 *   for why a raw field carries that rather than `null`.
 */
export const CHANNEL_UNITS = Object.freeze({
  /**
   * A value with no unit: raw ADC counts, a range code, a register readback.
   *
   * Raw fields carry this string rather than `null` because a units row with an
   * empty cell reads as "the unit was not recorded", where this reads as "there
   * is no unit" — and those are different facts about a column. Java makes the
   * same distinction with the same word.
   */
  NO_UNITS: 'no_units',
  /** The 32768 Hz sample counter. Lowercase — see the module docblock. */
  TICKS: 'ticks',
  /** Milliseconds. Used for a calibrated timestamp and a real-world time. */
  MILLISECONDS: 'ms',
  MILLIVOLTS: 'mV',
  KOHMS: 'kOhms',
  /** Microsiemens. Java's `U_SIEMENS`; this SDK previously said `'uSiemens'`. */
  MICRO_SIEMENS: 'uS',
  KPASCAL: 'kPa',
  /** Java's `DEGREES_CELSIUS`, spelled out. */
  DEGREES_CELSIUS: 'Degrees Celsius',
  /** Java's `DEGREES_CELSIUS_SHORT`. For a UI label, never for a recording. */
  DEGREES_CELSIUS_SHORT: '°C',
  PERCENT: '%',
  /** Acceleration. Java's `METER_PER_SECOND_SQUARE` / `ACCEL_CAL_UNIT`. */
  ACCEL: 'm/(s^2)',
  /** Angular rate. Java's `DEGREES_PER_SECOND` / `GYRO_CAL_UNIT`. */
  GYRO: 'deg/s',
  /**
   * Magnetic flux in the magnetometer's own units. Java's `LOCAL_FLUX` /
   * `MAG_CAL_UNIT` — the kinematic block's sensitivity is in LSB/Gauss on some
   * parts and LSB/gauss-equivalent on others, and the driver has never claimed
   * more precision than "local flux" for the result.
   */
  MAG: 'local_flux',
  /** Microtesla. What the Verisense decoders emit for their magnetometer. */
  MICRO_TESLA: 'uT',
} as const);

/** One of the {@link CHANNEL_UNITS} strings. */
export type ChannelUnit = (typeof CHANNEL_UNITS)[keyof typeof CHANNEL_UNITS];
