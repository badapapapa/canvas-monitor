/**
 * Every response's security headers (DECISIONS.md D-65). Set by the proxy on
 * every request it handles; tested as a unit.
 *
 * - Content-Security-Policy with a per-request nonce: scripts only from this
 *   origin with that nonce, no inline anything else, no third-party origin at
 *   all (no fonts, analytics or CDNs), frame-ancestors 'none'.
 * - Cache-Control: exactly what Next.js sends for a dynamic page, and what the
 *   live site was seen sending (D-71): `private, no-cache, no-store, max-age=0,
 *   must-revalidate`. No browser, proxy or CDN keeps a copy. The same value on
 *   every response, API routes included, so there is one to test.
 * - X-Robots-Tag: noindex, nofollow.
 * - Referrer-Policy: same-origin, so a click to Canvas, OneDrive or Google
 *   Calendar does not reveal the dashboard's address. NOT no-referrer: under
 *   no-referrer, browsers send `Origin: null` on every POST, even same-origin
 *   ones (Fetch standard), and the login's CSRF check would refuse them all
 *   (D-66; found in a real browser, not by fetch-based tests).
 * - Strict-Transport-Security and CSP upgrade-insecure-requests: on the
 *   production deployment only, which is always HTTPS (D-67). The local
 *   preview is plain http://localhost, and WebKit (Safari) applies
 *   upgrade-insecure-requests to localhost: its login form went to
 *   https://localhost and failed. Everywhere else both are left out, and
 *   nothing else changes, so HSTS is never sent over plain HTTP or on localhost.
 */

export const CACHE_CONTROL = 'private, no-cache, no-store, max-age=0, must-revalidate';

export interface HeaderMode {
  /** `next dev`: React needs eval and inline styles. */
  dev: boolean;
  /** The production deployment (lib/env.ts productionDeployment): the only one given HSTS and upgrade-insecure-requests. */
  production: boolean;
}

export function contentSecurityPolicy(nonce: string, { dev, production }: HeaderMode): string {
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
    ...(production ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function securityHeaders(nonce: string, mode: HeaderMode): Record<string, string> {
  return {
    'Content-Security-Policy': contentSecurityPolicy(nonce, mode),
    'Cache-Control': CACHE_CONTROL,
    'X-Robots-Tag': 'noindex, nofollow, noarchive',
    'Referrer-Policy': 'same-origin',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
    ...(mode.production ? { 'Strict-Transport-Security': 'max-age=63072000; includeSubDomains' } : {}),
  };
}

/** A fresh, unguessable nonce per request. */
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
