/**
 * Microsoft identity for the archive (SPEC.md section 5; DECISIONS.md D-49).
 *
 * Public client, no secret: the device authorization grant signs me in once
 * from a terminal, and the refresh token carries every scheduled run after
 * that. The authority is hard-coded to /consumers, which admits personal
 * Microsoft accounts only, so an NUS work account cannot sign in even by
 * mistake. The guard refuses any other authority as well.
 *
 * Refresh tokens rotate: each exchange returns a new one, which is persisted
 * BEFORE the access token is used. Microsoft documents (checked 2026-09-21)
 * that it "doesn't revoke old refresh tokens when used to fetch new access
 * tokens", so a crash between the exchange and the save is harmless -- the
 * previous token still works. SPEC.md originally said the opposite; D-49.
 */

import type { Clock } from '../core/clock.ts';
import { sleep as realSleep } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';
import { scrubString } from '../core/redact.ts';
import { LOGIN_BASE, type RequestGuard } from './guard.ts';

export type GraphErrorCode =
  | 'auth' // refresh token dead or consent revoked: sign in again
  | 'provisioning' // the 2026 AppFolder regression: 403 serviceReadOnly / 503 pending provisioning
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'quota' // 507: the drive is full
  | 'throttled'
  | 'server'
  | 'network'
  | 'malformed';

export class GraphError extends Error {
  readonly code: GraphErrorCode;
  readonly status: number | null;
  constructor(code: GraphErrorCode, message: string, status: number | null = null) {
    super(scrubString(message));
    this.name = 'GraphError';
    this.code = code;
    this.status = status;
  }
}

export interface TokenProviderOptions {
  clientId: string;
  scope: string;
  guard: RequestGuard;
  log: Logger;
  clock: Clock;
  /** The current refresh token. */
  refreshToken: () => string;
  /** Persist the NEW refresh token. Must resolve before the token is used. */
  saveRefreshToken: (token: string) => Promise<void>;
  loginBase?: string;
  fetchImpl?: typeof fetch;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

function tokenUrl(loginBase: string): string {
  return `${loginBase.replace(/\/+$/, '')}/consumers/oauth2/v2.0/token`;
}

export class TokenProvider {
  private readonly options: TokenProviderOptions;
  private readonly doFetch: typeof fetch;
  private access: { token: string; expiresAt: number } | null = null;

  constructor(options: TokenProviderOptions) {
    this.options = options;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  invalidate(): void {
    this.access = null;
  }

  async get(): Promise<string> {
    const now = this.options.clock.now().getTime();
    if (this.access !== null && this.access.expiresAt - 60_000 > now) return this.access.token;

    const url = tokenUrl(this.options.loginBase ?? LOGIN_BASE);
    const body = new URLSearchParams({
      client_id: this.options.clientId,
      grant_type: 'refresh_token',
      refresh_token: this.options.refreshToken(),
      scope: this.options.scope,
    }).toString();
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    this.options.guard.check({ method: 'POST', url, headers, body });

    let response: Response;
    let json: TokenResponse;
    try {
      response = await this.doFetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(20_000) });
      json = (await response.json().catch(() => ({}))) as TokenResponse;
    } catch (error) {
      throw new GraphError('network', `token refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!response.ok || typeof json.access_token !== 'string') {
      const code = json.error ?? `http_${response.status}`;
      const dead = code === 'invalid_grant' || code === 'interaction_required' || code === 'consent_required';
      throw new GraphError(dead ? 'auth' : 'server', `token refresh rejected: ${code}`, response.status);
    }

    // Persist first. If this throws, the new access token is never used and
    // the run stops; the previous refresh token remains valid.
    if (typeof json.refresh_token === 'string' && json.refresh_token !== '') {
      await this.options.saveRefreshToken(json.refresh_token);
    }
    this.access = { token: json.access_token, expiresAt: now + (json.expires_in ?? 3600) * 1000 };
    return this.access.token;
  }
}

export interface DeviceLoginOptions {
  clientId: string;
  scope: string;
  guard: RequestGuard;
  clock: Clock;
  /** Shown to me: where to go and which code to type. */
  prompt: (message: string) => void;
  loginBase?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** The device authorization grant, against /consumers only. */
export async function deviceCodeLogin(options: DeviceLoginOptions): Promise<{ refreshToken: string; accessToken: string }> {
  const base = (options.loginBase ?? LOGIN_BASE).replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const wait = options.sleep ?? realSleep;
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };

  const codeUrl = `${base}/consumers/oauth2/v2.0/devicecode`;
  const codeBody = new URLSearchParams({ client_id: options.clientId, scope: options.scope }).toString();
  options.guard.check({ method: 'POST', url: codeUrl, headers, body: codeBody });
  const codeResponse = await doFetch(codeUrl, { method: 'POST', headers, body: codeBody });
  const code = (await codeResponse.json().catch(() => ({}))) as {
    device_code?: string;
    message?: string;
    interval?: number;
    expires_in?: number;
    error?: string;
  };
  if (!codeResponse.ok || typeof code.device_code !== 'string') {
    throw new GraphError('auth', `device code request failed: ${code.error ?? codeResponse.status}`, codeResponse.status);
  }
  options.prompt(code.message ?? 'Complete the sign-in in a browser.');

  const deadline = options.clock.now().getTime() + (code.expires_in ?? 900) * 1000;
  let interval = Math.max(1, code.interval ?? 5) * 1000;
  const url = tokenUrl(base);
  while (options.clock.now().getTime() < deadline) {
    await wait(interval);
    const body = new URLSearchParams({
      client_id: options.clientId,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code.device_code,
    }).toString();
    options.guard.check({ method: 'POST', url, headers, body });
    const response = await doFetch(url, { method: 'POST', headers, body });
    const json = (await response.json().catch(() => ({}))) as TokenResponse;
    if (response.ok && typeof json.access_token === 'string') {
      if (typeof json.refresh_token !== 'string') {
        throw new GraphError('auth', 'signed in, but no refresh token came back (was offline_access requested?)');
      }
      return { refreshToken: json.refresh_token, accessToken: json.access_token };
    }
    if (json.error === 'authorization_pending') continue;
    if (json.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new GraphError('auth', `sign-in did not complete: ${json.error ?? response.status}`, response.status);
  }
  throw new GraphError('auth', 'sign-in timed out before the code was entered');
}
