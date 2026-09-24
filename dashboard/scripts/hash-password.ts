/**
 * Choose the dashboard password (DECISIONS.md D-65). Run it yourself, locally:
 *
 *   node scripts/hash-password.ts            # generate a strong password (recommended)
 *   node scripts/hash-password.ts --own      # type your own (no echo; 20+ characters)
 *
 * Prints, for you alone: the password (generated mode only -- put it in your
 * password manager; it is not stored anywhere), its scrypt HASH for Vercel's
 * DASHBOARD_PASSWORD_HASH, and a fresh DASHBOARD_SESSION_SECRET. Nothing is
 * written to disk, sent anywhere, or kept in shell history (no arguments).
 */

import { randomBytes, randomInt } from 'node:crypto';
import { hashPassword } from '../lib/password.ts';

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
let password: string;
if (own) {
  password = await readHidden('Password (hidden, 20+ characters): ');
  const again = await readHidden('Again: ');
  if (password !== again) throw new Error('The two entries differ.');
  if (password.length < 20) throw new Error('Use 20 or more characters (or run without --own to generate one).');
} else {
  password = generate();
}

const hash = await hashPassword(password);
const sessionSecret = randomBytes(48).toString('base64url');

process.stdout.write('\n');
if (!own) process.stdout.write(`Your dashboard password (save it in your password manager now; it is stored nowhere):\n\n  ${password}\n\n`);
process.stdout.write('For Vercel > Settings > Environment Variables, Production ONLY, marked Sensitive:\n\n');
process.stdout.write(`  DASHBOARD_PASSWORD_HASH   ${hash}\n`);
process.stdout.write(`  DASHBOARD_SESSION_SECRET  ${sessionSecret}\n\n`);
process.stdout.write('Clear this terminal afterwards. Changing either value later logs every session out.\n');
