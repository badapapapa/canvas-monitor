/**
 * The `sync_lock` backstop (SPEC.md section 7, DECISIONS.md D-07).
 *
 * In GitHub Actions the real mutex is the workflow's concurrency group plus
 * `timeout-minutes: 10`, which together mean a run cannot outlive its own lock.
 * This row exists for the case Actions cannot see: a manual `npm run sync` on
 * my machine overlapping a scheduled one.
 *
 * Acquisition is a single conditional UPDATE, so two runs racing for it are
 * serialised by the database rather than by application logic.
 */

import type { Db } from '../core/db/writer.ts';

/** SPEC.md section 7: a lock older than this is presumed abandoned. */
export const LOCK_STALE_MS = 15 * 60_000;

export async function acquireLock(db: Db, holder: string, now: Date): Promise<boolean> {
  const nowIso = now.toISOString();
  const staleBefore = new Date(now.getTime() - LOCK_STALE_MS).toISOString();
  const result = await db.write.execute('acquire sync lock', {
    sql: `UPDATE sync_lock SET holder = ?, locked_at = ?, heartbeat_at = ?
           WHERE id = 1 AND (holder IS NULL OR heartbeat_at IS NULL OR heartbeat_at < ?)`,
    args: [holder, nowIso, nowIso, staleBefore],
  });
  return result.rowsAffected === 1;
}

export async function releaseLock(db: Db, holder: string): Promise<void> {
  await db.write.execute('release sync lock', {
    sql: 'UPDATE sync_lock SET holder = NULL, locked_at = NULL, heartbeat_at = NULL WHERE id = 1 AND holder = ?',
    args: [holder],
  });
}
