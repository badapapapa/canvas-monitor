/**
 * What the dashboard shows, read from the read model (DECISIONS.md D-65).
 * Every function takes the VerifiedSession it was given; there is no other way in.
 */

import type { Secrets } from './env.ts';
import { readRows } from './db.ts';
import type { VerifiedSession } from './session.ts';

export interface Module { id: number; code: string; kind: 'course' | 'group'; coverage: string; answersTracked: boolean }
export interface Deadline { ref: string; moduleId: number; title: string; dueAt: string; canvasUrl: string | null; revisedAt: string | null }
export interface Activity {
  ref: string; moduleId: number; kind: string; change: string; title: string | null; at: string; seenAt: string;
  canvasUrl: string | null; fileRoute: string | null; fileSize: number | null; onedriveUrl: string | null;
}
export interface Followup { id: number; moduleId: number; label: string; postedAt: string }

export interface Snapshot {
  publishedAt: string | null;
  modules: Module[];
  deadlines: Deadline[];
  activity: Activity[];
  followups: Followup[];
  health: Record<string, string>;
}

const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** Everything, or one module's share of it. `moduleId` is a validated integer or null. */
export async function snapshot(session: VerifiedSession, secrets: Secrets, moduleId: number | null): Promise<Snapshot> {
  const where = moduleId === null ? '' : ' WHERE module_id = ?';
  const args = moduleId === null ? [] : [moduleId];
  const [meta, modules, deadlines, activity, followups, health] = await Promise.all([
    readRows(session, secrets, "SELECT value FROM rm_meta WHERE name = 'published_at'"),
    readRows(session, secrets, 'SELECT id, code, kind, coverage, answers_tracked FROM rm_modules ORDER BY kind, code'),
    readRows(session, secrets, `SELECT ref, module_id, title, due_at, canvas_url, revised_at FROM rm_deadlines${where} ORDER BY due_at`, args),
    readRows(session, secrets, `SELECT ref, module_id, kind, change, title, at, seen_at, canvas_url, file_route, file_size, onedrive_url FROM rm_activity${where} ORDER BY at DESC`, args),
    readRows(session, secrets, `SELECT id, module_id, label, posted_at FROM rm_followups${where} ORDER BY posted_at, id`, args),
    readRows(session, secrets, 'SELECT name, value FROM rm_health'),
  ]);
  return {
    publishedAt: str(meta[0]?.['value']),
    modules: modules.map((r) => ({ id: Number(r['id']), code: String(r['code']), kind: r['kind'] === 'group' ? 'group' : 'course', coverage: String(r['coverage']), answersTracked: Number(r['answers_tracked']) === 1 })),
    deadlines: deadlines.map((r) => ({ ref: String(r['ref']), moduleId: Number(r['module_id']), title: String(r['title']), dueAt: String(r['due_at']), canvasUrl: str(r['canvas_url']), revisedAt: str(r['revised_at']) })),
    activity: activity.map((r) => ({
      ref: String(r['ref']), moduleId: Number(r['module_id']), kind: String(r['kind']), change: String(r['change']), title: str(r['title']),
      at: String(r['at']), seenAt: String(r['seen_at']), canvasUrl: str(r['canvas_url']), fileRoute: str(r['file_route']),
      fileSize: r['file_size'] === null || r['file_size'] === undefined ? null : Number(r['file_size']), onedriveUrl: str(r['onedrive_url']),
    })),
    followups: followups.map((r) => ({ id: Number(r['id']), moduleId: Number(r['module_id']), label: String(r['label']), postedAt: String(r['posted_at']) })),
    health: Object.fromEntries(health.map((r) => [String(r['name']), String(r['value'])])),
  };
}
