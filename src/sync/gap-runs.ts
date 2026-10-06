/**
 * What GitHub knows about the scheduled runs inside a gap (DECISIONS.md D-77),
 * so the gap report says what happened instead of guessing. On 2026-10-05 GitHub
 * created five runs, never gave them a machine, and cancelled them; the report
 * then said they "never happened".
 *
 * One read of this repository's own run history, with the run's own
 * job-scoped token (`actions: read`, nothing else), a 5-second timeout, and no
 * effect on the sync if it fails: the report then says it could not tell.
 * The repository is public, so this reads nothing that is not already public.
 */

export interface GapRun {
  id: string;
  status: string;
  conclusion: string | null;
}

/** Scheduled runs created between two instants, or null when that cannot be known. */
export type GapRunsLookup = (from: Date, to: Date) => Promise<GapRun[] | null>;

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function gapRunsFromEnvironment(env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = fetch): GapRunsLookup {
  const token = env['ACTIONS_READ_TOKEN'];
  const repo = env['GITHUB_REPOSITORY'];
  const self = env['GITHUB_RUN_ID'];
  return async (from, to) => {
    if (token === undefined || token === '' || repo === undefined || !REPO.test(repo)) return null;
    const url = `https://api.github.com/repos/${repo}/actions/workflows/sync.yml/runs` +
      `?event=schedule&per_page=100&created=${encodeURIComponent(`${from.toISOString()}..${to.toISOString()}`)}`;
    try {
      const response = await fetchImpl(url, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) return null;
      const body = (await response.json()) as { workflow_runs?: Array<{ id: number; status: string; conclusion: string | null }> };
      if (!Array.isArray(body.workflow_runs)) return null;
      return body.workflow_runs
        .filter((r) => String(r.id) !== self)
        .map((r) => ({ id: String(r.id), status: r.status, conclusion: r.conclusion ?? null }));
    } catch {
      return null;
    }
  };
}

export interface GapExplanation {
  /** Runs GitHub created in the gap that never reached our sync (no `runs` row). */
  cancelled: number;
  failedBeforeStart: number;
  stillWaiting: number;
  /** Slots with no run created at all. */
  neverCreated: number;
}

/** Explain `missed` slots from GitHub's runs and the ids of runs that did reach our sync. */
export function explainGap(missed: number, runs: readonly GapRun[], startedIds: ReadonlySet<string>): GapExplanation {
  const silent = runs.filter((r) => !startedIds.has(r.id));
  const cancelled = silent.filter((r) => r.status === 'completed' && r.conclusion === 'cancelled').length;
  const stillWaiting = silent.filter((r) => r.status !== 'completed').length;
  const failedBeforeStart = silent.length - cancelled - stillWaiting;
  return { cancelled, failedBeforeStart, stillWaiting, neverCreated: Math.max(0, missed - silent.length) };
}

/** The gap report's sentence about why, in plain words. */
export function describeGap(missed: number, e: GapExplanation | null): string {
  const runs = (n: number) => `${n} run${n === 1 ? '' : 's'}`;
  if (e === null) {
    return `${missed} scheduled slot${missed === 1 ? '' : 's'} produced no sync (GitHub's run history could not be read to say why).`;
  }
  const parts: string[] = [];
  if (e.cancelled > 0) parts.push(`GitHub created ${runs(e.cancelled)} but cancelled ${e.cancelled === 1 ? 'it' : 'them'} before ${e.cancelled === 1 ? 'it' : 'they'} started (no machine was assigned in time)`);
  if (e.failedBeforeStart > 0) parts.push(`${runs(e.failedBeforeStart)} failed before the sync itself started`);
  if (e.stillWaiting > 0) parts.push(`${runs(e.stillWaiting)} ${e.stillWaiting === 1 ? 'is' : 'are'} still waiting for a machine`);
  if (e.neverCreated > 0) parts.push(`GitHub never created a run for ${e.neverCreated} slot${e.neverCreated === 1 ? '' : 's'}`);
  return `${missed} scheduled slot${missed === 1 ? '' : 's'} produced no sync: ${parts.join('; ')}.`;
}
