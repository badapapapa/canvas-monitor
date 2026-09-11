/**
 * The one place that talks to Canvas over HTTP (SPEC.md section 4).
 *
 * Pagination, rate limiting, retry policy, three-state error classification and
 * raw capture all live here so that no call site has to remember any of them.
 * `CanvasClient` above this layer is just typed endpoint names.
 *
 * SECURITY -- cross-origin redirects and the bearer token:
 *
 *   Canvas file `url` fields redirect to an external storage host
 *   (instructure-uploads / S3). Authorisation for that hop is the `verifier`
 *   query parameter, NOT the bearer token. The WHATWG fetch specification
 *   requires `Authorization` to be stripped when a redirect crosses origins,
 *   and undici (Node's built-in fetch) implements this -- so the NUS token is
 *   not forwarded to a CDN.
 *
 *   That guarantee is a property of the HTTP client, not of this code. Swapping
 *   in axios, got, or node-fetch would silently leak the token to a third-party
 *   host on every file download. test/unit/canvas-http.test.ts asserts the
 *   stripping behaviour against a real redirect, so a client swap fails the
 *   build instead of leaking. Do not delete that test.
 */

import { classifyResponse } from './classify-error.ts';
import { parseLinkHeader } from './paginate.ts';
import type { RateLimitGovernor } from './rate-limit.ts';
import type { RawStore } from './raw-store.ts';
import { failure, ok, deniedOrAbsent, type Result } from '../core/result.ts';
import { sleep, type Clock } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';

export type QueryValue = string | number | boolean | readonly (string | number)[] | undefined;
export type Query = Record<string, QueryValue>;

export interface CanvasHttpOptions {
  baseUrl: string;
  token: string;
  log: Logger;
  clock: Clock;
  governor: RateLimitGovernor;
  rawStore: RawStore;
  timeoutMs?: number;
  maxAttempts?: number;
  /** Injectable for tests. Must be a fetch that strips auth on cross-origin redirect. */
  fetchImpl?: typeof fetch;
}

export interface ListOptions<T> {
  /**
   * Stop paginating at the first item satisfying this predicate, keeping the
   * items before it. Used from Phase 3 with `sort=updated_at&order=desc` on
   * /files to avoid re-reading the whole file list every 20 minutes -- Canvas
   * offers no server-side `updated_since` filter (SPEC.md section 7).
   */
  stopWhen?: (item: T) => boolean;
  maxPages?: number;
}

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_ATTEMPTS = 4;
const DEFAULT_MAX_PAGES = 200;
const PER_PAGE = 100;

/** One decoded Canvas response page: the body, plus the `rel="next"` link. */
interface RequestPage<T> {
  body: T;
  next: string | undefined;
}

export class CanvasHttp {
  private readonly options: CanvasHttpOptions;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly doFetch: typeof fetch;

  constructor(options: CanvasHttpOptions) {
    this.options = options;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  /** A single object endpoint. */
  async get<T>(path: string, query: Query = {}): Promise<Result<T>> {
    const url = this.buildUrl(path, query);
    const page = await this.request<T>(url, path);
    return page.kind === 'ok' ? ok(page.value.body) : page;
  }

  /** A paginated collection endpoint. Follows `rel="next"` to exhaustion. */
  async list<T>(path: string, query: Query = {}, options: ListOptions<T> = {}): Promise<Result<T[]>> {
    const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;
    let url: string | undefined = this.buildUrl(path, { per_page: PER_PAGE, ...query });
    const collected: T[] = [];

    for (let pageNumber = 1; url !== undefined && pageNumber <= maxPages; pageNumber += 1) {
      // Annotated because `url` is reassigned from `response` below, and
      // without it TypeScript reports a circular inference on the narrowing.
      const response: Result<RequestPage<T[]>> = await this.request<T[]>(url, path);

      // A failure on page 3 fails the whole listing. A partially-read
      // collection reported as complete is exactly the "looks complete and
      // isn't" failure SPEC.md section 2.2 prohibits.
      if (response.kind !== 'ok') return response;

      const body = response.value.body;
      if (!Array.isArray(body)) {
        return failure(path, 'malformed', `Expected an array from ${path}, got ${typeof body}.`);
      }

      let stopped = false;
      for (const item of body) {
        if (options.stopWhen?.(item) === true) {
          stopped = true;
          break;
        }
        collected.push(item);
      }

      if (stopped) {
        this.options.log.debug('canvas.paginate.early_stop', { path, page: pageNumber, collected: collected.length });
        return ok(collected);
      }

      url = response.value.next;

      if (url !== undefined && pageNumber === maxPages) {
        return failure(
          path,
          'unknown',
          `Pagination exceeded ${maxPages} pages for ${path}; refusing to continue.`,
          { retryable: false },
        );
      }
    }

    return ok(collected);
  }

  /**
   * One page only, no pagination.
   *
   * Coverage probing asks "can I see this at all?", not "what is all of it?".
   * Paginating a 400-file course to answer a yes/no question would spend the
   * rate-limit budget (SPEC.md section 4) on nothing.
   */
  async firstPage<T>(path: string, query: Query = {}): Promise<Result<T[]>> {
    const url = this.buildUrl(path, { per_page: 5, ...query });
    const response: Result<RequestPage<T[]>> = await this.request<T[]>(url, path);
    if (response.kind !== 'ok') return response;
    const body = response.value.body;
    if (!Array.isArray(body)) {
      return failure(path, 'malformed', `Expected an array from ${path}, got ${typeof body}.`);
    }
    return ok(body);
  }

  private buildUrl(pathOrUrl: string, query: Query): string {
    if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl;
    const base = this.options.baseUrl.replace(/\/+$/, '');
    const suffix = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`;
    const url = new URL(`${base}${suffix}`);
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) {
        for (const entry of value) url.searchParams.append(key, String(entry));
      } else {
        url.searchParams.set(key, String(value as string | number | boolean));
      }
    }
    return url.toString();
  }

  private async request<T>(url: string, endpoint: string): Promise<Result<RequestPage<T>>> {
    let lastRetryable: Result<never> | null = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt += 1) {
      await this.options.governor.beforeRequest();

      const startedAt = this.options.clock.now().getTime();
      let response: Response;
      let bodyText: string;

      try {
        response = await this.doFetch(url, {
          headers: {
            authorization: `Bearer ${this.options.token}`,
            accept: 'application/json',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        bodyText = await response.text();
      } catch (error) {
        const isTimeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        lastRetryable = failure(
          endpoint,
          isTimeout ? 'timeout' : 'network',
          error instanceof Error ? error.message : String(error),
        );
        if (attempt < this.maxAttempts) {
          await sleep(backoffMs(attempt, undefined));
          continue;
        }
        return lastRetryable;
      }

      const durationMs = this.options.clock.now().getTime() - startedAt;
      this.options.governor.observe(response.headers);

      const parsed = safeJson(bodyText);
      await this.options.rawStore.capture({
        method: 'GET',
        url,
        status: response.status,
        headers: response.headers,
        body: parsed.ok ? parsed.value : { unparsed: bodyText.slice(0, 4000) },
        durationMs,
      });

      const classification = classifyResponse(response.status, response.headers, bodyText);

      this.options.log.debug('canvas.request', {
        endpoint,
        status: response.status,
        outcome: classification.kind,
        duration_ms: durationMs,
        attempt,
        rate_remaining: response.headers.get('x-rate-limit-remaining'),
      });

      switch (classification.kind) {
        case 'denied_or_absent':
          return deniedOrAbsent(endpoint, response.status, classification.detail);

        case 'fatal':
          return failure(endpoint, classification.code, classification.message, {
            status: response.status,
            retryable: false,
          });

        case 'retryable': {
          lastRetryable = failure(endpoint, classification.code, classification.message, {
            status: response.status,
            retryable: true,
          });
          if (attempt < this.maxAttempts) {
            const waitMs = backoffMs(attempt, classification.retryAfterMs);
            this.options.log.warn('canvas.request.retrying', {
              endpoint,
              status: response.status,
              attempt,
              wait_ms: waitMs,
              code: classification.code,
            });
            await sleep(waitMs);
            continue;
          }
          return lastRetryable;
        }

        case 'ok': {
          if (!parsed.ok) {
            return failure(endpoint, 'malformed', `Canvas returned unparsable JSON: ${parsed.reason}`, {
              status: response.status,
              retryable: false,
            });
          }
          return ok({
            body: parsed.value as T,
            next: parseLinkHeader(response.headers.get('link')).next,
          });
        }
      }
    }

    return lastRetryable ?? failure(endpoint, 'unknown', 'Exhausted attempts without a classification.');
  }
}

function backoffMs(attempt: number, retryAfterMs: number | undefined): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, 60_000);
  const base = 500 * 2 ** (attempt - 1);
  const jitter = Math.random() * 250;
  return Math.min(30_000, base + jitter);
}

function safeJson(text: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  if (text.trim() === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(stripWhileTrue(text)) };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

/** Canvas prefixes some JSON responses with `while(1);` as an XSSI guard. */
function stripWhileTrue(text: string): string {
  return text.startsWith('while(1);') ? text.slice('while(1);'.length) : text;
}
