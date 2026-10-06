/**
 * The sync schedule, as code (SPEC.md section 11).
 *
 * These must match `.github/workflows/sync.yml` exactly; a test reads the YAML
 * and fails if they drift apart. They exist in code so a run can count the
 * scheduled runs that never happened between itself and the previous one.
 */

import { parseCron } from '../core/cron.ts';

/**
 * Every 20 min 08:07-22:47 SGT, every 30 min 23:13-07:43 SGT, in UTC (D-77).
 * Off :00/:15/:20/:30/:40/:45, where GitHub's scheduler is busiest.
 */
export const SYNC_SCHEDULES = ['7,27,47 0-14 * * *', '13,43 15-23 * * *'] as const;

/**
 * Report a gap once at least this many consecutive slots were missed: an hour
 * in the daytime, 90 minutes overnight. A single lost run is 20 minutes of
 * latency that the next run fully recovers; three is a pattern worth knowing.
 */
export const MISSED_SLOTS_REPORT_THRESHOLD = 3;

const matchers = SYNC_SCHEDULES.map(parseCron);

/** Scheduled slots strictly between two slots -- the runs that never happened. */
export function slotsBetween(from: Date, to: Date): number {
  let count = 0;
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  for (let t = start; t < to.getTime(); t += 60_000) {
    const at = new Date(t);
    if (matchers.some((m) => m.matches(at))) count += 1;
  }
  return count;
}
