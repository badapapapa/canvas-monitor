/**
 * `npm run dashboard:smoke` -- the REAL production build of the dashboard
 * (next build + next start), against an invented local read model, checked
 * over plain HTTP (DECISIONS.md D-65):
 *
 *   - without a session, every page redirects to /login and every API route
 *     answers 401, and no response body carries any course data;
 *   - the login page carries none either;
 *   - login refuses a wrong password and a cross-site post, and a right one
 *     sets a __Host- HttpOnly Secure SameSite=Strict cookie;
 *   - with the session, the pages render the data;
 *   - every response is no-store, noindex, framed by nobody, under a nonce CSP,
 *     and every script tag carries that nonce;
 *   - changing the session secret signs the existing session out;
 *   - the whole login flow in REAL browser engines, WebKit (Safari) and
 *     Chromium, at http://localhost as the preview is used: sign in, read,
 *     open a module, log out; every request stays on http, no HSTS, no CSP
 *     violation, the cookie HttpOnly/Secure/Strict and invisible to scripts
 *     (D-67: Safari followed upgrade-insecure-requests to https://localhost);
 *   - a preview environment (VERCEL_ENV=preview) serves nothing at all.
 *
 * Invented data only. Uses a random local port and temporary files.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { createClient } from '@libsql/client';
import { READMODEL_DDL, READMODEL_SCHEMA_VERSION } from '../src/readmodel/schema.ts';
import { hashPassword } from '../dashboard/lib/password.ts';
import { chromium, webkit, type BrowserType } from 'playwright';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DASH = path.join(ROOT, 'dashboard');
const PASSWORD = 'smoke-test-password-not-real-0123';
const MARKER = 'ZZ9999'; // an invented module code: it must never appear before login

const work = mkdtempSync(path.join(tmpdir(), 'dash-smoke-'));

// Build and run a throwaway COPY of the dashboard (copy-on-write on APFS, so cheap), never
// dashboard/ itself: the local preview's dashboard/.env.local holds a real token, and Next
// would load it (and its loader rewrites any variable it names, expanding every `$` --
// the scrypt hash's too). The copy has no .env* file, and the preview's build is untouched.
const APP = path.join(work, 'dashboard');
if (spawnSync('cp', ['-cR', DASH, APP]).status !== 0 && spawnSync('cp', ['-R', DASH, APP]).status !== 0) throw new Error('could not copy the dashboard');
for (const f of readdirSync(APP)) if (f.startsWith('.env') || f === '.next' || f === '.vercel') rmSync(path.join(APP, f), { recursive: true, force: true });
assert.ok(!readdirSync(APP).some((f) => f.startsWith('.env')), 'no .env file in the smoke copy');
const children: ChildProcess[] = [];
const done = (code: number) => {
  for (const c of children) {
    try { if (c.pid !== undefined) process.kill(-c.pid, 'SIGTERM'); } catch { /* already gone */ } // npx and its next-server
  }
  rmSync(work, { recursive: true, force: true });
  process.exit(code);
};

try {
  // An invented read model.
  const dbUrl = `file:${path.join(work, 'rm.sqlite')}`;
  const rm = createClient({ url: dbUrl });
  await rm.batch([
    ...READMODEL_DDL,
    { sql: "INSERT INTO rm_meta (name, value) VALUES ('schema_version', ?), ('published_at', ?)", args: [READMODEL_SCHEMA_VERSION, new Date().toISOString()] },
    `INSERT INTO rm_modules (id, code, kind, coverage, answers_tracked) VALUES (1, '${MARKER}', 'course', 'full', 1)`,
    { sql: 'INSERT INTO rm_deadlines (ref, module_id, title, due_at, canvas_url) VALUES (?, 1, ?, ?, ?)', args: ['d1', 'Invented Assignment', new Date(Date.now() + 5 * 86_400_000).toISOString(), 'https://canvas.example.test/a/1'] },
    { sql: "INSERT INTO rm_activity (ref, module_id, kind, change, title, at, seen_at) VALUES ('a1', 1, 'announcement', 'new', 'Invented announcement', ?, ?)", args: [new Date().toISOString(), new Date().toISOString()] },
    { sql: "INSERT INTO rm_followups (id, module_id, label, posted_at) VALUES (1, 1, 'Tutorial 3', ?)", args: [new Date(Date.now() - 9 * 86_400_000).toISOString()] },
    "INSERT INTO rm_health (name, value) VALUES ('active_alerts', '0'), ('archived_files', '12')",
  ], 'write');
  rm.close();

  const build = spawnSync('npx', ['next', 'build'], { cwd: APP, encoding: 'utf8', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

  const secretsEnv = {
    READMODEL_DATABASE_URL: dbUrl, READMODEL_READ_TOKEN: 'local-file-needs-no-token',
    DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD), DASHBOARD_SESSION_SECRET: 's'.repeat(64),
  };
  const start = async (port: number, extra: Record<string, string>) => {
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NEXT_TELEMETRY_DISABLED: '1', ...secretsEnv, ...extra };
    const child = spawn('npx', ['next', 'start', '-p', String(port)], { cwd: APP, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    children.push(child);
    let logs = '';
    child.stdout?.on('data', (d: Buffer) => (logs += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (logs += d.toString()));
    for (let i = 0; i < 100; i += 1) {
      try {
        await fetch(`http://127.0.0.1:${port}/login`, { redirect: 'manual' });
        return () => logs;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw new Error(`server did not start:\n${logs}`);
  };

  // --- production-like local run ------------------------------------------------
  const port = 41000 + Math.floor(Math.random() * 1000);
  const base = `http://127.0.0.1:${port}`;
  const logs = await start(port, { DASHBOARD_LOCAL: '1' });
  // The local preview never sends HSTS or upgrade-insecure-requests over plain http (D-67).
  const plain = await fetch(`${base}/login`);
  assert.equal(plain.headers.get('strict-transport-security'), null, 'HSTS over plain http');
  assert.doesNotMatch(plain.headers.get('content-security-policy') ?? '', /upgrade-insecure-requests/, 'upgrade-insecure-requests on the local preview');
  const get = (p: string, cookie?: string) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie === undefined ? {} : { cookie } });
  const checkHeaders = (res: Response, what: string) => {
    assert.equal(res.headers.get('cache-control'), 'private, no-cache, no-store, max-age=0, must-revalidate', `${what}: cache-control (as production sends it)`);
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/, `${what}: x-robots-tag`);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, `${what}: csp`);
    assert.equal(res.headers.get('x-powered-by'), null, `${what}: x-powered-by`);
    assert.equal(res.headers.get('referrer-policy'), 'same-origin', `${what}: referrer-policy (no-referrer breaks browser logins, D-66)`);
  };

  for (const p of ['/', '/m/1', '/m/2', '/anything']) {
    const res = await get(p);
    assert.equal(res.status, 303, p);
    assert.equal(new URL(res.headers.get('location') ?? '', base).pathname, '/login', p);
    const body = await res.text();
    assert.ok(!body.includes(MARKER) && !body.includes('Invented'), `${p}: data before login`);
    checkHeaders(res, p);
  }
  for (const p of ['/api/logout', '/api/whatever']) {
    const res = await get(p);
    assert.equal(res.status, 401, p);
    checkHeaders(res, p);
  }

  const loginPage = await get('/login');
  assert.equal(loginPage.status, 200);
  const loginHtml = await loginPage.text();
  assert.ok(!loginHtml.includes(MARKER) && !loginHtml.includes('Invented'), 'the login page carries no data');
  checkHeaders(loginPage, '/login');

  const post = (password: string, origin = base) => fetch(`${base}/api/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }), headers: { origin, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const wrong = await post('not-the-password');
  assert.equal(wrong.headers.get('location'), '/login?e=1', `wrong password: status ${wrong.status}, body ${(await wrong.clone().text()).slice(0, 80)}`);
  assert.equal(wrong.headers.get('set-cookie'), null);
  checkHeaders(wrong, 'a refused login');
  assert.equal((await post(PASSWORD, 'https://evil.example.test')).status, 403, 'cross-site login');
  const right = await post(PASSWORD);
  const setCookie = right.headers.get('set-cookie') ?? '';
  // The local preview's cookie is `cm_session`: WebKit refuses `__Host-` from http://localhost (D-67).
  // Production's `__Host-` name is proven by the unit tests.
  assert.ok(setCookie.startsWith('cm_session='), 'the local session cookie name');
  for (const attr of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(setCookie.includes(attr), attr);
  const cookie = setCookie.split(';')[0]!;
  checkHeaders(right, 'a successful login');

  const home = await get('/', cookie);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.ok(html.includes(MARKER) && html.includes('Invented Assignment') && html.includes('Tutorial 3'), 'the data renders with a session');
  assert.ok(html.includes('calendar.google.com/calendar/render'), 'add-to-calendar link');
  checkHeaders(home, '/ (signed in)');
  const nonce = /'nonce-([^']+)'/.exec(home.headers.get('content-security-policy') ?? '')?.[1];
  assert.ok(nonce !== undefined, 'a nonce');
  const scripts = [...html.matchAll(/<script\b[^>]*>/g)].map((m) => m[0]);
  assert.ok(scripts.length > 0 && scripts.every((t) => t.includes(`nonce="${nonce}"`)), 'every script carries the nonce');
  assert.equal((await get('/m/1', cookie)).status, 200);
  assert.equal((await get('/m/999', cookie)).status, 404);
  assert.ok(!/ZZ9999|Invented/.test(logs()), 'no course data in the server logs');

  // --- real browser engines: the whole login flow, as the owner uses the preview ------------
  const engines: Array<[string, BrowserType]> = [['WebKit', webkit], ['Chromium', chromium]];
  for (const [name, engine] of engines) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      const site = `http://localhost:${port}`;
      const problems: string[] = [];
      page.on('request', (r) => { if (!r.url().startsWith(site) && !r.url().startsWith('data:')) problems.push(`request left http://localhost: ${r.url()}`); });
      page.on('response', (r) => { if (r.headers()['strict-transport-security'] !== undefined) problems.push(`HSTS on ${r.url()}`); });
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`console error: ${m.text()}`); });
      page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
      const at = (p: string) => new URL(page.url()).pathname === p && new URL(page.url()).protocol === 'http:';

      await page.goto(`${site}/`);
      assert.ok(at('/login'), `${name}: / without a session lands on http /login (at ${page.url()})`);
      assert.ok(!(await page.content()).includes(MARKER), `${name}: data before login`);

      await page.fill('#password', 'not-the-password');
      await page.click('button[type=submit]');
      await page.waitForURL(/\/login\?e=1$/, { timeout: 10_000 });
      assert.ok((await page.content()).includes('That did not work'), `${name}: a wrong password is refused politely`);

      await page.fill('#password', PASSWORD);
      await page.click('button[type=submit]');
      await page.waitForURL(`${site}/`, { timeout: 10_000 });
      assert.ok(at('/'), `${name}: signed in over http (at ${page.url()})`);
      const signedIn = await page.content();
      assert.ok(signedIn.includes(MARKER) && signedIn.includes('Invented Assignment') && signedIn.includes('Tutorial 3'), `${name}: the data renders`);

      const cookies = await context.cookies();
      const session = cookies.find((c) => c.name === 'cm_session');
      assert.ok(session !== undefined, `${name}: the session cookie was stored`);
      assert.deepEqual([session.httpOnly, session.secure, session.sameSite, session.path], [true, true, 'Strict', '/'], `${name}: cookie attributes`);
      assert.equal(await page.evaluate('document.cookie'), '', `${name}: the cookie is invisible to page scripts`);

      await page.click('a[href="/m/1"]');
      await page.waitForURL(`${site}/m/1`, { timeout: 10_000 });
      assert.ok((await page.content()).includes('Invented Assignment'), `${name}: the module view renders`);

      await page.click('form[action="/api/logout"] button');
      await page.waitForURL(`${site}/login`, { timeout: 10_000 });
      await page.goto(`${site}/`);
      assert.ok(at('/login'), `${name}: logged out`);
      assert.deepEqual(problems, [], `${name}: ${problems.join('; ')}`);
      console.log(`  ${name}: login flow passed`);
    } catch (error) {
      throw new Error(`${name}: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`);
    } finally {
      await browser.close();
    }
  }

  // --- revocation: a new session secret signs every existing session out (D-66) ------------
  const rotatedPort = port + 2;
  await start(rotatedPort, { DASHBOARD_LOCAL: '1', DASHBOARD_SESSION_SECRET: 'r'.repeat(64) });
  const afterRotation = await fetch(`http://127.0.0.1:${rotatedPort}/`, { redirect: 'manual', headers: { cookie } });
  assert.equal(afterRotation.status, 303, 'the old session is refused after the secret changes');
  assert.equal(new URL(afterRotation.headers.get('location') ?? '', base).pathname, '/login');
  assert.ok(!(await afterRotation.text()).includes(MARKER), 'no data for the old session');

  // --- a preview deployment: nothing at all ------------------------------------------
  const previewPort = port + 1;
  await start(previewPort, { VERCEL: '1', VERCEL_ENV: 'preview' });
  for (const p of ['/', '/login', '/m/1']) {
    const res = await fetch(`http://127.0.0.1:${previewPort}${p}`, { redirect: 'manual', headers: { cookie } });
    assert.equal(res.status, 404, `preview ${p}`);
    assert.ok(!(await res.text()).includes(MARKER), `preview ${p}: data`);
  }
  const previewLogin = await fetch(`http://127.0.0.1:${previewPort}/api/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password: PASSWORD }),
    headers: { origin: `http://127.0.0.1:${previewPort}`, 'content-type': 'application/x-www-form-urlencoded' },
  });
  assert.equal(previewLogin.status, 404, 'preview login');

  console.log('dashboard smoke: all checks passed (production build, invented data).');
  done(0);
} catch (error) {
  console.error(`dashboard smoke FAILED: ${error instanceof Error ? error.message : String(error)}`);
  done(1);
}
