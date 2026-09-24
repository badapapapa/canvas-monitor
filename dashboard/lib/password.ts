/**
 * The dashboard password (DECISIONS.md D-65). Only its hash exists server-side,
 * in DASHBOARD_PASSWORD_HASH (Vercel, Production only):
 *
 *   scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
 *
 * Brute force is made impractical without the dashboard writing anything:
 *   1. the password is GENERATED, ~120 random bits (scripts/hash-password.ts),
 *      so guessing is hopeless at any rate;
 *   2. each check costs a memory-hard scrypt (N=2^15, r=8: ~32 MB, tens of ms),
 *      and a failure is padded to a fixed minimum time;
 *   3. Vercel's firewall rate-limits POST /api/login per IP, at the edge.
 * A leaked hash is the same: offline guessing against 120 bits of scrypt is
 * not a practical attack.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password: string, salt: Buffer, n: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password, salt, KEYLEN, { N: n, r, p, maxmem: MAXMEM }, (err, key) => (err === null ? resolve(key) : reject(err)));
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scrypt(password, salt, N, R, P);
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

// A fixed decoy, so a missing or malformed hash costs the same scrypt as a real check.
const DECOY_SALT = Buffer.alloc(16, 7);

/** Constant-time check of a password against a stored hash. Never throws on bad input. */
export async function verifyPassword(password: string, stored: string | undefined): Promise<boolean> {
  const parts = (stored ?? '').split('$');
  const wellFormed = parts.length === 6 && parts[0] === 'scrypt' && Number(parts[1]) === N && Number(parts[2]) === R && Number(parts[3]) === P;
  const salt = wellFormed ? Buffer.from(parts[4]!, 'base64') : DECOY_SALT;
  const expected = wellFormed ? Buffer.from(parts[5]!, 'base64') : Buffer.alloc(KEYLEN);
  const candidate = await scrypt(password.slice(0, 256), salt, N, R, P);
  const same = candidate.length === expected.length && timingSafeEqual(candidate, expected);
  return wellFormed && same && password.length > 0 && password.length <= 256;
}
