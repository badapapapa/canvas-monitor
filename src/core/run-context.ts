/**
 * Everything a command needs, assembled once and threaded down.
 *
 * Also the place where scheduler drift is recorded (SPEC.md section 11 /
 * DECISIONS.md D-10). GitHub Actions queues cron runs on a best-effort basis;
 * the Phase 2 review of whether Actions is good enough needs a distribution of
 * `started_at - scheduled_for`, and that data only exists if it is collected
 * from the first run onward.
 */

import { randomUUID } from 'node:crypto';
import { openClient, enableForeignKeys } from './db/client.ts';
import { createDb, type Db } from './db/writer.ts';
import { createLogger, type Logger } from './log.ts';
import { readBootstrap, type Bootstrap } from './env.ts';
import { systemClock, type Clock } from './clock.ts';
import { differenceSeconds } from './time.ts';
import { latestSlotAtOrBefore } from './cron.ts';
import { messageOf, isAppError } from './errors.ts';

export type RunStatus = 'ok' | 'partial' | 'failed';

export interface RunContext {
  readonly runId: string;
  readonly command: string;
  readonly dryRun: boolean;
  /** Redaction is lifted. Local debugging only; refused under CI. */
  readonly unsafeLog: boolean;
  /** Running under CI, so identifying output is suppressed. */
  readonly ci: boolean;
  readonly startedAt: Date;
  readonly clock: Clock;
  readonly log: Logger;
  readonly db: Db;
  readonly bootstrap: Bootstrap;
  /** The slot this run was scheduled for, when it was scheduled at all. */
  readonly scheduledFor: Date | undefined;
}

export interface StartRunOptions {
  command: string;
  dryRun: boolean;
  unsafeLog?: boolean;
  clock?: Clock;
  bootstrap?: Bootstrap;
  /** Skip the `runs` row. Used by `migrate`, which may run before the table exists. */
  recordRun?: boolean;
  /**
   * Open the database through the dry-run writer, so this command CANNOT write
   * to it, while still being a real run of its own work (the mirror, D-58).
   * `dry_run` in the log keeps meaning --dry-run; this is logged separately as
   * `db_access: "read-only"`, because the two are different claims (D-59).
   */
  readOnlyDb?: boolean;
  /** Where log lines go. Defaults to stderr; injected by tests. */
  sink?: (line: string) => void;
}

export async function startRun(options: StartRunOptions): Promise<RunContext> {
  const clock = options.clock ?? systemClock;
  const bootstrap = options.bootstrap ?? readBootstrap();
  const runId = randomUUID();
  const startedAt = clock.now();

  const unsafeLog = options.unsafeLog === true;
  const log = createLogger({
    runId,
    level: bootstrap.logLevel,
    clock,
    unsafe: unsafeLog,
    ...(options.sink === undefined ? {} : { sink: options.sink }),
  }).child({
    command: options.command,
    dry_run: options.dryRun,
    ...(options.readOnlyDb === true ? { db_access: 'read-only' } : {}),
  });

  // An explicit RUN_SCHEDULED_FOR wins; otherwise reconstruct the slot from the
  // cron expression that fired. A lower bound once drift exceeds the cadence.
  let scheduledFor = bootstrap.scheduledFor;
  if (scheduledFor === undefined && bootstrap.cronSchedule !== undefined) {
    try {
      scheduledFor = latestSlotAtOrBefore(bootstrap.cronSchedule, startedAt) ?? undefined;
    } catch {
      scheduledFor = undefined; // a malformed expression must not stop a sync
    }
  }
  const drift = scheduledFor === undefined ? null : differenceSeconds(startedAt, scheduledFor);

  const client = openClient(bootstrap);
  await enableForeignKeys(client);
  const db = createDb(client, log, options.dryRun || options.readOnlyDb === true);

  const ctx: RunContext = {
    runId,
    command: options.command,
    dryRun: options.dryRun,
    unsafeLog,
    ci: bootstrap.ci,
    scheduledFor,
    startedAt,
    clock,
    log,
    db,
    bootstrap,
  };


  if (options.recordRun !== false) {
    await db.write.execute('open run', {
      sql: `INSERT INTO runs (run_id, command, dry_run, scheduled_for, started_at, drift_seconds, status, host)
            VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      args: [
        runId,
        options.command,
        options.dryRun ? 1 : 0,
        scheduledFor?.toISOString() ?? null,
        startedAt.toISOString(),
        drift,
        bootstrap.host,
      ],
    });
  }

  log.info('run.start', {
    scheduled_for: scheduledFor?.toISOString() ?? null,
    drift_seconds: drift,
    host: bootstrap.host,
  });

  if (drift !== null && drift > 300) {
    // Not fatal, but it is the number that decides whether GitHub Actions
    // stays the scheduler. Surface it rather than burying it in a table.
    log.warn('run.schedule_drift', { drift_seconds: drift });
  }

  return ctx;
}

export async function finishRun(
  ctx: RunContext,
  status: RunStatus,
  error?: unknown,
  opts: { recordRun?: boolean } = {},
): Promise<void> {
  const finishedAt = ctx.clock.now();
  const errorCode = error === undefined ? null : isAppError(error) ? error.code : 'unhandled';
  const errorMessage = error === undefined ? null : messageOf(error);

  if (opts.recordRun !== false) {
    await ctx.db.write
      .execute('close run', {
        sql: `UPDATE runs SET finished_at = ?, status = ?, error_code = ?, error_message = ? WHERE run_id = ?`,
        args: [finishedAt.toISOString(), status, errorCode, errorMessage, ctx.runId],
      })
      .catch((writeError: unknown) => {
        ctx.log.error('run.close_failed', { reason: messageOf(writeError) });
      });
  }

  ctx.log.info('run.finish', {
    status,
    duration_ms: finishedAt.getTime() - ctx.startedAt.getTime(),
    ...(errorCode === null ? {} : { error_code: errorCode, error_message: errorMessage }),
  });

  ctx.db.close();
}
