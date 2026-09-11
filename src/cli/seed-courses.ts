/**
 * `npm run seed-courses` -- load the reviewed seed file (SPEC.md section 16).
 *
 * Idempotent: re-running with an edited file updates rather than duplicating,
 * which is enforced by `UNIQUE (context_type, canvas_id)` on `contexts` plus
 * ON CONFLICT upserts, not by application logic hoping to be correct
 * (SPEC.md section 2.4).
 *
 * Only `module_code`, `enabled` and `site_role` are read from `proposed` --
 * `reason` and `explanation` exist to justify the proposal to a human reader.
 * `coverage_status` is observed and is carried across as-is.
 *
 * The whole file is validated BEFORE anything is written (DECISIONS.md D-37).
 * An enabled context with no module code is rejected outright rather than
 * warned about: its module code becomes a OneDrive folder name, fixed at first
 * sight under the route-once rule (SPEC.md section 8), so a missing one is not
 * a cosmetic problem to tidy later -- it is a permanent misfiling.
 */

import { readFile } from 'node:fs/promises';
import { AppError } from '../core/errors.ts';
import type { RunContext } from '../core/run-context.ts';
import { SEED_PATH, type SeedContext, type SeedFile } from '../discover/seed.ts';
import type { TxHandle } from '../core/db/writer.ts';

export interface SeedOutcome {
  inserted: number;
  updated: number;
  disabled: number;
}

export async function runSeedCourses(
  ctx: RunContext,
  options: { path?: string | undefined },
): Promise<SeedOutcome> {
  const path = options.path ?? SEED_PATH;

  let seed: SeedFile;
  try {
    seed = JSON.parse(await readFile(path, 'utf8')) as SeedFile;
  } catch (error) {
    throw new AppError(
      'config_missing',
      `Could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      'Run `npm run discover` first, then review the file it writes.',
    );
  }

  if (!Array.isArray(seed.contexts) || seed.contexts.length === 0) {
    throw new AppError('config_invalid', `${path} contains no contexts.`);
  }

  // Validate everything first, so a bad entry late in the file cannot leave
  // earlier entries half-applied or produce a partial error report.
  const problems = seed.contexts.flatMap((entry) => validate(entry, seed.contexts));
  if (problems.length > 0) {
    throw new AppError(
      'config_invalid',
      `${path} has ${problems.length} problem(s); nothing was loaded:\n  - ${problems.join('\n  - ')}`,
      'Fix these in the seed file and re-run `npm run seed-courses`.',
    );
  }

  const outcome: SeedOutcome = { inserted: 0, updated: 0, disabled: 0 };
  const now = ctx.clock.now().toISOString();

  // One transaction for the whole load: a half-seeded contexts table would
  // leave later phases keying on ids that do not exist.
  await ctx.db.transaction('seed contexts', async (tx) => {
    for (const entry of seed.contexts) {
      const existing = await tx.read({
        sql: 'SELECT context_id FROM contexts WHERE context_type = ? AND canvas_id = ?',
        args: [entry.context_type, entry.canvas_id],
      });
      const isNew = existing.rows.length === 0;

      await tx.write.execute('upsert context', {
        sql: `INSERT INTO contexts
                (context_type, canvas_id, display_name, enabled, coverage_status,
                 coverage_checked_at, first_seen_at, last_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?)
              ON CONFLICT(context_type, canvas_id) DO UPDATE SET
                display_name = excluded.display_name,
                enabled = excluded.enabled,
                coverage_status = excluded.coverage_status,
                coverage_checked_at = excluded.coverage_checked_at,
                last_seen_at = excluded.last_seen_at`,
        args: [
          entry.context_type,
          entry.canvas_id,
          entry.display_name,
          entry.proposed.enabled ? 1 : 0,
          entry.coverage_status,
          now,
          now,
          now,
        ],
      });

      if (entry.context_type === 'course') {
        const row = await tx.read({
          sql: 'SELECT context_id FROM contexts WHERE context_type = ? AND canvas_id = ?',
          args: [entry.context_type, entry.canvas_id],
        });
        const contextId = row.rows[0]?.['context_id'];
        if (contextId === undefined && !ctx.dryRun) {
          throw new AppError('config_invalid', `Failed to resolve context_id for course ${entry.canvas_id}.`);
        }

        await tx.write.execute('upsert course', {
          sql: `INSERT INTO courses
                  (context_id, canvas_course_id, module_code, display_name, course_code,
                   site_role, term, section_id, section_name)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(context_id) DO UPDATE SET
                  module_code = excluded.module_code,
                  display_name = excluded.display_name,
                  course_code = excluded.course_code,
                  site_role = excluded.site_role,
                  term = excluded.term,
                  section_id = excluded.section_id,
                  section_name = excluded.section_name`,
          args: [
            contextId ?? null,
            entry.canvas_id,
            entry.proposed.module_code,
            entry.display_name,
            entry.course_code,
            entry.proposed.site_role,
            entry.term_code,
            entry.section_id,
            entry.section_name,
          ],
        });
      }

      if (entry.context_type === 'group') {
        const contextId = await resolveContextId(tx, 'group', entry.canvas_id);
        if (contextId === null && !ctx.dryRun) {
          throw new AppError('config_invalid', `Failed to resolve context_id for group ${entry.canvas_id}.`);
        }
        // The parent may legitimately be absent from `contexts`: a concluded
        // group's parent course never appears in the active list.
        const parentId = entry.parent_canvas_course_id ?? null;
        const parentContextId = parentId === null ? null : await resolveContextId(tx, 'course', parentId);

        await tx.write.execute('upsert group', {
          sql: `INSERT INTO groups
                  (context_id, canvas_group_id, parent_canvas_course_id, parent_context_id,
                   module_code, term, display_name, concluded)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(context_id) DO UPDATE SET
                  parent_canvas_course_id = excluded.parent_canvas_course_id,
                  parent_context_id = excluded.parent_context_id,
                  module_code = excluded.module_code,
                  term = excluded.term,
                  display_name = excluded.display_name,
                  concluded = excluded.concluded`,
          args: [
            contextId,
            entry.canvas_id,
            parentId,
            parentContextId,
            entry.proposed.module_code,
            entry.term_code,
            entry.display_name,
            entry.concluded === true ? 1 : 0,
          ],
        });
      }

      if (isNew) outcome.inserted += 1;
      else outcome.updated += 1;
      if (!entry.proposed.enabled) outcome.disabled += 1;
    }
  });

  ctx.log.info('seed.loaded', { ...outcome, dry_run: ctx.dryRun });
  process.stdout.write(
    ctx.dryRun
      ? `\nDRY RUN: would insert ${outcome.inserted}, update ${outcome.updated} ` +
        `(${outcome.disabled} disabled). Nothing written.\n\n`
      : `\nInserted ${outcome.inserted}, updated ${outcome.updated} ` +
        `(${outcome.disabled} disabled).\n\n`,
  );
  return outcome;
}

async function resolveContextId(
  tx: { read: TxHandle['read'] },
  type: 'course' | 'group',
  canvasId: number,
): Promise<number | null> {
  const row = await tx.read({
    sql: 'SELECT context_id FROM contexts WHERE context_type = ? AND canvas_id = ?',
    args: [type, canvasId],
  });
  const value = row.rows[0]?.['context_id'];
  return value === undefined || value === null ? null : Number(value);
}

/** Every problem with one entry, as a sentence naming the entry. */
export function validate(entry: SeedContext, all: readonly SeedContext[]): string[] {
  const id = `${entry.context_type ?? 'context'} ${entry.canvas_id ?? '?'}`;
  const problems: string[] = [];

  if (entry.context_type !== 'course' && entry.context_type !== 'group') {
    problems.push(`${id}: context_type must be "course" or "group".`);
  }
  if (typeof entry.canvas_id !== 'number' || !Number.isInteger(entry.canvas_id)) {
    problems.push(`${id}: canvas_id must be an integer.`);
  }
  if (typeof entry.proposed?.enabled !== 'boolean') {
    problems.push(`${id}: proposed.enabled must be true or false.`);
    return problems;
  }

  const code = entry.proposed.module_code;
  if (entry.proposed.enabled && (typeof code !== 'string' || code.trim() === '')) {
    problems.push(
      `${id} is enabled but has no module_code. It would become the OneDrive folder ` +
        'name, fixed at first sight. Set proposed.module_code, or set proposed.enabled to false.',
    );
  }

  // A group filed under a different module than its own parent course is
  // almost certainly a stale inheritance: the parent's code was edited during
  // review and the group's was not. Under route-once that split is permanent,
  // so it is caught here rather than discovered in OneDrive in week 8.
  if (entry.context_type === 'group' && entry.proposed.enabled) {
    const parentId = entry.parent_canvas_course_id ?? null;
    const parent = parentId === null ? undefined : all.find((c) => c.context_type === 'course' && c.canvas_id === parentId);
    if (parent !== undefined && typeof code === 'string' && parent.proposed.module_code !== code) {
      problems.push(
        `${id} has module_code "${code}" but its parent course ${parentId} has ` +
          `"${parent.proposed.module_code ?? '(none)'}". Group files would land in a different ` +
          'folder from the course. Make them match.',
      );
    }
  }

  return problems;
}
