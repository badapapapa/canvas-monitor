import { existsSync } from 'node:fs';
/**
 * `npm run discover` (SPEC.md section 16).
 *
 * Produces `courses.seed.json` for review, and answers the Phase 1 empirical
 * questions along the way. Writes nothing to the database -- `seed-courses`
 * does that, after I have edited the file.
 */

import { CanvasClient } from '../canvas/client.ts';
import { CanvasHttp } from '../canvas/http.ts';
import { RateLimitGovernor } from '../canvas/rate-limit.ts';
import { createRawStore } from '../canvas/raw-store.ts';
import { Config } from '../core/config.ts';
import { describe } from '../core/result.ts';
import { courseTermName, type CanvasCourse } from '../canvas/types.ts';
import type { RunContext } from '../core/run-context.ts';
import { probeCoverage, type CoverageStatus } from './coverage.ts';
import {
  currentTermCode,
  extractModuleCodes,
  findSharedCodeGroups,
  isNonAcademic,
  parseTerm,
  proposeEnabled,
} from './module-code.ts';
import { buildSeedFile, writeSeedFile, SEED_PATH, type SeedContext } from './seed.ts';
import { proposeGroup } from './group.ts';
import { AppError } from '../core/errors.ts';
import {
  askContextCodeCap,
  askFallbackReliance,
  askFilesSortSupport,
  askGroupAnnouncementRoute,
  askHistoricalAccess,
  type Finding,
} from './questions.ts';

export interface DiscoverOutcome {
  ok: boolean;
  seedPath: string;
  contexts: number;
  enabled: number;
  findings: Finding[];
}

export async function runDiscover(
  ctx: RunContext,
  options: { out?: string | undefined; overwrite?: boolean } = {},
): Promise<DiscoverOutcome> {
  const seedPath = options.out ?? SEED_PATH;

  // Refuse up front, before spending a full discovery's worth of Canvas
  // requests on a file that would then fail to write. writeSeedFile still
  // opens with an exclusive flag, so a file created mid-run is not clobbered.
  if (!ctx.dryRun && options.overwrite !== true && existsSync(seedPath)) {
    throw new AppError(
      'usage',
      `${seedPath} already exists and may contain your reviewed edits.`,
      'Re-run with --out <path> to write elsewhere and compare, or --overwrite to replace it.',
    );
  }
  const config = await Config.load(ctx.db);
  const governor = new RateLimitGovernor(ctx.log);
  const http = new CanvasHttp({
    baseUrl: config.require('canvas_base_url'),
    token: config.require('canvas_token'),
    log: ctx.log,
    clock: ctx.clock,
    governor,
    rawStore: createRawStore({
      runId: ctx.runId,
      enabled: config.getBoolean('raw_capture_enabled', true),
      log: ctx.log,
      clock: ctx.clock,
    }),
  });
  const client = new CanvasClient(http);

  const self = await client.getSelf();
  if (self.kind !== 'ok') {
    ctx.log.error('discover.auth_failed', { outcome: describe(self) });
    process.stderr.write(`\nCannot authenticate: ${describe(self)}\n\n`);
    return { ok: false, seedPath, contexts: 0, enabled: 0, findings: [] };
  }

  const courses = await client.listActiveCourses();
  if (courses.kind !== 'ok') {
    ctx.log.error('discover.courses_failed', { outcome: describe(courses) });
    process.stderr.write(`\nCannot list courses: ${describe(courses)}\n\n`);
    return { ok: false, seedPath, contexts: 0, enabled: 0, findings: [] };
  }

  const terms = courses.value.map((c) => parseTerm(courseTermName(c)));
  const termCode = currentTermCode(terms);
  ctx.log.info('discover.current_term', { term_code: termCode, courses: courses.value.length });

  const codeEntries = courses.value.map((course) => ({
    canvasId: course.id,
    codes: extractModuleCodes(course.course_code, course.name).all,
  }));
  const shared = findSharedCodeGroups(codeEntries);

  const contexts: SeedContext[] = [];
  const coverageSummary: Array<{ canvasId: number; enabled: boolean; status: CoverageStatus }> = [];
  const reviewNotes: string[] = [];

  for (const course of courses.value) {
    const seeded = await discoverCourse(ctx, client, course, termCode, shared);
    contexts.push(seeded);
    coverageSummary.push({
      canvasId: course.id,
      enabled: seeded.proposed.enabled,
      status: seeded.coverage_status,
    });
  }

  // Groups are separate contexts, not courses (SPEC.md section 4). Seeded here
  // so Phase 3 has them, even though nothing ingests them yet.
  const groups = await client.listGroups();
  if (groups.kind === 'ok') {
    const courseContexts = contexts.filter((c) => c.context_type === 'course');
    for (const group of groups.value) {
      contexts.push(proposeGroup(group, courseContexts));
    }
    ctx.log.info('discover.groups', { count: groups.value.length });
  } else {
    reviewNotes.push(`Group discovery failed: ${describe(groups)}. No group contexts were seeded.`);
    ctx.log.warn('discover.groups_failed', { outcome: describe(groups) });
  }

  // Only contexts we actually probed can be inconclusive. A disabled course is
  // "unknown" because we chose not to look, which is not a failure to report.
  const inconclusive = contexts.filter(
    (c) => c.context_type === 'course' && c.coverage_probed && c.coverage_status === 'unknown',
  );
  if (inconclusive.length > 0) {
    reviewNotes.push(
      `${inconclusive.length} course(s) have coverage_status "unknown" -- the probe failed in ` +
        'transport rather than being denied. That is not the same as having no files. Re-run discover.',
    );
  }
  if (shared.size === 0) {
    reviewNotes.push(
      'No two courses share a module code, so no lecture/tutorial site split was detected. ' +
        'Every site_role is proposed as "lecture".',
    );
  }
  const multiCode = contexts.filter(
    (c) => c.proposed.enabled && c.proposed.module_code_alternatives.length > 0,
  );
  if (multiCode.length > 0) {
    reviewNotes.push(
      `${multiCode.length} course(s) are combined offerings with more than one module code ` +
        '(e.g. ABC1001/ABD1002). Which one you enrolled under is not inferable from Canvas -- ' +
        'check module_code_alternatives and set module_code to the one you want as the folder name.',
    );
  }

  // --- empirical questions -------------------------------------------------
  const window = announcementWindow(ctx.clock.now());
  const findings: Finding[] = [];
  findings.push(await askHistoricalAccess(client));
  findings.push(
    await askGroupAnnouncementRoute(client, groups.kind === 'ok' ? groups.value : [], window),
  );
  findings.push(await askContextCodeCap(client, courses.value, window));

  const filesProbeCourse = contexts.find(
    (c) => c.context_type === 'course' && c.proposed.enabled && c.coverage_status === 'full',
  );
  findings.push(
    filesProbeCourse === undefined
      ? {
          ref: 'D-32',
          question: 'Does /files honour sort=updated_at&order=desc?',
          answer: 'Unanswerable -- no enabled course reports full Files coverage.',
          conclusive: false,
          detail: ['Re-probe once a course with a readable Files tab is enabled.'],
        }
      : await askFilesSortSupport(client, filesProbeCourse.canvas_id),
  );
  findings.push(askFallbackReliance(coverageSummary));

  const seed = buildSeedFile({
    generatedAt: ctx.clock.now().toISOString(),
    runId: ctx.runId,
    canvasUserId: self.value.id,
    currentTermCode: termCode,
    reviewNotes,
    contexts,
  });

  if (ctx.dryRun) {
    ctx.log.info('discover.seed_not_written', { dry_run: true, contexts: contexts.length });
  } else {
    await writeSeedFile(seed, seedPath, { overwrite: options.overwrite === true });
  }

  const snapshot = governor.snapshot();
  ctx.log.info('discover.complete', {
    contexts: contexts.length,
    enabled: contexts.filter((c) => c.proposed.enabled).length,
    rate_ceiling: snapshot.ceiling,
    rate_remaining: snapshot.remaining,
    rate_pauses: snapshot.pauses,
  });

  return {
    ok: true,
    seedPath,
    contexts: contexts.length,
    enabled: contexts.filter((c) => c.proposed.enabled).length,
    findings,
  };
}

async function discoverCourse(
  ctx: RunContext,
  client: CanvasClient,
  course: CanvasCourse,
  termCode: string | null,
  shared: Map<string, number[]>,
): Promise<SeedContext> {
  const term = parseTerm(courseTermName(course));
  const codes = extractModuleCodes(course.course_code, course.name);
  const enabled = proposeEnabled(term, termCode);

  // Non-academic and prior-term sites are not probed: coverage on a site we are
  // proposing to disable is budget spent on noise.
  const shouldProbe = enabled.enabled && course.access_restricted_by_date !== true;

  const coverage = shouldProbe
    ? { ...(await probeCoverage(client, course.id, ctx.log)), probed: true }
    : {
        status: 'unknown' as CoverageStatus,
        probed: false,
        detail: course.access_restricted_by_date === true
          ? 'Access restricted by date; not probed.'
          : `Not probed: proposed disabled (${enabled.reason}). Enable it and re-run to probe.`,
      };

  let sectionId: number | null = null;
  let sectionName: string | null = null;
  if (shouldProbe) {
    const enrollments = await client.listSelfEnrollments(course.id);
    if (enrollments.kind === 'ok') {
      const mine = enrollments.value[0];
      sectionId = mine?.course_section_id ?? null;
    } else {
      ctx.log.warn('discover.enrollment_failed', {
        canvas_course_id: course.id,
        outcome: describe(enrollments),
      });
    }
  }

  const sharesWith = codes.all
    .flatMap((code) => shared.get(code) ?? [])
    .filter((id) => id !== course.id);

  return {
    context_type: 'course',
    canvas_id: course.id,
    display_name: course.name ?? null,
    course_code: course.course_code ?? null,
    term_code: term.code,
    term_name: term.name,
    section_id: sectionId,
    section_name: sectionName,
    coverage_status: coverage.status,
    coverage_probed: coverage.probed,
    coverage_detail: coverage.detail,
    shares_module_code_with: [...new Set(sharesWith)],
    proposed: {
      module_code: codes.primary,
      module_code_alternatives: codes.all.slice(1),
      site_role: isNonAcademic(term) ? null : 'lecture',
      enabled: enabled.enabled,
      reason: enabled.reason,
      explanation: enabled.explanation,
    },
  };
}

/**
 * SPEC.md section 4: `/announcements` applies a default recent window and will
 * silently look complete without explicit dates. Probes use a wide window for
 * the same reason.
 */
function announcementWindow(now: Date): { start: string; end: string } {
  return {
    start: new Date(now.getTime() - 180 * 86_400_000).toISOString(),
    end: new Date(now.getTime() + 7 * 86_400_000).toISOString(),
  };
}
