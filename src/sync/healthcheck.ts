/**
 * Optional dead-man's switch (DECISIONS.md D-44).
 *
 * Every alert in this system is sent BY a run. If runs stop -- the workflow is
 * auto-disabled, Actions has an outage, the schedule is silently dropped --
 * nothing is left to notice, and SPEC.md section 2.1's "never silently fail"
 * has exactly one blind spot: the case where the failure is that nothing ran.
 *
 * An external service that expects a ping every run and alerts when pings stop
 * is the only thing that closes it. Pings never throw and never delay a sync
 * by more than a few seconds: a monitoring hook must not become a failure mode.
 */

import type { Logger } from '../core/log.ts';

export type PingKind = 'start' | 'success' | 'fail';

export async function ping(url: string | undefined, kind: PingKind, log: Logger): Promise<void> {
  if (url === undefined || url === '') return;
  const target = kind === 'success' ? url : `${url.replace(/\/+$/, '')}/${kind}`;
  try {
    await fetch(target, { method: 'POST', signal: AbortSignal.timeout(5_000) });
  } catch (error) {
    log.warn('healthcheck.ping_failed', { kind, reason: error instanceof Error ? error.message : String(error) });
  }
}
