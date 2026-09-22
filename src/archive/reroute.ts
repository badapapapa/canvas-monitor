/**
 * Re-routing `_unsorted` files, only after I have approved a preview
 * (DECISIONS.md D-40, D-57).
 *
 * `planReroutes` is read-only: it asks the current rules where each re-routable
 * `_unsorted` file would go and fingerprints the answer. `applyReroutes` re-plans,
 * refuses unless the fingerprint is the one I approved, and then moves each file
 * with the guard's narrow move exception. Each file is re-routed at most once:
 * the row stops being re-routable the moment it lands.
 *
 * Crash safety: the file keeps its OneDrive item id when moved. If a run dies
 * between the move and the database update, the next apply finds the stored
 * item id already at the destination and just records it.
 */

import { createHash } from 'node:crypto';
import type { RunContext } from '../core/run-context.ts';
import { GraphError } from '../graph/auth.ts';
import type { DriveItem, GraphDrive } from '../graph/drive.ts';
import { route, STANDARD_CATEGORIES, targetProblem, type StoredRule } from './route.ts';
import { loadRules } from './rules.ts';

export interface RerouteMove {
  fileId: string;
  contextId: number;
  moduleCode: string;
  from: string;
  to: string;
  destination: string;
  rule: string;
  onedriveItemId: string | null;
}

export interface ReroutePlan {
  moves: RerouteMove[];
  /** `_unsorted` files no rule claims yet: they stay, still re-routable. */
  staying: Array<{ fileId: string; moduleCode: string; from: string }>;
  fingerprint: string;
}

export async function planReroutes(ctx: RunContext): Promise<ReroutePlan> {
  const rules = await loadRules(ctx.db);
  const rows = await ctx.db.read(
    `SELECT f.id, f.context_id, f.target_path, f.onedrive_item_id, i.title, i.meta, x.context_type,
            COALESCE(c.module_code, g.module_code) AS module_code
       FROM files f
       JOIN items i ON i.id = f.id
       JOIN contexts x ON x.context_id = f.context_id
       LEFT JOIN courses c ON c.context_id = f.context_id
       LEFT JOIN groups g ON g.context_id = f.context_id
      WHERE f.download_state = 'complete' AND f.route_category = '_unsorted' AND f.route_reroutable = 1
      ORDER BY module_code, f.target_path, f.id`,
  );
  const moves: RerouteMove[] = [];
  const staying: ReroutePlan['staying'] = [];
  const usedRules = new Map<number, StoredRule>();

  for (const r of rows.rows) {
    const from = String(r['target_path'] ?? '');
    const segments = from.split('/');
    const moduleCode = String(r['module_code'] ?? `context ${String(r['context_id'])}`);
    const fileId = String(r['id']);
    if (segments.length !== 4 || segments[2] !== '_unsorted') {
      staying.push({ fileId, moduleCode, from });
      continue;
    }
    const meta = JSON.parse(String(r['meta'] ?? '{}')) as { folder?: string | null; module?: string | null };
    const contextRules = rules.get(Number(r['context_id'])) ?? [];
    const decision = route(
      { contextType: String(r['context_type']) === 'group' ? 'group' : 'course', folder: meta.folder ?? null, module: meta.module ?? null, fileName: String(r['title'] ?? segments[3]) },
      contextRules,
    );
    if (decision.category === '_unsorted' || decision.category === 'Group') {
      staying.push({ fileId, moduleCode, from });
      continue;
    }
    const ruleId = /^db:(\d+)$/.exec(decision.rule);
    if (ruleId !== null) {
      const used = contextRules.find((x) => x.id === Number(ruleId[1]));
      if (used !== undefined) usedRules.set(used.id, used);
    }
    moves.push({
      fileId,
      contextId: Number(r['context_id']),
      moduleCode,
      from,
      to: [segments[0], segments[1], decision.category, segments[3]].join('/'),
      destination: decision.category,
      rule: decision.rule,
      onedriveItemId: r['onedrive_item_id'] === null ? null : String(r['onedrive_item_id']),
    });
  }

  // The fingerprint covers every move and the exact rules behind them: any
  // change to either, between preview and apply, means a new preview.
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      moves: moves.map((m) => [m.fileId, m.from, m.to, m.rule]),
      rules: [...usedRules.values()].sort((a, b) => a.id - b.id).map((x) => [x.id, x.field, x.pattern, x.target, x.priority]),
    }))
    .digest('hex')
    .slice(0, 16);
  return { moves, staying, fingerprint };
}

export interface RerouteResult {
  moved: number;
  recovered: number;
  failed: Array<{ fileId: string; reason: string }>;
}

export async function applyReroutes(ctx: RunContext, drive: GraphDrive, approvedFingerprint: string): Promise<RerouteResult> {
  const plan = await planReroutes(ctx);
  if (plan.fingerprint !== approvedFingerprint) {
    throw new GraphError('malformed', `the plan changed since the preview (approved ${approvedFingerprint}, now ${plan.fingerprint}); run --preview again`);
  }
  const destinations = new Set<string>(STANDARD_CATEGORIES);
  for (const m of plan.moves) if (targetProblem(m.destination) === null) destinations.add(m.destination);
  drive.allowMoveDestinations(destinations);

  const out: RerouteResult = { moved: 0, recovered: 0, failed: [] };
  for (const m of plan.moves) {
    const from = m.from.split('/');
    const to = m.to.split('/');
    try {
      let landed: DriveItem | null = null;
      const atDest = await drive.itemAt(to);
      if (atDest !== null && m.onedriveItemId !== null && atDest.id === m.onedriveItemId) {
        landed = atDest; // moved by a run that died before recording it
        out.recovered += 1;
      } else {
        landed = await drive.move(from, to.slice(0, 3));
        if (m.onedriveItemId !== null && landed.id !== m.onedriveItemId) {
          throw new GraphError('malformed', 'the moved item is not the archived one', null, 'moveIdMismatch');
        }
        out.moved += 1;
      }
      const decided = ctx.clock.now().toISOString();
      await ctx.db.write.execute('record reroute', {
        sql: `UPDATE files SET target_path = ?, route_category = ?, route_rule = ?, route_confidence = 1,
                               route_decided_at = ?, route_reroutable = 0, share_url = COALESCE(?, share_url)
               WHERE id = ? AND route_reroutable = 1`,
        args: [m.to, m.destination, m.rule, decided, landed.webUrl ?? null, m.fileId],
      });
      ctx.log.info('reroute.moved', { item: m.fileId, rule: m.rule });
    } catch (error) {
      const reason = error instanceof GraphError ? [error.code, error.status, error.graphCode].filter((x) => x !== null).join(' ') : 'internal';
      out.failed.push({ fileId: m.fileId, reason });
      ctx.log.warn('reroute.failed', { item: m.fileId, reason });
    }
  }
  return out;
}
