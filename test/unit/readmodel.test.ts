/**
 * The dashboard's read model can hold no secret (DECISIONS.md D-65): by its
 * schema, by the publisher's source, and by what actually lands in it when the
 * main database is full of secrets. Invented names throughout.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, type Client } from '@libsql/client';
import { migrate } from '../../src/core/db/migrate.ts';
import { createDb } from '../../src/core/db/writer.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { publishReadModel, ReadModelNotMigrated } from '../../src/readmodel/publish.ts';
import { HEALTH_NAMES, READMODEL_COLUMNS, READMODEL_DDL, READMODEL_SCHEMA_VERSION } from '../../src/readmodel/schema.ts';

const temps: string[] = [];
after(() => Promise.all(temps.map((d) => rm(d, { recursive: true, force: true }))));
const clock = fixedClock('2026-09-30T03:00:00Z');
const NOW = new Date('2026-09-30T03:00:00Z');

async function fresh(name: string): Promise<Client> {
  const dir = await mkdtemp(path.join(tmpdir(), `rm-${name}-`));
  temps.push(dir);
  return createClient({ url: `file:${path.join(dir, 'db.sqlite')}` });
}

async function migratedReadModel(): Promise<Client> {
  const rm = await fresh('target');
  await rm.batch([...READMODEL_DDL, { sql: "INSERT INTO rm_meta (name, value) VALUES ('schema_version', ?)", args: [READMODEL_SCHEMA_VERSION] }], 'write');
  return rm;
}

// Sentinels planted in every place a secret lives in the main database. The
// credential-shaped ones are assembled at run time, so no credential-shaped
// string sits in this file for the repository's own secret scanners to flag.
const SECRETS = {
  canvas_token: ['7777', 'SENTINELCANVASTOKENabcdefghijklmnopqrstu'].join('~'),
  graph_refresh_token: ['M', 'C104_SENTINEL-refresh-token-value-0123456789'].join('.'),
  graph_client_id: '00000000-5e11-7e11-5e11-000000000001',
  telegram_bot_token: ['1234567890', 'SENTINELtelegramTOKENabcdefghijklmnopq'].join(':'),
  telegram_content_chat_id: '987654321987',
  telegram_ops_chat_id: '-100987654321987',
  healthcheck_url: 'https://hc-ping.example.test/SENTINEL-healthcheck-uuid',
};

async function mainWithSecrets(): Promise<Client> {
  const main = await fresh('main');
  await main.execute('PRAGMA foreign_keys = ON');
  await migrate(main, silentLogger(), clock, { dryRun: false });
  const at = '2026-09-25T00:00:00Z';
  await main.batch([
    ...Object.entries(SECRETS).map(([k, v]) => ({ sql: 'INSERT INTO config (key, value, secret, updated_at) VALUES (?, ?, 1, ?)', args: [k, v, at] })),
    `INSERT INTO contexts (context_id, context_type, canvas_id, enabled, coverage_status, first_seen_at) VALUES (1, 'course', 10001, 1, 'full', '${at}')`,
    `INSERT INTO courses (context_id, canvas_course_id, module_code, term) VALUES (1, 10001, 'AB1234', '2610')`,
    `INSERT INTO items (id, context_id, resource_type, external_id, title, body_text, content_hash, canvas_url, posted_at, due_at, first_seen_at, last_seen_at, state) VALUES
       ('a1', 1, 'assignment', 'a1', 'Assignment 1', 'SENTINEL-BODY-assignment', 'h', 'https://canvas.example.test/courses/10001/assignments/1', '${at}', '2026-10-09T15:59:00Z', '${at}', '${at}', 'seen'),
       ('n1', 1, 'announcement', 'n1', 'Week 7 notes', 'SENTINEL-BODY-announcement', 'h', 'https://canvas.example.test/courses/10001/discussion_topics/9', '${at}', NULL, '${at}', '${at}', 'seen'),
       ('g1', 1, 'grade', 'g1', 'Quiz 3', 'SENTINEL-SCORE-9-of-10', 'h', NULL, '${at}', NULL, '${at}', '${at}', 'seen'),
       ('f1', 1, 'file', 'f1', 'Lab 04.pdf', NULL, 'h', 'https://canvas.example.test/files/1/download?verifier=SENTINELverifier', '${at}', NULL, '${at}', '${at}', 'seen'),
       ('f2', 1, 'file', 'f2', 'Lab 05.pdf', NULL, 'h', 'https://canvas.example.test/courses/10001/files/2', '${at}', NULL, '${at}', '${at}', 'seen')`,
    `INSERT INTO files (id, context_id, canvas_file_id, display_name, size_bytes, route_category, route_rule, route_confidence, route_decided_at, target_path, download_state, share_url, first_seen_at) VALUES
       ('f1', 1, 1, 'Lab 04.pdf', 100, 'Labs', 'lab:folder', 1, '${at}', '2610/AB1234/Labs/Lab 04.pdf', 'complete', 'https://onedrive.live.com/?id=ABC&tempauth=SENTINELtempauth', '${at}'),
       ('f2', 1, 2, 'Lab 05.pdf', 200, 'Labs', 'lab:folder', 1, '${at}', '2610/AB1234/Labs/Lab 05.pdf', 'complete', 'https://onedrive.live.com/?id=DEF', '${at}')`,
    `INSERT INTO followups (id, context_id, category, number, question_file_id, state, opened_at, recorded_at, baseline) VALUES (1, 1, 'Labs', '5', 'f2', 'open', '${at}', '${at}', 1)`,
    `INSERT INTO runs (run_id, command, dry_run, started_at, finished_at, drift_seconds, status, error_message, host) VALUES
       ('r1', 'sync', 0, '2026-09-29T00:00:00Z', '2026-09-29T00:01:00Z', 120, 'ok', NULL, 'gha'),
       ('r2', 'sync', 0, '2026-09-29T01:00:00Z', '2026-09-29T01:01:00Z', 300, 'failed', 'SENTINEL-error-message', 'gha')`,
    `INSERT INTO ops_alerts (alert_key, severity, summary, first_raised_at, last_raised_at, occurrences) VALUES
       ('context_stale:1', 'warn', 'SENTINEL-alert-summary AB1234 stale', '${at}', '${at}', 1)`,
  ], 'write');
  return main;
}

async function dumpAll(rm: Client): Promise<string[]> {
  const values: string[] = [];
  for (const table of Object.keys(READMODEL_COLUMNS)) {
    for (const row of (await rm.execute(`SELECT * FROM ${table}`)).rows) for (const v of Object.values(row)) if (v !== null) values.push(String(v));
  }
  return values;
}

describe('read model: the schema cannot hold a secret', () => {
  it('has exactly the allowlisted tables and columns, and nothing else', async () => {
    const rm = await migratedReadModel();
    const tables = (await rm.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")).rows.map((r) => String(r['name']));
    assert.deepEqual(tables, Object.keys(READMODEL_COLUMNS).sort());
    for (const [table, columns] of Object.entries(READMODEL_COLUMNS)) {
      const actual = (await rm.execute(`PRAGMA table_info(${table})`)).rows.map((r) => String(r['name']));
      assert.deepEqual(actual, [...columns], table);
    }
  });

  it('has no column whose name suggests a secret, a body, or configuration', () => {
    for (const [table, columns] of Object.entries(READMODEL_COLUMNS)) {
      for (const c of columns) assert.doesNotMatch(c, /token|secret|pass|auth|cred|cookie|config|key|body|score|grade_value|email/i, `${table}.${c}`);
    }
  });

  it('refuses credential-bearing URLs and unknown health or meta names in the database itself', async () => {
    const rm = await migratedReadModel();
    const bad = [
      "INSERT INTO rm_activity (ref, module_id, kind, change, at, seen_at, onedrive_url) VALUES ('x', 1, 'file', 'new', 't', 't', 'https://onedrive.live.com/?id=1&tempauth=abc')",
      "INSERT INTO rm_activity (ref, module_id, kind, change, at, seen_at, canvas_url) VALUES ('y', 1, 'file', 'new', 't', 't', 'https://c.example.test/f/1/download?verifier=abc')",
      "INSERT INTO rm_activity (ref, module_id, kind, change, at, seen_at, canvas_url) VALUES ('z', 1, 'file', 'new', 't', 't', 'http://c.example.test/plain')",
      "INSERT INTO rm_activity (ref, module_id, kind, change, at, seen_at, onedrive_url) VALUES ('w', 1, 'file', 'new', 't', 't', 'https://my.microsoftpersonalcontent.com/download')",
      "INSERT INTO rm_deadlines (ref, module_id, title, due_at, canvas_url) VALUES ('d', 1, 't', 't', 'https://someone@example.test/')",
      "INSERT INTO rm_health (name, value) VALUES ('canvas_token', 'x')",
      "INSERT INTO rm_meta (name, value) VALUES ('graph_refresh_token', 'x')",
    ];
    for (const sql of bad) await assert.rejects(() => rm.execute(sql), /CHECK constraint/i, sql);
  });
});

describe('read model: the publisher never reads a secret', () => {
  it('never names the config table or any secret-bearing key', async () => {
    const dir = path.resolve(fileURLToPath(new URL('../../src/readmodel', import.meta.url)));
    for (const file of ['publish.ts', 'schema.ts']) {
      // Code only: comments may SAY "never the config table".
      const code = (await readFile(path.join(dir, file), 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      assert.doesNotMatch(code, /\bconfig\b|canvas_token|refresh_token|telegram|healthcheck|client_id|body_text|body_hash|\bi\.meta\b|preview|summary|error_message/i, file);
    }
  });
});

describe('read model: what actually lands holds no secret', () => {
  it('publishes only display data from a main database full of secrets', async () => {
    const main = await mainWithSecrets();
    const rm = await migratedReadModel();
    const result = await publishReadModel(createDb(main, silentLogger(), true), rm, NOW);
    assert.deepEqual(result, { modules: 1, deadlines: 1, activity: 5, followups: 1 });

    const values = await dumpAll(rm);
    for (const [k, secret] of Object.entries(SECRETS)) assert.ok(!values.some((v) => v.includes(secret)), `${k} leaked`);
    for (const v of values) {
      assert.doesNotMatch(v, /SENTINEL/, 'a planted body, score, error or alert text leaked');
      assert.doesNotMatch(v, /tempauth|verifier=|\d{3,6}~[A-Za-z0-9]{20,}|\d{5,15}:[A-Za-z0-9_-]{30,}|eyJ[A-Za-z0-9_-]{10,}/, v);
    }
    // The credential-bearing links were dropped, not stored; the plain ones kept.
    const f1 = (await rm.execute("SELECT canvas_url, onedrive_url FROM rm_activity WHERE ref = 'f1'")).rows[0]!;
    assert.deepEqual([f1['canvas_url'], f1['onedrive_url']], [null, null]);
    const f2 = (await rm.execute("SELECT onedrive_url FROM rm_activity WHERE ref = 'f2'")).rows[0]!;
    assert.equal(f2['onedrive_url'], 'https://onedrive.live.com/?id=DEF');
    const health = (await rm.execute('SELECT name FROM rm_health ORDER BY name')).rows.map((r) => String(r['name']));
    assert.ok(health.every((h) => (HEALTH_NAMES as readonly string[]).includes(h)));
  });

  it('replaces the contents atomically: a second publish leaves no stale rows', async () => {
    const main = await mainWithSecrets();
    const rm = await migratedReadModel();
    await publishReadModel(createDb(main, silentLogger(), true), rm, NOW);
    await main.execute("UPDATE followups SET state = 'dismissed' WHERE id = 1");
    await publishReadModel(createDb(main, silentLogger(), true), rm, NOW);
    assert.equal((await rm.execute('SELECT count(*) AS n FROM rm_followups')).rows[0]?.['n'], 0);
  });

  it('refuses to publish into a read model that is not migrated', async () => {
    const main = await mainWithSecrets();
    const empty = await fresh('empty');
    await assert.rejects(() => publishReadModel(createDb(main, silentLogger(), true), empty, NOW), ReadModelNotMigrated);
  });

  it('never writes to the main database while publishing', async () => {
    const main = await mainWithSecrets();
    const before = (await main.execute('SELECT total_changes() AS c')).rows[0]?.['c'];
    // The main database is handed over through the DRY-RUN writer: a write would be a no-op, and the count proves none was even attempted.
    await publishReadModel(createDb(main, silentLogger(), true), await migratedReadModel(), NOW);
    assert.equal((await main.execute('SELECT total_changes() AS c')).rows[0]?.['c'], before);
  });
});
