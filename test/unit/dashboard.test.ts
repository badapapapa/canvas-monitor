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
import { LOCAL_SESSION_COOKIE, SESSION_COOKIE, sessionCookie, sessionCookieName, signSession, verifySession, SESSION_TTL_SECONDS } from '../../dashboard/lib/session.ts';
import { hashPassword, verifyPassword } from '../../dashboard/lib/password.ts';
import { productionDeployment, secrets, servingAllowed } from '../../dashboard/lib/env.ts';
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
    const c = sessionCookie(v, SESSION_COOKIE);
    for (const attr of [`${SESSION_COOKIE}=`, 'HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/', `Max-Age=${SESSION_TTL_SECONDS}`]) assert.ok(c.includes(attr), attr);
    assert.ok(SESSION_COOKIE.startsWith('__Host-'));
    const local = sessionCookie(v, LOCAL_SESSION_COOKIE);
    assert.equal(local.replace(`${LOCAL_SESSION_COOKIE}=`, ''), c.replace(`${SESSION_COOKIE}=`, ''), 'the local cookie differs by name only');
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

  it('lasts 30 days, and no longer (D-66)', async () => {
    assert.equal(SESSION_TTL_SECONDS, 30 * 24 * 3600);
    const v = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: T });
    const at = (days: number) => verifySession(v, { secret: SECRET, passwordHash: HASH_A, nowSeconds: T + days * 86_400 });
    assert.equal((await at(29.9))?.kind, 'verified-session');
    assert.equal(await at(30), null);
  });

  it('rotating the session secret signs out every device at once (the revocation path)', async () => {
    const devices = await Promise.all([T, T + 3600, T + 86_400].map((t) => signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: t })));
    const opts = { secret: SECRET, passwordHash: HASH_A, nowSeconds: T + 2 * 86_400 };
    for (const d of devices) assert.equal((await verifySession(d, opts))?.kind, 'verified-session');
    for (const d of devices) assert.equal(await verifySession(d, { ...opts, secret: 'r'.repeat(64) }), null);
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

const PROD = { dev: false, production: true };
const LOCAL = { dev: false, production: false };

describe('dashboard headers', () => {
  const h = securityHeaders('NONCE123', PROD);
  it('never lets an authenticated response be cached, indexed or framed', () => {
    assert.match(h['Cache-Control']!, /^no-store\b/);
    assert.doesNotMatch(h['Cache-Control']!, /public|max-age=[1-9]/);
    assert.match(h['X-Robots-Tag']!, /noindex/);
    assert.match(h['X-Robots-Tag']!, /nofollow/);
    assert.equal(h['X-Frame-Options'], 'DENY');
    // same-origin, never no-referrer: under no-referrer a browser sends `Origin: null`
    // on its own same-origin login POST, and the CSRF check refuses every login (D-66).
    assert.equal(h['Referrer-Policy'], 'same-origin');
    for (const f of ['app/layout.tsx', 'next.config.ts']) {
      assert.doesNotMatch(readFileSync(path.join(DASH, f), 'utf8'), /['"]no-referrer['"]/, `${f} sets no-referrer`);
    }
  });

  it('has a strict CSP: nonce scripts only, no inline, no third-party origin, no framing', () => {
    const csp = contentSecurityPolicy('NONCE123', PROD);
    assert.match(csp, /script-src 'self' 'nonce-NONCE123' 'strict-dynamic'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /default-src 'self'/);
    assert.match(csp, /object-src 'none'/);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|https?:|\*/);
  });

  it('production sends every header, HSTS and upgrade-insecure-requests included (D-67)', () => {
    assert.deepEqual(Object.keys(h).sort(), [
      'Cache-Control', 'Content-Security-Policy', 'Cross-Origin-Opener-Policy', 'Cross-Origin-Resource-Policy', 'Permissions-Policy',
      'Referrer-Policy', 'Strict-Transport-Security', 'X-Content-Type-Options', 'X-Frame-Options', 'X-Robots-Tag',
    ]);
    assert.equal(h['Strict-Transport-Security'], 'max-age=63072000; includeSubDomains');
    assert.match(h['Content-Security-Policy']!, /; upgrade-insecure-requests$/);
  });

  it('the local http preview differs by exactly two things: no HSTS, no upgrade-insecure-requests (D-67)', () => {
    const l = securityHeaders('NONCE123', LOCAL);
    const { 'Strict-Transport-Security': hsts, 'Content-Security-Policy': prodCsp, ...prodRest } = h;
    const { 'Content-Security-Policy': localCsp, ...localRest } = l;
    assert.ok(hsts !== undefined && !('Strict-Transport-Security' in l));
    assert.deepEqual(localRest, prodRest);
    assert.equal(localCsp, prodCsp!.replace('; upgrade-insecure-requests', ''));
    assert.doesNotMatch(localCsp!, /upgrade-insecure-requests/);
  });

  it('HSTS and upgrade-insecure-requests only on the production deployment, whatever else is set', () => {
    assert.equal(productionDeployment({ VERCEL: '1', VERCEL_ENV: 'production' }), true);
    assert.equal(productionDeployment({ VERCEL: '1', VERCEL_ENV: 'production', DASHBOARD_LOCAL: '1' }), true);
    for (const env of [{}, { DASHBOARD_LOCAL: '1' }, { VERCEL: '1' }, { VERCEL: '1', VERCEL_ENV: 'preview' }, { VERCEL: '1', VERCEL_ENV: 'development' }]) {
      assert.equal(productionDeployment(env), false, JSON.stringify(env));
    }
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

  it('on the production deployment, sends HSTS and upgrade-insecure-requests on every response, even with DASHBOARD_LOCAL set', async () => {
    process.env['DASHBOARD_LOCAL'] = '1';
    try {
      const v = await signSession({ secret: SECRET, passwordHash: HASH_A, nowSeconds: Math.floor(Date.now() / 1000) });
      for (const res of [await proxy(req('/login')), await proxy(req('/')), await proxy(req('/', `${SESSION_COOKIE}=${v}`)), await proxy(req('/api/x'))]) {
        assert.equal(res.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
        assert.match(res.headers.get('content-security-policy') ?? '', /upgrade-insecure-requests/);
        for (const k of ['x-frame-options', 'referrer-policy', 'x-content-type-options', 'cross-origin-opener-policy', 'cross-origin-resource-policy', 'permissions-policy']) {
          assert.ok(res.headers.get(k) !== null, k);
        }
      }
    } finally {
      delete process.env['DASHBOARD_LOCAL'];
    }
  });

  it('on a preview deployment or under `vercel dev`, its 404s carry no HSTS', async () => {
    try {
      for (const env of ['preview', 'development']) {
        process.env['VERCEL_ENV'] = env;
        const res = await proxy(new NextRequest('http://localhost:3000/'));
        assert.equal(res.status, 404, env);
        assert.equal(res.headers.get('strict-transport-security'), null, env);
        assert.doesNotMatch(res.headers.get('content-security-policy') ?? '', /upgrade-insecure-requests/, env);
      }
    } finally {
      process.env['VERCEL_ENV'] = 'production';
    }
  });

  it('in the local http preview, never sends HSTS or upgrade-insecure-requests, and redirects over plain http', async () => {
    const vercel = { VERCEL: process.env['VERCEL'], VERCEL_ENV: process.env['VERCEL_ENV'] };
    delete process.env['VERCEL'];
    delete process.env['VERCEL_ENV'];
    process.env['DASHBOARD_LOCAL'] = '1';
    try {
      const local = (p: string) => new NextRequest(`http://localhost:3100${p}`);
      for (const p of ['/login', '/', '/m/1', '/api/x']) {
        const res = await proxy(local(p));
        assert.equal(res.headers.get('strict-transport-security'), null, p);
        assert.doesNotMatch(res.headers.get('content-security-policy') ?? '', /upgrade-insecure-requests/, p);
        assert.match(res.headers.get('cache-control') ?? '', /no-store/, p);
        const location = res.headers.get('location');
        if (location !== null) assert.equal(new URL(location).protocol, 'http:', `${p}: a redirect to https`);
        assert.notEqual(res.status, 301, 'no permanent (cacheable) redirect');
        assert.notEqual(res.status, 308, 'no permanent (cacheable) redirect');
      }
    } finally {
      delete process.env['DASHBOARD_LOCAL'];
      Object.assign(process.env, vercel);
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
    const v = JSON.parse(readFileSync(path.join(DASH, 'vercel.json'), 'utf8')) as { git: { deploymentEnabled: Record<string, boolean> }; regions: string[]; installCommand: string };
    assert.deepEqual(v.git.deploymentEnabled, { '**': false, main: true });
    assert.deepEqual(v.regions, ['hnd1']);
  });

  it('runs no dependency install script: on Vercel, in any npm install here, and none is locked (D-66)', () => {
    const v = JSON.parse(readFileSync(path.join(DASH, 'vercel.json'), 'utf8')) as { installCommand?: string };
    assert.equal(v.installCommand, 'npm ci --ignore-scripts');
    assert.match(readFileSync(path.join(DASH, '.npmrc'), 'utf8'), /^ignore-scripts=true$/m);
    const lock = JSON.parse(readFileSync(path.join(DASH, 'package-lock.json'), 'utf8')) as { packages: Record<string, { hasInstallScript?: boolean }> };
    const withScripts = Object.entries(lock.packages).filter(([, p]) => p.hasInstallScript === true).map(([k]) => k);
    assert.deepEqual(withScripts, [], 'a dependency now declares an install script: decide whether the build needs it (D-66)');
  });

  it('never uploads a local .env file in a CLI deploy (.vercelignore)', () => {
    const ignore = readFileSync(path.join(DASH, '.vercelignore'), 'utf8').split('\n').map((l) => l.trim());
    assert.ok(ignore.includes('.env*'));
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

describe('dashboard session cookie name: __Host- on production, always (D-67)', () => {
  it('production uses the __Host- name, whatever else is set; everything else the local name', () => {
    assert.equal(sessionCookieName({ VERCEL: '1', VERCEL_ENV: 'production' }), '__Host-cm_session');
    assert.equal(sessionCookieName({ VERCEL: '1', VERCEL_ENV: 'production', DASHBOARD_LOCAL: '1' }), '__Host-cm_session');
    assert.equal(sessionCookieName({ DASHBOARD_LOCAL: '1' }), 'cm_session');
  });
});

describe('dashboard password script --clipboard: prints nothing secret (D-69)', () => {
  it('puts the password, hash and secret on the clipboard in turn, prints none of them, then clears it', async () => {
    const { mkdtempSync, writeFileSync, chmodSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(path.join(tmpdir(), 'pbcopy-'));
    try {
      const capture = path.join(dir, 'capture');
      writeFileSync(path.join(dir, 'pbcopy'), `#!/bin/sh\ncat >> "${capture}"\nprintf '\\n--END--\\n' >> "${capture}"\n`);
      chmodSync(path.join(dir, 'pbcopy'), 0o755);
      const r = spawnSync(process.execPath, [path.join(DASH, 'scripts/hash-password.ts'), '--clipboard'], {
        encoding: 'utf8', input: '\n\n\n', env: { PATH: `${dir}:${process.env['PATH'] ?? ''}` },
      });
      assert.equal(r.status, 0, r.stderr);
      const copied = readFileSync(capture, 'utf8').split('\n--END--\n').slice(0, -1);
      assert.equal(copied.length, 4, 'password, hash, secret, then a cleared clipboard');
      const [password, hash, secret, cleared] = copied as [string, string, string, string];
      assert.equal(cleared, '');
      assert.ok(await verifyPassword(password, hash), 'the hash is of that password');
      assert.equal(secret.length, 64);
      for (const v of [password, hash, secret]) {
        assert.ok(!r.stdout.includes(v) && !r.stderr.includes(v), 'a secret was printed');
      }
      assert.match(r.stdout, /Clipboard cleared/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
