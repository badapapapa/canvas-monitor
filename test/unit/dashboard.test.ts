/**
 * The dashboard's security properties (DECISIONS.md D-65), from the main test
 * suite: units for its security modules, the real proxy driven with Next's own
 * request type, and static checks over all of its code.
 */

import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_COOKIE, sessionCookie, signSession, verifySession, SESSION_TTL_SECONDS } from '../../dashboard/lib/session.ts';
import { hashPassword, verifyPassword } from '../../dashboard/lib/password.ts';
import { secrets, servingAllowed } from '../../dashboard/lib/env.ts';
import { contentSecurityPolicy, securityHeaders } from '../../dashboard/lib/headers.ts';
import { assertReadOnly, WriteRefused } from '../../dashboard/lib/sql-guard.ts';
import { googleCalendarLink } from '../../dashboard/lib/calendar.ts';

const DASH = path.resolve(fileURLToPath(new URL('../../dashboard', import.meta.url)));
const SECRET = 'x'.repeat(64);
const HASH_A = 'scrypt$32768$8$1$c2FsdA==$aGFzaEE=';
const HASH_B = 'scrypt$32768$8$1$c2FsdA==$aGFzaEI=';
const T = 1_790_000_000;

describe('dashboard session: a signed cookie, nothing stored', () => {
  it('round-trips, and carries the strict cookie attributes', async () => {
    const v = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: T });
    assert.equal((await verifySession(v, { secret: SECRET, passwordHash: HASH_A, nowSeconds: T + 60 }))?.kind, 'verified-session');
    const c = sessionCookie(v);
    for (const attr of [`${SESSION_COOKIE}=`, 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_SECONDS}`]) assert.ok(c.includes(attr), attr);
    assert.ok(SESSION_COOKIE.startsWith('__Host-'));
    assert.ok(!/Domain=/i.test(c));
  });

  it('refuses a tampered, forged, expired, future, or other-password session', async () => {
    const v = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: T });
    const [payload, sig] = v.split('.') as [string, string];
    const opts = { secret: SECRET, passwordHash: HASH_A, nowSeconds: T + 60 };
    const forgedPayload = Buffer.from(JSON.stringify({ v: 1, iat: T, exp: T + 999_999, pv: 'x' })).toString('base64url');
    for (const bad of [undefined, '', 'x', `${payload}.`, `${forgedPayload}.${sig}`, `${payload}.${sig.slice(0, -2)}AA`, `${payload}.${sig}.extra`]) {
      assert.equal(await verifySession(bad, opts), null, String(bad));
    }
    assert.equal(await verifySession(v, { ...opts, secret: 'y'.repeat(64) }), null, 'another secret');
    assert.equal(await verifySession(v, { ...opts, nowSeconds: T + SESSION_TTL_SECONDS + 1 }), null, 'expired');
    assert.equal(await verifySession(v, { ...opts, passwordHash: HASH_B }), null, 'password changed');
    const future = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: T + 3600 });
    assert.equal(await verifySession(future, opts), null, 'issued in the future');
    assert.equal(await verifySession(v, { ...opts, secret: 'short' }), null, 'a weak secret is refused, not used');
  });
});

describe('dashboard password: scrypt hash, constant-time check', () => {
  it('accepts the password and nothing else', async () => {
    const hash = await hashPassword('correct horse battery staple extra');
    assert.match(hash, /^scrypt\$32768\$8\$1\$/);
    assert.ok(!hash.includes('correct horse'));
    assert.equal(await verifyPassword('correct horse battery staple extra', hash), true);
    for (const wrong of ['', 'correct horse battery staple', 'correct horse battery staple extra ', 'x'.repeat(300)]) assert.equal(await verifyPassword(wrong, hash), false, wrong);
    for (const stored of [undefined, '', 'plaintext', 'scrypt$1024$8$1$c2FsdA==$aGFzaA==']) assert.equal(await verifyPassword('anything', stored), false, String(stored));
  });
});

describe('dashboard environment: data only on the production deployment', () => {
  it('serves on production, and locally only when asked; never on a preview', () => {
    assert.equal(servingAllowed({ VERCEL: '1', VERCEL_ENV: 'production' }), true);
    assert.equal(servingAllowed({ VERCEL: '1', VERCEL_ENV: 'preview' }), false);
    assert.equal(servingAllowed({ VERCEL: '1', VERCEL_ENV: 'development' }), false);
    assert.equal(servingAllowed({ VERCEL: '1', VERCEL_ENV: 'preview', DASHBOARD_LOCAL: '1' }), false, 'the local switch does nothing on Vercel');
    assert.equal(servingAllowed({ VERCEL: '1' }), false);
    assert.equal(servingAllowed({ DASHBOARD_LOCAL: '1' }), true);
    assert.equal(servingAllowed({}), false);
  });

  it('serves nothing unless all four secrets are present', () => {
    const all = { READMODEL_DATABASE_URL: 'libsql://x', READMODEL_READ_TOKEN: 't', DASHBOARD_PASSWORD_HASH: 'h', DASHBOARD_SESSION_SECRET: 's' };
    assert.notEqual(secrets(all), null);
    for (const k of Object.keys(all)) assert.equal(secrets({ ...all, [k]: '' }), null, k);
  });
});

describe('dashboard headers', () => {
  const h = securityHeaders('NONCE123', false);
  it('never lets an authenticated response be cached, indexed or framed', () => {
    assert.match(h['Cache-Control']!, /^no-store\b/);
    assert.doesNotMatch(h['Cache-Control']!, /public|max-age=[1-9]/);
    assert.match(h['X-Robots-Tag']!, /noindex/);
    assert.match(h['X-Robots-Tag']!, /nofollow/);
    assert.equal(h['X-Frame-Options'], 'DENY');
    assert.equal(h['Referrer-Policy'], 'no-referrer');
  });

  it('has a strict CSP: nonce scripts only, no inline, no third-party origin, no framing', () => {
    const csp = contentSecurityPolicy('NONCE123', false);
    assert.match(csp, /script-src 'self' 'nonce-NONCE123' 'strict-dynamic'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  });
});

describe('dashboard SQL guard: one SELECT, no write', () => {
  it('allows reads', () => {
    assert.doesNotThrow(() => assertReadOnly('SELECT id FROM rm_modules'));
    assert.doesNotThrow(() => assertReadOnly("WITH x AS (SELECT 1) SELECT * FROM x"));
    assert.doesNotThrow(() => assertReadOnly("SELECT title FROM rm_activity WHERE title = 'update notes'"));
  });
  it('refuses every write, and stacked statements', () => {
    for (const sql of ["INSERT INTO rm_meta VALUES ('a','b')", 'UPDATE rm_meta SET value = 1', 'DELETE FROM rm_meta', 'DROP TABLE rm_meta', 'PRAGMA writable_schema = 1',
      "ATTACH 'x' AS y", 'SELECT 1; DELETE FROM rm_meta', "WITH x AS (SELECT 1) INSERT INTO rm_meta SELECT * FROM x", 'REPLACE INTO rm_meta VALUES (1, 2)', 'BEGIN']) {
      assert.throws(() => assertReadOnly(sql), WriteRefused, sql);
    }
  });
});

describe('dashboard calendar link', () => {
  it('builds a Google Calendar event for the hour before the deadline, in SGT', () => {
    const url = new URL(googleCalendarLink({ title: 'Assignment 3', moduleCode: 'AB1234', dueAt: '2026-10-30T15:59:00Z', canvasUrl: 'https://canvas.example.test/a/3' })!);
    assert.equal(url.origin + url.pathname, 'https://calendar.google.com/calendar/render');
    assert.equal(url.searchParams.get('dates'), '20261030T225900/20261030T235900');
    assert.equal(url.searchParams.get('ctz'), 'Asia/Singapore');
    assert.equal(url.searchParams.get('text'), 'Due: Assignment 3 (AB1234)');
    assert.equal(url.searchParams.get('details'), 'https://canvas.example.test/a/3');
    assert.equal(new URL(googleCalendarLink({ title: 't', moduleCode: 'm', dueAt: '2026-10-30T15:59:00Z', canvasUrl: 'javascript:alert(1)' })!).searchParams.get('details'), null);
  });
});

// --- the real proxy ------------------------------------------------------------

describe('dashboard proxy: no page, no route, no data without a session', () => {
  const saved = { ...process.env };
  let proxy: (r: unknown) => Promise<Response>;
  let NextRequest: new (url: string, init?: RequestInit) => unknown;
  before(async () => {
    Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production', READMODEL_DATABASE_URL: 'libsql://x.example.test', READMODEL_READ_TOKEN: 't', DASHBOARD_PASSWORD_HASH: HASH_A, DASHBOARD_SESSION_SECRET: SECRET });
    ({ proxy } = (await import('../../dashboard/proxy.ts')) as unknown as { proxy: typeof proxy });
    ({ NextRequest } = (await import('../../dashboard/node_modules/next/server.js')) as unknown as { NextRequest: typeof NextRequest });
  });
  after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const req = (p: string, cookie?: string) => new NextRequest(`https://dash.example.test${p}`, cookie === undefined ? {} : { headers: { cookie } });

  it('redirects every page, and refuses every API route, without a session', async () => {
    for (const p of ['/', '/m/1', '/m/999', '/anything']) {
      const res = await proxy(req(p));
      assert.equal(res.status, 303, p);
      assert.equal(new URL(res.headers.get('location')!).pathname, '/login', p);
    }
    for (const p of ['/api/logout', '/api/data']) assert.equal((await proxy(req(p))).status, 401, p);
    assert.equal((await proxy(req('/', `${SESSION_COOKIE}=forged.value`))).status, 303, 'a forged cookie is no session');
  });

  it('lets the login page and a valid session through, with the security headers on everything', async () => {
    const login = await proxy(req('/login'));
    assert.equal(login.headers.get('x-middleware-next'), '1');
    const v = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: Math.floor(Date.now() / 1000) });
    const home = await proxy(req('/', `${SESSION_COOKIE}=${v}`));
    assert.equal(home.headers.get('x-middleware-next'), '1');
    for (const res of [login, home, await proxy(req('/'))]) {
      assert.match(res.headers.get('cache-control') ?? '', /no-store/);
      assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
      assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/);
    }
  });

  it('serves nothing at all on a preview deployment, even with every secret present', async () => {
    process.env['VERCEL_ENV'] = 'preview';
    try {
      const v = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: Math.floor(Date.now() / 1000) });
      for (const p of ['/', '/login', '/api/login', '/m/1']) assert.equal((await proxy(req(p, `${SESSION_COOKIE}=${v}`))).status, 404, p);
    } finally {
      process.env['VERCEL_ENV'] = 'production';
    }
  });
});

// --- static checks over all dashboard code -------------------------------------

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = path.join(dir, name);
    if (['node_modules', '.next', 'scripts'].includes(name)) return [];
    return statSync(p).isDirectory() ? sources(p) : /\.(ts|tsx)$/.test(name) ? [p] : [];
  });
}
const code = (file: string) => readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rel = (f: string) => path.relative(DASH, f);

describe('dashboard code: structural guarantees', () => {
  const files = sources(DASH).filter((f) => !f.endsWith('next-env.d.ts'));

  it('every page and route checks the session itself before reading anything', () => {
    const entries = files.filter((f) => /\/(page\.tsx|route\.ts)$/.test(f));
    assert.ok(entries.length >= 4, 'found the pages and routes');
    for (const f of entries) {
      const r = rel(f);
      if (r === path.join('app', 'login', 'page.tsx') || r === path.join('app', 'api', 'login', 'route.ts')) continue;
      const src = code(f);
      const check = src.search(/\b(requireSession|sessionForRoute)\(/);
      assert.ok(check >= 0, `${r} never checks the session`);
      const read = src.search(/\b(snapshot|readRows)\(/);
      assert.ok(read === -1 || check < read, `${r} reads before checking the session`);
    }
  });

  it('contains no write statement and no client method that could write', () => {
    for (const f of files) {
      if (rel(f) === path.join('lib', 'sql-guard.ts')) continue;
      const src = code(f);
      assert.doesNotMatch(src, /\b(INSERT|UPDATE|DELETE|REPLACE|UPSERT|CREATE|DROP|ALTER|ATTACH|DETACH|PRAGMA|VACUUM|REINDEX)\b/, rel(f));
      assert.doesNotMatch(src, /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|drop\s+table|create\s+table)\b/i, rel(f));
      assert.doesNotMatch(src, /\.(batch|transaction|executeMultiple|migrate|sync)\(/, rel(f));
    }
  });

  it('touches the database in exactly one file', () => {
    const users = files.filter((f) => /@libsql\/client|\.execute\(/.test(code(f))).map(rel);
    assert.deepEqual(users, [path.join('lib', 'db.ts')]);
  });

  it('never reaches for the main database, its tokens, or any configuration secret', () => {
    for (const f of files) assert.doesNotMatch(code(f), /TURSO_|canvas_token|refresh_token|telegram|\bconfig\b(?!\s*=)/i, rel(f));
  });

  it('logs nothing, defines no Server Function, and exposes no environment variable to the browser', () => {
    for (const f of files) {
      const src = code(f);
      assert.doesNotMatch(src, /\bconsole\.(log|info|warn|error|debug)\b/, rel(f));
      assert.doesNotMatch(src, /['"]use server['"]/, rel(f));
      assert.doesNotMatch(src, /NEXT_PUBLIC_/, rel(f));
      assert.doesNotMatch(src, /style=\{/, `${rel(f)}: inline styles break the strict CSP`);
    }
  });

  it('turns off every deployment but main, and runs near the database', () => {
    const v = JSON.parse(readFileSync(path.join(DASH, 'vercel.json'), 'utf8')) as { git: { deploymentEnabled: Record<string, boolean> }; regions: string[] };
    assert.deepEqual(v.git.deploymentEnabled, { '**': false, main: true });
    assert.deepEqual(v.regions, ['hnd1']);
  });
});

// --- the login route itself ------------------------------------------------------

describe('dashboard login route: CSRF-checked, slow to fail, sets only a strict cookie', () => {
  const saved = { ...process.env };
  let POST: (r: Request) => Promise<Response>;
  let hash: string;
  before(async () => {
    hash = await hashPassword('the-right-password-for-this-test');
    Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'production', READMODEL_DATABASE_URL: 'libsql://x.example.test', READMODEL_READ_TOKEN: 't', DASHBOARD_PASSWORD_HASH: hash, DASHBOARD_SESSION_SECRET: SECRET });
    ({ POST } = (await import('../../dashboard/app/api/login/route.ts')) as unknown as { POST: typeof POST });
  });
  after(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
  });
  const login = (password: string, origin: string | null = 'https://dash.example.test') =>
    POST(new Request('https://dash.example.test/api/login', {
      method: 'POST', body: new URLSearchParams({ password }),
      headers: { 'content-type': 'application/x-www-form-urlencoded', host: 'dash.example.test', ...(origin === null ? {} : { origin }) },
    }));

  it('signs in with the right password, setting a __Host- HttpOnly Secure SameSite=Strict cookie', async () => {
    const res = await login('the-right-password-for-this-test');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/');
    const cookie = res.headers.get('set-cookie') ?? '';
    for (const attr of [`${SESSION_COOKIE}=`, 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(cookie.includes(attr), attr);
  });

  it('refuses a wrong password slowly, saying nothing, setting nothing', async () => {
    const started = Date.now();
    const res = await login('a-wrong-guess');
    assert.ok(Date.now() - started >= 950, 'padded to the failure floor');
    assert.equal(res.status, 303);
    assert.equal(res.headers.get('location'), '/login?e=1');
    assert.equal(res.headers.get('set-cookie'), null);
  });

  it('refuses a cross-site or origin-less login (CSRF)', async () => {
    assert.equal((await login('the-right-password-for-this-test', 'https://evil.example.test')).status, 403);
    assert.equal((await login('the-right-password-for-this-test', 'https://dash.example.test.evil.example')).status, 403);
    assert.equal((await login('the-right-password-for-this-test', 'null')).status, 403);
    assert.equal((await login('the-right-password-for-this-test', null)).status, 403);
  });
});

describe('dashboard password script: prints secrets, so never in CI', () => {
  for (const flag of ['CI', 'GITHUB_ACTIONS', 'VERCEL']) {
    it(`refuses when ${flag} is set, and prints nothing secret`, () => {
      const r = spawnSync(process.execPath, [path.join(DASH, 'scripts/hash-password.ts')], {
        encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '', [flag]: 'true' },
      });
      assert.equal(r.status, 2);
      assert.equal(r.stdout, '');
      assert.doesNotMatch(r.stderr, /scrypt\$|SESSION_SECRET /);
    });
  }
});
