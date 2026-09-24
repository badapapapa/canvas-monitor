import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Canvas Monitor',
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: 'same-origin',
};

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#F5F3EE' };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the request makes every page render per request, which the CSP
  // nonce needs (and nothing here is ever cached anyway).
  await headers();
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
