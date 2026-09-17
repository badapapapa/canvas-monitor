import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { cp, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { migrate, splitStatements } from '../../src/core/db/migrate.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { isAppError } from '../../src/core/errors.ts';

const MIGRATIONS = path.resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));
const clock = fixedClock('2026-09-17T08:00:00Z');
const temps: string[] = [];
after(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

async function scratch(upTo?: string): Promise<{ client: Client; dir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'canvas-mig-'));
  temps.push(root);
  const dir = path.join(root, 'migrations');
  await mkdir(dir);
  for (const f of await readdir(MIGRATIONS)) {
    if (upTo === undefined || f <= upTo) await cp(path.join(MIGRATIONS, f), path.join(dir, f));
  }
  const client = createClient({ url: `file:${path.join(root, 'db.sqlite')}` });
  await client.execute('PRAGMA foreign_keys = ON');
  return { client, dir };
}

describe('splitStatements', () => {
  it('splits on semicolons and drops comments', () => {
    const out = splitStatements(`-- header; with a semicolon\nCREATE TABLE a (x INT); -- trailing\n\nINSERT INTO a VALUES (1);`);
    assert.deepEqual(out, ['CREATE TABLE a (x INT)', 'INSERT INTO a VALUES (1)']);
  });

  it('leaves semicolons and dashes inside strings alone', () => {
    const out = splitStatements(`INSERT INTO t VALUES ('a;b -- not a comment', 'it''s; fine');`);
    assert.deepEqual(out, [`INSERT INTO t VALUES ('a;b -- not a comment', 'it''s; fine')`]);
  });

  it('refuses a trigger rather than cutting its body apart', () => {
    assert.throws(
      () => splitStatements('CREATE TRIGGER t AFTER INSERT ON a BEGIN SELECT 1; END;'),
      (e: unknown) => isAppError(e) && e.code === 'migration_failed',
    );
  });

  it('splits every shipped migration without error', async () => {
    const { loadMigrations } = await import('../../src/core/db/migrate.ts');
    for (const m of await loadMigrations(MIGRATIONS)) assert.ok(splitStatements(m.sql).length > 0, m.version);
  });
});

describe('migrations are atomic', () => {
  it('rolls back a failing migration entirely, bookkeeping included', async () => {
    const { client, dir } = await scratch();
    await writeFile(
      path.join(dir, '9999_broken.sql'),
      'CREATE TABLE half_done (x INT);\nINSERT INTO table_that_does_not_exist VALUES (1);\n',
    );
    await assert.rejects(() => migrate(client, silentLogger(), clock, { dryRun: false, dir }));

    const table = await client.execute("SELECT name FROM sqlite_master WHERE name = 'half_done'");
    assert.equal(table.rows.length, 0, 'the first statement must have been rolled back');
    const recorded = await client.execute("SELECT version FROM schema_migrations WHERE version = '9999_broken'");
    assert.equal(recorded.rows.length, 0, 'a failed migration must not be recorded as applied');

    // Everything before it did apply, and a fixed file can be re-run.
    const applied = await client.execute('SELECT count(*) AS n FROM schema_migrations');
    assert.ok(Number(applied.rows[0]?.['n']) >= 7);
    client.close();
  });
});

describe('0007 rebuilds items and watermarks without losing data', () => {
  it('preserves every existing row and starts accepting files', async () => {
    const { client, dir } = await scratch('0006_ingest.sql');
    await migrate(client, silentLogger(), clock, { dryRun: false, dir });

    await client.execute(
      `INSERT INTO contexts (context_id, context_type, canvas_id, first_seen_at) VALUES (1, 'course', 10001, '2026-09-10T00:00:00Z')`,
    );
    for (let i = 0; i < 25; i += 1) {
      await client.execute({
        sql: `INSERT INTO items (id, context_id, resource_type, external_id, title, content_hash, meta,
                first_seen_at, last_seen_at, notified_at, state)
              VALUES (?, 1, ?, ?, ?, ?, ?, '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', '2026-09-11T00:00:00Z', 'seen')`,
        args: [`id-${i}`, i % 2 === 0 ? 'announcement' : 'assignment', String(i), `Title ${i}`, `hash-${i}`, JSON.stringify({ n: i })],
      });
    }
    await client.execute(`INSERT INTO watermarks (context_id, resource_type, last_status, last_ok_at, baselined_at)
                          VALUES (1, 'announcement', 'ok', '2026-09-17T00:00:00Z', '2026-09-11T00:00:00Z')`);
    // Rejected before the migration: this is what 0007 exists to change.
    await assert.rejects(() =>
      client.execute(`INSERT INTO items (id, context_id, resource_type, external_id, content_hash, first_seen_at, last_seen_at, state)
                      VALUES ('f', 1, 'file', '9', 'h', 'x', 'x', 'seen')`),
    );

    for (const f of await readdir(MIGRATIONS)) await cp(path.join(MIGRATIONS, f), path.join(dir, f));
    const outcome = await migrate(client, silentLogger(), clock, { dryRun: false, dir });
    assert.deepEqual(outcome.applied, ['0007_file_items']);

    const items = await client.execute('SELECT id, title, content_hash, meta, notified_at FROM items ORDER BY id');
    assert.equal(items.rows.length, 25, 'no item may be lost in the rebuild');
    const one = items.rows.find((r) => r['id'] === 'id-7');
    assert.equal(one?.['title'], 'Title 7');
    assert.equal(one?.['content_hash'], 'hash-7');
    assert.deepEqual(JSON.parse(String(one?.['meta'])), { n: 7 });

    const mark = await client.execute('SELECT baselined_at, last_ok_at FROM watermarks');
    assert.equal(mark.rows[0]?.['baselined_at'], '2026-09-11T00:00:00Z', 'baselines survive, or the next run floods');

    await client.execute(`INSERT INTO items (id, context_id, resource_type, external_id, content_hash, first_seen_at, last_seen_at, state)
                          VALUES ('f', 1, 'file', '9', 'h', 'x', 'x', 'seen')`);
    await client.execute(`INSERT INTO watermarks (context_id, resource_type, last_status) VALUES (1, 'file', 'ok')`);

    const idx = await client.execute("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_items_context'");
    assert.equal(idx.rows.length, 1, 'the index is recreated');
    const unique = await client.execute({
      sql: `INSERT INTO items (id, context_id, resource_type, external_id, content_hash, first_seen_at, last_seen_at, state)
            VALUES ('dup', 1, 'file', '9', 'h', 'x', 'x', 'seen')`,
      args: [],
    }).then(() => 'accepted', () => 'rejected');
    assert.equal(unique, 'rejected', 'the (context, resource, external id) uniqueness survives the rebuild');

    const fk = await client.execute('PRAGMA foreign_key_check');
    assert.equal(fk.rows.length, 0);
    client.close();
  });
});
