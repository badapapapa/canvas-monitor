/**
 * One sync run (SPEC.md section 7).
 *
 *   1. Acquire the lock (backstop; Actions' concurrency group is the real one).
 *   2. For each enabled course, in its own failure domain:
 *        fetch everything OUTSIDE any transaction, classify against what is
 *        stored, then commit items + watermarks + the queued notification in
 *        ONE transaction. A course that fails is logged and skipped; the
 *        others commit normally (section 2.6).
 *   3. Reconcile operational alerts.
 *   4. Flush the queue.
 *
 * Phase 2 scope: courses only; announcements, assignments, grades, feedback.
 * Groups, files and downloads arrive in Phases 3 and 4.
 */

import { CanvasClient } from '../canvas/client.ts';
import { CanvasHttp } from '../canvas/http.ts';
import { RateLimitGovernor } from '../canvas/rate-limit.ts';
import { createRawStore } from '../canvas/raw-store.ts';
import type { CanvasAnnouncement, CanvasAssignment } from '../canvas/types.ts';
import { Config, tokenDaysRemaining } from '../core/config.ts';
import { AppError, messageOf } from '../core/errors.ts';
import { describe, ok, type Result } from '../core/result.ts';
import type { RunContext } from '../core/run-context.ts';
import type { TxHandle } from '../core/db/writer.ts';
import { classify, type Classified, type StoredItem } from '../ingest/classify.ts';
import {
  itemId,
  normaliseAnnouncement,
  normaliseAssignment,
  normaliseComments,
  normaliseGrade,
  RESOURCE_TYPES,
  type ItemRecord,
  type ResourceType,
} from '../ingest/normalise.ts';
import { reconcileAlerts, tokenExpiryCondition, type AlertCondition, type ReconcileOutcome } from '../notify/ops.ts';
import { enqueueContent, enqueueWatching, flush, type FlushOutcome } from '../notify/queue.ts';
import type { ContentPayload, Payload, RenderItem, WatchingPayload } from '../notify/render.ts';
import { TelegramClient } from '../notify/telegram.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { loadMigrations } from '../core/db/migrate.ts';
import { ping } from './healthcheck.ts';

/** SPEC.md section 12: a deadline inside this window overrides quiet hours. */
export const URGENT_WINDOW_MS = 12 * 3600_000;
/** SPEC.md section 12: a context stale for longer than this pages me. */
export const STALE_AFTER_MS = 24 * 3600_000;
/** A scheduled run this late, or a gap this long, means the scheduler is failing. */
export const DRIFT_ALERT_MS = 60 * 60_000;
export const GAP_ALERT_MS = 3 * 3600_000;
/**
 * /announcements applies a short default window unless dates are given
 * (SPEC.md section 4). 200 days covers any semester, so a baseline sees the
 * whole term and an edit to an early announcement is still detected.
 */
const ANNOUNCEMENT_LOOKBACK_MS = 200 * 86_400_000;

type FetchStatus = 'ok' | 'denied_or_absent' | 'error' | 'unverified';

interface ResourceFetch {
  status: FetchStatus;
  records: ItemRecord[];
  detail: string | null;
}

interface CourseContext {
  contextId: number;
  canvasId: number;
  label: string;
  firstSeenAt: string;
}

interface Watermark {
  lastOkAt: string | null;
  baselinedAt: string | null;
  lastStatus: string | null;
}

export interface SyncOptions {
  /** Test seam: point the Telegram client at a local fake. */
  telegramApiBase?: string;
}

export interface SyncOutcome {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  contexts: number;
  failedContexts: number;
  baselined: number;
  notified: number;
  alerts: ReconcileOutcome | null;
  flush: FlushOutcome | null;
  /** What this run decided to enqueue, for the --dry-run preview. */
  planned: Payload[];
}

export async function runSync(ctx: RunContext, options: SyncOptions = {}): Promise<SyncOutcome> {
  await assertSchemaCurrent(ctx);
  const config = await Config.load(ctx.db);
  const telegram = buildTelegram(config, ctx, options);
  const chats = telegram === null ? null : {
    content: config.require('telegram_content_chat_id'),
    ops: config.require('telegram_ops_chat_id'),
  };
  const healthUrl = ctx.dryRun ? undefined : config.get('healthcheck_url');
  await ping(healthUrl, 'start', ctx.log);

  if (!ctx.dryRun && !(await acquireLock(ctx.db, ctx.runId, ctx.clock.now()))) {
    ctx.log.warn('sync.lock_held', { reason: 'another sync holds the lock and it is not stale' });
    await ping(healthUrl, 'success', ctx.log);
    return empty('skipped');
  }

  let outcome: SyncOutcome = empty('failed');
  try {
    outcome = await syncBody(ctx, config, telegram, chats);
    return outcome;
  } finally {
    if (!ctx.dryRun) await releaseLock(ctx.db, ctx.runId).catch(() => undefined);
    await ping(healthUrl, outcome.status === 'failed' ? 'fail' : 'success', ctx.log);
  }
}

/**
 * Refuse to run against a schema behind the code. Without this, a sync run
 * before `npm run migrate` -- or a scheduled run after a push that added a
 * migration nobody applied -- dies on "no such table", which says nothing
 * about the fix. Migrations stay a deliberate manual step, not something a
 * push does to production on its own.
 */
async function assertSchemaCurrent(ctx: RunContext): Promise<void> {
  const expected = (await loadMigrations()).map((m) => m.version);
  let applied = new Set<string>();
  try {
    const rows = await ctx.db.read('SELECT version FROM schema_migrations');
    applied = new Set(rows.rows.map((r) => String(r['version'])));
  } catch {
    // No bookkeeping table at all: nothing has been migrated.
  }
  const pending = expected.filter((v) => !applied.has(v));
  if (pending.length > 0) {
    throw new AppError(
      'config_invalid',
      `The database schema is behind the code: ${pending.join(', ')} not applied.`,
      'Run `npm run migrate` (it is additive), then sync again.',
    );
  }
}

function empty(status: SyncOutcome['status']): SyncOutcome {
  return { status, contexts: 0, failedContexts: 0, baselined: 0, notified: 0, alerts: null, flush: null, planned: [] };
}

function buildTelegram(config: Config, ctx: RunContext, options: SyncOptions): TelegramClient | null {
  const token = config.get('telegram_bot_token');
  const content = config.get('telegram_content_chat_id');
  const ops = config.get('telegram_ops_chat_id');

  if (token === undefined || content === undefined || ops === undefined) {
    if (ctx.dryRun) return null; // a dry run previews without sending
    throw new AppError(
      'config_missing',
      'Telegram is not configured, so nothing could be delivered.',
      'Set telegram_bot_token, telegram_content_chat_id and telegram_ops_chat_id with npm run set-config.',
    );
  }
  if (content === ops) {
    throw new AppError(
      'config_invalid',
      'telegram_content_chat_id and telegram_ops_chat_id are the same chat.',
      'Operational alerts need their own chat so failures never get lost in content (SPEC.md section 12).',
    );
  }
  return new TelegramClient({
    token,
    log: ctx.log,
    ...(options.telegramApiBase === undefined ? {} : { apiBase: options.telegramApiBase }),
  });
}

async function syncBody(
  ctx: RunContext,
  config: Config,
  telegram: TelegramClient | null,
  chats: { content: string; ops: string } | null,
): Promise<SyncOutcome> {
  const now = ctx.clock.now();
  const outcome = empty('ok');
  const alerts: AlertCondition[] = [];
  const evaluatedPrefixes: string[] = ['token_expiry@', 'telegram_delivery'];

  const token = tokenExpiryCondition(tokenDaysRemaining(config, now));
  if (token !== null) alerts.push(token);

  const failedSends = await ctx.db.read({
    sql: `SELECT count(*) AS n FROM notifications WHERE state = 'failed' AND created_at > ?`,
    args: [new Date(now.getTime() - STALE_AFTER_MS).toISOString()],
  });
  if (Number(failedSends.rows[0]?.['n'] ?? 0) > 0) {
    alerts.push({
      key: 'telegram_delivery',
      severity: 'critical',
      summary: 'Some notifications could not be delivered in the last 24 hours.',
      detail: 'Check the notifications table for state = failed and last_error.',
    });
  }

  const canvas = new CanvasClient(
    new CanvasHttp({
      baseUrl: config.require('canvas_base_url'),
      token: config.require('canvas_token'),
      log: ctx.log,
      clock: ctx.clock,
      governor: new RateLimitGovernor(ctx.log),
      rawStore: createRawStore({
        runId: ctx.runId,
        // Off under CI: the runner's disk is discarded at job end, so a capture
        // there is pure cost -- and one less place real responses could sit.
        enabled: config.getBoolean('raw_capture_enabled', true) && !ctx.ci,
        log: ctx.log,
        clock: ctx.clock,
      }),
    }),
  );

  const self = await canvas.getSelf();
  if (self.kind !== 'ok') {
    if (self.kind === 'error' && self.code === 'auth') {
      alerts.push({
        key: 'canvas_auth',
        severity: 'critical',
        summary: 'Canvas rejected the token (401). Nothing is being synced.',
        detail: 'Generate a new token in Canvas, then: npm run set-config canvas_token',
      });
      evaluatedPrefixes.push('canvas_auth');
    }
    // Anything else (network, 5xx) is transient and says nothing about auth;
    // a context left unsynced for 24 hours is caught by the staleness alert.
    ctx.log.error('sync.self_failed', { outcome: describe(self) });
    outcome.alerts = await reconcileAlerts(ctx.db, now, alerts, evaluatedPrefixes);
    outcome.flush = await flush({ db: ctx.db, log: ctx.log, now, dryRun: ctx.dryRun }, telegram, chats);
    outcome.status = 'failed';
    return outcome;
  }
  evaluatedPrefixes.push('canvas_auth');

  const contexts = await loadContexts(ctx);
  const watermarks = await loadWatermarks(ctx, contexts.map((c) => c.contextId));
  outcome.contexts = contexts.length;

  const announcements = await fetchAnnouncements(ctx, canvas, contexts, now);
  const watching: WatchingPayload = { kind: 'watching', contexts: [] };
  const baselinedScope: string[] = [];

  for (const context of contexts) {
    try {
      const result = await syncCourse(ctx, canvas, context, {
        announcements: announcements.get(context.canvasId) ?? ok([]),
        watermarks: watermarks.get(context.contextId) ?? new Map(),
        selfId: self.value.id,
        now,
      });
      if (result.failed) outcome.failedContexts += 1;
      outcome.notified += result.notified;
      if (result.payload !== null) outcome.planned.push(result.payload);
      if (result.baselined.size > 0) {
        const counts: Partial<Record<ResourceType, number>> = {};
        for (const [type, n] of result.baselined) {
          counts[type] = n;
          baselinedScope.push(`${context.contextId}:${type}`);
          outcome.baselined += n;
        }
        watching.contexts.push({ label: context.label, counts });
      }
    } catch (error) {
      outcome.failedContexts += 1;
      ctx.log.error('sync.context_failed', { context_id: context.contextId, reason: messageOf(error) });
    }
  }

  if (baselinedScope.length > 0) {
    outcome.planned.push(watching);
    await enqueueWatching(ctx.db, { scopeKey: baselinedScope.sort().join(','), payload: watching, now });
  }

  alerts.push(...(await staleContextAlerts(ctx, contexts, now)));
  evaluatedPrefixes.push('context_stale:');

  if (ctx.scheduledFor !== undefined) {
    const health = await scheduleHealthAlert(ctx, now);
    if (health !== null) alerts.push(health);
    evaluatedPrefixes.push('schedule_health');
  }

  outcome.alerts = await reconcileAlerts(ctx.db, now, alerts, evaluatedPrefixes);
  outcome.flush = await flush({ db: ctx.db, log: ctx.log, now, dryRun: ctx.dryRun }, telegram, chats);

  outcome.status = outcome.flush.failed > 0 ? 'failed' : outcome.failedContexts > 0 ? 'partial' : 'ok';
  ctx.log.info('sync.summary', {
    contexts: outcome.contexts,
    failed_contexts: outcome.failedContexts,
    baselined: outcome.baselined,
    notified: outcome.notified,
    sent: outcome.flush.sent,
    held: outcome.flush.stillHeld,
    alerts_raised: outcome.alerts.raised.length,
    alerts_resolved: outcome.alerts.resolved.length,
  });
  return outcome;
}

async function loadContexts(ctx: RunContext): Promise<CourseContext[]> {
  const rows = await ctx.db.read(
    `SELECT x.context_id, x.canvas_id, x.first_seen_at, c.module_code
       FROM contexts x JOIN courses c ON c.context_id = x.context_id
      WHERE x.enabled = 1 AND x.context_type = 'course'
      ORDER BY x.context_id`,
  );
  return rows.rows.map((r) => ({
    contextId: Number(r['context_id']),
    canvasId: Number(r['canvas_id']),
    // Never null for an enabled context: the seed loader rejects that (D-37).
    label: String(r['module_code']),
    firstSeenAt: String(r['first_seen_at']),
  }));
}

async function loadWatermarks(ctx: RunContext, contextIds: number[]): Promise<Map<number, Map<ResourceType, Watermark>>> {
  const out = new Map<number, Map<ResourceType, Watermark>>();
  if (contextIds.length === 0) return out;
  const rows = await ctx.db.read({
    sql: `SELECT context_id, resource_type, last_ok_at, baselined_at, last_status FROM watermarks
           WHERE context_id IN (${contextIds.map(() => '?').join(', ')})`,
    args: contextIds,
  });
  for (const r of rows.rows) {
    const id = Number(r['context_id']);
    const inner = out.get(id) ?? new Map<ResourceType, Watermark>();
    inner.set(String(r['resource_type']) as ResourceType, {
      lastOkAt: r['last_ok_at'] === null ? null : String(r['last_ok_at']),
      baselinedAt: r['baselined_at'] === null ? null : String(r['baselined_at']),
      lastStatus: r['last_status'] === null ? null : String(r['last_status']),
    });
    out.set(id, inner);
  }
  return out;
}

/**
 * One multi-course /announcements call per chunk of 10, split back out per
 * course by `context_code`. A failed chunk fails only its own courses.
 */
async function fetchAnnouncements(
  ctx: RunContext,
  canvas: CanvasClient,
  contexts: CourseContext[],
  now: Date,
): Promise<Map<number, Result<CanvasAnnouncement[]>>> {
  const out = new Map<number, Result<CanvasAnnouncement[]>>();
  if (contexts.length === 0) return out;
  const window = {
    start: new Date(now.getTime() - ANNOUNCEMENT_LOOKBACK_MS).toISOString(),
    end: new Date(now.getTime() + 86_400_000).toISOString(),
  };
  for (const chunk of await canvas.listAnnouncements(contexts.map((c) => c.canvasId), window)) {
    const result = chunk.result;
    if (result.kind !== 'ok') {
      for (const id of chunk.courseIds) out.set(id, result);
      continue;
    }
    const unattributed = result.value.filter((a) => typeof a.context_code !== 'string').length;
    if (unattributed > 0) ctx.log.warn('sync.announcements_unattributed', { count: unattributed });
    for (const id of chunk.courseIds) {
      out.set(id, ok(result.value.filter((a) => a.context_code === `course_${id}`)));
    }
  }
  return out;
}

function statusOf<T>(result: Result<T>): FetchStatus {
  return result.kind === 'ok' ? 'ok' : result.kind;
}

async function syncCourse(
  ctx: RunContext,
  canvas: CanvasClient,
  context: CourseContext,
  input: {
    announcements: Result<CanvasAnnouncement[]>;
    watermarks: Map<ResourceType, Watermark>;
    selfId: number;
    now: Date;
  },
): Promise<{ failed: boolean; notified: number; baselined: Map<ResourceType, number>; payload: ContentPayload | null }> {
  const { now } = input;
  const log = ctx.log.child({ context_id: context.contextId });

  // --- fetch, outside any transaction (SPEC.md section 7) ------------------
  const assignments = await canvas.listAssignments(context.canvasId);
  const submissions = await canvas.listSubmissions(context.canvasId);
  const assignmentById = new Map<number, CanvasAssignment>(
    assignments.kind === 'ok' ? assignments.value.map((a) => [a.id, a]) : [],
  );

  // D-38: /announcements answers 200 [] for a course the token cannot read.
  // An empty list is "none posted" only if another endpoint proves the course
  // is readable in this same run; otherwise it is unverified.
  const readable = assignments.kind === 'ok' || submissions.kind === 'ok';
  const fetches: Record<ResourceType, ResourceFetch> = {
    announcement:
      input.announcements.kind !== 'ok'
        ? { status: statusOf(input.announcements), records: [], detail: describe(input.announcements) }
        : input.announcements.value.length === 0 && !readable
          ? { status: 'unverified', records: [], detail: 'empty list, and no other endpoint confirmed readability (D-38)' }
          : {
              status: 'ok',
              records: input.announcements.value
                .map((a) => normaliseAnnouncement(a, now))
                .filter((r): r is ItemRecord => r !== null),
              detail: null,
            },
    assignment:
      assignments.kind === 'ok'
        ? { status: 'ok', records: assignments.value.map(normaliseAssignment), detail: null }
        : { status: statusOf(assignments), records: [], detail: describe(assignments) },
    grade:
      submissions.kind === 'ok'
        ? { status: 'ok', records: submissions.value.map((s) => normaliseGrade(s, assignmentById.get(s.assignment_id))), detail: null }
        : { status: statusOf(submissions), records: [], detail: describe(submissions) },
    comment:
      submissions.kind === 'ok'
        ? {
            status: 'ok',
            records: submissions.value.flatMap((s) => normaliseComments(s, assignmentById.get(s.assignment_id), input.selfId)),
            detail: null,
          }
        : { status: statusOf(submissions), records: [], detail: describe(submissions) },
  };

  // --- classify against stored state (reads only) --------------------------
  const storedRows = await ctx.db.read({
    sql: 'SELECT resource_type, external_id, content_hash, meta FROM items WHERE context_id = ?',
    args: [context.contextId],
  });
  const stored = new Map<string, StoredItem>();
  for (const r of storedRows.rows) {
    stored.set(`${String(r['resource_type'])}:${String(r['external_id'])}`, {
      contentHash: String(r['content_hash']),
      meta: r['meta'] === null ? {} : (JSON.parse(String(r['meta'])) as Record<string, unknown>),
    });
  }

  const decided: Classified[] = [];
  const baselined = new Map<ResourceType, number>();
  for (const type of RESOURCE_TYPES) {
    const fetch = fetches[type];
    if (fetch.status !== 'ok') {
      log.warn('sync.resource_skipped', { resource: type, status: fetch.status, detail: fetch.detail });
      continue;
    }
    const baseline = input.watermarks.get(type)?.baselinedAt == null;
    for (const record of fetch.records) {
      const c = classify(record, stored.get(`${type}:${record.externalId}`), { baseline });
      if (c.kind !== 'unchanged') decided.push(c);
    }
    // Count what would have been NEWS, not every record: a submission that is
    // unsubmitted or held is stored as a grade item, but calling it one of my
    // "grades" in the summary would overstate what exists (seen live).
    if (baseline) baselined.set(type, fetch.records.filter((r) => r.notifiable).length);
  }

  const toNotify = decided.filter((c) => c.notify);
  const payload: ContentPayload | null =
    toNotify.length === 0 ? null : { kind: 'content', contextLabel: context.label, items: toNotify.map(renderItemOf) };
  const urgent = toNotify.some(
    (c) =>
      c.record.resourceType === 'assignment' &&
      c.record.dueAt !== null &&
      new Date(c.record.dueAt).getTime() > now.getTime() &&
      new Date(c.record.dueAt).getTime() - now.getTime() <= URGENT_WINDOW_MS,
  );

  // --- commit: items, watermarks and the queued notification together ------
  await ctx.db.transaction(`sync context ${context.contextId}`, async (tx) => {
    for (const c of decided) await upsertItem(tx, context.contextId, c, now, baselined.has(c.record.resourceType));
    for (const type of RESOURCE_TYPES) {
      await upsertWatermark(tx, context.contextId, type, fetches[type], now, baselined.has(type));
    }
    if (payload !== null) {
      await enqueueContent(tx, {
        contextId: context.contextId,
        refs: toNotify.map((c) => ({
          id: itemId(context.contextId, c.record.resourceType, c.record.externalId),
          contentHash: c.record.contentHash,
        })),
        payload,
        urgent,
        now,
      });
    }
  });

  const failed = RESOURCE_TYPES.some((t) => fetches[t].status !== 'ok');
  log.info('sync.context_done', {
    new: decided.filter((c) => c.kind === 'new').length,
    revised: decided.filter((c) => c.kind === 'revised').length,
    notify: toNotify.length,
    urgent,
    baselined: [...baselined.values()].reduce((a, b) => a + b, 0),
    failed,
  });
  return { failed, notified: toNotify.length, baselined, payload };
}

function renderItemOf(c: Classified): RenderItem {
  const r = c.record;
  const facts = r.meta['facts'] as { score?: number | null; grade?: string | null; excused?: boolean } | undefined;
  return {
    resourceType: r.resourceType,
    kind: c.kind === 'new' ? 'new' : 'revised',
    title: r.title,
    url: r.canvasUrl,
    change: c.change,
    postedAt: r.postedAt,
    dueAt: r.dueAt,
    ...(Array.isArray(r.meta['other_due_dates']) ? { otherDueDates: r.meta['other_due_dates'] as string[] } : {}),
    ...(typeof r.meta['preview'] === 'string' ? { preview: r.meta['preview'] } : {}),
    ...(r.resourceType === 'grade' && facts !== undefined
      ? {
          grade: {
            score: facts.score ?? null,
            grade: facts.grade ?? null,
            pointsPossible: (r.meta['points_possible'] as number | null | undefined) ?? null,
            excused: facts.excused === true,
          },
        }
      : {}),
  };
}

async function upsertItem(tx: TxHandle, contextId: number, c: Classified, now: Date, baseline: boolean): Promise<void> {
  const r = c.record;
  const nowIso = now.toISOString();
  // Pending items are 'new'/'revised' until enqueueContent stamps them. Items
  // that are not news (a baseline, a held grade) are recorded as 'seen'.
  const state = c.notify ? (c.kind === 'new' ? 'new' : 'revised') : 'seen';
  await tx.write.execute(`upsert ${r.resourceType}`, {
    sql: `INSERT INTO items
            (id, context_id, resource_type, external_id, title, body_text, body_hash, content_hash,
             canvas_url, posted_at, updated_at_canvas, due_at, meta,
             first_seen_at, last_seen_at, revised_at, notified_at, state)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
          ON CONFLICT(context_id, resource_type, external_id) DO UPDATE SET
            title = excluded.title, body_text = excluded.body_text, body_hash = excluded.body_hash,
            content_hash = excluded.content_hash, canvas_url = excluded.canvas_url,
            posted_at = excluded.posted_at, updated_at_canvas = excluded.updated_at_canvas,
            due_at = excluded.due_at, meta = excluded.meta, last_seen_at = excluded.last_seen_at,
            revised_at = ?, state = excluded.state`,
    args: [
      itemId(contextId, r.resourceType, r.externalId),
      contextId,
      r.resourceType,
      r.externalId,
      r.title,
      r.bodyText,
      r.bodyHash,
      r.contentHash,
      r.canvasUrl,
      r.postedAt,
      r.updatedAt,
      r.dueAt,
      JSON.stringify(r.meta),
      nowIso,
      nowIso,
      // D-41: a baseline records what exists as already accounted for.
      baseline ? nowIso : null,
      state,
      nowIso,
    ],
  });
}

async function upsertWatermark(
  tx: TxHandle,
  contextId: number,
  type: ResourceType,
  fetch: ResourceFetch,
  now: Date,
  baselinedNow: boolean,
): Promise<void> {
  const nowIso = now.toISOString();
  const ok = fetch.status === 'ok';
  const maxTs = ok ? maxTimestamp(fetch.records) : null;
  await tx.write.execute(`watermark ${type}`, {
    sql: `INSERT INTO watermarks
            (context_id, resource_type, last_seen_max_ts, last_run_at, last_status, last_ok_at, baselined_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(context_id, resource_type) DO UPDATE SET
            -- Never derived from the clock: the max timestamp actually present,
            -- or unchanged when the response was empty (SPEC.md section 7).
            last_seen_max_ts = COALESCE(excluded.last_seen_max_ts, watermarks.last_seen_max_ts),
            last_run_at = excluded.last_run_at,
            last_status = excluded.last_status,
            last_ok_at = COALESCE(excluded.last_ok_at, watermarks.last_ok_at),
            baselined_at = COALESCE(watermarks.baselined_at, excluded.baselined_at)`,
    args: [contextId, type, maxTs, nowIso, fetch.status, ok ? nowIso : null, ok && baselinedNow ? nowIso : null],
  });
}

function maxTimestamp(records: ItemRecord[]): string | null {
  let best: number | null = null;
  for (const r of records) {
    for (const candidate of [r.postedAt, r.updatedAt]) {
      if (candidate === null) continue;
      const t = new Date(candidate).getTime();
      if (!Number.isNaN(t) && (best === null || t > best)) best = t;
    }
  }
  return best === null ? null : new Date(best).toISOString();
}

async function staleContextAlerts(ctx: RunContext, contexts: CourseContext[], now: Date): Promise<AlertCondition[]> {
  const fresh = await loadWatermarks(ctx, contexts.map((c) => c.contextId));
  const out: AlertCondition[] = [];
  for (const c of contexts) {
    const marks = fresh.get(c.contextId) ?? new Map<ResourceType, Watermark>();
    // The stalest resource decides. A resource that has never succeeded counts
    // from when the context was first seen.
    let oldest = Number.POSITIVE_INFINITY;
    const failing: string[] = [];
    for (const type of RESOURCE_TYPES) {
      const mark = marks.get(type);
      const t = new Date(mark?.lastOkAt ?? c.firstSeenAt).getTime();
      if (t < oldest) oldest = t;
      if (mark?.lastStatus !== undefined && mark.lastStatus !== null && mark.lastStatus !== 'ok') {
        failing.push(`${type}: ${mark.lastStatus}`);
      }
    }
    const age = now.getTime() - oldest;
    if (age > STALE_AFTER_MS) {
      out.push({
        key: `context_stale:${c.contextId}`,
        severity: 'warn',
        summary: `${c.label} has not synced successfully for ${Math.floor(age / 3600_000)} hours.`,
        ...(failing.length > 0 ? { detail: failing.join('; ') } : {}),
      });
    }
  }
  return out;
}

async function scheduleHealthAlert(ctx: RunContext, now: Date): Promise<AlertCondition | null> {
  const scheduledFor = ctx.scheduledFor;
  if (scheduledFor === undefined) return null;
  const drift = ctx.startedAt.getTime() - scheduledFor.getTime();
  const previous = await ctx.db.read({
    sql: `SELECT started_at FROM runs
           WHERE command = 'sync' AND dry_run = 0 AND scheduled_for IS NOT NULL AND run_id != ?
           ORDER BY started_at DESC LIMIT 1`,
    args: [ctx.runId],
  });
  const prevStart = previous.rows[0]?.['started_at'];
  const gap = prevStart === undefined || prevStart === null ? 0 : now.getTime() - new Date(String(prevStart)).getTime();
  if (drift <= DRIFT_ALERT_MS && gap <= GAP_ALERT_MS) return null;
  return {
    key: 'schedule_health',
    severity: 'warn',
    summary: 'Scheduled syncs are running late or being skipped.',
    detail:
      `This run started ${Math.round(drift / 60_000)} min after its slot` +
      (gap > 0 ? `; the previous scheduled run was ${(gap / 3600_000).toFixed(1)} h earlier.` : '.'),
  };
}
