/**
 * The identity gate for human-readable command output.
 *
 * Logs are redacted by default (DECISIONS.md D-26). Command **output** is not:
 * reading the course list is the entire purpose of `probe`, and reviewing
 * `courses.seed.json` by hand is the entire purpose of `discover`. Suppressing
 * identity locally would make both commands useless.
 *
 * The single exception is CI. GitHub Actions captures stdout into the same
 * public run log as stderr, so a command that prints a course name publishes it
 * just as surely as one that logs it -- and `--unsafe-log` cannot be the guard,
 * because it is refused under CI by design.
 *
 * This lives in core rather than in one command so that every command that
 * prints identifying data passes through the same gate. Reimplementing it per
 * command is how one of them ends up not having it.
 */

/** Marker matching the logger's identity tier, so the two read alike. */
export const IDENTITY_MASK = '[name]';

/**
 * Mask an identifying value when, and only when, running under CI.
 *
 * Numeric identifiers are never passed through here. Canvas ids reveal nothing
 * without a token and are what keeps suppressed output actionable.
 */
export function maskIdentity(ci: boolean, value: string | null): string | null {
  if (!ci) return value;
  return value === null ? null : IDENTITY_MASK;
}

/** The banner shown once when output has been suppressed. */
export function suppressionNotice(ci: boolean): string | null {
  return ci ? 'Course names suppressed: running under CI, where stdout is published.' : null;
}
