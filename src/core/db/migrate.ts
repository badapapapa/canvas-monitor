/**
 * Forward-only migration runner.
 *
 * Migrations are applied in filename order and checksummed. Editing a
 * migration that has already been applied is an error, not a silent
 * divergence: the schema in the file must match the schema in the database, or
 * every later assumption about the data model is unverifiable.
 *
 * DDL runs against the raw client rather than through the dry-run Mutator,
 * because a migration is a whole-file unit. `--dry-run` here lists what would
 * be applied and applies nothing.
 *
 * Each migration after 0001 is applied ATOMICALLY, together with its
 * bookkeeping row, through libSQL's `migrate()`: one transaction, foreign keys
 * off for its duration. From 0007 onward migrations rebuild tables holding live
 * data (SQLite cannot alter a CHECK constraint in place), and a rebuild that
 * died between DROP and RENAME would lose it. All or nothing.
 */

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Client } from '@libsql/client';
import { AppError } from '../errors.ts';
import type { Logger } from '../log.ts';
import type { Clock } from '../clock.ts';

const MIGRATIONS_DIR = path.resolve(fileURLToPath(new URL('../../../migrations', import.meta.url)));

export interface Migration {
  version: string;
  sql: string;
  checksum: string;
}

/**
 * Split a migration file into statements: strips `--` comments and splits on
 * semicolons, both only outside single-quoted strings.
 *
 * Deliberately refuses CREATE TRIGGER, whose BEGIN...END body contains
 * semicolons this splitter would cut through. Better a loud refusal the day a
 * trigger is added (FTS5, Phase 7) than a silently mangled migration.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      current += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          current += "'";
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
    } else if (ch === '-' && sql[i + 1] === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end - 1;
    } else if (ch === ';') {
      statements.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  statements.push(current);
  const out = statements.map((s) => s.trim()).filter((s) => s !== '');
  const trigger = out.find((s) => /\bCREATE\s+(TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i.test(s));
  if (trigger !== undefined) {
    throw new AppError(
      'migration_failed',
      'splitStatements cannot safely split CREATE TRIGGER (its body contains semicolons).',
      'Extend the splitter to handle BEGIN...END before adding a trigger migration.',
    );
  }
  return out;
}

export interface MigrateOutcome {
  applied: string[];
  pending: string[];
  alreadyApplied: string[];
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
  const out: Migration[] = [];
  for (const name of entries) {
    const sql = await readFile(path.join(dir, name), 'utf8');
    out.push({
      version: name.replace(/\.sql$/, ''),
      sql,
      checksum: createHash('sha256').update(sql).digest('hex').slice(0, 16),
    });
  }
  return out;
}

export async function migrate(
  client: Client,
  log: Logger,
  clock: Clock,
  opts: { dryRun: boolean; dir?: string },
): Promise<MigrateOutcome> {
  const migrations = await loadMigrations(opts.dir ?? MIGRATIONS_DIR);
  const first = migrations[0];
  if (first === undefined) throw new AppError('migration_failed', 'No migrations found.');

  // 0001 bootstraps the bookkeeping table, so it is applied unconditionally
  // (it is idempotent) before the table can be queried.
  await client.executeMultiple(first.sql);

  const existing = await client.execute('SELECT version, checksum FROM schema_migrations');
  const applied = new Map<string, string>();
  for (const row of existing.rows) {
    applied.set(String(row['version']), String(row['checksum']));
  }

  const outcome: MigrateOutcome = { applied: [], pending: [], alreadyApplied: [] };

  for (const migration of migrations) {
    const priorChecksum = applied.get(migration.version);

    if (priorChecksum !== undefined) {
      if (priorChecksum !== migration.checksum) {
        throw new AppError(
          'migration_failed',
          `Migration ${migration.version} has changed since it was applied ` +
            `(recorded ${priorChecksum}, file ${migration.checksum}).`,
          'Migrations are immutable once applied. Add a new migration instead of editing this one.',
        );
      }
      outcome.alreadyApplied.push(migration.version);
      continue;
    }

    if (opts.dryRun) {
      outcome.pending.push(migration.version);
      log.info('migrate.pending', { version: migration.version, dry_run: true });
      continue;
    }

    log.info('migrate.applying', { version: migration.version });
    const bookkeeping = {
      sql: 'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)',
      args: [migration.version, clock.now().toISOString(), migration.checksum],
    };
    if (migration.version === first.version) {
      await client.execute(bookkeeping); // 0001 already ran, idempotently, above
    } else {
      // The migration and the record that it ran commit together, or neither does.
      await client.migrate([...splitStatements(migration.sql), bookkeeping]);
    }
    outcome.applied.push(migration.version);
  }

  return outcome;
}
