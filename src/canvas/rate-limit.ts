/**
 * Canvas leaky-bucket governor (SPEC.md section 4).
 *
 * Canvas returns `X-Rate-Limit-Remaining` on every response and `X-Request-Cost`
 * for the request just served. The bucket refills over time, so the correct
 * response to a low reading is to WAIT, not to retry a fixed number of times.
 *
 * The spec originally said "if it drops below 100, sleep". 100 is only
 * meaningful relative to a bucket ceiling the spec never states, and the
 * ceiling is per-token and configurable per Canvas instance. So the threshold
 * is derived from the highest remaining value actually observed, and the
 * observed ceiling is logged on first sight -- evidence rather than a guess.
 *
 * This governor is load-bearing, not defensive: because Canvas offers no
 * server-side `updated_since` filter on the endpoints this system polls
 * (SPEC.md section 7), every run re-lists every resource in full.
 */

import { sleep } from '../core/clock.ts';
import type { Logger } from '../core/log.ts';

/** Pause once remaining falls below this fraction of the observed ceiling. */
const THRESHOLD_FRACTION = 0.2;

/**
 * The NUS bucket ceiling, observed 2026-09-10 (DECISIONS.md D-31).
 *
 * `X-Rate-Limit-Remaining` reported exactly 700 on every response of the first
 * live probe, and never dented across the run. This replaces the placeholder
 * floor the threshold used to fall back on: a ceiling reading below this is
 * treated as an artefact of a partially-drained bucket rather than as the real
 * size, so the threshold stays anchored at 140 instead of collapsing to
 * something that would let a run drain the bucket before pausing.
 *
 * Still raised by observation -- if NUS ever runs a larger bucket, the
 * governor follows the evidence rather than this constant.
 */
const OBSERVED_NUS_CEILING = 700;
const BASE_PAUSE_MS = 1_000;
const MAX_PAUSE_MS = 30_000;

export interface RateLimitSnapshot {
  ceiling: number | null;
  remaining: number | null;
  lastCost: number | null;
  threshold: number | null;
  pauses: number;
  totalPausedMs: number;
}

export class RateLimitGovernor {
  private ceiling: number | null = null;
  private remaining: number | null = null;
  private lastCost: number | null = null;
  private pauses = 0;
  private totalPausedMs = 0;

  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  observe(headers: Headers): void {
    const remaining = numberHeader(headers, 'x-rate-limit-remaining');
    const cost = numberHeader(headers, 'x-request-cost');

    if (cost !== null) this.lastCost = cost;
    if (remaining === null) return;

    this.remaining = remaining;

    if (this.ceiling === null || remaining > this.ceiling) {
      const previous = this.ceiling;
      this.ceiling = remaining;
      // Log the first real observation: this is the number the threshold is
      // derived from, and it is the answer to "what is the bucket size?"
      if (previous === null) {
        this.log.info('canvas.rate_limit.ceiling_observed', { ceiling: remaining });
      } else {
        this.log.debug('canvas.rate_limit.ceiling_raised', { from: previous, to: remaining });
      }
    }
  }

  get threshold(): number | null {
    if (this.ceiling === null) return null;
    const effective = Math.max(this.ceiling, OBSERVED_NUS_CEILING);
    return effective * THRESHOLD_FRACTION;
  }

  shouldPause(): boolean {
    const threshold = this.threshold;
    return threshold !== null && this.remaining !== null && this.remaining < threshold;
  }

  /** How long to wait: further below the threshold means a longer wait. */
  pauseMs(): number {
    const threshold = this.threshold;
    if (threshold === null || this.remaining === null || !this.shouldPause()) return 0;
    const deficit = (threshold - this.remaining) / threshold; // 0 -> 1
    return Math.min(MAX_PAUSE_MS, Math.round(BASE_PAUSE_MS * (1 + deficit * 9)));
  }

  /** Call before each request. Sleeps if the bucket is running low. */
  async beforeRequest(): Promise<void> {
    if (!this.shouldPause()) return;
    const ms = this.pauseMs();
    this.pauses += 1;
    this.totalPausedMs += ms;
    this.log.warn('canvas.rate_limit.pausing', {
      remaining: this.remaining,
      threshold: this.threshold,
      pause_ms: ms,
    });
    await sleep(ms);
  }

  snapshot(): RateLimitSnapshot {
    return {
      ceiling: this.ceiling,
      remaining: this.remaining,
      lastCost: this.lastCost,
      threshold: this.threshold,
      pauses: this.pauses,
      totalPausedMs: this.totalPausedMs,
    };
  }
}

function numberHeader(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null) return null;
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : null;
}
