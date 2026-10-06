/**
 * Time budgets for one sync run (DECISIONS.md D-77).
 *
 * GitHub kills the job at 10 minutes (`timeout-minutes`). A run killed there
 * never releases the database lock and never tells Healthchecks, so the run
 * keeps its own, earlier clock:
 *
 *   run       8 minutes from the start, everything included;
 *   reserve   the last 90 s of that, kept for finishing -- alerts, the
 *             dashboard publish, messages, then the lock and Healthchecks,
 *             which always run;
 *   course    90 s of Canvas requests per course: a slow course fails alone,
 *             and the others still sync;
 *   integrity 60 s for the archive integrity check, then it resumes next run.
 *
 * Real elapsed time, not the run's clock: tests freeze the clock, and a budget
 * that never advances would never end.
 */

import { budgetNow } from '../core/clock.ts';

export interface Budgets {
  runMs: number;
  reserveMs: number;
  courseMs: number;
  integrityMs: number;
}

export const DEFAULT_BUDGETS: Budgets = {
  runMs: 8 * 60_000,
  reserveMs: 90_000,
  courseMs: 90_000,
  integrityMs: 60_000,
};

/** What the lock release and the Healthchecks ping need after everything else (each has its own timeout). */
export const FINISH_MS = 20_000;

export class RunBudget {
  readonly started: number;
  readonly budgets: Budgets;
  private readonly now: () => number;

  constructor(budgets: Budgets = DEFAULT_BUDGETS, now: () => number = budgetNow) {
    this.budgets = budgets;
    this.now = now;
    this.started = now();
  }

  /** Work (Canvas, archive, integrity, follow-ups) stops starting new things here. */
  get workDeadline(): number {
    return this.started + this.budgets.runMs - this.budgets.reserveMs;
  }

  /** Finishing (alerts, publish, messages) stops here, leaving FINISH_MS for the lock and Healthchecks. */
  get finishDeadline(): number {
    return this.started + this.budgets.runMs - FINISH_MS;
  }

  remainingWork(): number {
    return this.workDeadline - this.now();
  }

  workExhausted(): boolean {
    return this.remainingWork() <= 0;
  }

  /** A deadline for one part: its own budget, never past the work deadline. */
  deadlineFor(partMs: number): number {
    return Math.min(this.now() + partMs, this.workDeadline);
  }
}
