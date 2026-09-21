/**
 * The app's view of OneDrive: one root folder, create-only (DECISIONS.md D-50).
 *
 * Everything here addresses items by PATH under the root, built by
 * `rootedPath` from segments that `safeSegment` produced. There is no method
 * that takes an item id, a raw URL, or a path outside the root -- and every
 * request still passes the guard before it is sent.
 */

import type { Clock } from '../core/clock.ts';
import { sleep as realSleep } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';
import { GraphError, type TokenProvider } from './auth.ts';
import { GRAPH_BASE, rootedPath, type RequestGuard, type RootSpec } from './guard.ts';

export interface DriveItem {
  id: string;
  name: string;
  size?: number;
  webUrl?: string;
  folder?: Record<string, unknown>;
  file?: { hashes?: { sha1Hash?: string; sha256Hash?: string; quickXorHash?: string } };
  parentReference?: { driveType?: string; path?: string };
}

export interface Quota {
  total: number;
  used: number;
  remaining: number;
  state: string | null;
}

/**
 * 16 x 320 KiB = 5 MiB. Microsoft: fragments must be multiples of 320 KiB
 * when a file is split, each under 60 MiB, and 5-10 MiB is recommended.
 */
export const CHUNK_BYTES = 16 * 320 * 1024;

const CONFLICT_QUERY = `?${encodeURIComponent('@microsoft.graph.conflictBehavior')}=fail`;

export interface GraphDriveOptions {
  root: RootSpec;
  guard: RequestGuard;
  tokens: TokenProvider;
  log: Logger;
  clock: Clock;
  graphBase?: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  chunkBytes?: number;
}

interface GraphErrorBody {
  error?: { code?: string; message?: string; innerError?: { code?: string } };
}

function classify(status: number, body: GraphErrorBody, context: string): GraphError {
  const code = body.error?.code ?? '';
  const inner = body.error?.innerError?.code ?? '';
  const message = `${context}: ${status} ${code}${inner ? `/${inner}` : ''} ${body.error?.message ?? ''}`.trim();
  // The 2026 regression on personal OneDrive: newly consented AppFolder-only
  // apps are read-only or "pending provisioning" (DECISIONS.md D-51).
  if (inner === 'serviceReadOnly' || code === 'itemDisabledDueToPendingProvisioning' || inner === 'itemDisabledDueToPendingProvisioning') {
    return new GraphError('provisioning', message, status);
  }
  if (status === 401) return new GraphError('auth', message, status);
  if (status === 403) return new GraphError('forbidden', message, status);
  if (status === 404) return new GraphError('not_found', message, status);
  if (status === 409) return new GraphError('conflict', message, status);
  if (status === 507) return new GraphError('quota', message, status);
  if (status === 429) return new GraphError('throttled', message, status);
  return new GraphError('server', message, status);
}

function retryAfterMs(response: Response): number {
  const raw = response.headers.get('retry-after');
  const seconds = raw === null ? Number.NaN : Number.parseFloat(raw);
  return Number.isFinite(seconds) ? Math.min(30_000, Math.max(0, seconds * 1000)) : 2000;
}

export class GraphDrive {
  private readonly o: GraphDriveOptions;
  private readonly base: string;
  private readonly doFetch: typeof fetch;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly knownFolders = new Set<string>();

  constructor(options: GraphDriveOptions) {
    this.o = options;
    this.base = (options.graphBase ?? GRAPH_BASE).replace(/\/+$/, '');
    this.doFetch = options.fetchImpl ?? fetch;
    this.wait = options.sleep ?? realSleep;
  }

  // --- the one place Graph is called -----------------------------------------

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, query = ''): Promise<T> {
    const url = `${this.base}${path}${query}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const attempts = this.o.maxAttempts ?? 4;
    let refreshed = false;

    for (let attempt = 1; ; attempt += 1) {
      const headers: Record<string, string> = { authorization: `Bearer ${await this.o.tokens.get()}` };
      if (payload !== undefined) headers['content-type'] = 'application/json';
      this.o.guard.check({ method, url, headers, ...(payload === undefined ? {} : { body: payload }) });

      let response: Response;
      try {
        response = await this.doFetch(url, { method, headers, ...(payload === undefined ? {} : { body: payload }), signal: AbortSignal.timeout(30_000) });
      } catch (error) {
        if (attempt < attempts) {
          await this.wait(500 * 2 ** attempt);
          continue;
        }
        throw new GraphError('network', `${method} ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (response.ok) return (await response.json()) as T;
      const errorBody = (await response.json().catch(() => ({}))) as GraphErrorBody;

      if (response.status === 401 && !refreshed) {
        refreshed = true;
        this.o.tokens.invalidate();
        continue;
      }
      const error = classify(response.status, errorBody, `${method} ${path}`);
      const retryable = response.status === 429 || (response.status >= 500 && error.code !== 'quota' && error.code !== 'provisioning');
      if (retryable && attempt < attempts) {
        await this.wait(response.status === 429 || response.status === 503 ? retryAfterMs(response) : 500 * 2 ** attempt);
        continue;
      }
      throw error;
    }
  }

  // --- reads -----------------------------------------------------------------

  /**
   * The root folder. In folder mode it is created on first use -- the only
   * write the guard allows outside the root, and only by the root's own name.
   */
  async rootItem(): Promise<DriveItem> {
    try {
      return await this.request<DriveItem>('GET', rootedPath(this.o.root, []));
    } catch (error) {
      if (!(error instanceof GraphError) || error.code !== 'not_found' || this.o.root.mode !== 'folder') throw error;
      await this.request<DriveItem>('POST', '/me/drive/root/children', {
        name: this.o.root.name,
        folder: {},
        '@microsoft.graph.conflictBehavior': 'fail',
      }, CONFLICT_QUERY);
      return this.request<DriveItem>('GET', rootedPath(this.o.root, []));
    }
  }

  async itemAt(segments: readonly string[]): Promise<DriveItem | null> {
    try {
      return await this.request<DriveItem>('GET', rootedPath(this.o.root, segments));
    } catch (error) {
      if (error instanceof GraphError && error.code === 'not_found') return null;
      throw error;
    }
  }

  /**
   * Quota straight from the drive -- never hard-coded. Under the AppFolder
   * scope Microsoft does not list GET /me/drive as permitted; a refusal is
   * reported as 'unreadable' rather than as a failure.
   */
  async quota(): Promise<Quota | 'unreadable'> {
    try {
      const drive = await this.request<{ quota?: Partial<Quota> }>('GET', '/me/drive', undefined, `?${encodeURIComponent('$select')}=quota,driveType`);
      const q = drive.quota;
      if (q === undefined || typeof q.total !== 'number' || typeof q.used !== 'number') return 'unreadable';
      return { total: q.total, used: q.used, remaining: q.remaining ?? q.total - q.used, state: q.state ?? null };
    } catch (error) {
      if (error instanceof GraphError && (error.code === 'forbidden' || error.code === 'not_found')) return 'unreadable';
      throw error;
    }
  }

  // --- writes: create only ---------------------------------------------------

  /** Create each missing folder along the path. Never replaces anything. */
  async ensureFolders(segments: readonly string[]): Promise<void> {
    for (let depth = 1; depth <= segments.length; depth += 1) {
      const path = segments.slice(0, depth);
      const key = path.join('/').toLowerCase();
      if (this.knownFolders.has(key)) continue;

      let item = await this.itemAt(path);
      if (item === null) {
        try {
          item = await this.request<DriveItem>(
            'POST',
            rootedPath(this.o.root, path.slice(0, -1), 'children'),
            { name: path[path.length - 1], folder: {}, '@microsoft.graph.conflictBehavior': 'fail' },
            CONFLICT_QUERY,
          );
        } catch (error) {
          // Lost a race with ourselves or found it after all: re-read.
          if (!(error instanceof GraphError) || error.code !== 'conflict') throw error;
          item = await this.itemAt(path);
        }
      }
      if (item === null || item.folder === undefined) {
        throw new GraphError('conflict', `"${path.join('/')}" exists and is not a folder`);
      }
      this.knownFolders.add(key);
    }
  }

  /**
   * Upload through a session that FAILS on a name clash -- never the simple
   * PUT, whose documented default is to replace an existing file. A conflict
   * surfaces as GraphError('conflict') for the caller to pick another name.
   */
  async upload(segments: readonly string[], bytes: Uint8Array): Promise<DriveItem> {
    const name = segments[segments.length - 1];
    if (name === undefined) throw new GraphError('malformed', 'upload needs a file name');

    for (let session = 1; session <= 2; session += 1) {
      const created = await this.request<{ uploadUrl?: string }>(
        'POST',
        rootedPath(this.o.root, segments, 'createUploadSession'),
        { item: { '@microsoft.graph.conflictBehavior': 'fail', name, fileSize: bytes.length } },
        CONFLICT_QUERY,
      );
      if (typeof created.uploadUrl !== 'string') throw new GraphError('malformed', 'createUploadSession returned no uploadUrl');
      this.o.guard.registerUploadUrl(created.uploadUrl);

      const result = await this.sendFragments(created.uploadUrl, bytes);
      if (result !== 'restart') return result;
      this.o.log.warn('graph.upload_session_restarted', { reason: 'session expired or lost' });
    }
    throw new GraphError('server', 'upload session was lost twice');
  }

  private async sendFragments(uploadUrl: string, bytes: Uint8Array): Promise<DriveItem | 'restart'> {
    const total = bytes.length;
    // One fragment for small files; 320 KiB multiples only matter when splitting.
    const chunk = total <= (this.o.chunkBytes ?? CHUNK_BYTES) ? Math.max(total, 1) : (this.o.chunkBytes ?? CHUNK_BYTES);
    let offset = 0;
    let failures = 0;

    while (true) {
      const end = Math.min(offset + chunk, total);
      const headers: Record<string, string> = {
        'content-length': String(end - offset),
        'content-range': `bytes ${offset}-${end - 1}/${total}`,
      };
      // No Authorization: the URL is pre-authenticated, and Microsoft warns a
      // bearer token there may 401. The guard refuses it regardless.
      this.o.guard.check({ method: 'PUT', url: uploadUrl, headers });

      let response: Response;
      try {
        response = await this.doFetch(uploadUrl, { method: 'PUT', headers, body: bytes.subarray(offset, end), signal: AbortSignal.timeout(120_000) });
      } catch {
        if (++failures > 4) throw new GraphError('network', 'upload fragment kept failing');
        await this.wait(500 * 2 ** failures);
        const resume = await this.nextExpected(uploadUrl);
        if (resume === 'restart') return 'restart';
        offset = resume;
        continue;
      }

      if (response.status === 200 || response.status === 201) return (await response.json()) as DriveItem;
      if (response.status === 202) {
        const next = ((await response.json().catch(() => ({}))) as { nextExpectedRanges?: string[] }).nextExpectedRanges?.[0];
        offset = next === undefined ? end : Number.parseInt(next.split('-')[0] ?? String(end), 10);
        failures = 0;
        continue;
      }

      const body = (await response.json().catch(() => ({}))) as GraphErrorBody;
      if (response.status === 404) return 'restart';
      if (response.status === 409 || response.status === 507) throw classify(response.status, body, 'upload');
      if (response.status === 416 || response.status >= 500 || response.status === 429) {
        if (++failures > 4) throw classify(response.status, body, 'upload');
        await this.wait(response.status === 429 || response.status === 503 ? retryAfterMs(response) : 500 * 2 ** failures);
        const resume = await this.nextExpected(uploadUrl);
        if (resume === 'restart') return 'restart';
        offset = resume;
        continue;
      }
      throw classify(response.status, body, 'upload');
    }
  }

  /** Where to resume, from the session itself. */
  private async nextExpected(uploadUrl: string): Promise<number | 'restart'> {
    this.o.guard.check({ method: 'GET', url: uploadUrl, headers: {} });
    try {
      const response = await this.doFetch(uploadUrl, { method: 'GET', signal: AbortSignal.timeout(30_000) });
      if (response.status === 404) return 'restart';
      const body = (await response.json().catch(() => ({}))) as { nextExpectedRanges?: string[] };
      const first = body.nextExpectedRanges?.[0];
      return first === undefined ? 0 : Number.parseInt(first.split('-')[0] ?? '0', 10);
    } catch {
      return 'restart';
    }
  }
}
