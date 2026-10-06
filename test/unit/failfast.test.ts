/**
 * Fail fast (DECISIONS.md D-77): a slow service fails its own part quickly,
 * and the gap report says what GitHub did with the runs in a gap.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { createClient } from '@libsql/client';
import { fetchWithTimeout } from '../../src/core/db/timeout-fetch.ts';
import { CanvasHttp } from '../../src/canvas/http.ts';
import { RateLimitGovernor } from '../../src/canvas/rate-limit.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { RunBudget } from '../../src/sync/budget.ts';
import { describeGap, explainGap, gapRunsFromEnvironment } from '../../src/sync/gap-runs.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

/** A server that accepts connections and never answers. */
async function silentServer(): Promise<string> {
  const server = createServer(() => { /* never respond */ });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

describe('Turso request timeout', () => {
  it('a database that never answers fails the query quickly instead of hanging the run', { timeout: 5_000 }, async () => {
    const url = await silentServer();
    const client = createClient({ url, authToken: 't', fetch: fetchWithTimeout(200) });
    const started = Date.now();
    await assert.rejects(() => client.execute('SELECT 1'));
    assert.ok(Date.now() - started < 3_000, `took ${Date.now() - started} ms`);
    client.close();
  });

  it('both databases use it: the main one and the read model', () => {
    for (const file of ['src/core/db/client.ts', 'src/readmodel/cli.ts']) {
      const code = readFileSync(file, 'utf8');
      const clients = [...code.matchAll(/createClient\(\{([^}]*)\}\)/gs)].map((m) => m[1]!);
      assert.ok(clients.length > 0, file);
      for (const c of clients.filter((c) => !/url: env\('TURSO_DATABASE_URL'\)|url: env\('READMODEL_DATABASE_URL'\), authToken: env\('TURSO_AUTH_TOKEN'\)/.test(c))) {
        assert.match(c, /fetch: fetchWithTimeout\(\)/, `${file}: a client without the timeout`);
      }
    }
  });
});

describe('Canvas deadline', () => {
  const http = (fetchImpl: typeof fetch) => new CanvasHttp({
    baseUrl: 'https://canvas.example.test/api/v1', token: 't', log: silentLogger(), clock: fixedClock('2026-10-06T00:00:00Z'),
    governor: new RateLimitGovernor(silentLogger()), rawStore: { capture: async () => {} } as never, fetchImpl,
  });
  const hanging: typeof fetch = (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'TimeoutError' })));
  });

  it('a request still running at the deadline is cut off, and not retried past it', { timeout: 5_000 }, async () => {
    const h = http(hanging);
    h.setDeadline(Date.now() + 300);
    const started = Date.now();
    const result = await h.get('/courses/1');
    assert.equal(result.kind, 'error');
    assert.ok(Date.now() - started < 1_500, `took ${Date.now() - started} ms`);
  });

  it('no request starts after the deadline', async () => {
    let calls = 0;
    const h = http(async () => { calls += 1; return new Response('{}'); });
    h.setDeadline(Date.now() - 1);
    const result = await h.get('/courses/1');
    assert.equal(result.kind, 'error');
    assert.equal(calls, 0);
    h.setDeadline(null);
    assert.equal((await h.get('/courses/1')).kind, 'ok', 'lifting the deadline lifts the limit');
  });
});

describe('run budget', () => {
  it('stops work before the end, leaving the reserve for finishing', () => {
    let t = 1_000;
    const b = new RunBudget({ runMs: 480_000, reserveMs: 90_000, courseMs: 90_000, integrityMs: 60_000 }, () => t);
    assert.equal(b.workDeadline, 1_000 + 390_000);
    assert.equal(b.deadlineFor(90_000), 1_000 + 90_000);
    t = 1_000 + 350_000;
    assert.equal(b.deadlineFor(90_000), b.workDeadline, 'a part never runs past the work deadline');
    assert.equal(b.workExhausted(), false);
    t = b.workDeadline;
    assert.equal(b.workExhausted(), true);
    assert.ok(b.finishDeadline > b.workDeadline && b.finishDeadline < 1_000 + 480_000);
  });

  it('the run budget ends well inside the 10-minute job timeout', async () => {
    const { DEFAULT_BUDGETS } = await import('../../src/sync/budget.ts');
    const yaml = readFileSync('.github/workflows/sync.yml', 'utf8');
    const jobMs = Number(/timeout-minutes:\s*(\d+)/.exec(yaml)?.[1]) * 60_000;
    assert.ok(DEFAULT_BUDGETS.runMs <= jobMs - 90_000, 'leave at least 90 s for setup before the sync starts');
  });
});

describe('gap report: what GitHub did with the runs in a gap', () => {
  it('explains the runs: cancelled before starting, failed before starting, waiting, never created', () => {
    const runs = [
      { id: '1', status: 'completed', conclusion: 'cancelled' },
      { id: '2', status: 'completed', conclusion: 'failure' },
      { id: '3', status: 'queued', conclusion: null },
      { id: '4', status: 'completed', conclusion: 'success' }, // reached our sync
    ];
    const e = explainGap(6, runs, new Set(['4']));
    assert.deepEqual(e, { cancelled: 1, failedBeforeStart: 1, stillWaiting: 1, neverCreated: 3 });
    assert.equal(describeGap(6, e), '6 scheduled slots produced no sync: GitHub created 1 run but cancelled it before it started (no machine was assigned in time); 1 run failed before the sync itself started; 1 run is still waiting for a machine; GitHub never created a run for 3 slots.');
    assert.equal(describeGap(5, null), "5 scheduled slots produced no sync (GitHub's run history could not be read to say why).");
  });

  it("reads this repository's scheduled runs in the gap, with the job's token, and never fails the sync", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const fake: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('authorization') });
      return Response.json({ workflow_runs: [{ id: 7, status: 'completed', conclusion: 'cancelled' }, { id: 9, status: 'in_progress', conclusion: null }] });
    };
    const lookup = gapRunsFromEnvironment({ ACTIONS_READ_TOKEN: 'tok', GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '9' }, fake);
    const runs = await lookup(new Date('2026-10-05T19:00:00Z'), new Date('2026-10-05T21:30:00Z'));
    assert.deepEqual(runs, [{ id: '7', status: 'completed', conclusion: 'cancelled' }], 'this run itself is left out');
    assert.match(calls[0]!.url, /^https:\/\/api\.github\.com\/repos\/owner\/repo\/actions\/workflows\/sync\.yml\/runs\?event=schedule&per_page=100&created=2026-10-05T19%3A00%3A00\.000Z\.\.2026-10-05T21%3A30%3A00\.000Z$/);
    assert.equal(calls[0]!.auth, 'Bearer tok');

    assert.equal(await gapRunsFromEnvironment({}, fake)(new Date(), new Date()), null, 'no token: cannot tell');
    assert.equal(await gapRunsFromEnvironment({ ACTIONS_READ_TOKEN: 't', GITHUB_REPOSITORY: 'x/y/../z' }, fake)(new Date(), new Date()), null, 'a strange repository name is refused');
    const failing: typeof fetch = async () => { throw new Error('network down'); };
    assert.equal(await gapRunsFromEnvironment({ ACTIONS_READ_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, failing)(new Date(), new Date()), null);
    const refused: typeof fetch = async () => new Response('{}', { status: 403 });
    assert.equal(await gapRunsFromEnvironment({ ACTIONS_READ_TOKEN: 't', GITHUB_REPOSITORY: 'o/r' }, refused)(new Date(), new Date()), null);
  });
});
