/**
 * POST /api/login (DECISIONS.md D-65). Reachable without a session, and the
 * only thing that is. It writes nothing anywhere: a success sets the signed
 * session cookie, a failure waits and says nothing specific. No attempt is
 * logged, and nothing about the password ever is.
 */

import { secrets, servingAllowed } from '../../../lib/env.ts';
import { verifyPassword } from '../../../lib/password.ts';
import { sessionCookie, signSession } from '../../../lib/session.ts';
import { sameOrigin } from '../../../lib/origin.ts';

export const dynamic = 'force-dynamic';

/** Every failure takes at least this long, so a guess costs the same however it fails. */
const FAILURE_FLOOR_MS = 1000;

function seeOther(location: string, extra: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { Location: location, 'Cache-Control': 'no-store', ...extra } });
}

export async function POST(request: Request): Promise<Response> {
  const started = Date.now();
  if (!servingAllowed()) return new Response('Not found', { status: 404 });
  const s = secrets();
  if (s === null) return new Response('Not configured', { status: 503 });
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });

  const form = await request.formData().catch(() => null);
  const raw = form?.get('password');
  const password = typeof raw === 'string' ? raw : '';

  if (!(await verifyPassword(password, s.passwordHash))) {
    const wait = FAILURE_FLOOR_MS - (Date.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return seeOther('/login?e=1');
  }
  const value = await signSession({ secret: s.sessionSecret, passwordHash: s.passwordHash, nowSeconds: Math.floor(Date.now() / 1000) });
  return seeOther('/', { 'Set-Cookie': sessionCookie(value) });
}

export async function GET(): Promise<Response> {
  return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
}
