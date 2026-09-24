/**
 * The follow-up stage of a sync (DECISIONS.md D-61, D-62). Runs after detection
 * and the archive, before the flush, so a close lands on the answer file's own
 * notification in the same run -- added at send time, never as its own message.
 *
 * Messages it can send, all through the normal queue:
 *   - the first run's ONE summary of what is being tracked, with real ages;
 *   - on a day I have a lesson, from 07:00 SGT, ONE reminder of what is overdue
 *     for the modules with a lesson that day (keyed by date: once a day).
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
import { describeItems, planFollowups, type ExistingFollowup, type PartialPolicy, type Plan, type TrackedFile } from './plan.ts';
import { planReminder, type OpenItem, type ReminderPlan, type Timetable } from './timetable.ts';

const TERM_REFRESH_MS = 24 * 3600_000;

export interface FollowupOutcome {
  status: 'ran' | 'awaiting_ruling';
  baseline: boolean;
  opened: number;
  closedOnArrival: number;
  closed: number;
  expired: number;
  /** The date a lesson-day reminder was enqueued for, or null. */
  reminded: string | null;
}

/** Every file in an enabled course, with where it is (or would be) routed. */
export async function loadTrackedFiles(db: Db): Promise<TrackedFile[]> {
  const rules = await loadRules(db);
  const rows = await db.read(
    `SELECT i.id, i.context_id, i.title, i.first_seen_at, i.posted_at, i.meta, c.module_code, f.route_category
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
    return {
      itemId: String(r['id']), contextId, moduleCode: String(r['module_code'] ?? `context ${contextId}`), category, title,
      firstSeenAt: String(r['first_seen_at']), postedAt: r['posted_at'] === null ? null : String(r['posted_at']),
    };
  });
}

export async function loadExisting(db: Db): Promise<ExistingFollowup[]> {
  const rows = await db.read('SELECT id, context_id, category, number, state, opened_at FROM followups');
  return rows.rows.map((r) => ({
    id: Number(r['id']), contextId: Number(r['context_id']), category: String(r['category']) as ExistingFollowup['category'],
    number: String(r['number']), state: String(r['state']) as ExistingFollowup['state'], openedAt: String(r['opened_at']),
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

export async function loadTrackingOff(db: Db): Promise<Set<number>> {
  const rows = await db.read('SELECT context_id FROM courses WHERE followups_tracking = 0');
  return new Set(rows.rows.map((r) => Number(r['context_id'])));
}

export async function loadTimetable(db: Db): Promise<Timetable> {
  const slots = await db.read('SELECT context_id, weekday, start_time, first_date, last_date, label FROM lesson_slots');
  const exceptions = await db.read('SELECT context_id, date FROM lesson_exceptions');
  return {
    slots: slots.rows.map((r) => ({
      contextId: Number(r['context_id']), weekday: Number(r['weekday']), startTime: String(r['start_time']),
      firstDate: String(r['first_date']), lastDate: String(r['last_date']), label: String(r['label']),
    })),
    exceptions: exceptions.rows.map((r) => ({ contextId: r['context_id'] === null ? null : Number(r['context_id']), date: String(r['date']) })),
  };
}

/** Open follow-ups right now, for the reminder: answered and dismissed ones are never here. */
export async function loadOpenItems(db: Db): Promise<OpenItem[]> {
  const rows = await db.read(
    `SELECT f.id, f.context_id, f.category, f.number, f.opened_at, c.module_code
       FROM followups f JOIN courses c ON c.context_id = f.context_id
      WHERE f.state = 'open' AND c.followups_tracking = 1`,
  );
  return rows.rows.map((r) => ({
    followupId: Number(r['id']), contextId: Number(r['context_id']), moduleCode: String(r['module_code']),
    category: String(r['category']) as OpenItem['category'], number: String(r['number']), openedAt: String(r['opened_at']),
  }));
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

export function trackingSummary(plan: Plan, now: Date): { title: string; lines: string[] } {
  const n = plan.opens.length;
  if (n === 0) return { title: 'Answer follow-ups', lines: ['Tracking 0: nothing is awaiting answers.'] };
  return { title: 'Answer follow-ups', lines: [`Tracking ${n} awaiting answers: ${describeItems(plan.opens, now).join('; ')}.`] };
}

export function reminderMessage(plan: ReminderPlan, now: Date): { title: string; lines: string[] } {
  return {
    title: 'Answers still outstanding',
    lines: plan.modules.map((m) => {
      const when = m.lessons.map((l) => `${l.label} ${l.startTime}`).join(', ');
      const items = describeItems(m.items.map((i) => ({ ...i, postedAt: i.openedAt })), now, { withModule: false }).join('; ');
      return `${m.moduleCode} ${when} today: ${items}`;
    }),
  };
}

export async function runFollowups(ctx: RunContext, deps: { config: Config; canvas: CanvasClient; now: Date }): Promise<FollowupOutcome> {
  const { config, now } = deps;
  const policy = (config.get('followup_partial_answers') ?? null) as PartialPolicy;
  const liveSince = config.get('followups_baselined_at') ?? null;
  const baseline = (liveSince ?? '') === '';
  const out: FollowupOutcome = { status: 'ran', baseline, opened: 0, closedOnArrival: 0, closed: 0, expired: 0, reminded: null };
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
    trackingOff: await loadTrackingOff(ctx.db),
    now,
  });
  const at = now.toISOString();
  const flag = baseline ? 1 : 0;

  for (const o of plan.opens) {
    await ctx.db.write.execute('open follow-up', {
      sql: `INSERT INTO followups (context_id, category, number, question_file_id, state, opened_at, recorded_at, baseline)
            VALUES (?, ?, ?, ?, 'open', ?, ?, ?) ON CONFLICT (context_id, category, number) DO NOTHING`,
      args: [o.contextId, o.category, o.number, o.question.itemId, o.postedAt, at, flag],
    });
  }
  for (const c of plan.closedOnArrival) {
    await ctx.db.write.execute('record answered pair', {
      sql: `INSERT INTO followups (context_id, category, number, question_file_id, state, opened_at, recorded_at, baseline,
                                   closed_at, closed_by_file_id, close_reason)
            VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'answered_on_arrival') ON CONFLICT (context_id, category, number) DO NOTHING`,
      args: [c.contextId, c.category, c.number, c.question.itemId, c.question.postedAt ?? c.question.firstSeenAt, at, flag, at, c.answer.itemId],
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

  if (baseline) {
    // The first run: silent, then ONE summary, and no reminder of its own.
    // Keyed, so a retried first run cannot send it twice.
    await enqueueNotice(ctx.db, { sendKey: 'followups-baseline', payload: { kind: 'notice', ...trackingSummary(plan, now) }, now });
    await setConfig(ctx.db, ctx.clock, 'followups_baselined_at', at);
  } else {
    // After this run's closes and expiries: only what is open NOW.
    const decision = planReminder({ now, timetable: await loadTimetable(ctx.db), open: await loadOpenItems(ctx.db), liveSince });
    if (decision.plan !== null) {
      // One per lesson day, whatever the number of runs after 07:00.
      await enqueueNotice(ctx.db, { sendKey: `lesson-reminder ${decision.plan.date}`, payload: { kind: 'notice', ...reminderMessage(decision.plan, now) }, now });
      out.reminded = decision.plan.date;
    }
  }

  Object.assign(out, { opened: plan.opens.length, closedOnArrival: plan.closedOnArrival.length, closed: plan.closes.length, expired: plan.expires.length });
  ctx.log.info('followups.summary', { ...out, ignored: plan.ignored.length, partial: plan.partial.length });
  return out;
}

