/**
 * Canvas HTTP outcome -> one of three states (SPEC.md section 4).
 *
 * The two traps this encodes:
 *
 * 1. Canvas returns 404 for permission denial, not 403. A 404 from
 *    /courses/:id/files may mean "no files" or "not allowed to see files".
 *    Both become `denied_or_absent`; neither becomes an empty array.
 *
 * 2. Canvas returns 403 for BOTH rate limiting and permission denial. They are
 *    different failures wearing the same status code: one should be retried
 *    after a pause, the other should never be retried and should reduce the
 *    recorded coverage for that course. They are told apart by the body text
 *    and the rate-limit header.
 */

import type { ErrorCode } from '../core/result.ts';

export type Classification =
  | { kind: 'ok' }
  | { kind: 'denied_or_absent'; detail: string }
  | { kind: 'retryable'; code: ErrorCode; message: string; retryAfterMs: number | undefined }
  | { kind: 'fatal'; code: ErrorCode; message: string };

const RATE_LIMIT_BODY = /rate\s*limit/i;

export function classifyResponse(
  status: number,
  headers: Headers,
  bodyText: string,
): Classification {
  if (status >= 200 && status < 300) return { kind: 'ok' };

  const retryAfterMs = parseRetryAfter(headers.get('retry-after'));

  if (status === 401) {
    return {
      kind: 'fatal',
      code: 'auth',
      message: 'Canvas rejected the token (401). It is expired, revoked, or wrong.',
    };
  }

  if (status === 403) {
    const remaining = Number.parseFloat(headers.get('x-rate-limit-remaining') ?? '');
    const looksRateLimited = RATE_LIMIT_BODY.test(bodyText) || (Number.isFinite(remaining) && remaining <= 0);
    if (looksRateLimited) {
      return {
        kind: 'retryable',
        code: 'rate_limited',
        message: `Canvas rate limit hit (403, remaining=${headers.get('x-rate-limit-remaining') ?? 'n/a'}).`,
        retryAfterMs,
      };
    }
    return { kind: 'denied_or_absent', detail: `403 permission denied: ${truncate(bodyText)}` };
  }

  if (status === 404) {
    // Deliberately not an error, and deliberately not an empty list.
    return { kind: 'denied_or_absent', detail: `404 absent or not permitted: ${truncate(bodyText)}` };
  }

  if (status === 429) {
    return { kind: 'retryable', code: 'rate_limited', message: 'Canvas returned 429.', retryAfterMs };
  }

  if (status === 408) {
    return { kind: 'retryable', code: 'timeout', message: 'Canvas returned 408.', retryAfterMs };
  }

  if (status >= 500) {
    return {
      kind: 'retryable',
      code: 'server',
      message: `Canvas returned ${status}: ${truncate(bodyText)}`,
      retryAfterMs,
    };
  }

  return { kind: 'fatal', code: 'unknown', message: `Canvas returned ${status}: ${truncate(bodyText)}` };
}

function parseRetryAfter(raw: string | null): number | undefined {
  if (raw === null) return undefined;
  const seconds = Number.parseFloat(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = new Date(raw);
  if (!Number.isNaN(at.getTime())) return undefined; // absolute dates need a clock; ignore.
  return undefined;
}

function truncate(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max)}...`;
}
