import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { createDb } from '../../src/core/db/writer.ts';
import { startRun } from '../../src/core/run-context.ts';
import { migrate, loadMigrations } from '../../src/core/db/migrate.ts';
import { Config, setConfig } from '../../src/core/config.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { isAppError } from '../../src/core/errors.ts';

const MIGRATIONS = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));
const clock = fixedClock('2026-08-27T05:00:00Z');
const temps: string[] = [];

after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function freshDb(): Promise<{ client: Client; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'canvas-monitor-'));
  temps.push(dir);
  const client = createClient({ url: `file:${path.join(dir, 'test.db')}` });
  await client.execute('PRAGMA foreign_keys = ON');
  return { client, dir };
}

describe('migrations', () => {
  it('applies every migration and is idempotent on a second run', async () => {
    const { client } = await freshDb();
    const first = await migrate(client, silentLogger(), clock, { dryRun: false });
    assert.ok(first.applied.length >= 4, 'expected the Phase 0 migrations to apply');

    const second = await migrate(client, silentLogger(), clock, { dryRun: false });
    assert.deepEqual(second.applied, []);
    assert.equal(second.alreadyApplied.length, first.applied.length);
    client.close();
  });

  it('applies nothing under --dry-run', async () => {
    const { client } = await freshDb();
    const outcome = await migrate(client, silentLogger(), clock, { dryRun: true });
    assert.ok(outcome.pending.includes('0003_contexts'));

    const tables = await client.execute(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='contexts'",
    );
    assert.equal(tables.rows.length, 0, '--dry-run must not create tables');
    client.close();
  });

  it('refuses to run when an applied migration has been edited', async () => {
    // The schema in the files must match the schema in the database, or every
    // later assumption about the data model is unverifiable.
    const { client, dir } = await freshDb();
    const copy = path.join(dir, 'migrations');
    await rm(copy, { recursive: true, force: true });
    const { mkdir, cp } = await import('node:fs/promises');
    await mkdir(copy, { recursive: true });
    await cp(MIGRATIONS, copy, { recursive: true });

    await migrate(client, silentLogger(), clock, { dryRun: false, dir: copy });

    const target = path.join(copy, '0003_contexts.sql');
    await writeFile(target, `${await readFile(target, 'utf8')}\n-- edited after the fact\n`);

    await assert.rejects(
      () => migrate(client, silentLogger(), clock, { dryRun: false, dir: copy }),
      (error: unknown) => isAppError(error) && error.code === 'migration_failed',
    );
    client.close();
  });

  it('names migrations in sorted order', async () => {
    const migrations = await loadMigrations(MIGRATIONS);
    const versions = migrations.map((m) => m.version);
    assert.deepEqual(versions, [...versions].sort());
  });
});

describe('schema intent', () => {
  it('keys content on context_id so course and group ids cannot collide', async () => {
    // Canvas course 4471 and group 4471 are different things (SPEC.md section 4).
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });

    await client.execute({
      sql: `INSERT INTO contexts (context_type, canvas_id, display_name, first_seen_at) VALUES (?, ?, ?, ?)`,
      args: ['course', 4471, 'AB1234 Lecture', clock.now().toISOString()],
    });
    await client.execute({
      sql: `INSERT INTO contexts (context_type, canvas_id, display_name, first_seen_at) VALUES (?, ?, ?, ?)`,
      args: ['group', 4471, 'AB1234 Project Group 7', clock.now().toISOString()],
    });

    const rows = await client.execute('SELECT context_id, context_type FROM contexts ORDER BY context_id');
    assert.equal(rows.rows.length, 2, 'the same Canvas id in two namespaces must coexist');
    client.close();
  });

  it('rejects a second context with the same type and canvas id', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });
    const insert = {
      sql: `INSERT INTO contexts (context_type, canvas_id, first_seen_at) VALUES (?, ?, ?)`,
      args: ['course', 999, clock.now().toISOString()],
    };
    await client.execute(insert);
    await assert.rejects(() => client.execute(insert));
    client.close();
  });

  it('rejects an unknown coverage_status', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });
    await assert.rejects(() =>
      client.execute({
        sql: `INSERT INTO contexts (context_type, canvas_id, coverage_status, first_seen_at) VALUES (?, ?, ?, ?)`,
        args: ['course', 1, 'probably_fine', clock.now().toISOString()],
      }),
    );
    client.close();
  });
});

describe('read-only database access (D-59)', () => {
  it('a readOnlyDb run cannot write, whatever --dry-run says, and the log tells them apart', async () => {
    const { client, dir } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });
    const lines: string[] = [];
    const ctx = await startRun({
      command: 'mirror', dryRun: false, recordRun: false, readOnlyDb: true, clock,
      bootstrap: { databaseUrl: `file:${path.join(dir, 'test.db')}`, authToken: undefined, logLevel: 'info', ci: false, scheduledFor: undefined, cronSchedule: undefined, host: 'test' },
      sink: (l: string) => lines.push(l),
    });
    await setConfig(ctx.db, clock, 'canvas_token', 'should-not-persist');
    const stored = await client.execute('SELECT count(*) AS n FROM config');
    assert.equal(Number(stored.rows[0]?.['n']), 0, 'a read-only run wrote to the archive database');
    ctx.log.info('probe', {});
    const fields = JSON.parse(lines.at(-1) ?? '{}') as Record<string, unknown>;
    assert.equal(fields['db_access'], 'read-only');
    assert.equal(fields['dry_run'], false, 'dry_run keeps meaning --dry-run');
    client.close();
  });
});

describe('dry-run seam', () => {
  it('mutates nothing through the writer under --dry-run', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });

    const dryDb = createDb(client, silentLogger(), true);
    await setConfig(dryDb, clock, 'canvas_token', 'should-not-persist');

    const stored = await client.execute('SELECT count(*) AS n FROM config');
    assert.equal(Number(stored.rows[0]?.['n']), 0, '--dry-run wrote to the database');
    client.close();
  });

  it('writes normally when not in dry run', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });

    const db = createDb(client, silentLogger(), false);
    await setConfig(db, clock, 'canvas_token', 'real-value');

    const config = await Config.load(db);
    assert.equal(config.get('canvas_token'), 'real-value');
    client.close();
  });

  it('reads real state during a dry run, so decisions stay realistic', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });
    await createDb(client, silentLogger(), false).write.execute('seed', {
      sql: 'INSERT INTO config (key, value, secret, updated_at) VALUES (?, ?, 0, ?)',
      args: ['canvas_base_url', 'https://example.test/api/v1', clock.now().toISOString()],
    });

    const dryDb = createDb(client, silentLogger(), true);
    const config = await Config.load(dryDb);
    assert.equal(config.get('canvas_base_url'), 'https://example.test/api/v1');
    client.close();
  });

  it('rolls back a dry-run transaction rather than committing it', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });

    const dryDb = createDb(client, silentLogger(), true);
    await dryDb.transaction('seed contexts', async (tx) => {
      await tx.write.execute('insert context', {
        sql: 'INSERT INTO contexts (context_type, canvas_id, first_seen_at) VALUES (?, ?, ?)',
        args: ['course', 1, clock.now().toISOString()],
      });
    });

    const rows = await client.execute('SELECT count(*) AS n FROM contexts');
    assert.equal(Number(rows.rows[0]?.['n']), 0);
    client.close();
  });
});

describe('config defaults', () => {
  it('falls back to the declared default when unset', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });
    const config = await Config.load(createDb(client, silentLogger(), false));
    assert.equal(config.get('canvas_base_url'), 'https://canvas.nus.edu.sg/api/v1');
    assert.equal(config.getNumber('raw_capture_retention_days', 0), 60);
    client.close();
  });

  it('throws an actionable error for a missing required key', async () => {
    const { client } = await freshDb();
    await migrate(client, silentLogger(), clock, { dryRun: false });
    const config = await Config.load(createDb(client, silentLogger(), false));
    assert.throws(
      () => config.require('canvas_token'),
      (error: unknown) => isAppError(error) && error.hint?.includes('set-config canvas_token') === true,
    );
    client.close();
  });
});
