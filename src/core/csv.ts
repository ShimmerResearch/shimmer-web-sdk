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
