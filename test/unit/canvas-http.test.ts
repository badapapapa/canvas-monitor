import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { CanvasHttp } from '../../src/canvas/http.ts';
import { RateLimitGovernor } from '../../src/canvas/rate-limit.ts';
import { silentLogger } from '../../src/core/log.ts';
import { systemClock } from '../../src/core/clock.ts';
import { startServer, sendJson, sendText, type FakeServer } from '../helpers/fake-canvas.ts';

const noCapture = { enabled: false, capture: () => Promise.resolve() };

function makeHttp(baseUrl: string, maxAttempts = 3): CanvasHttp {
  return new CanvasHttp({
    baseUrl,
    token: 'test-token',
    log: silentLogger(),
    clock: systemClock,
    governor: new RateLimitGovernor(silentLogger()),
    rawStore: noCapture,
    maxAttempts,
    timeoutMs: 2_000,
  });
}

const servers: FakeServer[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<FakeServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

describe('CanvasHttp pagination', () => {
  it('follows rel="next" to exhaustion', async () => {
    const server = await serve((req, res) => {
      const page = new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1';
      if (page === '1') {
        sendJson(res, 200, [{ id: 1 }, { id: 2 }], {
          link: `<http://127.0.0.1:${port}/api/v1/courses?page=2>; rel="next"`,
        });
      } else {
        sendJson(res, 200, [{ id: 3 }]);
      }
    });
    const port = new URL(server.url).port;

    const result = await makeHttp(`${server.url}/api/v1`).list<{ id: number }>('/courses');
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' ? result.value.map((c) => c.id) : [], [1, 2, 3]);
  });

  it('sets per_page=100 so a single page is never assumed', async () => {
    const server = await serve((_req, res) => sendJson(res, 200, []));
    await makeHttp(`${server.url}/api/v1`).list('/courses');
    assert.match(server.requests[0]?.url ?? '', /per_page=100/);
  });

  it('fails the whole listing when a later page errors', async () => {
    // A partially-read collection reported as complete is the failure mode
    // SPEC.md section 2.2 exists to prevent.
    const server = await serve((req, res) => {
      const page = new URL(req.url ?? '', 'http://x').searchParams.get('page') ?? '1';
      if (page === '1') {
        sendJson(res, 200, [{ id: 1 }], { link: `<http://127.0.0.1:${port}/api/v1/files?page=2>; rel="next"` });
      } else {
        sendText(res, 500, 'boom');
      }
    });
    const port = new URL(server.url).port;

    const result = await makeHttp(`${server.url}/api/v1`, 1).list('/files');
    assert.equal(result.kind, 'error');
  });

  it('stops early when stopWhen matches, keeping preceding items', async () => {
    const server = await serve((_req, res) =>
      sendJson(res, 200, [{ id: 3, updated_at: 'c' }, { id: 2, updated_at: 'b' }, { id: 1, updated_at: 'a' }], {
        link: `<http://127.0.0.1:${port}/api/v1/files?page=2>; rel="next"`,
      }),
    );
    const port = new URL(server.url).port;

    const result = await makeHttp(`${server.url}/api/v1`).list<{ id: number; updated_at: string }>(
      '/files',
      { sort: 'updated_at', order: 'desc' },
      { stopWhen: (item) => item.updated_at <= 'b' },
    );
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' ? result.value.map((f) => f.id) : [], [3]);
    assert.equal(server.requests.length, 1, 'must not fetch page 2 after stopping');
  });
});

describe('CanvasHttp error handling', () => {
  it('maps 404 to denied_or_absent, not to an empty array', async () => {
    const server = await serve((_req, res) => sendJson(res, 404, { errors: [{ message: 'does not exist' }] }));
    const result = await makeHttp(`${server.url}/api/v1`).list('/courses/1/files');
    assert.equal(result.kind, 'denied_or_absent');
  });

  it('retries a 500 and succeeds on the next attempt', async () => {
    const server = await serve((_req, res, hits) => {
      if (hits === 1) sendText(res, 500, 'boom');
      else sendJson(res, 200, [{ id: 1 }]);
    });
    const result = await makeHttp(`${server.url}/api/v1`).list('/courses');
    assert.equal(result.kind, 'ok');
    assert.equal(server.requests.length, 2);
  });

  it('never retries a 401', async () => {
    const server = await serve((_req, res) => sendText(res, 401, 'Invalid access token.'));
    const result = await makeHttp(`${server.url}/api/v1`).get('/users/self');
    assert.equal(result.kind, 'error');
    assert.equal(result.kind === 'error' && result.code, 'auth');
    assert.equal(server.requests.length, 1, 'a dead token does not recover by waiting');
  });

  it('reports unparsable 200 bodies as malformed instead of guessing', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{ not json');
    });
    const result = await makeHttp(`${server.url}/api/v1`).get('/users/self');
    assert.equal(result.kind, 'error');
    assert.equal(result.kind === 'error' && result.code, 'malformed');
  });

  it('strips the XSSI while(1); prefix Canvas puts on some responses', async () => {
    const server = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('while(1);[{"id":7}]');
    });
    const result = await makeHttp(`${server.url}/api/v1`).list<{ id: number }>('/courses');
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.kind === 'ok' ? result.value : [], [{ id: 7 }]);
  });
});

describe('bearer token handling across redirects', () => {
  it('sends the token to Canvas itself', async () => {
    const server = await serve((_req, res) => sendJson(res, 200, { id: 1 }));
    await makeHttp(`${server.url}/api/v1`).get('/users/self');
    assert.equal(server.requests[0]?.authorization, 'Bearer test-token');
  });

  it('does NOT forward the token across a cross-origin redirect', async () => {
    // SPEC.md section 5 / DECISIONS.md D-09. Canvas file URLs redirect to an
    // external storage host, authorised by the `verifier` query parameter --
    // not by the bearer token. undici implements the fetch requirement to drop
    // Authorization on a cross-origin redirect, so the NUS token never reaches
    // a CDN.
    //
    // That is a property of the HTTP CLIENT, not of our code. If anyone swaps
    // in axios, got, or node-fetch, this test fails instead of the token
    // leaking silently on every download. Do not delete it.
    const storage = await serve((req, res) => {
      sendJson(res, 200, { saw_authorization: req.headers.authorization !== undefined });
    });
    const canvas = await serve((_req, res) => {
      res.writeHead(302, { location: `${storage.url}/files/abc123` });
      res.end();
    });

    const result = await makeHttp(`${canvas.url}/api/v1`).get<{ saw_authorization: boolean }>('/files/1/download');

    assert.equal(result.kind, 'ok');
    assert.equal(
      result.kind === 'ok' && result.value.saw_authorization,
      false,
      'the Canvas bearer token was forwarded to a third-party host',
    );
    assert.equal(storage.requests[0]?.authorization, undefined);
  });
});
