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
}

export interface StartRunOptions {
  command: string;
  dryRun: boolean;
  unsafeLog?: boolean;
  clock?: Clock;
  bootstrap?: Bootstrap;
  /** Skip the `runs` row. Used by `migrate`, which may run before the table exists. */
  recordRun?: boolean;
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
  }).child({ command: options.command, dry_run: options.dryRun });

  const client = openClient(bootstrap);
  await enableForeignKeys(client);
  const db = createDb(client, log, options.dryRun);

  const ctx: RunContext = {
    runId,
    command: options.command,
    dryRun: options.dryRun,
    unsafeLog,
    ci: bootstrap.ci,
    startedAt,
    clock,
    log,
    db,
    bootstrap,
  };

  const drift =
    bootstrap.scheduledFor === undefined ? null : differenceSeconds(startedAt, bootstrap.scheduledFor);

  if (options.recordRun !== false) {
    await db.write.execute('open run', {
      sql: `INSERT INTO runs (run_id, command, dry_run, scheduled_for, started_at, drift_seconds, status, host)
            VALUES (?, ?, ?, ?, ?, ?, 'running', ?)`,
      args: [
        runId,
        options.command,
        options.dryRun ? 1 : 0,
        bootstrap.scheduledFor?.toISOString() ?? null,
        startedAt.toISOString(),
        drift,
        bootstrap.host,
      ],
    });
  }

  log.info('run.start', {
    scheduled_for: bootstrap.scheduledFor?.toISOString() ?? null,
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
