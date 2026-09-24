/**
 * Every response's security headers (DECISIONS.md D-65). Set by the proxy on
 * every request it handles; tested as a unit.
 *
 * - Content-Security-Policy with a per-request nonce: scripts only from this
 *   origin with that nonce, no inline anything else, no third-party origin at
 *   all (no fonts, analytics or CDNs), frame-ancestors 'none'.
 * - Cache-Control: no-store, so no browser, proxy or CDN keeps a copy.
 * - X-Robots-Tag: noindex, nofollow.
 * - Referrer-Policy: no-referrer, so a click to Canvas, OneDrive or Google
 *   Calendar does not reveal the dashboard's address.
 */

export function contentSecurityPolicy(nonce: string, dev: boolean): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${dev ? " 'unsafe-eval'" : ''}`,
    `style-src 'self'${dev ? " 'unsafe-inline'" : ` 'nonce-${nonce}'`}`,
    "img-src 'self'",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    'upgrade-insecure-requests',
  ].join('; ');
}

export function securityHeaders(nonce: string, dev: boolean): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(nonce, dev),
    'Cache-Control': 'no-store, max-age=0',
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    'Strict-Transport-Security': 'max-age=63072000; includeSubDomains',
  };
}

/** A fresh, unguessable nonce per request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
