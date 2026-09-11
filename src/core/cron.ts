/**
 * Minimal five-field cron matching, UTC, for one job: working out which slot
 * a scheduled run was meant for (SPEC.md section 11, DECISIONS.md D-10).
 *
 * GitHub Actions does not tell a run when it was scheduled -- only the cron
 * expression that fired (`github.event.schedule`). So the run reconstructs its
 * slot as the latest matching minute at or before its own start.
 *
 * KNOWN LIMIT, recorded in DECISIONS.md D-43: if a run is delayed by more than
 * one cadence interval, the latest slot is a LATER slot than the one that
 * fired, and drift is under-reported. Drift is therefore a lower bound once it
 * exceeds the cadence; dropped runs are measured separately, as gaps between
 * consecutive runs in the `runs` table.
 */

type Field = (value: number) => boolean;

function parseField(spec: string, min: number, max: number): Field {
  const allowed = new Set<number>();
  for (const part of spec.split(',')) {
    const [rangePart, stepPart] = part.split('/') as [string, string | undefined];
    const step = stepPart === undefined ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: bad step in "${spec}"`);

    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map((n) => Number.parseInt(n, 10)) as [number, number];
      lo = a;
      hi = b;
    } else {
      lo = Number.parseInt(rangePart, 10);
      hi = stepPart === undefined ? lo : max;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`cron: bad range in "${spec}"`);
    }
    for (let v = lo; v <= hi; v += step) allowed.add(v);
  }
  return (value) => allowed.has(value);
}

export interface CronMatcher {
  matches(at: Date): boolean;
}

export function parseCron(expression: string): CronMatcher {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`cron: expected 5 fields, got ${fields.length} in "${expression}"`);
  const [m, h, dom, mon, dow] = fields as [string, string, string, string, string];
  const minute = parseField(m, 0, 59);
  const hour = parseField(h, 0, 23);
  const day = parseField(dom, 1, 31);
  const month = parseField(mon, 1, 12);
  const weekday = parseField(dow, 0, 6);
  return {
    matches: (at) =>
      minute(at.getUTCMinutes()) &&
      hour(at.getUTCHours()) &&
      day(at.getUTCDate()) &&
      month(at.getUTCMonth() + 1) &&
      weekday(at.getUTCDay()),
  };
}

/** The latest minute at or before `at` that the expression matches. */
export function latestSlotAtOrBefore(expression: string, at: Date, lookbackMinutes = 48 * 60): Date | null {
  const matcher = parseCron(expression);
  const start = Math.floor(at.getTime() / 60_000) * 60_000;
  for (let i = 0; i <= lookbackMinutes; i += 1) {
    const candidate = new Date(start - i * 60_000);
    if (matcher.matches(candidate)) return candidate;
  }
  return null;
}
