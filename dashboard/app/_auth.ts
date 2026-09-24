/**
 * The inner check (DECISIONS.md D-65): every page and route calls one of these
 * BEFORE reading anything, whatever the proxy did. A test fails the build if a
 * page or route does not.
 */

import { cookies } from 'next/headers';
import { redirect, notFound } from 'next/navigation';
import { secrets, servingAllowed, type Secrets } from '../lib/env.ts';
import { SESSION_COOKIE, verifySession, type VerifiedSession } from '../lib/session.ts';

/** For pages: a verified session and the secrets, or a redirect to /login. */
export async function requireSession(): Promise<{ session: VerifiedSession; secrets: Secrets }> {
  if (!servingAllowed()) notFound();
  const s = secrets();
  if (s === null) notFound();
  const session = await verifySession((await cookies()).get(SESSION_COOKIE)?.value, {
    secret: s.sessionSecret, passwordHash: s.passwordHash, nowSeconds: Math.floor(Date.now() / 1000),
  });
  if (session === null) redirect('/login');
  return { session, secrets: s };
}

/** For API routes: a verified session, or null (the route answers 401). */
export async function sessionForRoute(request: Request): Promise<VerifiedSession | null> {
  if (!servingAllowed()) return null;
  const s = secrets();
  if (s === null) return null;
  const cookie = (request.headers.get('cookie') ?? '').split(';').map((c) => c.trim()).find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  return verifySession(cookie?.slice(SESSION_COOKIE.length + 1), {
    secret: s.sessionSecret, passwordHash: s.passwordHash, nowSeconds: Math.floor(Date.now() / 1000),
  });
}

export { sameOrigin } from '../lib/origin.ts';
