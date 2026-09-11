import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRawStore, hasNoReplayValue, pruneRawCaptures, scrubUrl } from '../../src/canvas/raw-store.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';

const clock = fixedClock('2026-08-27T05:00:00Z');
const temps: string[] = [];

after(async () => {
  await Promise.all(temps.map((dir) => rm(dir, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'canvas-raw-'));
  temps.push(dir);
  return dir;
}

async function onlyCapture(root: string): Promise<Record<string, unknown>> {
  const days = await readdir(root);
  const day = days[0] ?? '';
  const runs = await readdir(path.join(root, day));
  const run = runs[0] ?? '';
  const files = await readdir(path.join(root, day, run));
  const file = files[0] ?? '';
  return JSON.parse(await readFile(path.join(root, day, run, file), 'utf8')) as Record<string, unknown>;
}

describe('raw capture', () => {
  it('redacts third-party personal data before anything reaches disk', async () => {
    // DECISIONS.md D-11. These captures carry other students' names and emails
    // from discussion topics and submission comments. Redaction happens before
    // the first write, not after the first incident.
    const root = await tempRoot();
    const store = createRawStore({ runId: 'run-1', enabled: true, log: silentLogger(), clock, root });

    await store.capture({
      method: 'GET',
      url: 'https://canvas.nus.edu.sg/api/v1/courses/1/discussion_topics',
      status: 200,
      headers: new Headers({ 'x-rate-limit-remaining': '694' }),
      body: [
        {
          id: 5,
          title: 'Week 6 thread',
          message: 'Reply to me at e0123456@u.nus.edu -- A0234567X',
          author: { id: 88, display_name: 'Another Student', avatar_url: 'https://x/y.png' },
        },
      ],
      durationMs: 42,
    });

    const captured = await onlyCapture(root);
    const serialised = JSON.stringify(captured);

    assert.ok(!serialised.includes('e0123456@u.nus.edu'), 'an email survived redaction');
    assert.ok(!serialised.includes('A0234567X'), 'a matriculation number survived redaction');
    assert.ok(!serialised.includes('Another Student'), 'a third-party name survived redaction');
    assert.ok(serialised.includes('Week 6 thread'), 'the content itself should still be replayable');
    assert.equal((captured['headers'] as Record<string, string>)['x-rate-limit-remaining'], '694');
  });

  it('keeps message bodies, because replay needs the response shape', async () => {
    // Logs drop bodies; captures keep them. Different jobs, same redaction hook.
    const root = await tempRoot();
    const store = createRawStore({ runId: 'run-2', enabled: true, log: silentLogger(), clock, root });
    await store.capture({
      method: 'GET',
      url: 'https://canvas.nus.edu.sg/api/v1/announcements',
      status: 200,
      headers: new Headers(),
      body: [{ id: 1, message: 'Tutorial 6 is postponed to Friday.' }],
      durationMs: 10,
    });

    const captured = await onlyCapture(root);
    assert.ok(JSON.stringify(captured).includes('Tutorial 6 is postponed'));
  });

  it('does not capture endpoints that replay never consults', () => {
    // /users/self exists only to check the token. Capturing it would store the
    // account holder's name to buy nothing: replay re-runs classification,
    // routing and version grouping, none of which consult who I am.
    assert.equal(hasNoReplayValue('https://canvas.nus.edu.sg/api/v1/users/self'), true);
    assert.equal(hasNoReplayValue('https://canvas.nus.edu.sg/api/v1/courses'), false);
  });

  it('strips credentials from captured URLs', () => {
    // File URLs carry a time-limited verifier token; it must never persist.
    const scrubbed = scrubUrl('https://canvas.nus.edu.sg/files/9/download?verifier=abc123&wrap=1');
    assert.ok(!scrubbed.includes('abc123'));
    assert.match(scrubbed, /verifier=%5Bredacted%5D|verifier=\[redacted\]/);
  });

  it('writes nothing when capture is disabled', async () => {
    const root = await tempRoot();
    const store = createRawStore({ runId: 'run-3', enabled: false, log: silentLogger(), clock, root });
    await store.capture({
      method: 'GET', url: 'https://x/api/v1/courses', status: 200,
      headers: new Headers(), body: [], durationMs: 1,
    });
    assert.deepEqual(await readdir(root), []);
  });

  it('never lets a capture failure fail the caller', async () => {
    const store = createRawStore({
      runId: 'run-4', enabled: true, log: silentLogger(), clock,
      root: '/proc/definitely-not-writable/nope',
    });
    await assert.doesNotReject(() =>
      store.capture({
        method: 'GET', url: 'https://x/api/v1/courses', status: 200,
        headers: new Headers(), body: [], durationMs: 1,
      }),
    );
  });
});

describe('capture retention', () => {
  it('deletes day directories past the retention window', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, '2026-01-01', 'old-run'), { recursive: true });
    await mkdir(path.join(root, '2026-08-20', 'recent-run'), { recursive: true });
    await mkdir(path.join(root, 'not-a-day'), { recursive: true });

    const outcome = await pruneRawCaptures({
      root, retentionDays: 60, now: clock.now(), log: silentLogger(), dryRun: false,
    });

    assert.deepEqual(outcome.deletedDays, ['2026-01-01']);
    assert.deepEqual(outcome.keptDays, ['2026-08-20']);

    const remaining = await readdir(root);
    assert.ok(!remaining.includes('2026-01-01'));
    assert.ok(remaining.includes('2026-08-20'));
    assert.ok(remaining.includes('not-a-day'), 'unrecognised entries are left alone');
  });

  it('deletes nothing under --dry-run', async () => {
    const root = await tempRoot();
    await mkdir(path.join(root, '2026-01-01', 'old-run'), { recursive: true });

    const outcome = await pruneRawCaptures({
      root, retentionDays: 60, now: clock.now(), log: silentLogger(), dryRun: true,
    });

    assert.deepEqual(outcome.deletedDays, ['2026-01-01']);
    assert.ok((await readdir(root)).includes('2026-01-01'), '--dry-run must not delete');
  });

  it('is a no-op when nothing has been captured yet', async () => {
    const outcome = await pruneRawCaptures({
      root: path.join(await tempRoot(), 'missing'),
      retentionDays: 60, now: clock.now(), log: silentLogger(), dryRun: false,
    });
    assert.deepEqual(outcome.deletedDays, []);
  });
});
