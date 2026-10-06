/**
 * Archive integrity (DECISIONS.md D-74): is every archived file still where the
 * archive put it, with its original OneDrive identity?
 *
 * Each sync re-checks a rotating batch: every file already found wrong (so a
 * fix is noticed at once), then those never checked, then the least recently
 * checked. Each check is one GET by path with `$select=id,size` -- a shape the
 * guard already allowed; it is not widened.
 *
 *   present          the original item, at its path, with its size
 *   missing          nothing at the path: moved out, renamed or deleted
 *   different_item   another item now sits at the path (e.g. a fresh upload)
 *   size_changed     the original item, but its size changed
 *
 * It only reads. Nothing is moved, re-uploaded or re-archived: a file that went
 * missing is the owner's to put back (README, "Hands off the archive").
 *
 * File names go into the ops alert, to the owner's own chat, and nowhere else:
 * the sync's logs are public, so they carry counts and opaque file ids only.
 */

import type { RunContext } from '../core/run-context.ts';
import { budgetNow } from '../core/clock.ts';
import type { AlertCondition } from '../notify/ops.ts';
import type { GraphDrive } from '../graph/drive.ts';

export const INTEGRITY_BATCH = 25;
/** How many problem files the alert names; the rest are counted. */
const NAMED = 10;

export type IntegrityStatus = 'present' | 'missing' | 'different_item' | 'size_changed';

export interface IntegrityOutcome {
  checked: number;
  /** Files found wrong in this run (any status but present). */
  wrong: number;
}

/** Re-check one batch. Throws on a Graph failure other than "not found", like the archive does. */
export async function checkArchiveIntegrity(
  ctx: RunContext,
  drive: Pick<GraphDrive, 'itemFacts'>,
  now: Date,
  batch: number = INTEGRITY_BATCH,
  /** Wall-clock ms after which no further file is checked (D-77); the rest wait for the next run. */
  deadline: number = Number.POSITIVE_INFINITY,
): Promise<IntegrityOutcome> {
  const rows = await ctx.db.read({
    sql: `SELECT f.id, f.target_path, f.onedrive_item_id, f.size_bytes, a.status, a.since
            FROM files f LEFT JOIN archive_checks a ON a.file_id = f.id
           WHERE f.download_state = 'complete' AND f.target_path IS NOT NULL
           ORDER BY (a.status IS NOT NULL AND a.status <> 'present') DESC,
                    (a.checked_at IS NOT NULL), a.checked_at, f.id
           LIMIT ?`,
    args: [batch],
  });
  const nowIso = now.toISOString();
  let wrong = 0;
  let checked = 0;
  for (const r of rows.rows) {
    if (budgetNow() >= deadline) break;
    checked += 1;
    const facts = await drive.itemFacts(String(r['target_path']).split('/'));
    const status: IntegrityStatus =
      facts === null ? 'missing'
      : facts.id !== String(r['onedrive_item_id'] ?? '') ? 'different_item'
      : r['size_bytes'] !== null && facts.size !== Number(r['size_bytes']) ? 'size_changed'
      : 'present';
    if (status !== 'present') wrong += 1;
    const since = r['status'] === status && r['since'] !== null ? String(r['since']) : nowIso;
    await ctx.db.write.execute('archive integrity', {
      sql: `INSERT INTO archive_checks (file_id, checked_at, status, since) VALUES (?, ?, ?, ?)
            ON CONFLICT (file_id) DO UPDATE SET checked_at = excluded.checked_at, status = excluded.status, since = excluded.since`,
      args: [String(r['id']), nowIso, status, since],
    });
  }
  ctx.log.info('archive.integrity', { checked, wrong });
  return { checked, wrong };
}

const WHY: Record<Exclude<IntegrityStatus, 'present'>, string> = {
  missing: 'missing (moved, renamed or deleted)',
  different_item: 'a different file now sits there',
  size_changed: 'its size has changed',
};

/** The one ops alert, from every archived file currently known to be wrong; null when none. */
export async function integrityAlert(ctx: RunContext): Promise<AlertCondition | null> {
  const rows = await ctx.db.read(
    `SELECT f.target_path, a.status FROM archive_checks a JOIN files f ON f.id = a.file_id
      WHERE a.status <> 'present' AND f.download_state = 'complete'
      ORDER BY f.target_path`,
  );
  if (rows.rows.length === 0) return null;
  const n = rows.rows.length;
  const lines = rows.rows.slice(0, NAMED).map((r) => {
    const [, module, folder, ...name] = String(r['target_path']).split('/');
    return `• ${module ?? '?'} ${folder ?? '?'}: ${name.join('/')}: ${WHY[String(r['status']) as keyof typeof WHY] ?? String(r['status'])}`;
  });
  if (n > NAMED) lines.push(`• and ${n - NAMED} more`);
  return {
    key: 'archive_integrity',
    severity: 'warn',
    summary: `${n} archived file${n === 1 ? ' is' : 's are'} no longer where the archive put ${n === 1 ? 'it' : 'them'}.`,
    detail: [
      ...lines,
      'Put each back at its exact place and name: restore a deleted file from the OneDrive Recycle bin, and move a moved one back. ' +
        'Never upload a fresh copy. Nothing here is re-uploaded. (README, "Hands off the archive".)',
    ].join('\n'),
  };
}
