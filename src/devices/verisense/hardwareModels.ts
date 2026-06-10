export type VerisenseHardwareFriendlyName = 'IMU' | 'GSR+' | 'SDK' | 'Pulse+';

export interface VerisenseHardwareCapabilities {
  readonly secondGeneration: boolean;
  readonly supportsMagnetometer: boolean;
}

export interface VerisenseHardwareRevision {
  readonly major: number;
  readonly minor: number;
  readonly internal: number;
}

export interface VerisenseHardwareRevisionSource {
  readonly revHwMajor?: number | null;
  readonly revHwMinor?: number | null;
  readonly revHwInternal?: number | null;
}

export const VERISENSE_HW_MAJOR_FRIENDLY_NAMES: Readonly<
  Record<number, VerisenseHardwareFriendlyName>
> = {
  61: 'IMU',
  62: 'GSR+',
  64: 'SDK',
  68: 'Pulse+',
};

export function getVerisenseHardwareFriendlyName(
  revHwMajor: number,
): VerisenseHardwareFriendlyName | null {
  return VERISENSE_HW_MAJOR_FRIENDLY_NAMES[revHwMajor] ?? null;
}

/**
 * Second-generation Verisense hardware is currently defined as:
 * - SR61.5+
 * - SR68.9+
 * - Any future major revision above SR68
 */
export function isVerisenseSecondGenerationHardware(
  revHwMajor: number,
  revHwMinor: number,
): boolean {
  const major = Number(revHwMajor);
  const minor = Number(revHwMinor);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;

  if (major > 68) return true;
  if (major === 61 && minor >= 5) return true;
  if (major === 68 && minor >= 9) return true;

  return false;
}

export function getVerisenseHardwareCapabilities(
  revHwMajor: number,
  revHwMinor: number,
): VerisenseHardwareCapabilities {
  const secondGeneration = isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor);
  return {
    secondGeneration,
    supportsMagnetometer: secondGeneration,
  };
}

/**
 * Which physical sensor blocks a Verisense board carries. Each flag lines up
 * with an operational-config field group (see
 * `getVerisenseSupportedOperationalFieldGroupIds`), so callers can decide which
 * config groups are meaningful for the connected hardware.
 *
 * Derived from the firmware Model IC matrix
 * (verisense-firmware/docs/VERISENSE_MODEL_IC_MATRIX.md).
 */
export interface VerisenseHardwareSensorSupport {
  /** 1st-gen low-power accel, LIS2DW12 (`accel1` group). */
  readonly accel1: boolean;
  /** 1st-gen gyro + accel2, LSM6DS3 (`gyro_accel2` group). */
  readonly gyroAccel2: boolean;
  /** 2nd-gen IMU + magnetometer, LSM6DSV + LIS2MDL (`lsm6dsv` group). */
  readonly imuGen2: boolean;
  /** Galvanic skin response front-end (`adc_gsr` group). */
  readonly gsr: boolean;
  /** Photoplethysmography front-end (`ppg` group). */
  readonly ppg: boolean;
  /** Ambient light sensor, VD6283 (`light` group). */
  readonly ambientLight: boolean;
  /** Skin temperature sensor, MLX90632 (`skin_temp` group). */
  readonly skinTemperature: boolean;
  /** Algorithm hub, MAX32674 (`algo` group). */
  readonly algorithmHub: boolean;
  /** 2xRGB status LEDs with auto-brightness (`led` group). */
  readonly ledAutoBrightness: boolean;
}

const VERISENSE_SENSOR_SUPPORT_NONE: VerisenseHardwareSensorSupport = {
  accel1: false,
  gyroAccel2: false,
  imuGen2: false,
  gsr: false,
  ppg: false,
  ambientLight: false,
  skinTemperature: false,
  algorithmHub: false,
  ledAutoBrightness: false,
};

const VERISENSE_SENSOR_SUPPORT_ALL: VerisenseHardwareSensorSupport = {
  accel1: true,
  gyroAccel2: true,
  imuGen2: true,
  gsr: true,
  ppg: true,
  ambientLight: true,
  skinTemperature: true,
  algorithmHub: true,
  ledAutoBrightness: true,
};

/**
 * Resolves which sensor blocks a given Verisense hardware revision carries,
 * derived from the firmware Model IC matrix
 * (verisense-firmware/docs/VERISENSE_MODEL_IC_MATRIX.md).
 *
 * Unknown / development hardware (e.g. SR64, or any unrecognised major
 * revision) reports every block as present so consumers never hide a setting
 * they cannot confidently rule out.
 */
export function getVerisenseHardwareSensorSupport(
  revHwMajor: number,
  revHwMinor: number,
): VerisenseHardwareSensorSupport {
  const major = Number(revHwMajor);
  const minor = Number(revHwMinor);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) {
    return { ...VERISENSE_SENSOR_SUPPORT_ALL };
  }

  const gen2 = isVerisenseSecondGenerationHardware(major, minor);

  switch (major) {
    case 61: // Verisense IMU
      return gen2
        ? // SR61.5+: LSM6DSV + LIS2MDL, GSR, ambient light, 2xRGB LEDs.
          {
            ...VERISENSE_SENSOR_SUPPORT_NONE,
            imuGen2: true,
            gsr: true,
            ambientLight: true,
            ledAutoBrightness: true,
          }
        : // SR61.1-4: LIS2DW12 + LSM6DS3 only.
          { ...VERISENSE_SENSOR_SUPPORT_NONE, accel1: true, gyroAccel2: true };
    case 62: // Verisense GSR+: LIS2DW12 + LSM6DS3, GSR, analog PPG.
      return {
        ...VERISENSE_SENSOR_SUPPORT_NONE,
        accel1: true,
        gyroAccel2: true,
        gsr: true,
        ppg: true,
      };
    case 63: // Verisense PPG: LIS2DW12 + LSM6DS3 + PPG.
      return { ...VERISENSE_SENSOR_SUPPORT_NONE, accel1: true, gyroAccel2: true, ppg: true };
    case 68: // Verisense Pulse+
      return gen2
        ? // SR68.9+: full 2nd-gen stack. The LIS2DW12 (accel1) is physically
          // present but routed to the algorithm hub and not recorded from, so
          // it is treated as unsupported for operational-config purposes.
          {
            ...VERISENSE_SENSOR_SUPPORT_NONE,
            imuGen2: true,
            gsr: true,
            ppg: true,
            ambientLight: true,
            skinTemperature: true,
            algorithmHub: true,
            ledAutoBrightness: true,
          }
        : // SR68.1-8: LIS2DW12 + PPG; skin temperature added from SR68.7.
          {
            ...VERISENSE_SENSOR_SUPPORT_NONE,
            accel1: true,
            ppg: true,
            skinTemperature: minor >= 7,
          };
    default:
      // SR64 (dev board) and any future/unknown major: assume everything.
      return { ...VERISENSE_SENSOR_SUPPORT_ALL };
  }
}

export function getVerisenseHardwareRevision(
  source: VerisenseHardwareRevisionSource | null | undefined,
): VerisenseHardwareRevision | null {
  if (!source) return null;

  const major = Number(source.revHwMajor);
  const minor = Number(source.revHwMinor);
  const internal = Number(source.revHwInternal);

  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(internal)) {
    return null;
  }

  if (major <= 0 || major > 255 || minor < 0 || minor > 255 || internal < 0 || internal > 65535) {
    return null;
  }

  return {
    major: Math.trunc(major),
    minor: Math.trunc(minor),
    internal: Math.trunc(internal),
  };
}

export function supportsVerisenseMagnetometer(
  source: VerisenseHardwareRevisionSource | null | undefined,
): boolean {
  const hw = getVerisenseHardwareRevision(source);
  if (!hw) return false;
  return getVerisenseHardwareCapabilities(hw.major, hw.minor).supportsMagnetometer;
}

export function formatVerisenseHardwareRevision(
  revHwMajor: number,
  revHwMinor: number,
  revHwInternal = 0,
  opts: { prefix?: string; includeFriendlyName?: boolean } = {},
): string {
  const prefix = opts.prefix ?? 'SR';
  const base = `${prefix}${revHwMajor}.${revHwMinor}.${revHwInternal}`;
  if (!opts.includeFriendlyName) return base;
  const friendly = getVerisenseHardwareFriendlyName(revHwMajor);
  return friendly ? `${base} (${friendly})` : base;
}

/**
 * Battery voltage scaling for streamed ADC battery samples.
 * Status responses already contain firmware-scaled battery values and should not use this helper.
 */
export function getVerisenseStreamingBatteryVoltageMultiplier(
  revHwMajor: number,
  revHwMinor: number,
): number {
  // SR62
  if (revHwMajor === 62) return 2.0;

  // SR61.5+, SR68.9+, and newer major revisions.
  if (isVerisenseSecondGenerationHardware(revHwMajor, revHwMinor)) {
    return 2.469;
  }

  return 1.0;
}
