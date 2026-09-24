/**
 * Every followups, timetable and tune-patterns subcommand, run for real against
 * a freshly MIGRATED database -- so a query naming a column the schema does not
 * have fails the build (the `f.nudged_at` bug: `followups list` selected a
 * column the reshaped migration 0010 had removed, and no test ran the CLI).
 *
 * Invented module code and file names throughout.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { migrate } from '../../src/core/db/migrate.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { startRun, type RunContext } from '../../src/core/run-context.ts';
import { runFollowupsCli, runTunePatterns } from '../../src/cli/followups.ts';
import { runTimetableCli, type TimetableArgs } from '../../src/cli/timetable.ts';
import { startServer, sendJson, type FakeServer } from '../helpers/fake-canvas.ts';
import { runFollowups } from '../../src/followups/stage.ts';
import { Config } from '../../src/core/config.ts';
import { CanvasClient } from '../../src/canvas/client.ts';
import { CanvasHttp } from '../../src/canvas/http.ts';
import { RateLimitGovernor } from '../../src/canvas/rate-limit.ts';
import { createRawStore } from '../../src/canvas/raw-store.ts';

const temps: string[] = [];
const servers: FakeServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

const clock = fixedClock('2026-09-30T03:00:00Z');

/** A fresh migrated database per test: one course, three file items, one open follow-up (#1). */
async function world(): Promise<{ client: Client; ctx: (dryRun?: boolean) => Promise<RunContext>; dir: string }> {
  const canvas = await startServer((req, res) => {
    if ((req.url ?? '').startsWith('/api/v1/courses')) return sendJson(res, 200, [{ id: 10001, term: { id: 1, end_at: '2027-01-09T15:59:00Z' } }]);
    sendJson(res, 404, {});
  });
  servers.push(canvas);
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-followups-'));
  temps.push(dir);
  const url = `file:${path.join(dir, 'db.sqlite')}`;
  const client = createClient({ url });
  await client.execute('PRAGMA foreign_keys = ON');
  await migrate(client, silentLogger(), clock, { dryRun: false });

  const at = '2026-09-18T00:00:00Z';
  await client.batch([
    `INSERT INTO contexts (context_id, context_type, canvas_id, enabled, coverage_status, first_seen_at) VALUES (1, 'course', 10001, 1, 'full', '${at}')`,
    `INSERT INTO courses (context_id, canvas_course_id, module_code, term) VALUES (1, 10001, 'AB1234', '2610')`,
    ...[['q4', 'Lab 04.pdf'], ['q3', 'Lab 03.pdf'], ['a3', 'Lab 03 - Solutions.pdf']].map(([id, title]) =>
      `INSERT INTO items (id, context_id, resource_type, external_id, title, content_hash, posted_at, meta, first_seen_at, last_seen_at, state)
       VALUES ('${id}', 1, 'file', '${id}', '${title}', 'h', '2026-09-14T01:00:00Z', '{"folder":"course files/Week 06/Practical Lab"}', '${at}', '${at}', 'seen')`),
    `INSERT INTO followups (id, context_id, category, number, question_file_id, state, opened_at, recorded_at, baseline)
     VALUES (1, 1, 'Labs', '4', 'q4', 'open', '2026-09-14T01:00:00Z', '${at}', 1)`,
    `INSERT INTO config (key, value, secret, updated_at) VALUES
       ('canvas_base_url', '${canvas.url}/api/v1', 0, '${at}'), ('canvas_token', 'invented-token', 1, '${at}'),
       ('followup_partial_answers', 'keep_open', 0, '${at}'), ('followups_baselined_at', '${at}', 0, '${at}')`,
  ], 'write');

  const ctx = (dryRun = false) => startRun({
    command: 'test', dryRun, recordRun: false, clock, sink: () => {},
    bootstrap: { databaseUrl: url, authToken: undefined, logLevel: 'error', ci: false, scheduledFor: undefined, cronSchedule: undefined, host: 'test' },
  });
  return { client, ctx, dir };
}

/** Run a CLI body with stdout captured and CI unset; any error (a bad column) fails the test. */
async function run(body: () => Promise<number>): Promise<string> {
  const write = process.stdout.write.bind(process.stdout);
  const saved = { CI: process.env['CI'], GITHUB_ACTIONS: process.env['GITHUB_ACTIONS'] };
  delete process.env['CI'];
  delete process.env['GITHUB_ACTIONS'];
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
  try {
    assert.equal(await body(), 0);
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved)) if (v !== undefined) process.env[k] = v;
  }
  return out;
}

const fu = (ctx: RunContext, action: string, rest: string[] = [], extra: Record<string, string> = {}) =>
  run(() => runFollowupsCli(ctx, { action, rest, ...extra }));
const tt = (ctx: RunContext, args: TimetableArgs) => run(() => runTimetableCli(ctx, args));

describe('followups CLI against a freshly migrated schema', () => {
  it('list, list --all', async () => {
    const w = await world();
    const ctx = await w.ctx();
    assert.match(await fu(ctx, 'list'), /#1\s+AB1234 Lab 4\s+open\s+posted 2026-09-14\s+Lab 04\.pdf/);
    assert.match(await fu(ctx, 'list', ['--all']), /#1/);
  });

  it('dismiss: closes an open follow-up once, and says so when it is not open', async () => {
    const w = await world();
    const ctx = await w.ctx();
    assert.match(await fu(ctx, 'dismiss', ['1']), /Dismissed #1/);
    const row = await w.client.execute('SELECT state, close_reason FROM followups WHERE id = 1');
    assert.deepEqual([row.rows[0]?.['state'], row.rows[0]?.['close_reason']], ['dismissed', 'dismissed']);
    assert.match(await fu(ctx, 'dismiss', ['1']), /#1 is not an open follow-up; nothing changed/);
    assert.match(await fu(ctx, 'list'), /No open follow-ups/);
  });

  it('dismiss --dry-run changes nothing', async () => {
    const w = await world();
    assert.match(await fu(await w.ctx(true), 'dismiss', ['1']), /DRY RUN: would dismiss #1/);
    const row = await w.client.execute('SELECT state FROM followups WHERE id = 1');
    assert.equal(row.rows[0]?.['state'], 'open');
  });

  it('module off / on', async () => {
    const w = await world();
    const ctx = await w.ctx();
    await fu(ctx, 'module', ['off'], { module: 'AB1234' });
    assert.equal((await w.client.execute('SELECT followups_tracking AS t FROM courses')).rows[0]?.['t'], 0);
    await fu(ctx, 'module', ['on'], { module: 'AB1234' });
    assert.equal((await w.client.execute('SELECT followups_tracking AS t FROM courses')).rows[0]?.['t'], 1);
  });

  it('phrases add / list', async () => {
    const w = await world();
    const ctx = await w.ctx();
    await fu(ctx, 'phrases', ['add'], { module: 'AB1234', phrase: 'marking scheme' });
    assert.match(await fu(ctx, 'phrases'), /AB1234\s+"marking scheme"/);
  });

  it('preview, from the database and from a draft, with a reminder date', async () => {
    const w = await world();
    const ctx = await w.ctx();
    const fromDb = await fu(ctx, 'preview', [], { reminderDate: '2026-10-01' });
    assert.match(fromDb, /Timetable and tracking switches from: the database/);
    assert.match(fromDb, /THE REMINDER AT 07:00 SGT ON 2026-10-01[\s\S]*none: no lesson today/);
    const draft = path.join(w.dir, 'draft.json');
    await writeFile(draft, JSON.stringify({ trackingOff: [], slots: [{ module: 'AB1234', weekday: 'thu', time: '09:00', from: '2026-08-13', to: '2026-11-12', label: 'lab' }], noLesson: [{ module: null, date: '2026-09-24' }] }));
    const fromDraft = await fu(ctx, 'preview', [], { draft, reminderDate: '2026-10-01' });
    assert.match(fromDraft, /AB1234 lab 09:00 today: Lab 4, posted 14 Sep/);
  });

  it('tune-patterns', async () => {
    const w = await world();
    assert.match(await run(async () => runTunePatterns(await w.ctx())), /"solutions"[\s\S]*Lab 03\.pdf\s+->\s+Lab 03 - Solutions\.pdf/);
  });
});

describe('timetable CLI against a freshly migrated schema', () => {
  it('add, skip, list, remove, unskip', async () => {
    const w = await world();
    const ctx = await w.ctx();
    await tt(ctx, { action: 'add', rest: [], module: 'AB1234', weekday: 'thu', time: '09:00', from: '2026-08-13', to: '2026-11-12', label: 'lab' });
    await tt(ctx, { action: 'skip', rest: [], all: true, date: '2026-09-24', note: 'recess' });
    await tt(ctx, { action: 'skip', rest: [], module: 'AB1234', date: '2026-10-08' });
    const listed = await tt(ctx, { action: 'list', rest: [] });
    assert.match(listed, /AB1234\s+thu 09:00\s+lab\s+2026-08-13 \.\. 2026-11-12/);
    assert.match(listed, /2026-09-24\s+ALL MODULES\s+recess/);
    const slot = (await w.client.execute('SELECT id FROM lesson_slots')).rows[0]!['id'];
    const skip = (await w.client.execute("SELECT id FROM lesson_exceptions WHERE date = '2026-10-08'")).rows[0]!['id'];
    assert.match(await tt(ctx, { action: 'remove', rest: [String(slot)] }), /Removed/);
    assert.match(await tt(ctx, { action: 'unskip', rest: [String(skip)] }), /Removed/);
  });

  it('import a draft into an empty timetable, tracking switches included', async () => {
    const w = await world();
    const draft = path.join(w.dir, 'draft.json');
    await writeFile(draft, JSON.stringify({ trackingOff: ['AB1234'], slots: [{ module: 'AB1234', weekday: 'thu', time: '12:00', from: '2026-08-13', to: '2026-11-12' }], noLesson: [{ module: 'AB1234', date: '2026-10-29' }] }));
    assert.match(await tt(await w.ctx(), { action: 'import', rest: [draft] }), /Imported 1 weekly lessons, 1 no-lesson dates, tracking off for 1/);
    assert.equal((await w.client.execute('SELECT count(*) AS n FROM lesson_slots')).rows[0]?.['n'], 1);
  });
});

describe('the sync stage\'s own queries against a freshly migrated schema', () => {
  it('the lesson-day reminder path (1 Oct, 07:10 SGT), then term-end expiry', async () => {
    const w = await world();
    await w.client.execute(`INSERT INTO lesson_slots (context_id, weekday, start_time, first_date, last_date, label, created_at)
                            VALUES (1, 4, '09:00', '2026-08-13', '2026-11-12', 'lab', '2026-09-01T00:00:00Z')`);
    const stage = async (iso: string) => {
      const ctx = await startRun({
        command: 'test', dryRun: false, recordRun: false, clock: fixedClock(iso), sink: () => {},
        bootstrap: { databaseUrl: `file:${path.join(w.dir, 'db.sqlite')}`, authToken: undefined, logLevel: 'error', ci: false, scheduledFor: undefined, cronSchedule: undefined, host: 'test' },
      });
      const config = await Config.load(ctx.db);
      const canvas = new CanvasClient(new CanvasHttp({
        baseUrl: config.require('canvas_base_url'), token: config.require('canvas_token'), log: ctx.log, clock: ctx.clock,
        governor: new RateLimitGovernor(ctx.log), rawStore: createRawStore({ runId: ctx.runId, enabled: false, log: ctx.log, clock: ctx.clock }),
      }));
      return runFollowups(ctx, { config, canvas, now: ctx.clock.now() });
    };
    const oct1 = await stage('2026-09-30T23:10:00Z'); // Thu 1 Oct, 07:10 SGT
    assert.equal(oct1.reminded, '2026-10-01');
    const queued = await w.client.execute("SELECT payload FROM notifications WHERE payload LIKE '%Answers still outstanding%'");
    assert.match(String(queued.rows[0]?.['payload']), /AB1234 lab 09:00 today: Lab 4, posted 14 Sep/);
    const after = await stage('2027-01-10T01:00:00Z'); // past Canvas's term end
    assert.equal(after.expired, 1);
    const row = await w.client.execute('SELECT state, close_reason FROM followups WHERE id = 1');
    assert.deepEqual([row.rows[0]?.['state'], row.rows[0]?.['close_reason']], ['expired', 'term_end']);
  });
});

