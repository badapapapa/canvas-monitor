/**
 * Next.js configuration (DECISIONS.md D-65). The per-request security headers,
 * CSP included, are set by proxy.ts; these also cover Next's own static assets.
 */
import path from 'node:path';
import type { NextConfig } from 'next';

// This folder is the whole app: never reach up into the main project's files.
const root = path.resolve(process.cwd());

const nextConfig: NextConfig = {
  poweredByHeader: false,
  reactStrictMode: true,
  productionBrowserSourceMaps: false,
  turbopack: { root },
  outputFileTracingRoot: root,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Robots-Tag', value: 'noindex, nofollow, noarchive' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
