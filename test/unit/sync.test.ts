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
  files?: unknown[] | number;
  folders?: unknown[] | number;
  modules?: unknown[] | number;
}

interface CanvasState {
  auth: boolean;
  announcements: Array<Record<string, unknown>>;
  courses: Record<number, FakeCourse>;
  groups: Record<number, { files?: unknown[] | number; folders?: unknown[] | number }>;
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
    const m = /^\/api\/v1\/(courses|groups)\/(\d+)\/(assignments|students\/submissions|files|folders|modules)$/.exec(url.pathname);
    if (m !== null) {
      const owner = m[1] === 'courses' ? state.courses[Number(m[2])] : state.groups[Number(m[2])];
      const field = m[3] === 'students/submissions' ? 'submissions' : (m[3] as string);
      const defaults: Record<string, unknown[]> = { files: [], folders: [{ id: 1, full_name: 'course files' }], modules: [] };
      const value = owner === undefined ? undefined : ((owner as Record<string, unknown>)[field] ?? defaults[field]);
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
  ctx(options?: { dryRun?: boolean; scheduledFor?: Date }): RunContext;
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
    groups: {},
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
        scheduledFor: options.scheduledFor,
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
const sync = (h: H, options: { dryRun?: boolean; scheduledFor?: Date } = {}) =>
  runSync(h.ctx(options), { telegramApiBase: h.telegramUrl });

/** Record a completed scheduled run, as startRun would have. */
async function priorRun(h: H, slot: string): Promise<void> {
  await h.client.execute({
    sql: `INSERT INTO runs (run_id, command, dry_run, scheduled_for, started_at, status) VALUES (?, 'sync', 0, ?, ?, 'ok')`,
    args: [randomUUID(), slot, slot],
  });
}

function announcement(id: number, course: number, title: string, message = '<p>Body</p>') {
  return { id, title, message, posted_at: '2026-09-10T02:00:00Z', context_code: `course_${course}`, html_url: `https://canvas.example/a/${id}` };
}

function file(id: number, name: string, over: Record<string, unknown> = {}) {
  return {
    id, display_name: name, filename: name, size: 1_300_000, folder_id: 7,
    created_at: '2026-09-15T14:14:00Z', updated_at: '2026-09-15T14:14:00Z', modified_at: '2026-09-15T14:14:00Z',
    hidden: false, hidden_for_user: false, locked: false, locked_for_user: false, upload_status: 'success',
    mime_class: 'pdf',
    // The real object carries a time-limited verifier. It must never be stored.
    url: `https://canvas.example/files/${id}/download?download_frd=1&verifier=SECRETVERIFIER${id}`,
    ...over,
  };
}

const FOLDERS = [
  { id: 1, full_name: 'course files' },
  { id: 7, full_name: 'course files/Week 06/Lecture Notes' },
  { id: 8, full_name: 'course files/Week 06/Practical Lab' },
];

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
    // An unreadable course denies everything readable -- files and modules
    // included -- while /announcements still answers with an empty success.
    h.state.courses[10002] = { assignments: 404, submissions: 404, files: 404, modules: 404 };

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

  it("alerts on the dashboard's read-only token expiry through the ops chat, from the recorded date only (D-66)", async () => {
    const db = createDb(h.client, silentLogger(), false);
    await sync(h);
    assert.ok(!ops(h).some((s) => s.text.includes('dashboard')), 'nothing recorded, no read model configured: silent');
    await setConfig(db, h.clock, 'dashboard_read_token_expires_at', '2026-09-17T00:00:00Z'); // 5.8 days
    await sync(h);
    assert.match(ops(h).at(-1)?.text ?? '', /The dashboard's read-only token expires in 5 days/);
    h.clock.set('2026-09-15T04:00:00Z'); // 1.8 days
    await sync(h);
    const texts = ops(h).map((s) => s.text);
    assert.match(texts.at(-1) ?? '', /expires in 1 day\b/);
    assert.ok(!texts.some((t) => t.includes('Resolved')), 'climbing a rung is not a recovery');
    await setConfig(db, h.clock, 'dashboard_read_token_expires_at', '2026-12-10T00:00:00Z'); // rotated
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

  // --- Phase 3: files ------------------------------------------------------------

  it('baselines existing files on the first sync instead of announcing them', async () => {
    Object.assign(h.state.courses[10001] as FakeCourse, { files: [file(1, 'Lecture 01.pdf'), file(2, 'Lecture 02.pdf')], folders: FOLDERS });
    const outcome = await sync(h);
    assert.equal(outcome.notified, 0);
    assert.match(content(h)[0]?.text ?? '', /AB1234<\/b> — 2 files/);
  });

  it('announces a silently uploaded file, with where it is and how big', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [file(1, 'Lecture 01.pdf')], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;

    course.files = [file(1, 'Lecture 01.pdf'), file(2, 'Exam Revision Pack.pdf', { size: 299_330, folder_id: 1 })];
    const outcome = await sync(h);

    assert.equal(outcome.notified, 1);
    const msg = content(h)[0]?.text ?? '';
    assert.match(msg, /📄 <a href="http:\/\/127\.0\.0\.1:\d+\/courses\/10001\/files\/2"><b>Exam Revision Pack\.pdf<\/b><\/a> — 292 KB/);
    assert.doesNotMatch(msg, /\/api\/v1/, 'the link must open the file page, not the API');
    assert.doesNotMatch(msg, /course files/, 'the root folder name is noise');
  });

  it('sends a lecture drop as one message, each file with its folder', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;

    course.files = [
      file(10, 'Lecture 06.pptx', { size: 3_312_020 }),
      file(11, 'Lecture 06.pdf'),
      file(12, 'src.zip', { size: 6_313 }),
      file(13, 'Lab Sheet 4.pdf', { folder_id: 8 }),
    ];
    await sync(h);

    assert.equal(content(h).length, 1, 'one message, not four');
    const msg = content(h)[0]?.text ?? '';
    assert.match(msg, /AB1234<\/b> · 4 new/);
    assert.match(msg, /Lecture 06\.pptx<\/b><\/a> — 3\.2 MB · Week 06\/Lecture Notes/);
    assert.match(msg, /src\.zip<\/b><\/a> — 6 KB · Week 06\/Lecture Notes/);
    assert.match(msg, /Lab Sheet 4\.pdf<\/b><\/a> — 1\.2 MB · Week 06\/Practical Lab/);
  });

  it('ignores updated_at churn and folder moves: zero false positives', async () => {
    // Observed live: updated_at moves with no content change, and instructors
    // reorganise folders. Neither is news.
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [file(1, 'Lab 03.pdf')], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;

    course.files = [file(1, 'Lab 03.pdf', { updated_at: '2026-09-17T00:59:00Z', folder_id: 8 })];
    const outcome = await sync(h);
    assert.equal(outcome.notified, 0);
    assert.equal(h.sent.length, 0);
  });

  it('keeps a copied file with modified_at before created_at quiet', async () => {
    // Files copied from an earlier offering keep their original modified_at.
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [file(1, 'dataset.csv', { modified_at: '2023-06-01T00:00:00Z' })], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;
    await sync(h);
    assert.equal(h.sent.length, 0);
  });

  it('reports a rename and a new version of the same file distinctly', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [file(1, 'Tutorial 6.pdf'), file(2, 'Slides.pdf', { size: 1_000_000 })], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;

    course.files = [
      file(1, 'Tutorial 6 (corrected).pdf'),
      file(2, 'Slides.pdf', { size: 1_500_000, modified_at: '2026-09-17T01:00:00Z' }),
    ];
    await sync(h);

    const msg = content(h)[0]?.text ?? '';
    assert.match(msg, /Updated: .*Tutorial 6 \(corrected\)\.pdf.* — renamed from “Tutorial 6\.pdf”/);
    assert.match(msg, /Updated: .*Slides\.pdf.* — new version \(977 KB → 1\.4 MB\)/);
  });

  it('holds a hidden file back, then announces it when it becomes available', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;

    course.files = [file(5, 'Answers.pdf', { hidden_for_user: true, locked_for_user: true })];
    await sync(h);
    assert.equal(h.sent.length, 0, 'not accessible yet: not news');

    course.files = [file(5, 'Answers.pdf')];
    await sync(h);
    assert.match(content(h)[0]?.text ?? '', /Now available: .*Answers\.pdf/);
  });

  it('holds back a file that is still uploading', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;
    course.files = [file(6, 'Big.pptx', { upload_status: 'pending' })];
    await sync(h);
    assert.equal(h.sent.length, 0);
  });

  it('never stores the time-limited download URL', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [], folders: FOLDERS });
    await sync(h);
    course.files = [file(1, 'Lecture 01.pdf')];
    await sync(h);
    for (const table of ['items', 'notifications']) {
      const rows = await h.client.execute(`SELECT * FROM ${table}`);
      assert.doesNotMatch(JSON.stringify(rows.rows), /SECRETVERIFIER|verifier=/, `verifier leaked into ${table}`);
    }
  });

  it('degrades visibly when the Files tab is hidden: one alert, no false flood', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [file(1, 'Lecture 01.pdf'), file(2, 'Lab 01.pdf')], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;

    // The instructor hides the Files tab; both files are still linked in Modules.
    Object.assign(course, {
      files: 404,
      modules: [{ id: 1, name: 'Week 1', items: [
        { id: 91, type: 'File', title: 'Lecture 01.pdf', content_id: 1, html_url: 'https://canvas.example/m/91', published: true },
        { id: 92, type: 'Page', title: 'Welcome' },
        { id: 93, type: 'File', title: 'Lab 01.pdf', content_id: 2, html_url: 'https://canvas.example/m/93', published: true },
      ] }],
    });
    const outcome = await sync(h);

    assert.equal(content(h).length, 0, 'the same files seen through Modules must not look "updated"');
    assert.equal(ops(h).length, 1);
    assert.match(ops(h)[0]?.text ?? '', /AB1234: file coverage reduced to Modules only \(2 files linked there\)/);
    assert.equal(outcome.status, 'ok', 'reduced coverage is not a failure; the alert carries it');
    const row = await h.client.execute('SELECT coverage_status FROM contexts WHERE context_id = 1');
    assert.equal(row.rows[0]?.['coverage_status'], 'modules_only');

    await sync(h);
    assert.equal(ops(h).length, 1, 'said once, not every run');

    // A new file linked in a module is still found, and the message says how.
    (course.modules as Array<{ items: unknown[] }>)[0]?.items.push(
      { id: 94, type: 'File', title: 'Lab 02.pdf', content_id: 3, html_url: 'https://canvas.example/m/94', published: true },
    );
    await sync(h);
    const msg = content(h)[0]?.text ?? '';
    assert.match(msg, /Lab 02\.pdf.* — module: Week 1/);
    assert.match(msg, /Read through Modules: the Files tab is hidden/);
  });

  it('recovers quietly when the Files tab returns: re-baseline, one "resolved"', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, {
      files: 404,
      modules: [{ id: 1, name: 'Week 1', items: [{ id: 91, type: 'File', title: 'Lecture 01.pdf', content_id: 1, published: true }] }],
    });
    await sync(h);
    h.sent.length = 0;

    // Back to full: three files existed all along, only one was linked.
    Object.assign(course, { files: [file(1, 'Lecture 01.pdf'), file(2, 'Unlinked A.pdf'), file(3, 'Unlinked B.pdf')], folders: FOLDERS });
    await sync(h);

    assert.equal(content(h).filter((s) => s.text.includes('📄')).length, 0, 'files that were there all along are not "new"');
    assert.match(content(h)[0]?.text ?? '', /Now watching[\s\S]*AB1234<\/b> — 3 files/);
    assert.match(ops(h)[0]?.text ?? '', /Resolved.*AB1234: file coverage reduced/);
  });

  it('does not flip coverage on a transient error', async () => {
    const course = h.state.courses[10001] as FakeCourse;
    Object.assign(course, { files: [file(1, 'Lecture 01.pdf')], folders: FOLDERS });
    await sync(h);
    h.sent.length = 0;
    course.files = 422;
    await sync(h);
    const row = await h.client.execute('SELECT coverage_status FROM contexts WHERE context_id = 1');
    assert.equal(row.rows[0]?.['coverage_status'], 'full');
    assert.equal(ops(h).length, 0);
  });

  it('says plainly when files cannot be read at all', async () => {
    Object.assign(h.state.courses[10001] as FakeCourse, { files: 403, modules: 403 });
    await sync(h);
    assert.match(ops(h)[0]?.text ?? '', /AB1234: files are not readable at all/);
    await sync(h);
    assert.equal(ops(h).length, 1);
  });

  it("says plainly, as a course, when its files cannot be read, with no decision number", async () => {
    Object.assign(h.state.courses[10001] as FakeCourse, { files: 403, modules: 403 });
    await sync(h);
    const text = ops(h)[0]?.text ?? '';
    assert.match(text, /If the course has ended, files not already archived can no longer be fetched/);
    assert.doesNotMatch(text, /D-\d/);
  });

  async function addGroup(): Promise<void> {
    await h.client.execute(`INSERT INTO contexts (context_id, context_type, canvas_id, enabled, coverage_status, first_seen_at)
                            VALUES (3, 'group', 20001, 1, 'unknown', '2026-09-10T00:00:00Z')`);
    await h.client.execute(`INSERT INTO groups (context_id, canvas_group_id, parent_canvas_course_id, parent_context_id, module_code, term)
                            VALUES (3, 20001, 10001, 1, 'AB1234', '2610')`);
  }

  it('a group that refuses its files is described as a group: left or moved, no course, no decision number (D-72)', async () => {
    await addGroup();
    h.state.groups[20001] = { files: [], folders: [] };
    await sync(h);
    h.sent.length = 0;
    h.state.groups[20001] = { files: 403, folders: 403 };
    await sync(h);
    const text = ops(h).map((m) => m.text).join('\n');
    assert.match(text, /AB1234 · group: this group's files can no longer be read/);
    assert.match(text, /left it or been moved to another group/);
    assert.doesNotMatch(text, /course|concluded|Modules|unrecoverable/i);
    assert.doesNotMatch(text, /D-\d/);
  });

  it('retiring a context closes its alerts quietly: no "Resolved", nothing left active (D-72)', async () => {
    await addGroup();
    h.state.groups[20001] = { files: [], folders: [] };
    await sync(h);
    h.state.groups[20001] = { files: 403, folders: 403 };
    await sync(h);
    const before = await h.client.execute("SELECT resolved_at FROM ops_alerts WHERE alert_key = 'coverage:3'");
    assert.equal(before.rows[0]?.['resolved_at'], null, 'the alert is active');
    h.sent.length = 0;

    await h.client.execute('UPDATE contexts SET enabled = 0 WHERE context_id = 3'); // the seed disables it
    await sync(h);
    const after = await h.client.execute("SELECT resolved_at FROM ops_alerts WHERE alert_key = 'coverage:3'");
    assert.notEqual(after.rows[0]?.['resolved_at'], null, 'closed');
    assert.equal(ops(h).length, 0, 'retired, not "Resolved": no message');
    const active = await h.client.execute("SELECT count(*) AS n FROM ops_alerts WHERE resolved_at IS NULL AND alert_key LIKE '%:3'");
    assert.equal(active.rows[0]?.['n'], 0);
  });

  it('watches enabled groups for files, labelled by their module', async () => {
    await h.client.execute(`INSERT INTO contexts (context_id, context_type, canvas_id, enabled, coverage_status, first_seen_at)
                            VALUES (3, 'group', 20001, 1, 'unknown', '2026-09-10T00:00:00Z')`);
    await h.client.execute(`INSERT INTO groups (context_id, canvas_group_id, parent_canvas_course_id, parent_context_id, module_code, term)
                            VALUES (3, 20001, 10001, 1, 'AB1234', '2610')`);
    h.state.groups[20001] = { files: [], folders: [{ id: 1, full_name: 'group files' }] };
    await sync(h);
    h.sent.length = 0;

    h.state.groups[20001] = { files: [file(40, 'Project Proposal.docx', { folder_id: 1 })], folders: [{ id: 1, full_name: 'group files' }] };
    await sync(h);

    const msg = content(h)[0]?.text ?? '';
    assert.match(msg, /<b>AB1234 · group<\/b> · 1 new/);
    assert.match(msg, /href="http:\/\/127\.0\.0\.1:\d+\/groups\/20001\/files\/40"/);
  });

  it('refuses to run against a schema behind the code, naming the fix', async () => {
    await h.client.execute("DELETE FROM schema_migrations WHERE version = '0007_file_items'");
    await assert.rejects(
      () => sync(h),
      (e: unknown) => e instanceof Error && e.message.includes('0007_file_items not applied'),
    );
    assert.equal(h.sent.length, 0);
  });

  it('reports a scheduling gap once, as an event, with no later "Resolved"', async () => {
    // The 2026-09-13 outage was sent as "running late" and then "Resolved" ten
    // minutes on, which made a 24-hour gap read as a blip.
    await sync(h);
    h.sent.length = 0;
    await priorRun(h, '2026-09-13T04:00:00.000Z');

    h.clock.set('2026-09-14T04:37:31Z');
    await sync(h, { scheduledFor: new Date('2026-09-14T04:20:00Z') });
    assert.equal(ops(h).length, 1);
    assert.match(ops(h)[0]?.text ?? '', /stopped for 24\.3 h and have now resumed/);
    assert.match(ops(h)[0]?.text ?? '', /54 scheduled runs never happened/);

    await priorRun(h, '2026-09-14T04:20:00.000Z');
    h.clock.set('2026-09-14T04:47:00Z');
    await sync(h, { scheduledFor: new Date('2026-09-14T04:40:00Z') });
    assert.equal(ops(h).length, 1, 'no follow-up "Resolved" for an event');
    assert.equal(content(h).length, 0);
  });

  it('says nothing about an on-time run or a single missed slot', async () => {
    await sync(h);
    h.sent.length = 0;
    await priorRun(h, '2026-09-17T04:00:00.000Z');
    h.clock.set('2026-09-17T04:47:00Z');
    await sync(h, { scheduledFor: new Date('2026-09-17T04:40:00Z') }); // skipped 04:20 only
    assert.equal(ops(h).length, 0);
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
