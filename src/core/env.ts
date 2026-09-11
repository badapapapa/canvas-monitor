/**
 * Bootstrap secrets ONLY (SPEC.md section 12).
 *
 * Everything that can live in the `config` table lives in the `config` table,
 * so it is rotatable by pasting a value in rather than by redeploying. The
 * database URL and its auth token are the exception because something has to
 * hold the key to the box that holds the keys.
 *
 * Adding a key here is a deviation and belongs in DECISIONS.md.
 */

import { AppError } from './errors.ts';
import { parseLevel, type Level } from './log.ts';

export interface Bootstrap {
  databaseUrl: string;
  authToken: string | undefined;
  logLevel: Level;
  /**
   * True when running under any CI system. Gates two things: `--unsafe-log` is
   * refused, and identifying command output is suppressed (DECISIONS.md D-26).
   *
   * There is deliberately no environment variable that lifts redaction. An env
   * var is precisely the thing a workflow file can set, which would make the
   * guarantee unenforceable.
   */
  ci: boolean;
  /** Set by the scheduler; lets a run measure its own queue drift. */
  scheduledFor: Date | undefined;
  host: string;
}

export function readBootstrap(env: NodeJS.ProcessEnv = process.env): Bootstrap {
  const databaseUrl = env['TURSO_DATABASE_URL']?.trim();
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new AppError(
      'config_missing',
      'TURSO_DATABASE_URL is not set.',
      'Copy .env.example to .env. For local work: TURSO_DATABASE_URL=file:./data/canvas-monitor.db',
    );
  }

  const authToken = env['TURSO_AUTH_TOKEN']?.trim();
  if (databaseUrl.startsWith('libsql://') && (authToken === undefined || authToken === '')) {
    throw new AppError(
      'config_missing',
      'TURSO_AUTH_TOKEN is required for a remote libsql:// database.',
      'Generate one with `turso db tokens create <db>`.',
    );
  }

  const scheduledRaw = env['RUN_SCHEDULED_FOR']?.trim();
  let scheduledFor: Date | undefined;
  if (scheduledRaw !== undefined && scheduledRaw !== '') {
    const parsed = new Date(scheduledRaw);
    if (Number.isNaN(parsed.getTime())) {
      throw new AppError('config_invalid', `RUN_SCHEDULED_FOR is not a valid instant: ${scheduledRaw}`);
    }
    scheduledFor = parsed;
  }

  return {
    databaseUrl,
    authToken: authToken === '' ? undefined : authToken,
    logLevel: parseLevel(env['LOG_LEVEL']),
    ci: env['CI'] === 'true' || env['CI'] === '1' || env['GITHUB_ACTIONS'] === 'true',
    scheduledFor,
    host: env['GITHUB_RUN_ID'] === undefined ? 'local' : `gha:${env['GITHUB_RUN_ID']}`,
  };
}
