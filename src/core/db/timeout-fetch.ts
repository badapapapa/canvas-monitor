/**
 * A request timeout for Turso (DECISIONS.md D-77). The libsql client talks to
 * Turso over HTTPS through `fetch`, and sets no timeout of its own: a stalled
 * connection would hold a sync until GitHub's 10-minute job timeout killed it,
 * before it could release the lock or tell Healthchecks.
 *
 * Every database request now gives up after this long, and the error reaches
 * the caller like any other database failure: one course fails alone, or the
 * run fails quickly and says so.
 */

export const DB_REQUEST_TIMEOUT_MS = 15_000;

export function fetchWithTimeout(ms: number = DB_REQUEST_TIMEOUT_MS, base: typeof fetch = fetch): typeof fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(ms);
    const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
    return base(input, { ...init, signal });
  };
}
