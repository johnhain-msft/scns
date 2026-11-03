/**
 * Timestamp normalization for SQLite `DATETIME` columns.
 *
 * Every `created_at` column in `schema.sql` is written by the column default
 * `datetime('now')`, which stores UTC in SQLite's own format:
 *
 *     2026-03-15 12:00:00        (space separator, no 'T', no 'Z', no millis)
 *
 * Application code naturally produces ISO-8601 instead (`Date#toISOString`):
 *
 *     2026-03-15T11:00:00.000Z
 *
 * SQLite has no native date type, so `created_at >= ?` is a plain **string**
 * comparison. At offset 10 the stored value holds `' '` (0x20) while an ISO
 * cutoff holds `'T'` (0x54), so every row sharing the cutoff's calendar date
 * sorts below it and is silently dropped regardless of its actual time.
 *
 * Normalizing the cutoff to SQLite's format makes the comparison correct while
 * keeping it index-friendly (unlike wrapping the column in `datetime(...)`,
 * which would defeat `idx_events_type` and `idx_scaling_decisions_created`).
 */

/** SQLite's `datetime('now')` output: `YYYY-MM-DD HH:MM:SS`. */
const SQLITE_DATETIME_PATTERN = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/

/**
 * Convert a timestamp to the format SQLite `DATETIME` columns are stored in.
 *
 * Accepts ISO-8601 (with or without milliseconds/offset) and returns UTC
 * `YYYY-MM-DD HH:MM:SS`. Values already in SQLite format are returned
 * unchanged — the function is idempotent, so it is safe to apply at any
 * boundary without knowing what the caller passed. Unparseable input is
 * returned as-is rather than silently becoming a different instant.
 */
export function toSqliteDateTime(value: string): string {
  const trimmed = value.trim()
  // Already stored-format. Must short-circuit: `Date.parse` would read a bare
  // `YYYY-MM-DD HH:MM:SS` as *local* time and shift it by the UTC offset.
  if (SQLITE_DATETIME_PATTERN.test(trimmed)) return trimmed

  const ms = Date.parse(trimmed)
  if (Number.isNaN(ms)) return trimmed

  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ')
}
