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
    if (migration.version !== first.version) {
      await client.executeMultiple(migration.sql);
    }
    await client.execute({
      sql: 'INSERT INTO schema_migrations (version, applied_at, checksum) VALUES (?, ?, ?)',
      args: [migration.version, clock.now().toISOString(), migration.checksum],
    });
    outcome.applied.push(migration.version);
  }

  return outcome;
}
