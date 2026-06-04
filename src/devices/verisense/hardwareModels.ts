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
