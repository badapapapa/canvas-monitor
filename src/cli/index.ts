#!/usr/bin/env node
/**
 * Thin CLI wrapper (SPEC.md section 3).
 *
 * The poller is a library; this file only parses arguments, assembles a run
 * context, and maps outcomes to exit codes. Anything resembling logic that
 * belongs in `src/core` or `src/canvas` does not belong here.
 *
 * Exit codes:
 *   0  success
 *   1  operational failure (Canvas error, database error, unexpected throw)
 *   2  configuration or usage problem -- something I need to fix by hand
 */

import { parseArgs } from 'node:util';
import { openClient, enableForeignKeys } from '../core/db/client.ts';
import { migrate } from '../core/db/migrate.ts';
import { readBootstrap } from '../core/env.ts';
import { createLogger } from '../core/log.ts';
import { systemClock } from '../core/clock.ts';
import { AppError, isAppError, messageOf } from '../core/errors.ts';
import { finishRun, startRun, type RunContext, type RunStatus } from '../core/run-context.ts';
import { Config } from '../core/config.ts';
import { pruneRawCaptures } from '../canvas/raw-store.ts';
import { runProbe } from './probe.ts';
import { runDiscoverCommand } from './discover.ts';
import { runSeedCourses } from './seed-courses.ts';
import { runSyncCommand } from './sync.ts';
import { runTelegramTest } from './telegram-test.ts';
import { runGraphLogin } from './graph-login.ts';
import { runReroute, runRules } from './reroute.ts';
import { runMirrorCli } from './mirror.ts';
import { runFollowupsCli, runTunePatterns } from './followups.ts';
import { runTimetableCli } from './timetable.ts';
import { runReadModelCli } from '../readmodel/cli.ts';
import { runBackfillCourse } from './backfill-course.ts';
import { runConfigList, runSetConfig } from './set-config.ts';

const USAGE = `
canvas-monitor

Usage: node src/cli/index.ts <command> [options]

Commands:
  migrate                  Apply pending schema migrations.
  probe                    Validate the Canvas token and list active courses.
  discover                 Probe coverage and write courses.seed.json for review.
  seed-courses [path]      Load the reviewed seed file into contexts and courses.
  sync                     One polling run: ingest, alert, deliver. --dry-run previews messages.
  telegram-test            Send a test message to both Telegram chats.
  graph-login              Connect OneDrive (device code sign-in, personal accounts only).
  backfill-course <id>     Archive one course's files once, without polling it (D-36).
  rules [list|add|remove]  Per-module routing rules, stored in the database (D-57).
                           add --module <code> --field folder|module|filename|extension
                               --pattern <regex|ext,list> --target <folder> [--priority N]
  mirror [--baseline]      Local only: copy NEW archive files into my own folders (D-58).
  tune-patterns            Read-only: rank the words that mark answer files, with their pairs (D-61).
  followups [preview]      Read-only: what follow-ups would open, close and ignore (D-61).
  followups list [--all]   Open follow-ups (--all: every state).
  followups dismiss <id>   Close one by hand ("answers were only given in class").
  followups phrases [add]  Module-specific answer phrases: add --module <code> --phrase "<words>".
  followups module off|on --module <code>   Answer tracking for a whole module (D-62).
  followups preview [--draft <file>] [--reminder-date YYYY-MM-DD]
  timetable [list]         My lessons, for lesson-day reminders (D-62). Personal: database only.
  timetable add --module <code> --weekday thu --time 09:00 --from YYYY-MM-DD --to YYYY-MM-DD [--label lab]
  timetable skip (--module <code> | --all) --date YYYY-MM-DD [--note "..."]
  timetable remove <id> | unskip <id> | import <draft.json>
  readmodel migrate|verify|publish   The dashboard's separate read-model database (D-65).
  reroute --preview        Show where each _unsorted file would move. Moves nothing.
  reroute --apply <fp>     Move exactly the previewed plan, once per file (D-40, D-57).
  set-config <key>         Set a config value, read from stdin (never argv).
  config-list              Show config keys and whether they are set.
  prune-raw                Delete raw captures past their retention window.

Global options:
  --dry-run                Perform all reads, log every intended write, mutate nothing.
  --json                   Machine-readable output on stdout (probe only).
  --from-env               set-config only: read the value from its env var.
  --out <path>             discover only: write the seed file here instead.
  --overwrite              discover only: replace an existing seed file. Without
                           this, discover refuses rather than clobber your edits.
  --unsafe-log             Lift log redaction. LOCAL DEBUGGING ONLY -- refused
                           under CI. Course names, file names and bodies will
                           be written to your terminal in the clear.
  -h, --help               This message.

Reserved (Phase 5):
  --replay                 Re-run classification against stored raw captures.
`;

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        'dry-run': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        'from-env': { type: 'boolean', default: false },
        scope: { type: 'string' },
        out: { type: 'string' },
        overwrite: { type: 'boolean', default: false },
        'unsafe-log': { type: 'boolean', default: false },
        replay: { type: 'boolean', default: false },
        preview: { type: 'boolean', default: false },
        apply: { type: 'string' },
        module: { type: 'string' },
        field: { type: 'string' },
        pattern: { type: 'string' },
        target: { type: 'string' },
        priority: { type: 'string' },
        baseline: { type: 'boolean', default: false },
        config: { type: 'string' },
        phrase: { type: 'string' },
        draft: { type: 'string' },
        'reminder-date': { type: 'string' },
        weekday: { type: 'string' },
        time: { type: 'string' },
        from: { type: 'string' },
        to: { type: 'string' },
        label: { type: 'string' },
        date: { type: 'string' },
        note: { type: 'string' },
        all: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${messageOf(error)}\n${USAGE}`);
    return 2;
  }

  const { values, positionals } = parsed;
  const command = positionals[0];

  if (values.help === true || command === undefined) {
    process.stdout.write(USAGE);
    return command === undefined && values.help !== true ? 2 : 0;
  }

  if (values.replay === true) {
    process.stderr.write(
      '\n--replay is reserved for Phase 5. Raw responses are already being captured to var/raw\n' +
        'so that replay has history to work with when it is built (SPEC.md section 15).\n\n',
    );
    return 2;
  }

  const dryRun = values['dry-run'] === true;
  loadDotEnv();

  // Refuse --unsafe-log under CI. This repository is public and its Actions
  // logs are public with it (DECISIONS.md D-10, D-26). The check lives here,
  // after loadDotEnv, so a committed .env cannot smuggle CI=false past it.
  const unsafeLog = values['unsafe-log'] === true;
  if (unsafeLog && isCi()) {
    process.stderr.write(
      '\n--unsafe-log is refused under CI.\n' +
        'This repository is public, so Actions logs are public. Unredacted output\n' +
        'would publish course names, file names and announcement bodies.\n' +
        'Run it on your own machine if you need to debug.\n\n',
    );
    return 2;
  }

  switch (command) {
    case 'migrate':
      return await withoutRunRecord('migrate', dryRun);
    case 'mirror':
      return await runMirrorCli({ dryRun, baseline: values.baseline === true, config: values.config });
    case 'readmodel':
      // The main database is opened read-only: every write here goes to the
      // SEPARATE read-model database, through its own token (D-65).
      return await withReadOnlyRun('readmodel', unsafeLog, (ctx) => runReadModelCli(ctx, positionals[1]));
    case 'tune-patterns':
      return await withReadOnlyRun('tune-patterns', unsafeLog, (ctx) => runTunePatterns(ctx));
    case 'followups':
      return positionals[1] === 'preview' || positionals[1] === undefined
        ? await withReadOnlyRun('followups-preview', unsafeLog, (ctx) => runFollowupsCli(ctx, {
            action: 'preview', rest: [],
            ...(values.draft === undefined ? {} : { draft: values.draft }),
            ...(values['reminder-date'] === undefined ? {} : { reminderDate: values['reminder-date'] }),
          }))
        : await withRun('followups', dryRun, unsafeLog, async (ctx) =>
            runFollowupsCli(ctx, { action: positionals[1], rest: [...positionals.slice(2), ...(values.all === true ? ['--all'] : [])], ...(values.module === undefined ? {} : { module: values.module }), ...(values.phrase === undefined ? {} : { phrase: values.phrase }) }));
    case 'timetable':
      return await withRun('timetable', dryRun, unsafeLog, async (ctx) => runTimetableCli(ctx, {
        action: positionals[1], rest: positionals.slice(2), all: values.all === true,
        ...Object.fromEntries((['module', 'weekday', 'time', 'from', 'to', 'label', 'date', 'note'] as const)
          .filter((k) => values[k] !== undefined).map((k) => [k, values[k] as string])),
      }));
    case 'rules':
      return await withRun('rules', dryRun, unsafeLog, async (ctx) =>
        runRules(ctx, { action: positionals[1], rest: positionals.slice(2), opts: { module: values.module, field: values.field, pattern: values.pattern, target: values.target, priority: values.priority } }));
    case 'reroute':
      return await withRun('reroute', dryRun, unsafeLog, async (ctx) => runReroute(ctx, { preview: values.preview === true, apply: values.apply }));
    case 'probe':
      return await withRun('probe', dryRun, unsafeLog, async (ctx) => {
        const outcome = await runProbe(ctx, { json: values.json === true });
        return outcome.ok ? 0 : 1;
      });
    case 'discover':
      return await withRun('discover', dryRun, unsafeLog, async (ctx) =>
        runDiscoverCommand(ctx, {
          json: values.json === true,
          out: values.out,
          overwrite: values.overwrite === true,
        }),
      );
    case 'sync':
      return await withRun('sync', dryRun, unsafeLog, async (ctx) =>
        runSyncCommand(ctx, { json: values.json === true }),
      );
    case 'telegram-test':
      return await withRun('telegram-test', dryRun, unsafeLog, async (ctx) => runTelegramTest(ctx));
    case 'graph-login':
      return await withRun('graph-login', dryRun, unsafeLog, async (ctx) => runGraphLogin(ctx, { scope: values.scope }));
    case 'backfill-course':
      return await withRun('backfill-course', dryRun, unsafeLog, async (ctx) => runBackfillCourse(ctx, { courseId: positionals[1] }));
    case 'seed-courses':
      return await withRun('seed-courses', dryRun, unsafeLog, async (ctx) => {
        await runSeedCourses(ctx, { path: positionals[1] });
        return 0;
      });
    case 'set-config':
      return await withRun('set-config', dryRun, unsafeLog, async (ctx) => {
        await runSetConfig(ctx, { key: positionals[1], fromEnv: values['from-env'] === true });
        return 0;
      });
    case 'config-list':
      return await withRun('config-list', dryRun, unsafeLog, async (ctx) => {
        await runConfigList(ctx);
        return 0;
      });
    case 'prune-raw':
      return await withRun('prune-raw', dryRun, unsafeLog, async (ctx) => {
        const config = await Config.load(ctx.db);
        const outcome = await pruneRawCaptures({
          retentionDays: config.getNumber('raw_capture_retention_days', 60),
          now: ctx.clock.now(),
          log: ctx.log,
          dryRun: ctx.dryRun,
        });
        process.stdout.write(
          `\nCutoff ${outcome.cutoff}: ${outcome.deletedDays.length} day(s) ` +
            `${ctx.dryRun ? 'would be ' : ''}removed, ${outcome.keptDays.length} kept.\n\n`,
        );
        return 0;
      });
    default:
      process.stderr.write(`Unknown command: ${command}\n${USAGE}`);
      return 2;
  }
}

/**
 * `migrate` runs before the `runs` table is guaranteed to exist, so it uses the
 * raw client and records nothing about itself.
 */
async function withoutRunRecord(command: string, dryRun: boolean): Promise<number> {
  const bootstrap = readBootstrap();
  const log = createLogger({
    runId: 'migrate',
    level: bootstrap.logLevel,
    clock: systemClock,
    unsafe: false,
  }).child({ command, dry_run: dryRun });

  const client = openClient(bootstrap);
  try {
    await enableForeignKeys(client);
    const outcome = await migrate(client, log, systemClock, { dryRun });
    if (dryRun) {
      process.stdout.write(
        outcome.pending.length === 0
          ? '\nSchema is up to date. Nothing pending.\n\n'
          : `\nPending migrations (none applied, --dry-run):\n  ${outcome.pending.join('\n  ')}\n\n`,
      );
    } else {
      process.stdout.write(
        outcome.applied.length === 0
          ? `\nSchema is up to date (${outcome.alreadyApplied.length} migration(s) already applied).\n\n`
          : `\nApplied:\n  ${outcome.applied.join('\n  ')}\n\n`,
      );
    }
    return 0;
  } finally {
    client.close();
  }
}

async function withRun(
  command: string,
  dryRun: boolean,
  unsafeLog: boolean,
  body: (ctx: RunContext) => Promise<number | { code: number; status: RunStatus }>,
): Promise<number> {
  let ctx: RunContext | undefined;
  try {
    ctx = await startRun({ command, dryRun, unsafeLog });
    const result = await body(ctx);
    // Most commands either did their job or did not. `sync` reports its own
    // status, because one course can fail while the others commit normally
    // (SPEC.md section 7) -- that is 'partial', and it still exits 0.
    const { code, status } = typeof result === 'number' ? { code: result, status: (result === 0 ? 'ok' : 'failed') as RunStatus } : result;
    await finishRun(ctx, status);
    return code;
  } catch (error) {
    if (ctx !== undefined) {
      await finishRun(ctx, 'failed', error);
    }
    throw error;
  }
}

/**
 * A run whose database access is read-only (D-59): no runs row, and the
 * dry-run writer, so the command structurally cannot write -- while dry_run
 * in the log stays false, because it is not a --dry-run.
 */
async function withReadOnlyRun(command: string, unsafeLog: boolean, body: (ctx: RunContext) => Promise<number>): Promise<number> {
  const ctx = await startRun({ command, dryRun: false, unsafeLog, recordRun: false, readOnlyDb: true });
  return body(ctx);
}

/**
 * CI detection, read straight from the process environment rather than from
 * Bootstrap, so the refusal above runs before any database connection.
 */
function isCi(): boolean {
  return (
    process.env['CI'] === 'true' ||
    process.env['CI'] === '1' ||
    process.env['GITHUB_ACTIONS'] === 'true'
  );
}

/** Node's own .env loader. No dependency, no dotenv. */
function loadDotEnv(): void {
  try {
    process.loadEnvFile('.env');
  } catch {
    // Absent .env is normal in CI, where the environment is already populated.
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  if (isAppError(error)) {
    process.stderr.write(`\n${error.message}\n`);
    if (error.hint !== undefined) process.stderr.write(`${error.hint}\n`);
    process.stderr.write('\n');
    process.exitCode = error.code === 'usage' || error.code.startsWith('config') ? 2 : 1;
  } else {
    process.stderr.write(`\nUnhandled failure: ${messageOf(error)}\n`);
    if (error instanceof Error && error.stack !== undefined) {
      process.stderr.write(`${error.stack}\n`);
    }
    process.exitCode = 1;
  }
}

export { main, AppError };
