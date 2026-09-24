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
import { Config, daysRemaining, tokenDaysRemaining } from '../core/config.ts';
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
  normaliseFile,
  normaliseModuleFile,
  RESOURCES_FOR,
  type ItemRecord,
  type ResourceType,
} from '../ingest/normalise.ts';
import { dashboardTokenExpiryCondition, reconcileAlerts, tokenExpiryCondition, type AlertCondition, type ReconcileOutcome } from '../notify/ops.ts';
import { enqueueContent, enqueueNotice, enqueueOps, enqueueWatching, flush, type FlushOutcome } from '../notify/queue.ts';
import { formatSgt, humanSize, type ContentPayload, type Payload, type RenderItem, type WatchingPayload } from '../notify/render.ts';
import { TelegramClient } from '../notify/telegram.ts';
import { acquireLock, releaseLock } from './lock.ts';
import { runArchive, tallyFailures, type ArchiveOutcome } from '../archive/stage.ts';
import { runFollowups, type FollowupOutcome } from '../followups/stage.ts';
import { publishReadModel } from '../readmodel/publish.ts';
import { readModelClient, readModelConfigured } from '../readmodel/cli.ts';
import { TokenProvider } from '../graph/auth.ts';
import { GraphDrive } from '../graph/drive.ts';
import { RequestGuard, SCOPES, type RootSpec } from '../graph/guard.ts';
import { setConfig } from '../core/config.ts';
import type { CoverageStatus } from '../discover/coverage.ts';
import { loadMigrations } from '../core/db/migrate.ts';
import { ping } from './healthcheck.ts';
import { MISSED_SLOTS_REPORT_THRESHOLD, slotsBetween } from './schedule.ts';

/** SPEC.md section 12: a deadline inside this window overrides quiet hours. */
export const URGENT_WINDOW_MS = 12 * 3600_000;
/** SPEC.md section 12: a context stale for longer than this pages me. */
export const STALE_AFTER_MS = 24 * 3600_000;
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

interface SyncContext {
  contextId: number;
  contextType: 'course' | 'group';
  canvasId: number;
  label: string;
  firstSeenAt: string;
  /** As stored before this run. */
  coverage: CoverageStatus;
}

interface Watermark {
  lastOkAt: string | null;
  baselinedAt: string | null;
  lastStatus: string | null;
}

export interface SyncOptions {
  /** Test seam: point the Telegram client at a local fake. */
  telegramApiBase?: string;
  /** Test seams: point Graph and the Microsoft login at a local fake. */
  graphBase?: string;
  loginBase?: string;
  /** Test seam: the read model's database client (otherwise from the environment). */
  readModel?: import('@libsql/client').Client;
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
  archive: ArchiveOutcome | null;
  followups: FollowupOutcome | null;
  /** The dashboard's read model this run: null when not configured. */
  readModel: 'published' | 'failed' | null;
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
    outcome = await syncBody(ctx, config, telegram, chats, options);
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

/** A run that archives this many files (usually a silent backlog, D-41) sends one summary. */
const BACKFILL_NOTICE_THRESHOLD = 10;

function buildDrive(ctx: RunContext, config: Config, options: SyncOptions): GraphDrive {
  const scope = config.get('graph_scope') === 'full' ? 'full' : 'appfolder';
  const root: RootSpec = scope === 'full' ? { mode: 'folder', name: config.require('onedrive_root_folder') } : { mode: 'appfolder' };
  const guard = new RequestGuard({
    root,
    ...(options.graphBase === undefined ? {} : { graphBase: options.graphBase }),
    ...(options.loginBase === undefined ? {} : { loginBase: options.loginBase }),
  });
  const tokens = new TokenProvider({
    clientId: config.require('graph_client_id'),
    scope: SCOPES[root.mode],
    guard,
    log: ctx.log,
    clock: ctx.clock,
    refreshToken: () => config.require('graph_refresh_token'),
    // Persisted before the new access token is used (D-49). Local copy updated
    // too, so a second exchange in the same run presents the newest token.
    saveRefreshToken: async (token) => {
      await setConfig(ctx.db, ctx.clock, 'graph_refresh_token', token);
      config.override('graph_refresh_token', token);
    },
    ...(options.loginBase === undefined ? {} : { loginBase: options.loginBase }),
  });
  return new GraphDrive({
    root,
    guard,
    tokens,
    log: ctx.log,
    clock: ctx.clock,
    ...(options.graphBase === undefined ? {} : { graphBase: options.graphBase }),
  });
}

/** A run with at least this many archive attempts, all failed, is one systemic problem. */
const CORRELATED_FAILURE_MIN = 2;

const DRIVE_BLOCKING: ReadonlySet<string> = new Set(['graph_auth', 'graph_app', 'provisioning', 'unreachable']);

/**
 * An unclassified failure to reach OneDrive (5xx, network, an unknown error
 * code) pages only once it has lasted STALE_AFTER_MS, like a stale course: one
 * bad run is noise, a day of them is an outage nobody else would notice.
 */
async function driveReachability(ctx: RunContext, config: Config, a: ArchiveOutcome, now: Date): Promise<AlertCondition[]> {
  const last = config.get('archive_drive_ok_at');
  if (a.stopped === null || !DRIVE_BLOCKING.has(a.stopped)) {
    await setConfig(ctx.db, ctx.clock, 'archive_drive_ok_at', now.toISOString());
    return [];
  }
  if (last === undefined || last === '') {
    // Never reached yet: start the clock at the first failure.
    await setConfig(ctx.db, ctx.clock, 'archive_drive_ok_at', now.toISOString());
    return [];
  }
  const age = now.getTime() - new Date(last).getTime();
  if (a.stopped !== 'unreachable' || age <= STALE_AFTER_MS) return [];
  return [{
    key: 'graph_unreachable',
    severity: 'warn',
    summary: `OneDrive has not been reachable for ${Math.floor(age / 3600_000)} hours. Files are not being archived.`,
    detail: a.stopDetail ?? '',
  }];
}

/** Operational alerts the archive stage can raise. The `storage@` family is a ladder. */
function archiveAlerts(a: ArchiveOutcome): AlertCondition[] {
  const out: AlertCondition[] = [];
  if (a.stopped === 'graph_auth') {
    out.push({
      key: 'graph_auth',
      severity: 'critical',
      summary: 'OneDrive access has expired or been revoked. Files are not being archived.',
      detail: 'Sign in again: npm run graph-login',
    });
  }
  if (a.stopped === 'graph_app') {
    out.push({
      key: 'graph_app',
      severity: 'critical',
      summary: 'The OneDrive app registration is missing, or its directory has been blocked for inactivity. Files are not being archived.',
      detail:
        `${a.stopDetail ?? ''}. Signing in again will not fix this (DECISIONS.md D-53). Check entra.microsoft.com: ` +
        'a directory blocked for inactivity (AADSTS5000225) can be reactivated through Microsoft support only within ' +
        '20 days; after that, register a new app (README, Going live, Phase 4) and run npm run graph-login.',
    });
  }
  if (a.stopped === 'provisioning') {
    out.push({
      key: 'graph_provisioning',
      severity: 'critical',
      summary: 'OneDrive refuses this app as read-only or "pending provisioning". Files are not being archived.',
      detail:
        'A known Microsoft regression since Aug 2026 for newly consented AppFolder-only apps (DECISIONS.md D-51). ' +
        'User-reported workaround: npm run graph-login -- --scope full once, remove the app at ' +
        'https://account.live.com/consent/Manage, then npm run graph-login again.',
    });
  }
  if (a.stopped === 'not_personal') {
    out.push({ key: 'onedrive_not_personal', severity: 'critical', summary: 'Signed in to a drive that is not a personal OneDrive. Archiving refused.', detail: a.stopDetail ?? '' });
  }
  if (a.stopped === 'quota_full') {
    out.push({ key: 'storage@full', severity: 'critical', summary: 'OneDrive is full: uploads are being refused (507).' });
  } else if (a.quota === 'unreadable') {
    out.push({
      key: 'storage@unreadable',
      severity: 'warn',
      summary: 'OneDrive quota is not readable with this scope, so the 80% storage alert is off.',
      detail: 'A full drive still alerts, from the upload itself. It was readable under Files.ReadWrite.AppFolder at sign-in (D-51), so this is a change.',
      remindEveryMs: null,
    });
  } else if (a.quota !== null && a.quota.total > 0) {
    const used = a.quota.used / a.quota.total;
    const pct = `${Math.round(used * 100)}% of ${humanSize(a.quota.total)}`;
    if (used >= 0.95) out.push({ key: 'storage@95', severity: 'critical', summary: `OneDrive is ${pct} full.` });
    else if (used >= 0.8) out.push({ key: 'storage@80', severity: 'warn', summary: `OneDrive is ${pct} full.`, remindEveryMs: null });
  }
  // Correlated failure: every attempt this run failed. One cause, not N, so it
  // pages now rather than after five attempts per file or a day of outage.
  if (a.failed >= CORRELATED_FAILURE_MIN && a.archived.length === 0 && a.adopted === 0) {
    const shape = Object.entries(tallyFailures(a.failures)).sort((x, y) => y[1] - x[1]);
    out.push({
      key: 'archive_all_failed',
      severity: 'critical',
      summary: `Every archive attempt this run failed (${a.failed} of ${a.failed}). Nothing was saved to OneDrive.`,
      detail: shape.slice(0, 3).map(([k, n]) => `${k} ×${n}`).join('; '),
    });
  }
  if (a.exhausted > 0) {
    out.push({
      key: 'archive_exhausted',
      severity: 'warn',
      summary: `${a.exhausted} file${a.exhausted === 1 ? '' : 's'} could not be archived after 5 attempts.`,
      detail: "See: SELECT display_name, last_error FROM files WHERE download_state = 'failed'",
    });
  }
  return out;
}

function empty(status: SyncOutcome['status']): SyncOutcome {
  return { status, contexts: 0, failedContexts: 0, baselined: 0, notified: 0, alerts: null, flush: null, planned: [], archive: null, followups: null, readModel: null };
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
  options: SyncOptions,
): Promise<SyncOutcome> {
  const now = ctx.clock.now();
  const outcome = empty('ok');
  const alerts: AlertCondition[] = [];
  const evaluatedPrefixes: string[] = ['token_expiry@', 'dashboard_token_expiry@', 'telegram_delivery'];

  const token = tokenExpiryCondition(tokenDaysRemaining(config, now));
  if (token !== null) alerts.push(token);

  // The dashboard's read-only token (D-66): once one is recorded, or once the
  // read model is configured (then "not recorded" is itself worth saying).
  const dashboardDays = daysRemaining(config, 'dashboard_read_token_expires_at', now);
  if (dashboardDays !== null || readModelConfigured()) {
    const dashboardToken = dashboardTokenExpiryCondition(dashboardDays);
    if (dashboardToken !== null) alerts.push(dashboardToken);
  }

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

  const courses = contexts.filter((c) => c.contextType === 'course');
  const announcements = await fetchAnnouncements(ctx, canvas, courses, now);
  const webBase = config.require('canvas_base_url').replace(/\/api\/v1\/?$/, '');
  const watching: WatchingPayload = { kind: 'watching', contexts: [] };
  const baselinedScope: string[] = [];
  const coverageNow = new Map<number, CoverageStatus>();

  for (const context of contexts) {
    try {
      const result = await syncContext(ctx, canvas, context, {
        announcements: context.contextType === 'course' ? (announcements.get(context.canvasId) ?? ok([])) : undefined,
        watermarks: watermarks.get(context.contextId) ?? new Map(),
        selfId: self.value.id,
        webBase,
        now,
      });
      coverageNow.set(context.contextId, result.coverage);
      if (result.coverageDetermined) {
        const alert = coverageAlert(context, result.coverage, result.linked);
        if (alert !== null) alerts.push(alert);
        evaluatedPrefixes.push(`coverage:${context.contextId}`);
      }
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

  // --- archive (Phase 4): after detection, BEFORE the flush, so a file
  // uploaded in this run already carries its OneDrive link when sent (D-52).
  if (config.getBoolean('archive_enabled', false)) {
    const drive = ctx.dryRun ? null : buildDrive(ctx, config, options);
    outcome.archive = await runArchive({ ctx, canvas, canvasToken: config.require('canvas_token'), drive, config });
    if (!ctx.dryRun) {
      alerts.push(...archiveAlerts(outcome.archive));
      alerts.push(...(await driveReachability(ctx, config, outcome.archive, now)));
      evaluatedPrefixes.push('graph_auth', 'graph_app', 'graph_unreachable', 'graph_provisioning', 'onedrive_not_personal', 'archive_exhausted');
      // Judged only when this run actually tried something; a quiet run leaves it standing.
      const a = outcome.archive;
      if (a.archived.length + a.adopted + a.failed > 0) evaluatedPrefixes.push('archive_all_failed');
      // Storage is judged only when this run actually reached the drive.
      if (outcome.archive.quota !== null || outcome.archive.stopped === 'quota_full') evaluatedPrefixes.push('storage@');
    }
    const archived = outcome.archive.archived;
    if (archived.length >= BACKFILL_NOTICE_THRESHOLD) {
      const bytes = archived.reduce((n, a) => n + a.bytes, 0);
      await enqueueNotice(ctx.db, {
        sendKey: `archive ${ctx.runId}`,
        payload: {
          kind: 'notice',
          title: 'Saved to OneDrive',
          lines: [
            `${archived.length} files (${humanSize(bytes)}) archived this run.`,
            outcome.archive.stopped === 'budget' ? 'More are queued and will follow over the next runs.' : 'The archive is up to date.',
          ],
        },
        now,
      });
    }
  }

  // --- follow-ups (Phase 6): after the archive, BEFORE the flush, so a close
  // shows on the answer file's own notification in this run (D-61).
  if (config.getBoolean('followups_enabled', false)) {
    outcome.followups = await runFollowups(ctx, { config, canvas, now });
  }

  alerts.push(...(await staleContextAlerts(ctx, contexts, coverageNow, now)));
  evaluatedPrefixes.push('context_stale:');

  await reportScheduleGap(ctx, now);
  // No schedule condition is ever raised now; evaluating the prefix lets any
  // row left active by the old raise/resolve alert close itself.
  evaluatedPrefixes.push('schedule_health');

  // --- the dashboard's read model (Phase 8): published to a SEPARATE database
  // with its own write token, from environment only (D-65). Absent: skipped.
  if (!ctx.dryRun && (options.readModel !== undefined || readModelConfigured())) {
    try {
      const target = options.readModel ?? readModelClient('write');
      const published = await publishReadModel(ctx.db, target, now);
      outcome.readModel = 'published';
      ctx.log.info('readmodel.published', published);
    } catch (error) {
      outcome.readModel = 'failed';
      // The error's class only: a message can quote a URL.
      ctx.log.warn('readmodel.publish_failed', { error: error instanceof Error ? error.name : 'unknown' });
      alerts.push({ key: 'dashboard_publish', severity: 'warn', summary: 'The dashboard\'s read model could not be updated this run; the dashboard shows the last good copy.' });
    }
    evaluatedPrefixes.push('dashboard_publish');
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

async function loadContexts(ctx: RunContext): Promise<SyncContext[]> {
  const rows = await ctx.db.read(
    `SELECT x.context_id, x.context_type, x.canvas_id, x.first_seen_at, x.coverage_status,
            COALESCE(c.module_code, g.module_code) AS module_code
       FROM contexts x
       LEFT JOIN courses c ON c.context_id = x.context_id
       LEFT JOIN groups g ON g.context_id = x.context_id
      WHERE x.enabled = 1
      ORDER BY x.context_type, x.context_id`,
  );
  return rows.rows.map((r) => {
    const contextType = String(r['context_type']) === 'group' ? 'group' : 'course';
    // Never null for an enabled context: the seed loader rejects that (D-37).
    const code = r['module_code'] === null ? `${contextType} ${String(r['canvas_id'])}` : String(r['module_code']);
    return {
      contextId: Number(r['context_id']),
      contextType,
      canvasId: Number(r['canvas_id']),
      label: contextType === 'group' ? `${code} · group` : code,
      firstSeenAt: String(r['first_seen_at']),
      coverage: String(r['coverage_status']) as CoverageStatus,
    };
  });
}

interface FileFetch {
  fetch: ResourceFetch;
  /** null: not determined this run (a transient error), so keep what is stored. */
  coverage: CoverageStatus | null;
  /** Files found through Modules, when that is the path in use. */
  linked: number | null;
}

/**
 * Files, by whichever path the course allows (SPEC.md section 4). Coverage
 * changes only on a DEFINITIVE answer -- a readable or denied listing -- and
 * never on a transient error, or one Canvas hiccup would page me twice.
 */
async function fetchFiles(canvas: CanvasClient, context: SyncContext, webBase: string): Promise<FileFetch> {
  const kind = context.contextType === 'group' ? 'groups' : 'courses';
  const files = await canvas.listFiles(kind, context.canvasId);

  if (files.kind === 'ok') {
    const folders = await canvas.listFolders(kind, context.canvasId);
    const names = new Map<number, string | null>(
      folders.kind === 'ok' ? folders.value.map((f) => [f.id, f.full_name ?? null]) : [],
    );
    // A folder listing failure costs the folder label, never the file.
    const records = files.value.map((f) =>
      normaliseFile(
        f,
        f.folder_id === null || f.folder_id === undefined ? null : (names.get(f.folder_id) ?? null),
        `${webBase}/${kind}/${context.canvasId}/files/${f.id}`,
      ),
    );
    return {
      fetch: { status: 'ok', records, detail: folders.kind === 'ok' ? null : `folders: ${describe(folders)}` },
      coverage: 'full',
      linked: null,
    };
  }
  if (files.kind === 'error') {
    return { fetch: { status: 'error', records: [], detail: describe(files) }, coverage: null, linked: null };
  }
  if (context.contextType === 'group') {
    return { fetch: { status: 'denied_or_absent', records: [], detail: describe(files) }, coverage: 'none', linked: null };
  }

  const modules = await canvas.listModules(context.canvasId);
  if (modules.kind === 'ok') {
    const found = modules.value.flatMap((m) =>
      (m.items ?? [])
        .map((i) => normaliseModuleFile(i, m.name ?? null))
        .filter((r): r is ItemRecord => r !== null),
    );
    // A file linked from two modules is one file: content_id is its id (D-23).
    const unique = [...new Map(found.map((r) => [r.externalId, r])).values()];
    return {
      fetch: { status: 'ok', records: unique, detail: 'read through Modules; the Files tab is not readable' },
      coverage: 'modules_only',
      linked: unique.length,
    };
  }
  if (modules.kind === 'error') {
    return { fetch: { status: 'error', records: [], detail: describe(modules) }, coverage: null, linked: null };
  }
  return {
    fetch: { status: 'denied_or_absent', records: [], detail: `${describe(files)}; ${describe(modules)}` },
    coverage: 'none',
    linked: null,
  };
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
  contexts: SyncContext[],
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

interface ContextResult {
  failed: boolean;
  notified: number;
  baselined: Map<ResourceType, number>;
  payload: ContentPayload | null;
  /** Coverage after this run; equal to the stored value when undetermined. */
  coverage: CoverageStatus;
  coverageDetermined: boolean;
  linked: number | null;
}

async function syncContext(
  ctx: RunContext,
  canvas: CanvasClient,
  context: SyncContext,
  input: {
    announcements: Result<CanvasAnnouncement[]> | undefined;
    watermarks: Map<ResourceType, Watermark>;
    selfId: number;
    webBase: string;
    now: Date;
  },
): Promise<ContextResult> {
  const { now } = input;
  const log = ctx.log.child({ context_id: context.contextId });
  const applicable = RESOURCES_FOR[context.contextType];
  const fetches: Partial<Record<ResourceType, ResourceFetch>> = {};

  // --- fetch, outside any transaction (SPEC.md section 7) ------------------
  const files = await fetchFiles(canvas, context, input.webBase);
  fetches.file = files.fetch;
  if (files.fetch.status === 'ok' && files.fetch.detail !== null) {
    log.warn('sync.files_partial', { detail: files.fetch.detail });
  }

  if (context.contextType === 'course') {
    const assignments = await canvas.listAssignments(context.canvasId);
    const submissions = await canvas.listSubmissions(context.canvasId);
    const assignmentById = new Map<number, CanvasAssignment>(
      assignments.kind === 'ok' ? assignments.value.map((a) => [a.id, a]) : [],
    );
    const announcements = input.announcements ?? ok([]);

    // D-38: /announcements answers 200 [] for a course the token cannot read.
    // An empty list is "none posted" only if another endpoint proves the course
    // is readable in this same run; otherwise it is unverified.
    const readable = assignments.kind === 'ok' || submissions.kind === 'ok' || files.fetch.status === 'ok';
    fetches.announcement =
      announcements.kind !== 'ok'
        ? { status: statusOf(announcements), records: [], detail: describe(announcements) }
        : announcements.value.length === 0 && !readable
          ? { status: 'unverified', records: [], detail: 'empty list, and no other endpoint confirmed readability (D-38)' }
          : {
              status: 'ok',
              records: announcements.value
                .map((a) => normaliseAnnouncement(a, now))
                .filter((r): r is ItemRecord => r !== null),
              detail: null,
            };
    fetches.assignment =
      assignments.kind === 'ok'
        ? { status: 'ok', records: assignments.value.map(normaliseAssignment), detail: null }
        : { status: statusOf(assignments), records: [], detail: describe(assignments) };
    fetches.grade =
      submissions.kind === 'ok'
        ? { status: 'ok', records: submissions.value.map((s) => normaliseGrade(s, assignmentById.get(s.assignment_id))), detail: null }
        : { status: statusOf(submissions), records: [], detail: describe(submissions) };
    fetches.comment =
      submissions.kind === 'ok'
        ? {
            status: 'ok',
            records: submissions.value.flatMap((s) => normaliseComments(s, assignmentById.get(s.assignment_id), input.selfId)),
            detail: null,
          }
        : { status: statusOf(submissions), records: [], detail: describe(submissions) };
  }

  const coverage = files.coverage ?? context.coverage;
  // Newly readable through /files after Modules-only or nothing: files that
  // were there all along become visible at once. They are baselined, not
  // announced one by one, and the "now watching" summary says so (D-47).
  const upgraded = files.coverage === 'full' && (context.coverage === 'modules_only' || context.coverage === 'none');

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
  for (const type of applicable) {
    const fetch = fetches[type];
    if (fetch === undefined) continue;
    if (fetch.status !== 'ok') {
      log.warn('sync.resource_skipped', { resource: type, status: fetch.status, detail: fetch.detail });
      continue;
    }
    const baseline = input.watermarks.get(type)?.baselinedAt == null || (type === 'file' && upgraded);
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
    toNotify.length === 0
      ? null
      : {
          kind: 'content',
          contextLabel: context.label,
          items: toNotify.map((c) => renderItemOf(c, context.contextId)),
          ...(coverage === 'modules_only'
            ? { note: 'Read through Modules: the Files tab is hidden, so files not linked in a module are missed.' }
            : {}),
        };
  const urgent = toNotify.some(
    (c) =>
      c.record.resourceType === 'assignment' &&
      c.record.dueAt !== null &&
      new Date(c.record.dueAt).getTime() > now.getTime() &&
      new Date(c.record.dueAt).getTime() - now.getTime() <= URGENT_WINDOW_MS,
  );

  // --- commit: items, watermarks, coverage and the queued notification -------
  await ctx.db.transaction(`sync context ${context.contextId}`, async (tx) => {
    for (const c of decided) await upsertItem(tx, context.contextId, c, now, baselined.has(c.record.resourceType));
    for (const type of applicable) {
      const fetch = fetches[type];
      if (fetch !== undefined) await upsertWatermark(tx, context.contextId, type, fetch, now, baselined.has(type));
    }
    if (files.coverage !== null) {
      await tx.write.execute('record coverage', {
        sql: 'UPDATE contexts SET coverage_status = ?, coverage_checked_at = ? WHERE context_id = ?',
        args: [files.coverage, now.toISOString(), context.contextId],
      });
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

  if (files.coverage !== null && files.coverage !== context.coverage && context.coverage !== 'unknown') {
    log.warn('sync.coverage_changed', { from: context.coverage, to: files.coverage });
  }

  const failed = applicable.some((t) => fetches[t]?.status !== 'ok');
  log.info('sync.context_done', {
    new: decided.filter((c) => c.kind === 'new').length,
    revised: decided.filter((c) => c.kind === 'revised').length,
    notify: toNotify.length,
    urgent,
    baselined: [...baselined.values()].reduce((a, b) => a + b, 0),
    coverage,
    failed,
  });
  return {
    failed,
    notified: toNotify.length,
    baselined,
    payload,
    coverage,
    coverageDetermined: files.coverage !== null,
    linked: files.linked,
  };
}

function renderItemOf(c: Classified, contextId: number): RenderItem {
  const r = c.record;
  const facts = r.meta['facts'] as { score?: number | null; grade?: string | null; excused?: boolean } | undefined;
  return {
    itemId: itemId(contextId, r.resourceType, r.externalId),
    resourceType: r.resourceType,
    kind: c.kind === 'new' ? 'new' : 'revised',
    title: r.title,
    url: r.canvasUrl,
    change: c.change,
    postedAt: r.postedAt,
    dueAt: r.dueAt,
    ...(Array.isArray(r.meta['other_due_dates']) ? { otherDueDates: r.meta['other_due_dates'] as string[] } : {}),
    ...(typeof r.meta['preview'] === 'string' ? { preview: r.meta['preview'] } : {}),
    ...(r.resourceType === 'file'
      ? {
          file: {
            folder: (r.meta['folder'] as string | null | undefined) ?? null,
            size: ((r.meta['facts'] as { size?: number | null } | undefined)?.size) ?? null,
            module: (r.meta['module'] as string | null | undefined) ?? null,
            unlockAt: (r.meta['unlock_at'] as string | null | undefined) ?? null,
          },
        }
      : {}),
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

async function staleContextAlerts(
  ctx: RunContext,
  contexts: SyncContext[],
  coverage: Map<number, CoverageStatus>,
  now: Date,
): Promise<AlertCondition[]> {
  const fresh = await loadWatermarks(ctx, contexts.map((c) => c.contextId));
  const out: AlertCondition[] = [];
  for (const c of contexts) {
    const marks = fresh.get(c.contextId) ?? new Map<ResourceType, Watermark>();
    // The stalest resource decides. A resource that has never succeeded counts
    // from when the context was first seen. Files are left out when coverage
    // is 'none': the coverage alert already says so, in plainer words.
    const types = RESOURCES_FOR[c.contextType].filter((t) => !(t === 'file' && coverage.get(c.contextId) === 'none'));
    let oldest = Number.POSITIVE_INFINITY;
    const failing: string[] = [];
    for (const type of types) {
      const mark = marks.get(type);
      const t = new Date(mark?.lastOkAt ?? c.firstSeenAt).getTime();
      if (t < oldest) oldest = t;
      if (mark?.lastStatus !== undefined && mark.lastStatus !== null && mark.lastStatus !== 'ok') {
        failing.push(`${type}: ${mark.lastStatus}`);
      }
    }
    const age = now.getTime() - oldest;
    if (types.length > 0 && age > STALE_AFTER_MS) {
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

/**
 * Reduced file coverage, raised once and resolved when it recovers (the
 * observation-week ask: a switch to Modules-only must degrade visibly). Never
 * reminded: a course can legitimately stay Modules-only all semester, and every
 * one of its messages already carries a note saying so.
 */
function coverageAlert(context: SyncContext, coverage: CoverageStatus, linked: number | null): AlertCondition | null {
  if (coverage === 'modules_only') {
    return {
      key: `coverage:${context.contextId}`,
      severity: 'warn',
      summary: `${context.label}: file coverage reduced to Modules only (${linked ?? 0} file${linked === 1 ? '' : 's'} linked there).`,
      detail: 'Its Files tab is no longer readable. Files not linked from a module will not be detected.',
      remindEveryMs: null,
    };
  }
  if (coverage === 'none') {
    return {
      key: `coverage:${context.contextId}`,
      severity: 'warn',
      summary: `${context.label}: files are not readable at all.`,
      detail:
        'Neither the Files tab nor Modules can be read, so no new file here will be detected. ' +
        'If the course has concluded, anything not already archived is now unrecoverable (D-36).',
      remindEveryMs: null,
    };
  }
  return null;
}

/**
 * A one-shot report when scheduled runs stopped and have now resumed
 * (DECISIONS.md D-46).
 *
 * This used to be a raise/resolve alert, which turned the real 24-hour outage
 * of 2026-09-13 into "running late" followed ten minutes later by "Resolved" --
 * a day-long gap that read as a blip. A gap is only observable once runs
 * resume, so it is reported as the event it is: how long, how many runs never
 * happened, and that this run has already caught up.
 *
 * Counted in slots from the stored `scheduled_for` of the previous run, not in
 * wall time, so a 20-minute daytime cadence and an hourly overnight one are
 * both judged correctly.
 */
async function reportScheduleGap(ctx: RunContext, now: Date): Promise<void> {
  const thisSlot = ctx.scheduledFor;
  if (thisSlot === undefined) return;
  const previous = await ctx.db.read({
    sql: `SELECT scheduled_for FROM runs
           WHERE command = 'sync' AND dry_run = 0 AND scheduled_for IS NOT NULL AND run_id != ?
             AND scheduled_for < ?
           ORDER BY scheduled_for DESC LIMIT 1`,
    args: [ctx.runId, thisSlot.toISOString()],
  });
  const prevRaw = previous.rows[0]?.['scheduled_for'];
  if (prevRaw === undefined || prevRaw === null) return;
  const prevSlot = new Date(String(prevRaw));
  const missed = slotsBetween(prevSlot, thisSlot);
  if (missed < MISSED_SLOTS_REPORT_THRESHOLD) return;

  const hours = (thisSlot.getTime() - prevSlot.getTime()) / 3600_000;
  await enqueueOps(ctx.db, {
    // Keyed on the gap itself, so a retried run cannot report it twice.
    sendKey: `schedule_gap ${prevSlot.toISOString()}..${thisSlot.toISOString()}`,
    payload: {
      kind: 'ops',
      severity: 'warn',
      summary: `Scheduled syncs stopped for ${hours.toFixed(1)} h and have now resumed.`,
      detail:
        `${missed} scheduled run${missed === 1 ? '' : 's'} never happened; the last one before the gap ` +
        `was for ${formatSgt(prevSlot.toISOString())}. This run re-read every course, so anything posted ` +
        'in that window has now been checked. If this repeats, look in GitHub Actions for sync runs ' +
        'that were queued for hours or cancelled.',
    },
    now,
  });
  ctx.log.warn('sync.schedule_gap', { missed_slots: missed, gap_hours: Number(hours.toFixed(2)) });
}
