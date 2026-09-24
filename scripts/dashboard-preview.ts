/**
 * `npm run dashboard:preview` -- step 3 of Phase 8: the dashboard, locally, on
 * the REAL read model (DECISIONS.md D-65, D-66). Run by the owner.
 *
 *   npm run dashboard:preview            set up, build, and self-check
 *   npm run dashboard:preview -- --clean remove the preview's secrets file and password
 *
 * Uses ONLY the read model's READ-ONLY token (READMODEL_DATABASE_URL and
 * READMODEL_READ_TOKEN from .env): never the write token, never the main
 * database. Makes a THROWAWAY preview password -- not the production one --
 * and writes:
 *
 *   dashboard/.env.local            (0600, gitignored) the read-only URL and
 *                                   token, the preview password's hash, a fresh
 *                                   session secret, DASHBOARD_LOCAL=1
 *   var/dashboard-preview/password  (0600, gitignored) the preview password
 *
 * Prints neither, nor any token or URL. The self-check signs in with the
 * password in-process and reports status codes and counts only: no module
 * code, title or other course data.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../dashboard/lib/password.ts';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const DASH = path.join(ROOT, 'dashboard');
const ENV_LOCAL = path.join(DASH, '.env.local');
const PASSWORD_DIR = path.join(ROOT, 'var', 'dashboard-preview');
const PASSWORD_FILE = path.join(PASSWORD_DIR, 'password');

let server: ChildProcess | undefined;
/** Stop the self-check server: the whole process group, since npx starts next-server as a child. */
const stopServer = () => {
  if (server?.pid !== undefined) {
    try { process.kill(-server.pid, 'SIGTERM'); } catch { /* already gone */ }
  }
};
const fail = (message: string): never => {
  stopServer();
  process.stderr.write(`dashboard preview: ${message}\n`);
  process.exit(1);
};

if (process.env['CI'] !== undefined || process.env['GITHUB_ACTIONS'] !== undefined || process.env['VERCEL'] !== undefined) {
  fail('this handles a real token: run it yourself, locally, never in CI.');
}

if (process.argv.includes('--clean')) {
  rmSync(ENV_LOCAL, { force: true });
  rmSync(PASSWORD_DIR, { recursive: true, force: true });
  process.stdout.write('Removed dashboard/.env.local and the preview password.\n');
  process.exit(0);
}

try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  fail('no .env in the repository root.');
}
const url = (process.env['READMODEL_DATABASE_URL'] ?? '').trim();
const readToken = (process.env['READMODEL_READ_TOKEN'] ?? '').trim();
if (url === '' || readToken === '') fail('READMODEL_DATABASE_URL and READMODEL_READ_TOKEN must be in .env.');
if (!url.startsWith('libsql://')) fail('READMODEL_DATABASE_URL is not a libsql:// URL.');

// A throwaway preview password: 24 characters, no look-alikes, like the real one.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const password = Array.from({ length: 24 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
const sessionSecret = randomBytes(48).toString('base64url');
const env = {
  DASHBOARD_LOCAL: '1',
  READMODEL_DATABASE_URL: url,
  READMODEL_READ_TOKEN: readToken,
  DASHBOARD_PASSWORD_HASH: await hashPassword(password),
  DASHBOARD_SESSION_SECRET: sessionSecret,
};
// Next's .env loader expands `$NAME`, and a scrypt hash is full of `$`: escape every one.
const line = ([k, v]: [string, string]) => `${k}=${v.replaceAll('$', '\\$')}`;
writeFileSync(ENV_LOCAL, `# Local preview only (npm run dashboard:preview). Gitignored. Remove with --clean.\n${Object.entries(env).map(line).join('\n')}\n`, { mode: 0o600 });
chmodSync(ENV_LOCAL, 0o600);
mkdirSync(PASSWORD_DIR, { recursive: true, mode: 0o700 });
writeFileSync(PASSWORD_FILE, password, { mode: 0o600 });
chmodSync(PASSWORD_FILE, 0o600);

for (const file of [ENV_LOCAL, PASSWORD_FILE]) {
  if (spawnSync('git', ['check-ignore', '-q', file], { cwd: ROOT }).status !== 0) fail('a preview secrets file is NOT gitignored; stopping.');
}

process.stdout.write('Building the dashboard (production build)...\n');
const build = spawnSync('npx', ['next', 'build'], { cwd: DASH, encoding: 'utf8', env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' } });
if (build.status !== 0) fail('the build failed. Run `npx next build` in dashboard/ to see why.');

// --- self-check: sign in and load every page, reporting statuses and counts only ----------
const port = 43000 + Math.floor(Math.random() * 1000);
const base = `http://127.0.0.1:${port}`;
let logs = '';
try {
  server = spawn('npx', ['next', 'start', '-p', String(port)], {
    cwd: DASH, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', NEXT_TELEMETRY_DISABLED: '1' }, // secrets from .env.local only
  });
  server.stdout?.on('data', (d: Buffer) => (logs += d.toString()));
  server.stderr?.on('data', (d: Buffer) => (logs += d.toString()));
  let up = false;
  for (let i = 0; i < 100 && !up; i += 1) {
    try { await fetch(`${base}/login`); up = true; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  if (!up) fail('the server did not start.');

  const get = (p: string, cookie?: string) => fetch(`${base}${p}`, { redirect: 'manual', headers: cookie === undefined ? {} : { cookie } });
  const anon = await get('/');
  if (anon.status !== 303) fail(`/ without a session answered ${anon.status}, not a redirect to /login.`);

  const login = await fetch(`${base}/api/login`, {
    method: 'POST', redirect: 'manual', body: new URLSearchParams({ password }),
    headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
  });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  if (!cookie.startsWith('__Host-cm_session=')) fail(`sign-in failed (status ${login.status}).`);

  const home = await get('/', cookie);
  const html = await home.text();
  if (home.status !== 200) fail(`/ answered ${home.status}.`);
  if (html.includes("data is unavailable")) fail('/ rendered but could not read the read model (check the read token and URL).');
  const moduleIds = [...new Set([...html.matchAll(/href="\/m\/(\d{1,6})"/g)].map((m) => m[1]!))];
  const statuses: number[] = [];
  for (const id of moduleIds) {
    const page = await get(`/m/${id}`, cookie);
    const body = await page.text();
    statuses.push(page.status === 200 && !body.includes('data is unavailable') ? 200 : page.status === 200 ? 503 : page.status);
  }
  const bad = statuses.filter((s) => s !== 200).length;
  const leaked = [readToken, sessionSecret, password].some((s) => html.includes(s) || logs.includes(s));
  if (leaked) fail('a secret appeared in a page or the server log.');
  if (bad > 0) fail(`${bad} of ${moduleIds.length} module pages did not render.`);

  process.stdout.write(`\nSelf-check passed: signed in; the main view and all ${moduleIds.length} module pages render from the real read model.\n`);
  process.stdout.write('No page or log line carried a token, the session secret or the password.\n\n');
  process.stdout.write('Preview password (throwaway; not your production one): copy it with\n\n  pbcopy < var/dashboard-preview/password\n\n');
  process.stdout.write('Remove the preview secrets afterwards:  npm run dashboard:preview -- --clean\n');
} finally {
  stopServer();
}
if (!existsSync(ENV_LOCAL) || readFileSync(ENV_LOCAL, 'utf8').length === 0) fail('dashboard/.env.local vanished.');
