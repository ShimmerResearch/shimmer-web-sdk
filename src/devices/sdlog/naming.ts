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

/** The root the data files are under: `data/<TrialName>_<ConfigTime>/…`. */
export const SD_DATA_ROOT = 'data';

/**
 * A kind of companion file: a file written beside a data file, at the data
 * file's path under a root of its own (log-and-stream-common
 * `docs/SHIMMER3_EVENT_CHANNEL.md` §4.1):
 *
 *   data/<TrialName>_<ConfigTime>/<ShimmerName>-<NNN>/<NNN>
 *   <root>/<TrialName>_<ConfigTime>/<ShimmerName>-<NNN>/<NNN><extension>
 *
 * A companion file splits when its data file does, and names the data file it
 * belongs with in its own header, not in its name. The event file is the
 * first kind.
 */
export interface SdCompanionKind {
  /** The root directory on the card, in lower case. */
  readonly root: string;
  /** What one file of this kind is called, for display: `event file`. */
  readonly label: string;
  /** Appended to the data file's name, with its dot; `''` for none. */
  readonly extension: string;
}

/**
 * Every kind of companion file that firmware writes, in the order a host
 * lists them. A new kind is one more entry here, as it is one more entry in
 * the firmware's table of roots a host may delete under
 * (`sdFtDeletableRoots`).
 */
export const SD_COMPANION_KINDS: readonly SdCompanionKind[] = Object.freeze([
  Object.freeze({ root: 'events', label: 'event file', extension: '' }),
]);

/**
 * What follows `root` in `path` (`''` for the root itself, else from its
 * `/`), or null when `path` is not in that tree. The root's case is ignored,
 * as FAT and the firmware ignore it; a leading `/` is allowed.
 */
function restUnderRoot(path: string, root: string): string | null {
  const p = path.replace(/^\/+/, '');
  if (p.slice(0, root.length).toLowerCase() !== root) return null;
  const rest = p.slice(root.length);
  return rest === '' || rest.startsWith('/') ? rest : null;
}

/** The kind of companion file whose tree `path` is in, or null. */
export function sdCompanionKindOf(path: string): SdCompanionKind | null {
  return SD_COMPANION_KINDS.find((k) => restUnderRoot(path, k.root) !== null) ?? null;
}

/**
 * The path of `kind`'s companion to a data path: a folder's companion folder
 * (`data/T_1/S-000` → `events/T_1/S-000`, `data` → `events`), or with
 * `{ file: true }` a data file's companion file, the kind's extension added.
 *
 * @returns null when `dataPath` is not under `data/`
 */
export function sdCompanionPathFor(
  dataPath: string,
  kind: SdCompanionKind,
  opts: { file?: boolean } = {},
): string | null {
  const rest = restUnderRoot(dataPath, SD_DATA_ROOT);
  if (rest === null) return null;
  return kind.root + rest + (opts.file ? kind.extension : '');
}

/**
 * The data path a companion path belongs with, the inverse of
 * {@link sdCompanionPathFor}: `events/T_1/S-000/001` → `data/T_1/S-000/001`,
 * the kind's extension dropped from a file name.
 *
 * Pairing by path is only a first guess. A copied or renamed file is paired
 * by its header, whose data-file initial timestamp (`fileOpenTicks` in an
 * event file) matches the data file's own.
 *
 * @returns null when `path` is not under a companion root
 */
export function sdDataPathForCompanion(path: string): string | null {
  const kind = sdCompanionKindOf(path);
  if (!kind) return null;
  let rest = restUnderRoot(path, kind.root) as string;
  const ext = kind.extension.toLowerCase();
  if (ext && rest.toLowerCase().endsWith(ext)) rest = rest.slice(0, -ext.length);
  return SD_DATA_ROOT + rest;
}
