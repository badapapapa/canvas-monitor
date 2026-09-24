/**
 * The dashboard's session (DECISIONS.md D-65): a signed cookie, nothing stored.
 *
 *   value = base64url(JSON {v, iat, exp, pv}) "." base64url(HMAC-SHA256(secret, payload))
 *
 * - Signed with DASHBOARD_SESSION_SECRET (Vercel, Production only). Rotating it
 *   (and redeploying: Vercel applies env changes to new deployments only) ends
 *   every session on every device at once. That is how access is revoked (D-66).
 * - 30 days, by the owner's choice (D-66); no server-side store, so no refresh.
 * - `pv` binds the session to the current password hash: changing the password
 *   also ends every session.
 * - Verified with Web Crypto's `verify`, a constant-time comparison, so it runs
 *   the same in the proxy and in pages.
 * - On the production deployment the cookie is `__Host-` prefixed: Secure,
 *   Path=/, no Domain, so no other site or subdomain can set or read it.
 *   HttpOnly and SameSite=Strict everywhere.
 * - The local http:// preview uses `cm_session`, otherwise identical (D-67):
 *   WebKit (Safari) refuses any `__Host-` cookie from http://localhost, so the
 *   prefix made Safari sign-in impossible there. The prefix guards against a
 *   sibling subdomain setting the cookie, which localhost does not have.
 */

import { productionDeployment, type DashboardEnv } from './env.ts';

export const SESSION_COOKIE = '__Host-cm_session';
export const LOCAL_SESSION_COOKIE = 'cm_session';

/** The session cookie's name: `__Host-` on the production deployment, always. */
export function sessionCookieName(env: DashboardEnv = process.env): string {
  return productionDeployment(env) ? SESSION_COOKIE : LOCAL_SESSION_COOKIE;
}
export const SESSION_TTL_SECONDS = 30 * 24 * 3600;

/** Proof that a request carried a valid session. Only `verifySession` makes one. */
export interface VerifiedSession {
  readonly kind: 'verified-session';
  readonly expiresAt: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** A short, one-way fingerprint of the password hash, so a password change ends sessions. */
async function passwordVersion(passwordHash: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(passwordHash)));
  return b64url(digest.slice(0, 9));
}

async function key(secret: string): ReturnType<typeof crypto.subtle.importKey> {
  if (secret.length < 43) throw new Error('DASHBOARD_SESSION_SECRET is too short (need 32+ random bytes)');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signSession(opts: { secret: string; passwordHash: string; nowSeconds: number }): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({
    v: 1, iat: opts.nowSeconds, exp: opts.nowSeconds + SESSION_TTL_SECONDS, pv: await passwordVersion(opts.passwordHash),
  })));
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', await key(opts.secret), enc.encode(payload)));
  return `${payload}.${b64url(sig)}`;
}

export async function verifySession(
  value: string | undefined,
  opts: { secret: string; passwordHash: string; nowSeconds: number },
): Promise<VerifiedSession | null> {
  if (value === undefined || value.length > 512) return null;
  const parts = value.split('.');
  if (parts.length !== 2) return null;
  const [payload, sigText] = parts as [string, string];
  const sig = unb64url(sigText);
  if (sig === null) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(opts.secret), sig, enc.encode(payload));
  } catch {
    return null;
  }
  if (!ok) return null;
  const raw = unb64url(payload);
  if (raw === null) return null;
  let claims: { v?: unknown; iat?: unknown; exp?: unknown; pv?: unknown };
  try {
    claims = JSON.parse(new TextDecoder().decode(raw)) as typeof claims;
  } catch {
    return null;
  }
  if (claims.v !== 1 || typeof claims.iat !== 'number' || typeof claims.exp !== 'number') return null;
  if (claims.iat > opts.nowSeconds + 60 || claims.exp <= opts.nowSeconds || claims.exp - claims.iat > SESSION_TTL_SECONDS) return null;
  if (claims.pv !== (await passwordVersion(opts.passwordHash))) return null;
  return { kind: 'verified-session', expiresAt: claims.exp };
}

/** The Set-Cookie value for a session, or for clearing it. */
export function sessionCookie(value: string | null, name: string = sessionCookieName()): string {
  const attrs = 'Path=/; HttpOnly; Secure; SameSite=Strict';
  return value === null ? `${name}=; ${attrs}; Max-Age=0` : `${name}=${value}; ${attrs}; Max-Age=${SESSION_TTL_SECONDS}`;
}
