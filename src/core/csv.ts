/**
 * Escape a value for a CSV cell (RFC 4180 style): whitespace runs collapse to
 * a single space, and cells containing a quote, comma, or newline are quoted
 * with internal quotes doubled. Null/undefined become the empty cell.
 */
export function csvCell(text: unknown): string {
  const s = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
