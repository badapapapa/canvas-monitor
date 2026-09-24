/**
 * The CSRF check for login and logout (DECISIONS.md D-65): a form POST whose
 * browser-set Origin names this very host, and nothing else. A page on another
 * site cannot make its browser send an Origin equal to this host. SameSite=Strict
 * on the session cookie is the other half.
 *
 * Compared with the Host header, not the request URL: a server can rebuild its
 * own URL with a different host name than the one the browser used.
 */
export function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  const host = request.headers.get('host');
  const site = request.headers.get('sec-fetch-site');
  if (origin === null || host === null || (site !== null && site !== 'same-origin')) return false;
  try {
    const o = new URL(origin);
    return (o.protocol === 'https:' || o.protocol === 'http:') && o.host === host;
  } catch {
    return false;
  }
}
