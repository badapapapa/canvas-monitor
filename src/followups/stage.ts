/**
 * The follow-up stage of a sync (DECISIONS.md D-61). Runs after detection and
 * the archive, before the flush, so a close lands on the answer file's own
 * notification in the same run -- added at send time, never as its own message.
 *
 * Messages it can send, all through the normal queue (quiet hours apply):
 *   - the first run's ONE summary of what is being tracked;
 *   - one nudge per follow-up, 10 days after its question, never repeated.
 * Nothing else. Opening, closing, expiring and dismissing are silent; a close
 * shows only as a line on the answer file's notification.
 */

import type { CanvasClient } from '../canvas/client.ts';
import type { Config } from '../core/config.ts';
import { setConfig } from '../core/config.ts';
import type { RunContext } from '../core/run-context.ts';
import type { Db } from '../core/db/writer.ts';
import { route } from '../archive/route.ts';
import { loadRules } from '../archive/rules.ts';
import { enqueueNotice } from '../notify/queue.ts';
import { describeOpen, planFollowups, type ExistingFollowup, type PartialPolicy, type Plan, type TrackedFile } from './plan.ts';

const TERM_REFRESH_MS = 24 * 3600_000;

export interface FollowupOutcome {
  status: 'ran' | 'awaiting_ruling';
  baseline: boolean;
  opened: number;
  closedOnArrival: number;
  closed: number;
  nudged: number;
  expired: number;
}

/** Every file in an enabled course, with where it is (or would be) routed. */
export async function loadTrackedFiles(db: Db): Promise<TrackedFile[]> {
  const rules = await loadRules(db);
  const rows = await db.read(
    `SELECT i.id, i.context_id, i.title, i.first_seen_at, i.meta, c.module_code, f.route_category
       FROM items i
       JOIN contexts x ON x.context_id = i.context_id AND x.enabled = 1 AND x.context_type = 'course'
       JOIN courses c ON c.context_id = i.context_id
       LEFT JOIN files f ON f.id = i.id
      WHERE i.resource_type = 'file'`,
  );
  return rows.rows.map((r) => {
    const contextId = Number(r['context_id']);
    const title = String(r['title'] ?? '');
    let category = r['route_category'] === null ? null : String(r['route_category']);
    if (category === null) {
      // Not archived yet: the route the archive will choose (route-once: the
      // files row, once it exists, is the truth).
      const meta = JSON.parse(String(r['meta'] ?? '{}')) as { folder?: string | null; module?: string | null };
      category = route({ contextType: 'course', folder: meta.folder ?? null, module: meta.module ?? null, fileName: title }, rules.get(contextId) ?? []).category;
    }
    return { itemId: String(r['id']), contextId, moduleCode: String(r['module_code'] ?? `context ${contextId}`), category, title, firstSeenAt: String(r['first_seen_at']) };
  });
}

export async function loadExisting(db: Db): Promise<ExistingFollowup[]> {
  const rows = await db.read('SELECT id, context_id, category, number, state, opened_at, nudged_at FROM followups');
  return rows.rows.map((r) => ({
    id: Number(r['id']), contextId: Number(r['context_id']), category: String(r['category']) as ExistingFollowup['category'],
    number: String(r['number']), state: String(r['state']) as ExistingFollowup['state'], openedAt: String(r['opened_at']),
    nudgedAt: r['nudged_at'] === null ? null : String(r['nudged_at']),
  }));
}

export async function loadPhrases(db: Db): Promise<Map<number, string[]>> {
  const rows = await db.read('SELECT context_id, phrase FROM answer_patterns ORDER BY id');
  const out = new Map<number, string[]>();
  for (const r of rows.rows) out.set(Number(r['context_id']), [...(out.get(Number(r['context_id'])) ?? []), String(r['phrase'])]);
  return out;
}

export async function loadTermEnds(db: Db): Promise<Map<number, string | null>> {
  const rows = await db.read('SELECT context_id, term_end_at FROM courses');
  return new Map(rows.rows.map((r) => [Number(r['context_id']), r['term_end_at'] === null ? null : String(r['term_end_at'])]));
}

/** Canvas's term.end_at for each active course; null where Canvas gives none. Read-only. */
export async function fetchTermEnds(db: Db, canvas: CanvasClient): Promise<Map<number, string | null> | null> {
  const courses = await canvas.listActiveCourses();
  if (courses.kind !== 'ok') return null;
  const ids = await db.read('SELECT context_id, canvas_course_id FROM courses');
  const byCanvas = new Map(ids.rows.map((r) => [Number(r['canvas_course_id']), Number(r['context_id'])]));
  const out = new Map<number, string | null>();
  for (const c of courses.value) {
    const contextId = byCanvas.get(c.id);
    if (contextId !== undefined) out.set(contextId, c.term?.end_at ?? c.end_at ?? null);
  }
  return out;
}

export function trackingSummary(plan: Plan): { title: string; lines: string[] } {
  const n = plan.opens.length;
  if (n === 0) return { title: 'Answer follow-ups', lines: ['Tracking 0: nothing is awaiting answers.'] };
  return { title: 'Answer follow-ups', lines: [`Tracking ${n}: ${describeOpen(plan.opens).join('; ')} awaiting answers.`] };
}

export async function runFollowups(ctx: RunContext, deps: { config: Config; canvas: CanvasClient; now: Date }): Promise<FollowupOutcome> {
  const { config, now } = deps;
  const policy = (config.get('followup_partial_answers') ?? null) as PartialPolicy;
  const baseline = (config.get('followups_baselined_at') ?? '') === '';
  const out: FollowupOutcome = { status: 'ran', baseline, opened: 0, closedOnArrival: 0, closed: 0, nudged: 0, expired: 0 };
  if (policy === null) {
    // The partial-answer case is the owner's to rule on (D-61); until then,
    // follow-ups do nothing at all rather than guess.
    ctx.log.warn('followups.awaiting_ruling', { key: 'followup_partial_answers' });
    return { ...out, status: 'awaiting_ruling' };
  }

  // Term ends: from Canvas, at most daily; on failure keep what is stored.
  const checked = config.get('followups_term_checked_at');
  if (checked === undefined || now.getTime() - new Date(checked).getTime() > TERM_REFRESH_MS) {
    const fresh = await fetchTermEnds(ctx.db, deps.canvas);
    if (fresh !== null) {
      for (const [contextId, end] of fresh) {
        await ctx.db.write.execute('record term end', { sql: 'UPDATE courses SET term_end_at = ? WHERE context_id = ?', args: [end, contextId] });
      }
      await setConfig(ctx.db, ctx.clock, 'followups_term_checked_at', now.toISOString());
    }
  }

  const plan = planFollowups({
    files: await loadTrackedFiles(ctx.db),
    existing: await loadExisting(ctx.db),
    phrases: await loadPhrases(ctx.db),
    partialPolicy: policy,
    termEnds: await loadTermEnds(ctx.db),
    now,
    baseline,
  });
  const at = now.toISOString();
  const flag = baseline ? 1 : 0;

  for (const o of plan.opens) {
    // A baseline follow-up already past 10 days shows its age in the summary
    // instead of getting its own nudge: mark it nudged now.
    const nudged = baseline && o.pastNudge ? at : null;
    await ctx.db.write.execute('open follow-up', {
      sql: `INSERT INTO followups (context_id, category, number, question_file_id, state, opened_at, recorded_at, baseline, nudged_at)
            VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?) ON CONFLICT (context_id, category, number) DO NOTHING`,
      args: [o.contextId, o.category, o.number, o.question.itemId, o.question.firstSeenAt, at, flag, nudged],
    });
  }
  for (const c of plan.closedOnArrival) {
    await ctx.db.write.execute('record answered pair', {
      sql: `INSERT INTO followups (context_id, category, number, question_file_id, state, opened_at, recorded_at, baseline,
                                   closed_at, closed_by_file_id, close_reason)
            VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'answered_on_arrival') ON CONFLICT (context_id, category, number) DO NOTHING`,
      args: [c.contextId, c.category, c.number, c.question.itemId, c.question.firstSeenAt, at, flag, at, c.answer.itemId],
    });
  }
  for (const c of plan.closes) {
    // Only a close in a live run is announced (as a line on the answer file's
    // message). A close decided during the first run -- possible only when an
    // interrupted first run is retried -- is recorded as silent.
    await ctx.db.write.execute('close follow-up', {
      sql: `UPDATE followups SET state = 'closed', closed_at = ?, closed_by_file_id = ?, close_reason = ? WHERE id = ? AND state = 'open'`,
      args: [at, c.answer.itemId, baseline ? 'answered_on_arrival' : 'answers', c.followupId],
    });
  }
  for (const e of plan.expires) {
    await ctx.db.write.execute('expire follow-up', {
      sql: `UPDATE followups SET state = 'expired', closed_at = ?, close_reason = 'term_end' WHERE id = ? AND state = 'open'`,
      args: [at, e.followupId],
    });
  }
  if (!baseline) {
    for (const n of plan.nudges) {
      // The send key makes a second enqueue a no-op even if nudged_at were lost.
      await enqueueNotice(ctx.db, {
        sendKey: `followup-nudge ${n.followupId}`,
        payload: { kind: 'notice', title: 'Answers still not posted', lines: [`${n.moduleCode} ${n.label}: no answers after ${n.ageDays} days. Worth asking in class.`] },
        now,
      });
      await ctx.db.write.execute('record nudge', { sql: 'UPDATE followups SET nudged_at = ? WHERE id = ? AND nudged_at IS NULL', args: [at, n.followupId] });
    }
  } else {
    // The first run: silent, then ONE summary. Keyed, so a retried first run
    // cannot send it twice.
    await enqueueNotice(ctx.db, { sendKey: 'followups-baseline', payload: { kind: 'notice', ...trackingSummary(plan) }, now });
    await setConfig(ctx.db, ctx.clock, 'followups_baselined_at', at);
  }

  Object.assign(out, {
    opened: plan.opens.length, closedOnArrival: plan.closedOnArrival.length, closed: plan.closes.length,
    nudged: baseline ? 0 : plan.nudges.length, expired: plan.expires.length,
  });
  ctx.log.info('followups.summary', { ...out, ignored: plan.ignored.length, partial: plan.partial.length });
  return out;
}
