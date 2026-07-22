/**
 * Time handling.
 *
 * One rule, no exceptions: every timestamp stored or returned by this server is
 * UTC ISO-8601 with milliseconds. The database, the API, the CLI `--since` flag
 * and the skill all speak the same format. The web UI converts to the viewer's
 * local time at render, and nowhere else.
 *
 * The agent comment loop ("show me comments since this timestamp") depends on
 * this being boringly consistent.
 */

/** Current time as UTC ISO-8601, for example 2026-07-22T09:41:07.123Z. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Parses a caller-supplied timestamp. Returns the normalised UTC ISO-8601 form,
 * or null if it is not a valid timestamp.
 */
export function parseIso(value: string): string | null {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString();
}
