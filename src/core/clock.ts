/**
 * The only place in `src/` allowed to read the wall clock.
 *
 * Enforced by test/unit/clock-discipline.test.ts, which fails the build if
 * `Date.now()` or a zero-argument `new Date()` appears anywhere else. Watermark
 * correctness (SPEC.md section 7) depends on timestamps being injectable, and a
 * single stray `Date.now()` in a watermark path is the exact bug that makes a
 * poll silently skip a window.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock frozen at an instant, for tests. */
export function fixedClock(iso: string): Clock {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error(`fixedClock: invalid ISO instant ${iso}`);
  return { now: () => new Date(at.getTime()) };
}

/** A clock that advances by a fixed step on each read, for tests. */
export function tickingClock(iso: string, stepMs: number): Clock {
  let t = new Date(iso).getTime();
  return {
    now: () => {
      const out = new Date(t);
      t += stepMs;
      return out;
    },
  };
}

/**
 * Elapsed wall time in ms, for time BUDGETS only (D-77): deadlines that must
 * advance even when a test freezes the run's Clock. Never for a timestamp
 * that is stored or compared with Canvas -- that is what Clock is for.
 */
export function budgetNow(): number {
  return Date.now();
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
