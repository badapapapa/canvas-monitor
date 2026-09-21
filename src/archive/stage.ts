/**
 * The archive stage: detected files -> OneDrive (SPEC.md sections 5, 7, 8, 16).
 *
 * Runs after detection in each sync, newest files first so a fresh upload is
 * never stuck behind a backlog, within a per-run budget so the job stays well
 * inside its 10-minute timeout.
 *
 * For each file, in order:
 *   1. Decide the route once and reserve the target path in a `pending` row.
 *      Over the size gate, or video: a terminal `skipped_*` row, no download.
 *   2. Count the attempt BEFORE any network work.
 *   3. Re-fetch the Canvas file object and download, verifying size.
 *   4. If an earlier attempt may have uploaded it, look first and adopt an
 *      identical file rather than uploading a duplicate.
 *   5. Upload through a session that fails on a clash; on a clash, add an
 *      upload-date suffix and try again. Never overwrite.
 *   6. Record `complete` with the item id and webUrl.
 *
 * Any crash leaves either a pending/failed row that the next run retries, or a
 * complete row for a file that is really there. Never the reverse.
 */

import type { CanvasClient } from '../canvas/client.ts';
import type { Config } from '../core/config.ts';
import type { RunContext } from '../core/run-context.ts';
import { messageOf } from '../core/errors.ts';
import { toSgtParts } from '../core/time.ts';
import { GraphError } from '../graph/auth.ts';
import type { GraphDrive, Quota } from '../graph/drive.ts';
import type { FileFacts } from '../ingest/normalise.ts';
import { downloadCanvasFile } from './download.ts';
import { alternateName, fitPath, safeSegment } from './filename.ts';
import { route, type Category } from './route.ts';

/** Leaves room for C:\Users\<name>\OneDrive\Apps\<app>\ under Windows' 260. */
export const PATH_BUDGET = 200;
const MAX_ATTEMPTS = 5;
const MAX_ALTERNATES = 5;

export type ArchiveStop = 'graph_auth' | 'graph_app' | 'provisioning' | 'quota_full' | 'not_personal' | 'unreachable' | 'budget';

export interface ArchiveOutcome {
  archived: Array<{ itemId: string; bytes: number }>;
  adopted: number;
  skipped: number;
  failed: number;
  planned: number;
  stopped: ArchiveStop | null;
  stopDetail: string | null;
  quota: Quota | 'unreadable' | null;
  exhausted: number;
}

interface Candidate {
  itemId: string;
  contextId: number;
  contextType: 'course' | 'group';
  contextCanvasId: number;
  canvasFileId: number;
  title: string | null;
  postedAt: string | null;
  term: string;
  moduleCode: string;
  facts: FileFacts;
  folder: string | null;
  module: string | null;
  mimeClass: string | null;
  row: { state: string; attempts: number; targetPath: string | null } | null;
}

function sgtDate(iso: string | null): string {
  if (iso === null) return 'unknown date';
  const p = toSgtParts(new Date(iso));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

async function loadCandidates(ctx: RunContext, contextIds: number[] | null, limit: number): Promise<Candidate[]> {
  const filter = contextIds === null ? 'x.enabled = 1' : `x.context_id IN (${contextIds.map(() => '?').join(', ')})`;
  const rows = await ctx.db.read({
    sql: `SELECT i.id, i.context_id, i.external_id, i.title, i.meta, i.posted_at,
                 x.context_type, x.canvas_id,
                 COALESCE(c.term, g.term) AS term, COALESCE(c.module_code, g.module_code) AS module_code,
                 f.download_state, f.attempts, f.target_path
            FROM items i
            JOIN contexts x ON x.context_id = i.context_id
            LEFT JOIN courses c ON c.context_id = x.context_id
            LEFT JOIN groups g ON g.context_id = x.context_id
            LEFT JOIN files f ON f.id = i.id
           WHERE i.resource_type = 'file' AND ${filter}
             AND (f.id IS NULL OR f.download_state = 'pending' OR (f.download_state = 'failed' AND f.attempts < ${MAX_ATTEMPTS}))
           ORDER BY i.first_seen_at DESC, i.id
           LIMIT ?`,
    args: [...(contextIds ?? []), limit],
  });
  return rows.rows.map((r) => {
    const meta = JSON.parse(String(r['meta'] ?? '{}')) as { facts?: FileFacts; folder?: string | null; module?: string | null; mime_class?: string | null };
    return {
      itemId: String(r['id']),
      contextId: Number(r['context_id']),
      contextType: String(r['context_type']) === 'group' ? 'group' : 'course',
      contextCanvasId: Number(r['canvas_id']),
      canvasFileId: Number(r['external_id']),
      title: r['title'] === null ? null : String(r['title']),
      postedAt: r['posted_at'] === null ? null : String(r['posted_at']),
      term: String(r['term'] ?? 'unknown term'),
      moduleCode: String(r['module_code'] ?? `context ${String(r['context_id'])}`),
      facts: meta.facts ?? { name: null, size: null, modified_at: null, accessible: false },
      folder: meta.folder ?? null,
      module: meta.module ?? null,
      mimeClass: meta.mime_class ?? null,
      row: r['download_state'] === null ? null : { state: String(r['download_state']), attempts: Number(r['attempts']), targetPath: r['target_path'] === null ? null : String(r['target_path']) },
    };
  });
}

export async function runArchive(deps: {
  ctx: RunContext;
  canvas: CanvasClient;
  canvasToken: string;
  drive: GraphDrive | null;
  config: Config;
  contextIds?: number[];
  unlimited?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<ArchiveOutcome> {
  const { ctx, config } = deps;
  const log = ctx.log.child({ stage: 'archive' });
  const started = ctx.clock.now().getTime();
  const canvasOrigin = new URL(config.require('canvas_base_url')).origin;
  const maxFileBytes = config.getNumber('archive_max_file_bytes', 50 * 1024 * 1024);
  const maxFiles = deps.unlimited === true ? Number.MAX_SAFE_INTEGER : config.getNumber('archive_max_files_per_run', 40);
  const maxBytes = deps.unlimited === true ? Number.MAX_SAFE_INTEGER : config.getNumber('archive_max_bytes_per_run', 400 * 1024 * 1024);
  const maxMs = deps.unlimited === true ? Number.MAX_SAFE_INTEGER : 240_000;
  const out: ArchiveOutcome = { archived: [], adopted: 0, skipped: 0, failed: 0, planned: 0, stopped: null, stopDetail: null, quota: null, exhausted: 0 };

  // Check the drive before touching any file: this is where a dead refresh
  // token, the AppFolder provisioning regression, or a non-personal drive shows.
  if (deps.drive !== null && !ctx.dryRun) {
    try {
      const root = await deps.drive.rootItem();
      const driveType = root.parentReference?.driveType;
      if (driveType !== undefined && driveType !== 'personal') {
        return { ...out, stopped: 'not_personal', stopDetail: `the signed-in drive is "${driveType}", not a personal OneDrive` };
      }
      out.quota = await deps.drive.quota();
    } catch (error) {
      // Never a silent stop: an unclassified failure is 'unreachable', which
      // the sync turns into an alert once it has lasted a day.
      const stop = stopFor(error);
      return stop.stopped === null ? { ...out, stopped: 'unreachable', stopDetail: messageOf(error) } : { ...out, ...stop };
    }
  }

  const candidates = await loadCandidates(ctx, deps.contextIds ?? null, deps.unlimited === true ? 100_000 : Math.max(maxFiles * 3, 50));
  let bytesThisRun = 0;
  let filesThisRun = 0;

  for (const c of candidates) {
    // A hidden, locked or uploading file waits: no row yet, so the moment it
    // becomes accessible it is archived like any other.
    if (!c.facts.accessible) continue;

    let targetPath = c.row?.targetPath ?? null;
    let state = c.row?.state ?? null;

    if (c.row === null) {
      const decision = route({ contextType: c.contextType, folder: c.folder, module: c.module, fileName: c.title ?? '' });
      const dirs = [safeSegment(c.term), safeSegment(c.moduleCode), decision.category];
      const segments = fitPath(dirs, safeSegment(c.title ?? `file ${c.canvasFileId}`), PATH_BUDGET);
      const size = c.facts.size ?? 0;
      state = size > maxFileBytes ? 'skipped_size' : c.mimeClass === 'video' ? 'skipped_type' : 'pending';
      targetPath = segments.join('/');
      await ctx.db.write.execute('reserve archive route', {
        sql: `INSERT INTO files (id, context_id, canvas_file_id, display_name, size_bytes, mime_class,
                                 route_category, route_rule, route_confidence, route_decided_at, route_reroutable,
                                 target_path, download_state, attempts, first_seen_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(id) DO NOTHING`,
        args: [
          c.itemId, c.contextId, c.canvasFileId, c.title, c.facts.size, c.mimeClass,
          decision.category, decision.rule, decision.confidence, ctx.clock.now().toISOString(), decision.reroutable ? 1 : 0,
          targetPath, state, ctx.clock.now().toISOString(),
        ],
      });
      if (state !== 'pending') {
        out.skipped += 1;
        log.info('archive.skipped', { item: c.itemId, reason: state, size });
        continue;
      }
    }

    if (ctx.dryRun || deps.drive === null) {
      out.planned += 1;
      continue;
    }
    if (filesThisRun >= maxFiles || bytesThisRun >= maxBytes || ctx.clock.now().getTime() - started > maxMs) {
      out.stopped = 'budget';
      break;
    }

    const segments = (targetPath ?? '').split('/');
    const dirs = segments.slice(0, -1);
    const priorAttempts = c.row?.attempts ?? 0;

    // Count the attempt first: a crash from here on is visible to the next run.
    await ctx.db.write.execute('count archive attempt', {
      sql: `UPDATE files SET attempts = attempts + 1, download_state = 'pending' WHERE id = ?`,
      args: [c.itemId],
    });

    try {
      const download = await downloadCanvasFile({
        canvas: deps.canvas,
        contextKind: c.contextType === 'group' ? 'groups' : 'courses',
        contextCanvasId: c.contextCanvasId,
        fileId: c.canvasFileId,
        token: deps.canvasToken,
        canvasOrigin,
        maxBytes: maxFileBytes,
        ...(deps.fetchImpl === undefined ? {} : { fetchImpl: deps.fetchImpl }),
      });
      if (download.kind === 'too_large') {
        await setState(ctx, c.itemId, 'skipped_size', download.detail);
        out.skipped += 1;
        continue;
      }
      if (download.kind !== 'ok') {
        await recordFailure(ctx, c.itemId, `${download.kind}: ${download.detail}`);
        out.failed += 1;
        continue;
      }
      filesThisRun += 1;
      bytesThisRun += download.bytes.length;

      await deps.drive.ensureFolders(dirs);

      let finalSegments = segments;
      let result: { id: string; webUrl?: string } | null = null;

      // A previous attempt may have uploaded this file before dying: adopt it.
      if (priorAttempts > 0) {
        const existing = await deps.drive.itemAt(segments);
        if (existing !== null && existing.size === download.bytes.length && sameHash(existing.file?.hashes?.sha1Hash, download.sha1)) {
          result = existing;
          out.adopted += 1;
        }
      }

      for (let n = 0; result === null && n <= MAX_ALTERNATES; n += 1) {
        if (n > 0) {
          const name = alternateName(segments[segments.length - 1] ?? 'file', sgtDate(c.postedAt), n);
          finalSegments = fitPath(dirs, safeSegment(name), PATH_BUDGET);
          // Reserve the new name before uploading under it.
          await ctx.db.write.execute('reserve alternate name', {
            sql: 'UPDATE files SET target_path = ? WHERE id = ?',
            args: [finalSegments.join('/'), c.itemId],
          });
        }
        try {
          result = await deps.drive.upload(finalSegments, download.bytes);
        } catch (error) {
          if (!(error instanceof GraphError) || error.code !== 'conflict') throw error;
          // The name is taken. If it is this very file (a crashed earlier
          // run), adopt it; otherwise try the next name. Never overwrite.
          const existing = await deps.drive.itemAt(finalSegments);
          if (existing !== null && existing.size === download.bytes.length && sameHash(existing.file?.hashes?.sha1Hash, download.sha1)) {
            result = existing;
            out.adopted += 1;
          }
        }
      }
      if (result === null) throw new Error(`every name up to ${MAX_ALTERNATES} alternates was taken`);

      await ctx.db.write.execute('archive complete', {
        sql: `UPDATE files SET download_state = 'complete', target_path = ?, content_sha256 = ?, content_sha1 = ?,
                               onedrive_item_id = ?, share_url = ?, downloaded_at = ?, archived_at = ?, last_error = NULL
               WHERE id = ?`,
        args: [finalSegments.join('/'), download.sha256, download.sha1, result.id, result.webUrl ?? null,
               ctx.clock.now().toISOString(), ctx.clock.now().toISOString(), c.itemId],
      });
      out.archived.push({ itemId: c.itemId, bytes: download.bytes.length });
      log.info('archive.complete', { item: c.itemId, bytes: download.bytes.length, category: segments[2] as Category });
    } catch (error) {
      const stop = stopFor(error);
      await recordFailure(ctx, c.itemId, messageOf(error));
      out.failed += 1;
      if (stop.stopped !== null) {
        out.stopped = stop.stopped;
        out.stopDetail = stop.stopDetail;
        break;
      }
    }
  }

  const gaveUp = await ctx.db.read(`SELECT count(*) AS n FROM files WHERE download_state = 'failed' AND attempts >= ${MAX_ATTEMPTS}`);
  out.exhausted = Number(gaveUp.rows[0]?.['n'] ?? 0);
  log.info('archive.summary', {
    archived: out.archived.length, adopted: out.adopted, skipped: out.skipped, failed: out.failed,
    planned: out.planned, stopped: out.stopped, exhausted: out.exhausted,
  });
  return out;
}

function sameHash(remote: string | undefined, local: string): boolean {
  // Where OneDrive reports a SHA-1, it must match; where it does not, size
  // alone decides (hash availability on personal OneDrive is not documented).
  return remote === undefined || remote.toUpperCase() === local;
}

function stopFor(error: unknown): { stopped: ArchiveStop | null; stopDetail: string | null } {
  if (!(error instanceof GraphError)) return { stopped: null, stopDetail: null };
  if (error.code === 'auth') return { stopped: 'graph_auth', stopDetail: error.message };
  if (error.code === 'app') return { stopped: 'graph_app', stopDetail: error.message };
  if (error.code === 'provisioning') return { stopped: 'provisioning', stopDetail: error.message };
  if (error.code === 'quota') return { stopped: 'quota_full', stopDetail: error.message };
  return { stopped: null, stopDetail: null };
}

async function setState(ctx: RunContext, id: string, state: string, detail: string): Promise<void> {
  await ctx.db.write.execute('archive state', {
    sql: 'UPDATE files SET download_state = ?, last_error = ? WHERE id = ?',
    args: [state, detail, id],
  });
}

async function recordFailure(ctx: RunContext, id: string, detail: string): Promise<void> {
  await ctx.db.write.execute('archive failure', {
    sql: `UPDATE files SET download_state = 'failed', last_error = ? WHERE id = ?`,
    args: [detail.slice(0, 500), id],
  });
}
