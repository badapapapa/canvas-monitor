/** POST /api/logout (DECISIONS.md D-65): clears the session cookie. Needs a session, like every route. */

import { sessionCookie } from '../../../lib/session.ts';
import { sameOrigin } from '../../../lib/origin.ts';
import { CACHE_CONTROL } from '../../../lib/headers.ts';
import { sessionForRoute } from '../../_auth.ts';

export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  if ((await sessionForRoute(request)) === null) return Response.json({ error: 'unauthorized' }, { status: 401 });
  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });
  return new Response(null, { status: 303, headers: { Location: '/login', 'Set-Cookie': sessionCookie(null), 'Cache-Control': CACHE_CONTROL } });
}
