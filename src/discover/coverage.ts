/**
 * Coverage probing (SPEC.md sections 2.2 and 4).
 *
 * The question is not "what files does this course have" but "what can I see at
 * all". A course whose Files tab the instructor disabled returns 404 -- the
 * same status Canvas uses for a course that does not exist -- so the answer is
 * three-state, and `none` is a real answer that must be recorded and shown, not
 * a failure to be smoothed over.
 */

import type { CanvasClient } from '../canvas/client.ts';
import { describe, type Result } from '../core/result.ts';
import type { Logger } from '../core/log.ts';

export type CoverageStatus = 'full' | 'modules_only' | 'none' | 'unknown';

export interface CoverageOutcome {
  status: CoverageStatus;
  files: string;
  modules: string | null;
  /** True when a transport error, not a permission answer, blocked the probe. */
  inconclusive: boolean;
  detail: string;
}

export async function probeCoverage(
  client: CanvasClient,
  courseId: number,
  log: Logger,
): Promise<CoverageOutcome> {
  const files = await client.probeFiles(courseId);

  if (files.kind === 'ok') {
    log.debug('discover.coverage', { canvas_course_id: courseId, status: 'full' });
    return {
      status: 'full',
      files: 'ok',
      modules: null,
      inconclusive: false,
      detail: `Files tab readable (${files.value.length} sampled).`,
    };
  }

  if (files.kind === 'error') {
    // An error is NOT a denial. Recording 'none' here would claim we know the
    // Files tab is off when all we know is that the request failed.
    log.warn('discover.coverage_inconclusive', {
      canvas_course_id: courseId,
      outcome: describe(files),
    });
    return {
      status: 'unknown',
      files: describeShort(files),
      modules: null,
      inconclusive: true,
      detail: 'Files probe failed in transport; coverage is unknown, not absent.',
    };
  }

  const modules = await client.probeModules(courseId);

  if (modules.kind === 'ok') {
    return {
      status: 'modules_only',
      files: describeShort(files),
      modules: 'ok',
      inconclusive: false,
      detail: `Files tab unavailable; modules readable (${modules.value.length} sampled). ` +
        'Files will be discovered via module items, so anything not placed in a module is invisible.',
    };
  }

  if (modules.kind === 'error') {
    return {
      status: 'unknown',
      files: describeShort(files),
      modules: describeShort(modules),
      inconclusive: true,
      detail: 'Files denied and the modules fallback failed in transport; coverage is unknown.',
    };
  }

  return {
    status: 'none',
    files: describeShort(files),
    modules: describeShort(modules),
    inconclusive: false,
    detail: 'Neither Files nor Modules is readable. This course contributes nothing and must be shown as uncovered.',
  };
}

function describeShort(result: Result<unknown>): string {
  if (result.kind === 'ok') return 'ok';
  if (result.kind === 'denied_or_absent') return `denied_or_absent(${result.status})`;
  return `error(${result.code})`;
}
