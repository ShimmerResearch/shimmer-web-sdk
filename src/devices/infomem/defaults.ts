/**
 * Default trial identity for a Shimmer3/Shimmer3R configuration.
 *
 * These are the values a host should apply when it has to invent a
 * configuration — a blank or erased InfoMem, or an explicit reset to defaults —
 * rather than leaving the identity fields empty. They live here, in one place,
 * so every path that fills in a default agrees; a device named by one screen
 * and differently by another is worse than one not named at all.
 *
 * Deliberately NOT applied automatically on read: silently renaming a device
 * because its name is blank would present an edit the user did not make as if
 * it were the device's own setting.
 */

/** Experiment ID applied when none is set. */
export const DEFAULT_TRIAL_NAME = 'DefaultTrial';

/** Prefix for a defaulted device name; the MAC suffix completes it. */
const DEVICE_NAME_PREFIX = 'Shimmer_';

/**
 * Hex characters of the MAC taken as the device's short identity.
 *
 * Four, because `Shimmer_` plus four is exactly the 12 ASCII bytes the InfoMem
 * name field holds (`idxSDShimmerName`) — a longer suffix would be silently
 * truncated on write, and a device whose stored name does not match the one it
 * was given is the kind of mismatch that costs an afternoon.
 */
const MAC_SUFFIX_CHARS = 4;

/**
 * The last {@link MAC_SUFFIX_CHARS} hex characters of a MAC, upper-cased.
 *
 * Accepts the separator-free form the device reports (`DF1797A1F3F8`) and the
 * colon- or dash-separated forms a host may hold, since both reach this code
 * from different places.
 *
 * @param mac a MAC address in any common notation
 * @returns the suffix, or `null` when `mac` holds too few hex characters
 */
export function macShortId(mac: string): string | null {
  const hex = String(mac ?? '').replace(/[^0-9a-fA-F]/g, '');
  if (hex.length < MAC_SUFFIX_CHARS) return null;
  return hex.slice(-MAC_SUFFIX_CHARS).toUpperCase();
}

/**
 * Device name to apply when none is set, e.g. `Shimmer_F3F8`.
 *
 * @param mac the device's MAC address, as read from InfoMem or the transport
 * @returns the defaulted name, or `null` when the MAC is unusable — callers
 *   should then leave the existing name alone rather than write a placeholder
 *   that looks like an identity but identifies nothing
 */
export function defaultDeviceName(mac: string): string | null {
  const id = macShortId(mac);
  return id === null ? null : `${DEVICE_NAME_PREFIX}${id}`;
}

/**
 * Both identity defaults together, for the usual case of applying them as a
 * pair.
 *
 * @param mac the device's MAC address
 * @returns `deviceName` (null when the MAC is unusable) and `trialName`
 */
export function defaultTrialIdentity(mac: string): {
  deviceName: string | null;
  trialName: string;
} {
  return { deviceName: defaultDeviceName(mac), trialName: DEFAULT_TRIAL_NAME };
}
