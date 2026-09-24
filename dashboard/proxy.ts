/**
 * The dashboard's outer gate (DECISIONS.md D-65). Runs before every request
 * except Next's own build assets (which hold no data).
 *
 *   1. Not the production deployment (a preview, or anywhere unasked):
 *      404 for everything, the login form included.
 *   2. Any secret missing: 503, nothing else.
 *   3. No valid session: pages redirect to /login, API routes get 401.
 *      Only /login and POST /api/login are reachable without one.
 *   4. Every response gets the security headers, with a fresh CSP nonce.
 *
 * This is not the only check: every page and route verifies the session again
 * itself before reading anything (app/_auth.ts), and the database layer
 * cannot be called without a verified session. A proxy bypass alone reads nothing.
 */

import { NextResponse, type NextRequest } from 'next/server.js';
import { productionDeployment, secrets, servingAllowed } from './lib/env.ts';
import { newNonce, securityHeaders } from './lib/headers.ts';
import { sessionCookieName, verifySession } from './lib/session.ts';

const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/login', '/api/login']);

export async function proxy(request: NextRequest): Promise<Response> {
  const nonce = newNonce();
  const headers = securityHeaders(nonce, { dev: process.env.NODE_ENV === 'development', production: productionDeployment() });
  const finish = (res: Response): Response => {
    for (const [k, v] of Object.entries(headers)) res.headers.set(k, v);
    return res;
  };

  if (!servingAllowed()) return finish(new NextResponse('Not found', { status: 404 }));
  const s = secrets();
  if (s === null) return finish(new NextResponse('Not configured', { status: 503 }));

  const path = request.nextUrl.pathname;
  const session = await verifySession(request.cookies.get(sessionCookieName())?.value, {
    secret: s.sessionSecret, passwordHash: s.passwordHash, nowSeconds: Math.floor(Date.now() / 1000),
  });

  if (session === null && !PUBLIC_PATHS.has(path)) {
    if (path.startsWith('/api/')) return finish(Response.json({ error: 'unauthorized' }, { status: 401 }));
    return finish(NextResponse.redirect(new URL('/login', request.url), 303));
  }
  if (session !== null && path === '/login') return finish(NextResponse.redirect(new URL('/', request.url), 303));

  // Hand the nonce to the render, which applies it to Next's own scripts.
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', headers['Content-Security-Policy']!);
  return finish(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
