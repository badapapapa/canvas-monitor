/**
 * The `courses.seed.json` shape and writer (SPEC.md section 16).
 *
 * This file is the deliberate human checkpoint. It is written to be READ and
 * EDITED, not merely parsed: every proposal carries the reason it was proposed,
 * so reviewing it is a matter of disagreeing with stated reasoning rather than
 * reverse-engineering a regex.
 *
 * It is gitignored. It contains real module codes and Canvas ids, and this
 * repository is public.
 */

import { writeFile } from 'node:fs/promises';
import { AppError } from '../core/errors.ts';
import type { CoverageStatus } from './coverage.ts';

export const SEED_PATH = 'courses.seed.json';

export interface SeedProposal {
  module_code: string | null;
  module_code_alternatives: string[];
  site_role: 'lecture' | 'tutorial' | 'common' | 'group' | null;
  enabled: boolean;
  reason: string;
  explanation: string;
}

export interface SeedContext {
  context_type: 'course' | 'group';
  canvas_id: number;
  display_name: string | null;
  course_code: string | null;
  term_code: string | null;
  term_name: string | null;
  section_id: number | null;
  section_name: string | null;
  coverage_status: CoverageStatus;
  /**
   * Whether coverage was actually probed. "unknown because we did not look" and
   * "unknown because the probe failed" are different facts, and collapsing them
   * would let a review note claim a transport failure that never happened.
   */
  coverage_probed: boolean;
  coverage_detail: string;
  shares_module_code_with: number[];
  /**
   * Groups only: the parent course, as Canvas states it on the group object.
   * Absent in seed files written before D-37; the loader tolerates that.
   */
  parent_canvas_course_id?: number | null;
  /** Groups only: Canvas's `concluded` flag. */
  concluded?: boolean;
  proposed: SeedProposal;
}

export interface SeedFile {
  $comment: string[];
  generated_at: string;
  generated_by_run: string;
  canvas_user_id: number;
  current_term_code: string | null;
  review_notes: string[];
  contexts: SeedContext[];
}

export function buildSeedFile(input: {
  generatedAt: string;
  runId: string;
  canvasUserId: number;
  currentTermCode: string | null;
  reviewNotes: string[];
  contexts: SeedContext[];
}): SeedFile {
  return {
    $comment: [
      'Review and edit this file, then load it with: npm run seed-courses',
      '',
      'Every `proposed` block is a SUGGESTION produced by inference over course',
      'names and term codes. NUS naming is inconsistent enough that inference',
      'always has edge cases -- that is why this checkpoint exists.',
      '',
      'Edit `proposed.module_code` and `proposed.enabled` freely. The loader',
      'reads those two fields and ignores `reason`/`explanation`, which are',
      'here to tell you why each value was picked.',
      '',
      'An ENABLED context must have a module_code: it becomes a OneDrive folder',
      'name, fixed at first sight. The loader rejects the file otherwise.',
      'Groups inherit module_code from their parent course automatically.',
      '',
      'coverage_status is OBSERVED, not proposed. Do not edit it; re-run',
      'discover if it looks wrong.',
      '',
      'This file is gitignored: it contains real module codes and Canvas ids.',
    ],
    generated_at: input.generatedAt,
    generated_by_run: input.runId,
    canvas_user_id: input.canvasUserId,
    current_term_code: input.currentTermCode,
    review_notes: input.reviewNotes,
    contexts: input.contexts,
  };
}

/**
 * Write the seed file, refusing to clobber an existing one unless asked.
 *
 * The seed file is the human checkpoint, and it is re-generated every semester.
 * Before this guard, re-running discover silently overwrote a file I had
 * already reviewed and edited -- the one artefact in this system that holds
 * judgement rather than data.
 */
export async function writeSeedFile(
  seed: SeedFile,
  path: string = SEED_PATH,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  const flag = options.overwrite === true ? 'w' : 'wx';
  try {
    await writeFile(path, `${JSON.stringify(seed, null, 2)}\n`, { encoding: 'utf8', flag });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new AppError(
        'usage',
        `${path} already exists and may contain your reviewed edits.`,
        'Re-run with --out <path> to write elsewhere and compare, or --overwrite to replace it.',
      );
    }
    throw error;
  }
}
