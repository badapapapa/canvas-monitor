/**
 * Choose the dashboard password (DECISIONS.md D-65, D-71). Run it yourself, locally:
 *
 *   node dashboard/scripts/hash-password.ts --vercel                  # recommended
 *   node dashboard/scripts/hash-password.ts --vercel --own            # type your own (no echo; 20+)
 *   node dashboard/scripts/hash-password.ts --vercel --session-only   # new session secret: signs everyone out
 *   node dashboard/scripts/hash-password.ts                           # prints all three instead
 *
 * --vercel (macOS, with the Vercel CLI logged in and dashboard/ linked):
 *   - the new PASSWORD goes on the clipboard, for your password manager, and
 *     nothing else ever does; the clipboard is cleared after you press Enter;
 *   - the HASH and a fresh SESSION SECRET go straight into
 *     `vercel env add NAME production --sensitive --force` on its stdin: never on
 *     the clipboard, never on screen, never in argv (which `ps` shows);
 *   - nothing secret is printed. Redeploy afterwards for them to take effect.
 *
 * Without --vercel the three are printed, for you alone. Nothing is written to
 * disk, sent anywhere else, or kept in shell history (no arguments carry values).
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { randomBytes, randomInt } from 'node:crypto';
import { hashPassword } from '../lib/password.ts';

/** The pinned Vercel CLI (README, "Redeploying the dashboard"; a test keeps the two equal). */
export const VERCEL_CLI = 'vercel@59.19.1';
const DASH = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

// 31 symbols, no look-alikes (0/O, 1/l/I): 24 of them is about 119 random bits.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
const LENGTH = 24;

function generate(): string {
  let out = '';
  for (let i = 0; i < LENGTH; i += 1) out += ALPHABET[randomInt(ALPHABET.length)];
  return out.match(/.{1,6}/g)!.join('-');
}

async function readHidden(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  const stdin = process.stdin;
  if (!stdin.isTTY) throw new Error('--own needs an interactive terminal');
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve) => {
    let value = '';
    const onData = (ch: string) => {
      if (ch === '\r' || ch === '\n') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.off('data', onData);
        process.stdout.write('\n');
        resolve(value);
      } else if (ch === '\u0003') {
        process.exit(130);
      } else if (ch === '\u007f') {
        value = value.slice(0, -1);
      } else {
        value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// It prints secrets, so never where a log would keep them (Actions logs on this repository are public).
if (process.env['CI'] !== undefined || process.env['GITHUB_ACTIONS'] !== undefined || process.env['VERCEL'] !== undefined) {
  process.stderr.write('hash-password prints secrets: run it yourself, in a local terminal, never in CI.\n');
  process.exit(2);
}

const own = process.argv.includes('--own');
const toVercel = process.argv.includes('--vercel');
const sessionOnly = process.argv.includes('--session-only');
const fail = (message: string): never => {
  process.stderr.write(`hash-password: ${message}\n`);
  process.exit(1);
};
if (sessionOnly && (!toVercel || own)) fail('--session-only goes with --vercel, and makes no password.');

/** The Vercel CLI, pinned, run in dashboard/, never running npm install scripts. */
const vercel = (args: string[], input?: string) => spawnSync('npx', ['--yes', VERCEL_CLI, ...args], {
  cwd: DASH,
  input,
  stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  env: { ...process.env, npm_config_ignore_scripts: 'true', VERCEL_TELEMETRY_DISABLED: '1' },
});

if (toVercel) {
  // Everything checked BEFORE a password exists, so a failure never strands a saved password.
  if (!existsSync(path.join(DASH, '.vercel', 'project.json'))) fail('dashboard/ is not linked to the Vercel project (README, "Redeploying the dashboard").');
  if (vercel(['whoami']).status !== 0) fail('the Vercel CLI is not logged in: npx --yes ' + VERCEL_CLI + ' login');
}

let password = '';
if (!sessionOnly) {
  if (own) {
    password = await readHidden('Password (hidden, 20+ characters): ');
    const again = await readHidden('Again: ');
    if (password !== again) throw new Error('The two entries differ.');
    if (password.length < 20) throw new Error('Use 20 or more characters (or run without --own to generate one).');
  } else {
    password = generate();
  }
}

const hash = sessionOnly ? '' : await hashPassword(password);
const sessionSecret = randomBytes(48).toString('base64url');

if (toVercel) {
  const copy = (value: string) => {
    if (spawnSync('pbcopy', { input: value }).status !== 0) throw new Error('--vercel needs pbcopy (macOS).');
  };
  const clear = () => { try { copy(''); } catch { /* nothing to clear */ } };
  process.on('SIGINT', () => { clear(); process.stdout.write('\nClipboard cleared.\n'); process.exit(130); });

  if (!sessionOnly && !own) {
    const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
    copy(password);
    process.stdout.write('\nYour new dashboard password is on the clipboard. Save it in your password manager,\nthen press Enter here. Nothing goes to Vercel until you do.\n');
    const done = (await lines.next()).done === true;
    clear();
    if (done) fail('input ended before Enter; nothing was sent to Vercel. Clipboard cleared.');
    process.stdout.write('Clipboard cleared.\n');
  }

  const values: Array<[string, string]> = [
    ...(sessionOnly ? [] : [['DASHBOARD_PASSWORD_HASH', hash] as [string, string]]),
    ['DASHBOARD_SESSION_SECRET', sessionSecret],
  ];
  for (const [name, value] of values) {
    const r = vercel(['env', 'add', name, 'production', '--sensitive', '--force'], value);
    if (r.status !== 0) {
      const why = (r.stderr?.toString() ?? '').split('\n').map((l) => l.trim()).filter(Boolean).at(-1)?.replaceAll(value, '[value]') ?? '';
      fail(`Vercel did not accept ${name} (exit ${String(r.status)}${why === '' ? '' : `: ${why}`}). The live site is unchanged until you redeploy; run this again.`);
    }
    process.stdout.write(`Set ${name} in Vercel (Production, Sensitive).\n`);
  }
  process.stdout.write('\nNothing secret was printed. Redeploy for this to take effect; every session is then signed out:\n  cd dashboard && npx --yes ' + VERCEL_CLI + ' deploy --prod\n');
  process.exit(0);
}

process.stdout.write('\n');
if (!own) process.stdout.write(`Your dashboard password (save it in your password manager now; it is stored nowhere):\n\n  ${password}\n\n`);
process.stdout.write('For Vercel > Settings > Environment Variables, Production ONLY, marked Sensitive:\n\n');
process.stdout.write(`  DASHBOARD_PASSWORD_HASH   ${hash}\n`);
process.stdout.write(`  DASHBOARD_SESSION_SECRET  ${sessionSecret}\n\n`);
process.stdout.write('Clear this terminal afterwards. Changing either value later logs every session out.\n');
