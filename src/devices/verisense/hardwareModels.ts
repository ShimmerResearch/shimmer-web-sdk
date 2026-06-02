export type VerisenseHardwareFriendlyName = 'IMU' | 'GSR+' | 'SDK' | 'Pulse+';

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

  // SR61.5 and >= SR68.9
  if (
    (revHwMajor === 61 && revHwMinor === 5) ||
    revHwMajor > 68 ||
    (revHwMajor === 68 && revHwMinor >= 9)
  ) {
    return 2.469;
  }

  return 1.0;
}
