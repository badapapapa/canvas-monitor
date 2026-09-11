/**
 * UTC storage, SGT presentation (SPEC.md section 4).
 *
 * Canvas returns UTC. Everything is stored as UTC ISO-8601. Every date bucket,
 * day grouping, quiet-hours check, and display string converts to
 * Asia/Singapore first. A 23:59 SGT deadline is 15:59Z and lands on the
 * previous day if bucketed naively -- that is the bug this module exists to
 * make impossible.
 */

export const SGT = 'Asia/Singapore';

/**
 * Singapore has been a fixed UTC+8 with no DST since 1982 and has no scheduled
 * change. The constant is here because arithmetic on a fixed offset is simpler
 * and faster than formatting round-trips -- but it is a claim about the world,
 * so test/unit/time.test.ts asserts it against Intl at a spread of dates. If
 * Singapore ever adopts DST, that test fails before anything silently drifts.
 */
export const SGT_OFFSET_MINUTES = 8 * 60;

const dayFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: SGT,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const partsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: SGT,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

export interface SgtParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function toSgtParts(at: Date): SgtParts {
  const found: Record<string, string> = {};
  for (const part of partsFormatter.formatToParts(at)) {
    if (part.type !== 'literal') found[part.type] = part.value;
  }
  const read = (k: string): number => {
    const raw = found[k];
    if (raw === undefined) throw new Error(`toSgtParts: missing ${k}`);
    return Number.parseInt(raw, 10);
  };
  // en-GB renders midnight as hour 24; normalise it to 0.
  const hour = read('hour') % 24;
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour,
    minute: read('minute'),
    second: read('second'),
  };
}

/** The SGT calendar day an instant falls on, as `YYYY-MM-DD`. */
export function sgtDayKey(at: Date): string {
  return dayFormatter.format(at);
}

/** Hour of day, 0-23, in SGT. */
export function sgtHour(at: Date): number {
  return toSgtParts(at).hour;
}

/** Construct the UTC instant for a wall-clock time in Singapore. */
export function sgtToUtc(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour, minute, second) - SGT_OFFSET_MINUTES * 60_000);
}

/** Canonical storage form. Always UTC, always millisecond-truncated ISO. */
export function utcIso(at: Date): string {
  return at.toISOString();
}

/**
 * Parse a Canvas timestamp. Returns null rather than an Invalid Date, so a
 * malformed upstream value cannot propagate as NaN into a watermark
 * comparison and quietly widen or collapse a polling window.
 */
export function parseCanvasTs(raw: string | null | undefined): Date | null {
  if (raw === null || raw === undefined || raw === '') return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** Quiet hours are 22:00-06:59:59 SGT inclusive (SPEC.md section 12). */
export function isQuietHours(at: Date): boolean {
  const hour = sgtHour(at);
  return hour >= 22 || hour < 7;
}

/**
 * The instant a message held during quiet hours should be released: 07:00 SGT
 * on the next day that has one. Held messages persist in the notification
 * queue across runs, since there is no long-lived process to hold them in.
 */
export function quietHoursReleaseAt(at: Date): Date {
  const p = toSgtParts(at);
  if (p.hour < 7) return sgtToUtc(p.year, p.month, p.day, 7, 0, 0);
  // 22:00 or later -- release at 07:00 the following SGT day.
  const nextDay = new Date(sgtToUtc(p.year, p.month, p.day, 12, 0, 0).getTime() + 24 * 3600_000);
  const n = toSgtParts(nextDay);
  return sgtToUtc(n.year, n.month, n.day, 7, 0, 0);
}

export function differenceSeconds(later: Date, earlier: Date): number {
  return Math.round((later.getTime() - earlier.getTime()) / 1000);
}
