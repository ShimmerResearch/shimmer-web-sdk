/**
 * SD-card directory naming helpers.
 *
 * The SD layout written by SDLog/LogAndStream firmware is:
 *
 *   <root>/data/<TrialName>_<ConfigTime>/<ShimmerName>-<SessionNumber>/000, 001, …
 *
 * with 3-digit numeric log-file names (no extension). Ported from
 * UtilDock#splitFileName (trial folder splits on the LAST `_`) and
 * ShimmerSDLog#parseSessionNameAndNumber (session folder splits on the
 * LAST `-`). Unlike the Java (which produces garbage or throws on malformed
 * names), these helpers validate and throw a typed BAD_HEADER error.
 */

import { SdLogFormatError } from './types.js';

/**
 * Split a session folder name (`<ShimmerName>-<SessionNumber>`) on its last
 * `-`. The Shimmer name may itself contain dashes.
 */
export function parseSdSessionName(folder: string): {
  shimmerName: string;
  sessionNumber: number;
} {
  const idx = folder.lastIndexOf('-');
  if (idx <= 0 || idx === folder.length - 1) {
    throw new SdLogFormatError(
      'BAD_HEADER',
      `"${folder}" is not a valid session folder name (expected <ShimmerName>-<SessionNumber>).`,
    );
  }
  const numberPart = folder.slice(idx + 1);
  if (!/^\d+$/.test(numberPart)) {
    throw new SdLogFormatError(
      'BAD_HEADER',
      `"${folder}" has a non-numeric session number ("${numberPart}").`,
    );
  }
  return { shimmerName: folder.slice(0, idx), sessionNumber: parseInt(numberPart, 10) };
}

/**
 * Split a trial folder name (`<TrialName>_<ConfigTime>`) on its last `_`.
 * The trial name may itself contain underscores; the config time is kept as
 * the raw string written by the firmware.
 */
export function parseSdTrialFolderName(folder: string): {
  trialName: string;
  configTime: string;
} {
  const idx = folder.lastIndexOf('_');
  if (idx <= 0 || idx === folder.length - 1) {
    throw new SdLogFormatError(
      'BAD_HEADER',
      `"${folder}" is not a valid trial folder name (expected <TrialName>_<ConfigTime>).`,
    );
  }
  return { trialName: folder.slice(0, idx), configTime: folder.slice(idx + 1) };
}
