/**
 * Structured logging with a run ID (SPEC.md section 15).
 *
 * Two rules encoded here rather than left to discipline:
 *
 * 1. Logs go to stderr. stdout belongs to command output, so `--json` stays
 *    machine-readable when piped.
 * 2. Redaction is ON BY DEFAULT and must be switched off explicitly, per
 *    DECISIONS.md D-26. Bodies, course names, module codes, file names and
 *    announcement titles are all stripped regardless of level. This repository
 *    is public (D-10), which makes GitHub Actions logs public with it.
 *
 * The escape hatch is `--unsafe-log`, for local debugging only. It cannot be
 * set from the Actions workflow: the CLI refuses it whenever CI or
 * GITHUB_ACTIONS is present in the environment, and there is deliberately no
 * environment variable that enables it -- an env var is exactly the thing a
 * workflow can set.
 */

import { redact } from './redact.ts';
import type { Clock } from './clock.ts';

export type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
  readonly level: Level;
}

export interface LoggerOptions {
  runId: string;
  level?: Level;
  clock: Clock;
  /**
   * Lift redaction entirely. Local debugging only; the CLI refuses to set this
   * under CI. Defaults to false, so forgetting it is safe rather than leaky.
   */
  unsafe?: boolean;
  sink?: (line: string) => void;
}

export function parseLevel(raw: string | undefined, fallback: Level = 'info'): Level {
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') return raw;
  return fallback;
}

export function createLogger(options: LoggerOptions): Logger {
  const level = options.level ?? 'info';
  const sink = options.sink ?? ((line: string) => process.stderr.write(`${line}\n`));
  // Default-deny. Both tiers lift together, and only on an explicit flag.
  const unsafe = options.unsafe === true;

  const make = (bindings: LogFields): Logger => {
    const emit = (entryLevel: Level, event: string, fields?: LogFields): void => {
      if (RANK[entryLevel] < RANK[level]) return;
      const payload = {
        ts: options.clock.now().toISOString(),
        level: entryLevel,
        run_id: options.runId,
        event,
        ...bindings,
        ...(fields ?? {}),
      };
      sink(JSON.stringify(redact(payload, { keepBodies: unsafe, keepIdentity: unsafe })));
    };

    return {
      level,
      debug: (event, fields) => emit('debug', event, fields),
      info: (event, fields) => emit('info', event, fields),
      warn: (event, fields) => emit('warn', event, fields),
      error: (event, fields) => emit('error', event, fields),
      child: (extra) => make({ ...bindings, ...extra }),
    };
  };

  return make({});
}

/** A logger that discards everything, for tests that do not assert on output. */
export function silentLogger(): Logger {
  const self: Logger = {
    level: 'error',
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => self,
  };
  return self;
}
