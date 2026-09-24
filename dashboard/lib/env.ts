/**
 * Where the dashboard may show data (DECISIONS.md D-65).
 *
 * ONLY on the production deployment -- or locally, when explicitly asked with
 * DASHBOARD_LOCAL=1 and not on Vercel at all. A preview deployment serves
 * nothing, not even the login form, even if a secret were ever scoped to it by
 * mistake. Every secret is also scoped to Production only in Vercel, so a
 * preview has none to use: two independent layers.
 */

export interface DashboardEnv {
  VERCEL?: string | undefined;
  VERCEL_ENV?: string | undefined;
  DASHBOARD_LOCAL?: string | undefined;
  NODE_ENV?: string | undefined;
}

export function servingAllowed(env: DashboardEnv = process.env): boolean {
  if (onVercel(env)) return env.VERCEL_ENV === 'production';
  return env.DASHBOARD_LOCAL === '1';
}

function onVercel(env: DashboardEnv): boolean {
  return env.VERCEL_ENV !== undefined || env.VERCEL !== undefined;
}

/**
 * The production deployment: the only place that is always HTTPS, so the only
 * one sent HSTS and upgrade-insecure-requests (lib/headers.ts, D-67). Not the
 * local http:// preview, not `vercel dev`, not a preview deployment's 404s.
 */
export function productionDeployment(env: DashboardEnv = process.env): boolean {
  return onVercel(env) && env.VERCEL_ENV === 'production';
}

export interface Secrets {
  readModelUrl: string;
  readModelToken: string;
  passwordHash: string;
  sessionSecret: string;
}

/** The four secrets, or null if any is missing: then nothing is served. Never logged. */
export function secrets(env: Record<string, string | undefined> = process.env): Secrets | null {
  const s = {
    readModelUrl: env['READMODEL_DATABASE_URL'] ?? '',
    readModelToken: env['READMODEL_READ_TOKEN'] ?? '',
    passwordHash: env['DASHBOARD_PASSWORD_HASH'] ?? '',
    sessionSecret: env['DASHBOARD_SESSION_SECRET'] ?? '',
  };
  return Object.values(s).every((v) => v.trim() !== '') ? s : null;
}
