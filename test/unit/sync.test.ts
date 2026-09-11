/**
 * End-to-end sync against a fake Canvas, a fake Telegram and a real database.
 *
 * Each scenario is one where being wrong would be SILENT: a lost second due
 * date change, a flood on first run, a 3am buzz, an unreadable course that
 * looks like a quiet one, an outage that pages every twenty minutes.
 */

import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createClient, type Client } from '@libsql/client';
import { createDb } from '../../src/core/db/writer.ts';
import { migrate } from '../../src/core/db/migrate.ts';
import { setConfig } from '../../src/core/config.ts';
import { silentLogger } from '../../src/core/log.ts';
import type { Clock } from '../../src/core/clock.ts';
import type { RunContext } from '../../src/core/run-context.ts';
import { runSync } from '../../src/sync/run.ts';
import { sgtToUtc } from '../../src/core/time.ts';
import { startServer, sendJson, type FakeServer } from '../helpers/fake-canvas.ts';

// --- fakes -----------------------------------------------------------------

interface FakeCourse {
  assignments: unknown[] | number; // a number is an HTTP status to fail with
  submissions: unknown[] | number;
}

interface CanvasState {
  auth: boolean;
  announcements: Array<Record<string, unknown>>;
  courses: Record<number, FakeCourse>;
}

interface Sent {
  chat: string;
  text: string;
  silent: boolean;
}

const servers: FakeServer[] = [];
const temps: string[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

function canvasHandler(state: CanvasState) {
  return (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!state.auth) return sendJson(res, 401, { errors: [{ message: 'Invalid access token.' }] });
    if (url.pathname === '/api/v1/users/self') return sendJson(res, 200, { id: 42 });
    if (url.pathname === '/api/v1/announcements') {
      const codes = url.searchParams.getAll('context_codes[]');
      return sendJson(res, 200, state.announcements.filter((a) => codes.includes(String(a['context_code']))));
    }
    const m = /^\/api\/v1\/courses\/(\d+)\/(assignments|students\/submissions)$/.exec(url.pathname);
    if (m !== null) {
      const course = state.courses[Number(m[1])];
      const value = m[2] === 'assignments' ? course?.assignments : course?.submissions;
      if (value === undefined) return sendJson(res, 404, { errors: [{ message: 'not found' }] });
      if (typeof value === 'number') return sendJson(res, value, { errors: [{ message: 'failure' }] });
      return sendJson(res, 200, value);
    }
    sendJson(res, 404, {});
  };
}

async function harness(): Promise<{
  state: CanvasState;
  sent: Sent[];
  telegramMode: { value: 'ok' | 'forbidden' };
  clock: Clock & { set(iso: string): void };
  ctx(options?: { dryRun?: boolean }): RunContext;
  client: Client;
  telegramUrl: string;
}> {
  const state: CanvasState = {
    auth: true,
    announcements: [],
    courses: {
      10001: { assignments: [], submissions: [] },
      10002: { assignments: [], submissions: [] },
    },
  };
  const canvas = await startServer(canvasHandler(state));
  servers.push(canvas);

  const sent: Sent[] = [];
  const telegramMode = { value: 'ok' as 'ok' | 'forbidden' };
  const telegram = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const body = JSON.parse(raw) as { chat_id: string; text: string; disable_notification: boolean };
      if (telegramMode.value === 'forbidden') {
        return sendJson(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' });
      }
      sent.push({ chat: String(body.chat_id), text: body.text, silent: body.disable_notification });
      sendJson(res, 200, { ok: true, result: { message_id: sent.length } });
    });
  });
  servers.push(telegram);

  const dir = await mkdtemp(path.join(tmpdir(), 'canvas-sync-'));
  temps.push(dir);
  const client = createClient({ url: `file:${path.join(dir, 'sync.db')}` });
  await client.execute('PRAGMA foreign_keys = ON');

  let current = new Date('2026-09-11T04:00:00Z'); // 12:00 SGT
  const clock = { now: () => new Date(current.getTime()), set: (iso: string) => void (current = new Date(iso)) };
  await migrate(client, silentLogger(), clock, { dryRun: false });

  const liveDb = createDb(client, silentLogger(), false);
  for (const [key, value] of [
    ['canvas_base_url', `${canvas.url}/api/v1`],
    ['canvas_token', 'test-token'],
    ['canvas_token_expires_at', '2026-12-31T00:00:00Z'],
    ['raw_capture_enabled', 'false'],
    ['telegram_bot_token', ['123456789', 'B'.repeat(35)].join(':')],
    ['telegram_content_chat_id', '111'],
    ['telegram_ops_chat_id', '-222'],
  ] as const) {
    await setConfig(liveDb, clock, key, value);
  }
  for (const [contextId, canvasId, code] of [[1, 10001, 'AB1234'], [2, 10002, 'CD3456']] as const) {
    await client.execute({
      sql: `INSERT INTO contexts (context_id, context_type, canvas_id, enabled, coverage_status, first_seen_at)
            VALUES (?, 'course', ?, 1, 'full', ?)`,
      args: [contextId, canvasId, '2026-09-10T00:00:00Z'],
    });
    await client.execute({
      sql: `INSERT INTO courses (context_id, canvas_course_id, module_code, term) VALUES (?, ?, ?, '2610')`,
      args: [contextId, canvasId, code],
    });
  }

  return {
    state,
    sent,
    telegramMode,
    clock,
    client,
    telegramUrl: telegram.url,
    ctx: (options = {}) => {
      const log = silentLogger();
      return {
        runId: randomUUID(),
        command: 'sync',
        dryRun: options.dryRun === true,
        unsafeLog: false,
        ci: false,
        scheduledFor: undefined,
        startedAt: clock.now(),
        clock,
        log,
        db: createDb(client, log, options.dryRun === true),
        bootstrap: {} as RunContext['bootstrap'],
      };
    },
  };
}

type H = Awaited<ReturnType<typeof harness>>;
const sync = (h: H, options: { dryRun?: boolean } = {}) =>
  runSync(h.ctx(options), { telegramApiBase: h.telegramUrl });

function announcement(id: number, course: number, title: string, message = '<p>Body</p>') {
  return { id, title, message, posted_at: '2026-09-10T02:00:00Z', context_code: `course_${course}`, html_url: `https://canvas.example/a/${id}` };
}

function assignment(id: number, due: string, over: Record<string, unknown> = {}) {
  return { id, name: `Assignment ${id}`, due_at: due, published: true, html_url: `https://canvas.example/as/${id}`, all_dates: [{ due_at: due }], ...over };
}

const content = (h: H) => h.sent.filter((s) => s.chat === '111');
const ops = (h: H) => h.sent.filter((s) => s.chat === '-222');

// --- scenarios ---------------------------------------------------------------

describe('sync end to end', () => {
  let h: H;
  beforeEach(async () => {
    h = await harness();
  });

  it('first run baselines silently and sends exactly one "now watching" summary', async () => {
    h.state.announcements = [announcement(1, 10001, 'Welcome'), announcement(2, 10001, 'Week 2'), announcement(3, 10002, 'Hello')];
    (h.state.courses[10001] as FakeCourse).assignments = [assignment(5, '2026-09-19T15:59:00Z')];

    const outcome = await sync(h);

    assert.equal(outcome.status, 'ok');
    assert.equal(outcome.notified, 0, 'nothing already on Canvas may be notified');
    assert.equal(outcome.baselined, 4);
    // An unsubmitted, unposted submission is stored but is not a "grade".
    assert.equal(content(h).length, 1);
    assert.match(content(h)[0]?.text ?? '', /Now watching/);
    assert.match(content(h)[0]?.text ?? '', /AB1234<\/b> — 2 announcements, 1 assignment\n/);
    assert.equal(ops(h).length, 0, 'a healthy first run raises no alerts');
  });

  it('a second identical run sends nothing', async () => {
    h.state.announcements = [announcement(1, 10001, 'Welcome')];
    await sync(h);
    h.sent.length = 0;
    const outcome = await sync(h);
    assert.equal(outcome.notified, 0);
    assert.equal(h.sent.length, 0);
  });

  it('notifies a new announcement after the baseline, in its own course batch', async () => {
    await sync(h);
    h.sent.length = 0;
    h.state.announcements = [announcement(9, 10002, 'Tutorial 6 moved', '<p>Now on <b>Friday</b>.</p>')];

    const outcome = await sync(h);

    assert.equal(outcome.notified, 1);
    const msg = content(h)[0]?.text ?? '';
    assert.match(msg, /<b>CD3456<\/b> · 1 new/);
    assert.match(msg, /Tutorial 6 moved/);
    assert.match(msg, /Now on Friday\./, 'preview is plain text, instructor markup stripped');
  });

  it('notifies BOTH of two successive due date changes (the batch-key collision)', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    course.assignments = [assignment(5, '2026-09-19T15:59:00Z')];
    await sync(h);
    h.sent.length = 0;

    course.assignments = [assignment(5, '2026-09-22T15:59:00Z')];
    await sync(h);
    course.assignments = [assignment(5, '2026-09-25T15:59:00Z')];
    await sync(h);

    const changes = content(h).filter((s) => s.text.includes('Due date changed'));
    assert.equal(changes.length, 2, 'the second change must not be swallowed by the UNIQUE constraint');
    assert.match(changes[1]?.text ?? '', /Tue 22 Sep, 23:59 → <b>Fri 25 Sep, 23:59<\/b>/);
  });

  it('announces a grade only when it is posted', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    course.assignments = [assignment(5, '2026-09-01T15:59:00Z', { points_possible: 10 })];
    course.submissions = [{ id: 70, assignment_id: 5, workflow_state: 'graded', posted_at: null, score: null }];
    await sync(h);
    h.sent.length = 0;

    await sync(h);
    assert.equal(content(h).length, 0, 'still held: nothing to say');

    course.submissions = [{ id: 70, assignment_id: 5, workflow_state: 'graded', posted_at: '2026-09-11T03:00:00Z', score: 8 }];
    await sync(h);
    assert.match(content(h)[0]?.text ?? '', /Grade posted: .*Assignment 5.* — <b>8 \/ 10<\/b>/);
  });

  it('treats an empty announcements list from an unreadable course as unverified, not quiet (D-38)', async () => {
    h.state.courses[10002] = { assignments: 404, submissions: 404 };

    const outcome = await sync(h);

    assert.equal(outcome.status, 'partial');
    const mark = await h.client.execute(
      "SELECT last_status, baselined_at FROM watermarks WHERE context_id = 2 AND resource_type = 'announcement'",
    );
    assert.equal(mark.rows[0]?.['last_status'], 'unverified');
    assert.equal(mark.rows[0]?.['baselined_at'], null, 'an unverified empty list must not be baselined');
    assert.doesNotMatch(content(h)[0]?.text ?? '', /CD3456/, 'the unreadable course is not "now watched"');
  });

  it('isolates a failing course: the other still commits and notifies', async () => {
    await sync(h);
    h.sent.length = 0;
    h.state.courses[10002] = { assignments: 422, submissions: 422 };
    h.state.announcements = [announcement(11, 10001, 'Still arrives')];

    const outcome = await sync(h);

    assert.equal(outcome.status, 'partial');
    assert.equal(outcome.failedContexts, 1);
    assert.match(content(h)[0]?.text ?? '', /Still arrives/);
  });

  it('holds non-urgent news through quiet hours, then sends one overnight digest', async () => {
    await sync(h);
    h.sent.length = 0;

    h.clock.set(sgtToUtc(2026, 9, 11, 23, 30).toISOString());
    h.state.announcements = [announcement(20, 10001, 'Late note')];
    await sync(h);
    h.clock.set(sgtToUtc(2026, 9, 12, 2, 10).toISOString());
    h.state.announcements.push(announcement(21, 10002, 'Later note'));
    await sync(h);
    assert.equal(content(h).length, 0, 'nothing may buzz between 22:00 and 07:00');

    h.clock.set(sgtToUtc(2026, 9, 12, 7, 5).toISOString());
    await sync(h);

    assert.equal(content(h).length, 1, 'one digest, not a burst');
    assert.match(content(h)[0]?.text ?? '', /Overnight<\/b> · 2 updates/);
    assert.match(content(h)[0]?.text ?? '', /Late note[\s\S]*Later note/);
  });

  it('breaks quiet hours only for a deadline inside 12 hours', async () => {
    await sync(h);
    h.sent.length = 0;

    const at = sgtToUtc(2026, 9, 11, 23, 30);
    h.clock.set(at.toISOString());
    const dueSoon = new Date(at.getTime() + 6 * 3600_000).toISOString();
    (h.state.courses[10001] as FakeCourse).assignments = [assignment(30, dueSoon)];
    await sync(h);

    assert.equal(content(h).length, 1, 'an imminent deadline is sent immediately');
    assert.match(content(h)[0]?.text ?? '', /in 6h/);
  });

  it('pages a Canvas 401 once, stays quiet while it persists, and announces the fix', async () => {
    await sync(h);
    h.sent.length = 0;

    h.state.auth = false;
    const failed = await sync(h);
    assert.equal(failed.status, 'failed');
    assert.equal(ops(h).length, 1);
    assert.match(ops(h)[0]?.text ?? '', /Canvas rejected the token/);

    await sync(h);
    assert.equal(ops(h).length, 1, 'a known outage must not page again every run');

    h.state.auth = true;
    await sync(h);
    assert.equal(ops(h).length, 2);
    assert.match(ops(h)[1]?.text ?? '', /Resolved/);
    assert.equal(content(h).length, 0, 'operational alerts never reach the content chat');
  });

  it('delivers operational alerts at night silently rather than holding them', async () => {
    await sync(h);
    h.sent.length = 0;
    h.clock.set(sgtToUtc(2026, 9, 11, 3, 0).toISOString());
    h.state.auth = false;
    await sync(h);
    assert.equal(ops(h).length, 1);
    assert.equal(ops(h)[0]?.silent, true, 'waiting on waking, without waking me');
  });

  it('climbs the token expiry ladder without false "resolved" messages', async () => {
    const db = createDb(h.client, silentLogger(), false);
    await setConfig(db, h.clock, 'canvas_token_expires_at', '2026-09-24T00:00:00Z'); // 12.8 days
    await sync(h);
    assert.match(ops(h).at(-1)?.text ?? '', /expires in 12 days/);

    h.clock.set('2026-09-18T04:00:00Z'); // 5.8 days
    await sync(h);
    const texts = ops(h).map((s) => s.text);
    assert.match(texts.at(-1) ?? '', /expires in 5 days/);
    assert.ok(!texts.some((t) => t.includes('Resolved')), 'climbing a rung is not a recovery');

    await setConfig(db, h.clock, 'canvas_token_expires_at', '2026-12-15T00:00:00Z'); // rotated
    await sync(h);
    assert.match(ops(h).at(-1)?.text ?? '', /Resolved/);
  });

  it('marks undeliverable notifications failed and fails the run', async () => {
    await sync(h);
    h.telegramMode.value = 'forbidden';
    h.state.announcements = [announcement(40, 10001, 'Unsendable')];
    const outcome = await sync(h);
    assert.equal(outcome.status, 'failed', 'a failed run is the escape hatch when Telegram itself is down');
    const row = await h.client.execute("SELECT state, last_error FROM notifications WHERE channel = 'content' ORDER BY id DESC LIMIT 1");
    assert.equal(row.rows[0]?.['state'], 'failed');
    assert.match(String(row.rows[0]?.['last_error']), /blocked/);
  });

  it('writes nothing and sends nothing under --dry-run, but previews what it would send', async () => {
    await sync(h);
    h.sent.length = 0;
    h.state.announcements = [announcement(50, 10001, 'Preview me')];
    const before = await h.client.execute('SELECT count(*) AS n FROM items');

    const outcome = await sync(h, { dryRun: true });

    const afterCount = await h.client.execute('SELECT count(*) AS n FROM items');
    assert.equal(Number(afterCount.rows[0]?.['n']), Number(before.rows[0]?.['n']));
    assert.equal(h.sent.length, 0);
    assert.equal(outcome.planned.length, 1);
  });

  it('skips cleanly when another run holds a fresh lock', async () => {
    await h.client.execute({
      sql: 'UPDATE sync_lock SET holder = ?, locked_at = ?, heartbeat_at = ? WHERE id = 1',
      args: ['someone-else', h.clock.now().toISOString(), h.clock.now().toISOString()],
    });
    const outcome = await sync(h);
    assert.equal(outcome.status, 'skipped');
    assert.equal(h.sent.length, 0);
  });

  it('refuses to run against a schema behind the code, naming the fix', async () => {
    await h.client.execute("DELETE FROM schema_migrations WHERE version = '0006_ingest'");
    await assert.rejects(
      () => sync(h),
      (e: unknown) => e instanceof Error && e.message.includes('0006_ingest not applied'),
    );
    assert.equal(h.sent.length, 0);
  });

  it('takes over a lock abandoned for more than 15 minutes', async () => {
    const stale = new Date(h.clock.now().getTime() - 16 * 60_000).toISOString();
    await h.client.execute({
      sql: 'UPDATE sync_lock SET holder = ?, locked_at = ?, heartbeat_at = ? WHERE id = 1',
      args: ['crashed-run', stale, stale],
    });
    const outcome = await sync(h);
    assert.equal(outcome.status, 'ok');
    const lock = await h.client.execute('SELECT holder FROM sync_lock WHERE id = 1');
    assert.equal(lock.rows[0]?.['holder'], null, 'released after the run');
  });
});
