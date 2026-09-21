/**
 * `npm run backfill-course -- <canvas_course_id>` -- archive a course once,
 * without polling it (DECISIONS.md D-36).
 *
 * For a course that is readable today but will not be forever -- above all a
 * prior-term course, whose content NUS will eventually revoke. Its files are
 * recorded as already seen (no notifications) and archived with no per-run
 * budget. It is never enabled for the 20-minute poll: nothing new will be
 * posted to a concluded course.
 */

import { CanvasClient } from '../canvas/client.ts';
import { CanvasHttp } from '../canvas/http.ts';
import { RateLimitGovernor } from '../canvas/rate-limit.ts';
import { createRawStore } from '../canvas/raw-store.ts';
import { Config } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import { describe } from '../core/result.ts';
import type { RunContext } from '../core/run-context.ts';
import { itemId, normaliseFile } from '../ingest/normalise.ts';
import { runArchive } from '../archive/stage.ts';
import { buildDriveForCli } from './graph-drive.ts';

export async function runBackfillCourse(ctx: RunContext, args: { courseId: string | undefined }): Promise<number> {
  const canvasId = Number(args.courseId);
  if (!Number.isInteger(canvasId) || canvasId <= 0) throw new AppError('usage', 'Usage: npm run backfill-course -- <canvas_course_id>');

  const ctxRow = await ctx.db.read({
    sql: `SELECT x.context_id, c.module_code, c.term FROM contexts x JOIN courses c USING (context_id)
           WHERE x.context_type = 'course' AND x.canvas_id = ?`,
    args: [canvasId],
  });
  const row = ctxRow.rows[0];
  if (row === undefined) throw new AppError('usage', `Course ${canvasId} is not in contexts. It must be in courses.seed.json (enabled or not).`);
  if (row['module_code'] === null) throw new AppError('usage', `Course ${canvasId} has no module_code; set one in the seed file and re-run seed-courses.`);
  const contextId = Number(row['context_id']);

  const config = await Config.load(ctx.db);
  const canvas = new CanvasClient(
    new CanvasHttp({
      baseUrl: config.require('canvas_base_url'), token: config.require('canvas_token'), log: ctx.log, clock: ctx.clock,
      governor: new RateLimitGovernor(ctx.log),
      rawStore: createRawStore({ runId: ctx.runId, enabled: false, log: ctx.log, clock: ctx.clock }),
    }),
  );
  const files = await canvas.listFiles('courses', canvasId);
  if (files.kind !== 'ok') {
    process.stderr.write(`\nCannot list files for course ${canvasId}: ${describe(files)}\nIts content may already be revoked.\n\n`);
    return 1;
  }
  const folders = await canvas.listFolders('courses', canvasId);
  const names = new Map<number, string | null>(folders.kind === 'ok' ? folders.value.map((f) => [f.id, f.full_name ?? null]) : []);
  const webBase = config.require('canvas_base_url').replace(/\/api\/v1\/?$/, '');
  const now = ctx.clock.now().toISOString();

  // Record as seen, never announced: this is an archive of the past.
  for (const f of files.value) {
    const record = normaliseFile(f, f.folder_id == null ? null : (names.get(f.folder_id) ?? null), `${webBase}/courses/${canvasId}/files/${f.id}`);
    await ctx.db.write.execute('backfill item', {
      sql: `INSERT INTO items (id, context_id, resource_type, external_id, title, content_hash, canvas_url,
                               posted_at, updated_at_canvas, meta, first_seen_at, last_seen_at, notified_at, state)
            VALUES (?, ?, 'file', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seen')
            ON CONFLICT(context_id, resource_type, external_id) DO NOTHING`,
      args: [itemId(contextId, 'file', record.externalId), contextId, record.externalId, record.title, record.contentHash,
             record.canvasUrl, record.postedAt, record.updatedAt, JSON.stringify(record.meta), now, now, now],
    });
  }
  process.stdout.write(`\n${files.value.length} files found in course ${canvasId}. Archiving...\n`);

  const drive = ctx.dryRun ? null : buildDriveForCli(ctx, config);
  const outcome = await runArchive({ ctx, canvas, canvasToken: config.require('canvas_token'), drive, config, contextIds: [contextId], unlimited: true });
  const bytes = outcome.archived.reduce((n, a) => n + a.bytes, 0);
  process.stdout.write(
    ctx.dryRun
      ? `DRY RUN: ${outcome.planned} would be archived, ${outcome.skipped} skipped. Nothing downloaded.\n\n`
      : `Archived ${outcome.archived.length} (${(bytes / 1024 / 1024).toFixed(1)} MB), adopted ${outcome.adopted}, ` +
        `skipped ${outcome.skipped}, failed ${outcome.failed}${outcome.stopped ? `, stopped: ${outcome.stopped}` : ''}.\n\n`,
  );
  return outcome.failed === 0 && outcome.stopped === null ? 0 : 1;
}
