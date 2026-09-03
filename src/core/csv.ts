/**
 * CSV emission for decoded sensor data.
 *
 * A stream of {@link ObjectCluster}s is not a table: each frame carries the
 * channels that frame happened to have, in whatever order the schema listed
 * them, with a raw and a calibrated version of some signals and only one of
 * others. Turning that into a CSV means fixing a column set ONCE and then
 * projecting every frame onto it — otherwise a row silently shifts the moment a
 * frame's field list differs, and the file reads as valid data that is wrong.
 *
 * {@link objectClusterColumns} derives that column set from a representative
 * frame; {@link objectClusterRow} projects a frame onto it, writing `null`
 * where a frame lacks a column rather than dropping the cell.
 */

import type { FieldKind, SensorField } from './types.js';
import type { ObjectCluster } from './ObjectCluster.js';

/**
 * Escape a value for a CSV cell (RFC 4180 style): whitespace runs — including
 * newlines — collapse to a single space, then cells containing a quote or
 * comma are quoted with internal quotes doubled. Null/undefined become the
 * empty cell.
 */
export function csvCell(text: unknown): string {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Join cells into one CSV line, each escaped by {@link csvCell}. No trailing
 * newline — the caller decides the line ending, which matters because a file
 * destined for Excel on Windows wants CRLF.
 */
export function csvRow(cells: readonly unknown[]): string {
  return cells.map((cell) => csvCell(cell)).join(',');
}

/** One column of a CSV built from {@link ObjectCluster} frames. */
export interface ObjectClusterColumn {
  /** Signal name as it appears in the frame, e.g. `'GYRO_X'`. */
  readonly name: string;
  /** Which version of the signal this column holds. */
  readonly kind: FieldKind;
  /** Unit of the first frame's value, for a units header row. May be null. */
  readonly unit: string | null;
  /** Column heading: `NAME_RAW`, `NAME_CAL`, or `NAME` when kind is null. */
  readonly header: string;
}

/** Options for {@link objectClusterColumns}. */
export interface ObjectClusterColumnOptions {
  /**
   * Restrict the columns to these kinds, e.g. `['cal']` for a calibrated-only
   * file or `['raw']` for one a user will calibrate themselves. Omit for every
   * kind present. Include `null` to keep the kindless channels (the timestamp,
   * typically) — a `kinds: ['cal']` file drops them, which is usually not
   * what the caller meant.
   */
  kinds?: readonly FieldKind[];
}

/**
 * Derive a CSV column set from one frame.
 *
 * Column ORDER follows `oc.fields`, so it matches the schema the device
 * negotiated rather than an alphabetical reordering the reader would have to
 * undo. A name/kind pair that appears twice in a frame contributes one column;
 * the first occurrence wins, and {@link objectClusterRow} reads that same one.
 *
 * Call this once, on the first frame, and reuse the result. Re-deriving it per
 * frame is the mistake this function exists to prevent.
 */
export function objectClusterColumns(
  oc: ObjectCluster,
  opts: ObjectClusterColumnOptions = {},
): ObjectClusterColumn[] {
  const { kinds } = opts;
  const out: ObjectClusterColumn[] = [];
  const seen = new Set<string>();
  for (const field of oc.fields) {
    if (kinds && !kinds.includes(field.kind)) continue;
    const header =
      field.kind === 'raw'
        ? `${field.name}_RAW`
        : field.kind === 'cal'
          ? `${field.name}_CAL`
          : field.name;
    if (seen.has(header)) continue;
    seen.add(header);
    out.push({ name: field.name, kind: field.kind, unit: field.unit, header });
  }
  return out;
}

/**
 * Project a frame onto a column set: one value per column, in column order,
 * `null` for a column this frame does not carry.
 *
 * Matches on the column's kind EXACTLY, which `ObjectCluster.get` deliberately
 * does not — it treats a null `kind` as "any kind", so a kindless column would
 * pick up a raw field that shares its name. Hence the index below is keyed by
 * kind first: the three buckets can never see each other.
 *
 * The index is built once per call rather than scanning `oc.fields` per column,
 * which made the projection O(columns × fields). This runs on the streaming
 * path — a Shimmer3R can put twenty-odd channels through it at 1024 Hz, and
 * both factors grow with the channel count together — so the quadratic term is
 * the whole cost. Keyed by kind then name rather than by a joined string so
 * there is no per-field key allocation to collect afterwards.
 */
export function objectClusterRow(
  oc: ObjectCluster,
  columns: readonly ObjectClusterColumn[],
): (number | null)[] {
  const byKind = new Map<FieldKind, Map<string, SensorField>>();
  for (const field of oc.fields) {
    let byName = byKind.get(field.kind);
    if (!byName) byKind.set(field.kind, (byName = new Map<string, SensorField>()));
    // First occurrence wins, as `Array.find` did and as
    // {@link objectClusterColumns} promises when a frame repeats a name/kind.
    if (!byName.has(field.name)) byName.set(field.name, field);
  }
  return columns.map((column) => {
    const field = byKind.get(column.kind)?.get(column.name);
    return field ? field.value : null;
  });
}
