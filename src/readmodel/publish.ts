/**
 * Publish the dashboard's read model (DECISIONS.md D-65), at the end of a sync.
 *
 * Reads the main database with a fixed set of SELECTs over an explicit column
 * allowlist -- never the config table, never a token -- and replaces the read
 * model's contents in ONE atomic batch through a SEPARATE client, whose token
 * can write to the read model only (it cannot reach the main database).
 *
 * The read model's schema is created by `npm run readmodel -- migrate`, run by
 * the owner; publishing never creates or alters tables.
 */

import type { Client, InStatement } from '@libsql/client';
import type { Db } from '../core/db/writer.ts';
import { followupLabel, type FollowupCategory } from '../followups/classify.ts';
import { READMODEL_SCHEMA_VERSION } from './schema.ts';

const DAY_MS = 24 * 3600_000;
const ACTIVITY_DAYS = 21;
const ACTIVITY_LIMIT = 150;

type Row = Record<string, unknown>;
const s = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export interface ReadModel {
  modules: Array<{ id: number; code: string; kind: 'course' | 'group'; coverage: string; answersTracked: 0 | 1 }>;
  deadlines: Array<{ ref: string; moduleId: number; title: string; dueAt: string; canvasUrl: string | null; revisedAt: string | null }>;
  activity: Array<{
    ref: string; moduleId: number; kind: 'announcement' | 'assignment' | 'file' | 'grade' | 'feedback'; change: 'new' | 'revised';
    title: string | null; at: string; seenAt: string; canvasUrl: string | null; fileRoute: string | null; fileSize: number | null; onedriveUrl: string | null;
  }>;
  followups: Array<{ id: number; moduleId: number; label: string; postedAt: string }>;
  health: Array<{ name: string; value: string }>;
}

const KIND: Record<string, ReadModel['activity'][number]['kind']> = {
  announcement: 'announcement', assignment: 'assignment', file: 'file', grade: 'grade', comment: 'feedback',
};

/** Canvas and OneDrive links only in their plain forms: anything else is dropped, not stored. */
function plainUrl(v: unknown): string | null {
  const url = s(v);
  if (url === null || !url.startsWith('https://')) return null;
  return /verifier=|tempauth|access_token|token=|@/i.test(url) ? null : url;
}

function p95(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)]!;
}

/** Everything the dashboard shows, from the main database. Reads only. */
export async function buildReadModel(db: Db, now: Date): Promise<ReadModel> {
  const iso = (ms: number) => new Date(ms).toISOString();

  const modules = (await db.read(
    `SELECT x.context_id, x.context_type, x.coverage_status,
            COALESCE(c.module_code, g.module_code) AS code, COALESCE(c.followups_tracking, 0) AS tracked
       FROM contexts x
       LEFT JOIN courses c ON c.context_id = x.context_id
       LEFT JOIN groups g ON g.context_id = x.context_id
      WHERE x.enabled = 1
      ORDER BY x.context_type, code`,
  )).rows as Row[];

  const deadlines = (await db.read({
    sql: `SELECT i.id, i.context_id, i.title, i.due_at, i.canvas_url, i.revised_at
            FROM items i JOIN contexts x ON x.context_id = i.context_id AND x.enabled = 1
           WHERE i.resource_type = 'assignment' AND i.due_at IS NOT NULL AND i.due_at >= ? AND i.state <> 'deleted_upstream'
           ORDER BY i.due_at LIMIT 100`,
    args: [iso(now.getTime() - DAY_MS)],
  })).rows as Row[];

  const activity = (await db.read({
    sql: `SELECT i.id, i.context_id, i.resource_type, i.title, i.posted_at, i.first_seen_at, i.revised_at, i.canvas_url,
                 f.route_category, f.size_bytes, f.share_url, f.download_state
            FROM items i
            JOIN contexts x ON x.context_id = i.context_id AND x.enabled = 1
            LEFT JOIN files f ON f.id = i.id
           WHERE i.state <> 'deleted_upstream' AND COALESCE(i.revised_at, i.posted_at, i.first_seen_at) >= ?
           ORDER BY COALESCE(i.revised_at, i.posted_at, i.first_seen_at) DESC LIMIT ${ACTIVITY_LIMIT}`,
    args: [iso(now.getTime() - ACTIVITY_DAYS * DAY_MS)],
  })).rows as Row[];

  const followups = (await db.read(
    `SELECT f.id, f.context_id, f.category, f.number, f.opened_at
       FROM followups f JOIN courses c ON c.context_id = f.context_id
      WHERE f.state = 'open' AND c.followups_tracking = 1
      ORDER BY f.context_id, f.category, CAST(f.number AS INTEGER)`,
  )).rows as Row[];

  // --- health: counts and times only; never an alert's text (it can name modules).
  const lastSync = (await db.read(
    "SELECT started_at, finished_at, status FROM runs WHERE command = 'sync' AND dry_run = 0 AND status <> 'running' ORDER BY started_at DESC LIMIT 1",
  )).rows[0] as Row | undefined;
  const week = iso(now.getTime() - 7 * DAY_MS);
  const runs = (await db.read({
    sql: "SELECT status, drift_seconds FROM runs WHERE command = 'sync' AND dry_run = 0 AND status <> 'running' AND started_at >= ?",
    args: [week],
  })).rows as Row[];
  const alerts = (await db.read('SELECT severity FROM ops_alerts WHERE resolved_at IS NULL')).rows as Row[];
  const archive = (await db.read(
    `SELECT sum(download_state = 'complete') AS archived, COALESCE(sum(CASE WHEN download_state = 'complete' THEN size_bytes END), 0) AS bytes,
            sum(download_state = 'complete' AND route_category = '_unsorted') AS unsorted, sum(download_state = 'skipped_size') AS too_large
       FROM files`,
  )).rows[0] as Row | undefined;

  const drift = p95(runs.map((r) => n(r['drift_seconds'])).filter((d): d is number => d !== null));
  const health: Array<[string, string | number | null]> = [
    ['last_sync_at', s(lastSync?.['finished_at']) ?? s(lastSync?.['started_at'])],
    ['last_sync_status', s(lastSync?.['status'])],
    ['runs_7d', runs.length],
    ['failed_runs_7d', runs.filter((r) => r['status'] === 'failed').length],
    ['drift_p95_seconds', drift],
    ['active_alerts', alerts.length],
    ['active_critical_alerts', alerts.filter((a) => a['severity'] === 'critical').length],
    ['archived_files', n(archive?.['archived']) ?? 0],
    ['archived_bytes', n(archive?.['bytes']) ?? 0],
    ['unsorted_files', n(archive?.['unsorted']) ?? 0],
    ['too_large_files', n(archive?.['too_large']) ?? 0],
  ];

  return {
    modules: modules.map((r) => ({
      id: Number(r['context_id']), code: s(r['code']) ?? `context ${String(r['context_id'])}`,
      kind: r['context_type'] === 'group' ? 'group' : 'course', coverage: s(r['coverage_status']) ?? 'unknown',
      answersTracked: Number(r['tracked']) === 1 ? 1 : 0,
    })),
    deadlines: deadlines.map((r) => ({
      ref: String(r['id']), moduleId: Number(r['context_id']), title: s(r['title']) ?? '(untitled)', dueAt: String(r['due_at']),
      canvasUrl: plainUrl(r['canvas_url']), revisedAt: s(r['revised_at']),
    })),
    activity: activity.map((r) => {
      const complete = r['download_state'] === 'complete';
      return {
        ref: String(r['id']), moduleId: Number(r['context_id']), kind: KIND[String(r['resource_type'])] ?? 'announcement',
        change: r['revised_at'] === null ? 'new' : 'revised', title: s(r['title']),
        at: String(r['revised_at'] ?? r['posted_at'] ?? r['first_seen_at']), seenAt: String(r['revised_at'] ?? r['first_seen_at']),
        canvasUrl: plainUrl(r['canvas_url']),
        fileRoute: complete ? s(r['route_category']) : null, fileSize: n(r['size_bytes']),
        onedriveUrl: complete ? plainUrl(r['share_url']) : null,
      };
    }),
    followups: followups.map((r) => ({
      id: Number(r['id']), moduleId: Number(r['context_id']),
      label: followupLabel(String(r['category']) as FollowupCategory, String(r['number'])), postedAt: String(r['opened_at']),
    })),
    health: health.filter(([, v]) => v !== null).map(([name, value]) => ({ name, value: String(value) })),
  };
}

/** The statements that replace the read model's contents: one atomic batch. */
export function publishStatements(model: ReadModel, now: Date): InStatement[] {
  const out: InStatement[] = ['DELETE FROM rm_modules', 'DELETE FROM rm_deadlines', 'DELETE FROM rm_activity', 'DELETE FROM rm_followups', 'DELETE FROM rm_health'];
  for (const m of model.modules) {
    out.push({ sql: 'INSERT INTO rm_modules (id, code, kind, coverage, answers_tracked) VALUES (?, ?, ?, ?, ?)', args: [m.id, m.code, m.kind, m.coverage, m.answersTracked] });
  }
  for (const d of model.deadlines) {
    out.push({ sql: 'INSERT INTO rm_deadlines (ref, module_id, title, due_at, canvas_url, revised_at) VALUES (?, ?, ?, ?, ?, ?)', args: [d.ref, d.moduleId, d.title, d.dueAt, d.canvasUrl, d.revisedAt] });
  }
  for (const a of model.activity) {
    out.push({
      sql: `INSERT INTO rm_activity (ref, module_id, kind, change, title, at, seen_at, canvas_url, file_route, file_size, onedrive_url)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [a.ref, a.moduleId, a.kind, a.change, a.title, a.at, a.seenAt, a.canvasUrl, a.fileRoute, a.fileSize, a.onedriveUrl],
    });
  }
  for (const f of model.followups) {
    out.push({ sql: 'INSERT INTO rm_followups (id, module_id, label, posted_at) VALUES (?, ?, ?, ?)', args: [f.id, f.moduleId, f.label, f.postedAt] });
  }
  for (const h of model.health) out.push({ sql: 'INSERT INTO rm_health (name, value) VALUES (?, ?)', args: [h.name, h.value] });
  out.push({ sql: "INSERT INTO rm_meta (name, value) VALUES ('published_at', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", args: [now.toISOString()] });
  return out;
}

export class ReadModelNotMigrated extends Error {}

/** Build from the main database and replace the read model's contents atomically. */
export async function publishReadModel(main: Db, target: Client, now: Date): Promise<{ modules: number; activity: number; deadlines: number; followups: number }> {
  const version = await target.execute("SELECT value FROM rm_meta WHERE name = 'schema_version'").catch(() => null);
  if (version === null || String(version.rows[0]?.['value'] ?? '') !== READMODEL_SCHEMA_VERSION) {
    throw new ReadModelNotMigrated(`read model schema ${READMODEL_SCHEMA_VERSION} is not in place: run npm run readmodel -- migrate`);
  }
  const model = await buildReadModel(main, now);
  await target.batch(publishStatements(model, now), 'write');
  return { modules: model.modules.length, activity: model.activity.length, deadlines: model.deadlines.length, followups: model.followups.length };
}
