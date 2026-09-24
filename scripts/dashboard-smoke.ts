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
 *   - a preview environment (VERCEL_ENV=preview) serves nothing at all.
 *
 * Invented data only. Uses a random local port and temporary files.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';
import { createClient } from '@libsql/client';
import { READMODEL_DDL, READMODEL_SCHEMA_VERSION } from '../src/readmodel/schema.ts';
import { hashPassword } from '../dashboard/lib/password.ts';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DASH = path.join(ROOT, 'dashboard');
const PASSWORD = 'smoke-test-password-not-real-0123';
const MARKER = 'ZZ9999'; // an invented module code: it must never appear before login

const work = mkdtempSync(path.join(tmpdir(), 'dash-smoke-'));
const children: ChildProcess[] = [];
const done = (code: number) => {
  for (const c of children) c.kill('SIGTERM');
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

  const build = spawnSync('npx', ['next', 'build'], { cwd: DASH, encoding: 'utf8', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
  if (build.status !== 0) throw new Error(`build failed:\n${build.stdout}\n${build.stderr}`);

  const secretsEnv = {
    READMODEL_DATABASE_URL: dbUrl, READMODEL_READ_TOKEN: 'local-file-needs-no-token',
    DASHBOARD_PASSWORD_HASH: await hashPassword(PASSWORD), DASHBOARD_SESSION_SECRET: 's'.repeat(64),
  };
  const start = async (port: number, extra: Record<string, string>) => {
    const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NEXT_TELEMETRY_DISABLED: '1', ...secretsEnv, ...extra };
    const child = spawn('npx', ['next', 'start', '-p', String(port)], { cwd: DASH, env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const get = (p: string, cookie?: string) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie === undefined ? {} : { cookie } });
  const checkHeaders = (res: Response, what: string) => {
    assert.match(res.headers.get('cache-control') ?? '', /no-store/, `${what}: cache-control`);
    assert.match(res.headers.get('x-robots-tag') ?? '', /noindex/, `${what}: x-robots-tag`);
    assert.match(res.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/, `${what}: csp`);
    assert.equal(res.headers.get('x-powered-by'), null, `${what}: x-powered-by`);
  };

  for (const p of ['/', '/m/1', '/m/2', '/anything']) {
    const res = await get(p);
    assert.equal(res.status, 303, p);
    assert.equal(new URL(res.headers.get('location') ?? '', base).pathname, '/login', p);
    const body = await res.text();
    assert.ok(!body.includes(MARKER) && !body.includes('Invented'), `${p}: data before login`);
    checkHeaders(res, p);
  }
  for (const p of ['/api/logout', '/api/whatever']) assert.equal((await get(p)).status, 401, p);

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
  assert.equal((await post(PASSWORD, 'https://evil.example.test')).status, 403, 'cross-site login');
  const right = await post(PASSWORD);
  const setCookie = right.headers.get('set-cookie') ?? '';
  for (const attr of ['__Host-cm_session=', 'HttpOnly', 'Secure', 'SameSite=Strict']) assert.ok(setCookie.includes(attr), attr);
  const cookie = setCookie.split(';')[0]!;

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
