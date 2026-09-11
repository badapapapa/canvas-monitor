/**
 * The Phase 1 empirical questions (DECISIONS.md D-28 … D-33).
 *
 * These are read-only probes whose purpose is to replace an assumption in
 * SPEC.md with an observation. Each returns what was seen AND what can honestly
 * be concluded from it -- several of them can only bound an answer rather than
 * settle it, and saying so is the point (SPEC.md section 17: escalate ambiguity
 * rather than resolving it).
 */

import type { CanvasClient } from '../canvas/client.ts';
import { describe } from '../core/result.ts';
import type { CanvasCourse, CanvasFile, CanvasGroup } from '../canvas/types.ts';
import { parseCanvasTs } from '../core/time.ts';
import type { CoverageStatus } from './coverage.ts';

export interface Finding {
  ref: string;
  question: string;
  answer: string;
  /** True when the probe settled it. False when it only bounded it. */
  conclusive: boolean;
  detail: string[];
}

/** D-28 — is historical course data reachable? */
export async function askHistoricalAccess(client: CanvasClient): Promise<Finding> {
  const completed = await client.listCourses('completed');

  if (completed.kind === 'ok') {
    const readable = completed.value.filter((c) => c.access_restricted_by_date !== true);
    return {
      ref: 'D-28',
      question: 'Is historical course data accessible?',
      answer:
        readable.length > 0
          ? `Yes -- ${readable.length} concluded course(s) readable.`
          : `Endpoint works but returned ${completed.value.length} course(s), none readable.`,
      conclusive: true,
      detail: [
        `enrollment_state=completed returned ${completed.value.length} course(s).`,
        `${completed.value.length - readable.length} were access_restricted_by_date.`,
        readable.length > 0
          ? 'tune-patterns can learn from real history in Phase 6.'
          : 'tune-patterns must tune on the current semester instead; Phase 6 needs replanning.',
      ],
    };
  }

  return {
    ref: 'D-28',
    question: 'Is historical course data accessible?',
    answer: 'No -- the endpoint is not available to this token.',
    conclusive: true,
    detail: [
      describe(completed),
      'tune-patterns must tune on the current semester instead; Phase 6 needs replanning.',
    ],
  };
}

/** D-29 — which group announcements route works? */
export async function askGroupAnnouncementRoute(
  client: CanvasClient,
  groups: readonly CanvasGroup[],
  window: { start: string; end: string },
): Promise<Finding> {
  const group = groups[0];

  if (group === undefined) {
    return {
      ref: 'D-29',
      question: 'Which group announcements route works?',
      answer: 'Unanswerable -- I am in no Canvas groups.',
      conclusive: false,
      detail: [
        '/users/self/groups returned nothing, so neither route can be tested.',
        'Re-probe when a module creates project groups. Until then D-17 stays open,',
        'and Phase 3 must not assume either route works.',
      ],
    };
  }

  const viaContext = await client.probeGroupAnnouncementsViaContext(group.id, window.start, window.end);
  const viaTopics = await client.probeGroupAnnouncementsViaTopics(group.id);

  const contextWorks = viaContext.kind === 'ok';
  const topicsWork = viaTopics.kind === 'ok';

  return {
    ref: 'D-29',
    question: 'Which group announcements route works?',
    answer:
      contextWorks && topicsWork
        ? 'Both routes work.'
        : contextWorks
          ? '/announcements?context_codes[]=group_N works; the discussion_topics route does not.'
          : topicsWork
            ? '/groups/:id/discussion_topics?only_announcements=true works; the context_codes route does not.'
            : 'Neither route works.',
    conclusive: true,
    detail: [
      `context_codes route: ${describe(viaContext)}`,
      `discussion_topics route: ${describe(viaTopics)}`,
      `Probed against group ${group.id} only; other groups may be configured differently.`,
    ],
  };
}

/**
 * D-30 — the real `context_codes[]` cap.
 *
 * This can only be BOUNDED with the contexts I actually have. Padding the
 * request with synthetic course codes would conflate "too many codes" with
 * "unknown context", so where the count cannot be reached honestly, the finding
 * says so rather than inventing a limit.
 */
export async function askContextCodeCap(
  client: CanvasClient,
  courses: readonly CanvasCourse[],
  window: { start: string; end: string },
): Promise<Finding> {
  const codes = courses.map((c) => `course_${c.id}`);
  const detail: string[] = [];
  let highestWorking = 0;

  for (const size of [1, 5, 10, codes.length].filter((n, i, a) => n <= codes.length && a.indexOf(n) === i)) {
    const result = await client.probeAnnouncements(codes.slice(0, size), window.start, window.end);
    detail.push(`${size} code(s): ${describe(result)}`);
    if (result.kind === 'ok') highestWorking = Math.max(highestWorking, size);
    else break;
  }

  const reachedSpecLimit = highestWorking >= 10;

  return {
    ref: 'D-30',
    question: 'What is the real context_codes[] cap?',
    answer: reachedSpecLimit
      ? `At least ${highestWorking} accepted; the assumed cap of 10 is not a hard error here.`
      : `Bounded only: ${highestWorking} accepted. I have ${codes.length} contexts, too few to reach the assumed cap of 10.`,
    conclusive: false,
    detail: [
      ...detail,
      'Padding with synthetic course codes would conflate "too many codes" with',
      '"unknown context", so the upper bound is left unmeasured rather than guessed.',
      'Chunking at 10 stays in place: it is safe whether or not the cap is higher.',
    ],
  };
}

/** D-32 — does `/files` honour `sort=updated_at&order=desc`? */
export async function askFilesSortSupport(
  client: CanvasClient,
  courseId: number,
): Promise<Finding> {
  const sorted = await client.probeFilesSorted(courseId);

  if (sorted.kind !== 'ok') {
    return {
      ref: 'D-32',
      question: 'Does /files honour sort=updated_at&order=desc?',
      answer: 'Unanswerable -- the probe course did not return files.',
      conclusive: false,
      detail: [describe(sorted), 'Re-probe once a course with a readable Files tab has content.'],
    };
  }

  const stamps = sorted.value
    .map((f: CanvasFile) => parseCanvasTs(f.updated_at)?.getTime())
    .filter((t): t is number => t !== undefined);

  if (stamps.length < 2) {
    return {
      ref: 'D-32',
      question: 'Does /files honour sort=updated_at&order=desc?',
      answer: `Unanswerable -- only ${stamps.length} dated file(s) returned.`,
      conclusive: false,
      detail: [
        'Ordering cannot be observed from a single item.',
        'The early-stop optimisation (D-03) stays unproven; full pagination remains correct either way.',
      ],
    };
  }

  const descending = stamps.every((t, i) => i === 0 || (stamps[i - 1] ?? 0) >= t);

  return {
    ref: 'D-32',
    question: 'Does /files honour sort=updated_at&order=desc?',
    answer: descending
      ? 'Yes -- results came back newest-first.'
      : 'No -- the parameter was accepted but ordering was not applied.',
    conclusive: true,
    detail: [
      `Sampled ${stamps.length} file timestamps.`,
      descending
        ? 'The D-03 early-stop optimisation is safe to build in Phase 3.'
        : 'Do NOT build the early stop: every run must paginate /files in full. Note the rate-limit cost.',
    ],
  };
}

/** D-33 — how much of the semester runs on the modules fallback? */
export function askFallbackReliance(
  coverage: ReadonlyArray<{ canvasId: number; enabled: boolean; status: CoverageStatus }>,
): Finding {
  const enabled = coverage.filter((c) => c.enabled);
  const counts = new Map<CoverageStatus, number>();
  for (const entry of enabled) counts.set(entry.status, (counts.get(entry.status) ?? 0) + 1);

  const modulesOnly = counts.get('modules_only') ?? 0;
  const none = counts.get('none') ?? 0;
  const unknown = counts.get('unknown') ?? 0;

  return {
    ref: 'D-33',
    question: 'Do any enabled courses report modules_only?',
    answer:
      modulesOnly === 0 && none === 0 && unknown === 0
        ? `No -- all ${enabled.length} enabled course(s) report full coverage.`
        : `${modulesOnly} modules_only, ${none} none, ${unknown} unknown, of ${enabled.length} enabled.`,
    conclusive: unknown === 0,
    detail: [
      ...[...counts].map(([status, n]) => `${status}: ${n}`),
      modulesOnly > 0
        ? 'Files not placed in a module are invisible in those courses. Say so in the coverage panel.'
        : 'The fallback path is currently unexercised against real data.',
      ...(unknown > 0 ? ['Some probes were inconclusive; coverage is unknown, not absent. Re-run.'] : []),
    ],
  };
}
