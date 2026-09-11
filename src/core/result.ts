/**
 * The three-state result (SPEC.md section 4).
 *
 * Canvas returns 404 for permission denials as well as for genuinely absent
 * resources. "This course has no files" and "you are not allowed to see this
 * course's files" are indistinguishable by status code. Collapsing either into
 * an empty array would make a partial system look complete, which SPEC.md
 * section 2.2 forbids outright.
 *
 * There is deliberately NO `unwrapOr`, `valueOrEmpty`, or `?? []` helper in
 * this module. Callers must handle `denied_or_absent` explicitly or fail to
 * typecheck. That compile error is the whole point of this file.
 */

export type ErrorCode =
  | 'auth'          // 401 -- token dead or revoked. Pages me. Never retried.
  | 'rate_limited'  // 403-with-rate-limit-body, or 429.
  | 'server'        // 5xx
  | 'network'       // DNS, connection reset, TLS
  | 'timeout'
  | 'malformed'     // 2xx whose body did not parse as expected
  | 'unknown';

export interface Ok<T> {
  readonly kind: 'ok';
  readonly value: T;
}

export interface DeniedOrAbsent {
  readonly kind: 'denied_or_absent';
  readonly status: number;
  readonly endpoint: string;
  readonly detail: string;
}

export interface Failure {
  readonly kind: 'error';
  readonly code: ErrorCode;
  readonly endpoint: string;
  readonly message: string;
  readonly status?: number;
  readonly retryable: boolean;
}

export type Result<T> = Ok<T> | DeniedOrAbsent | Failure;

export function ok<T>(value: T): Ok<T> {
  return { kind: 'ok', value };
}

export function deniedOrAbsent(endpoint: string, status: number, detail: string): DeniedOrAbsent {
  return { kind: 'denied_or_absent', endpoint, status, detail };
}

export function failure(
  endpoint: string,
  code: ErrorCode,
  message: string,
  opts: { status?: number; retryable?: boolean } = {},
): Failure {
  const retryable = opts.retryable ?? (code === 'server' || code === 'network' || code === 'timeout' || code === 'rate_limited');
  return opts.status === undefined
    ? { kind: 'error', endpoint, code, message, retryable }
    : { kind: 'error', endpoint, code, message, retryable, status: opts.status };
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.kind === 'ok';
}

/** Map the success arm, preserving both non-ok arms untouched. */
export function mapOk<T, U>(r: Result<T>, fn: (value: T) => U): Result<U> {
  return r.kind === 'ok' ? ok(fn(r.value)) : r;
}

/** A one-line description suitable for a log field or an operator alert. */
export function describe<T>(r: Result<T>): string {
  switch (r.kind) {
    case 'ok':
      return 'ok';
    case 'denied_or_absent':
      return `denied_or_absent(${r.status}) ${r.endpoint}: ${r.detail}`;
    case 'error':
      return `error(${r.code}${r.status === undefined ? '' : ` ${r.status}`}) ${r.endpoint}: ${r.message}`;
  }
}
