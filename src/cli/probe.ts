/**
 * `npm run probe` -- the Phase 0 done-when (SPEC.md section 14).
 *
 * Validates the token and lists active courses. It does NOT probe coverage,
 * resolve sections, or propose module codes: that is `npm run discover` in
 * Phase 1. This command exists to prove the client works end to end --
 * pagination, rate limiting, three-state errors, capture and config -- against
 * the real instance before anything is built on top of it.
 */

import { CanvasClient } from '../canvas/client.ts';
import { CanvasHttp } from '../canvas/http.ts';
import { RateLimitGovernor } from '../canvas/rate-limit.ts';
import { createRawStore } from '../canvas/raw-store.ts';
import { Config, tokenDaysRemaining } from '../core/config.ts';
import { describe, type Result } from '../core/result.ts';
import { courseTermName, isAccessRestricted, type CanvasCourse } from '../canvas/types.ts';
import type { RunContext } from '../core/run-context.ts';
import { maskIdentity, suppressionNotice } from '../core/presentation.ts';

export interface ProbeOptions {
  json: boolean;
}



export interface ProbeOutcome {
  ok: boolean;
  userId: number | null;
  courses: Array<{
    id: number;
    course_code: string | null;
    name: string | null;
    term: string | null;
    workflow_state: string | null;
    access_restricted: boolean;
  }>;
  tokenDaysRemaining: number | null;
  warnings: string[];
}

export async function runProbe(ctx: RunContext, options: ProbeOptions): Promise<ProbeOutcome> {
  const config = await Config.load(ctx.db);
  const token = config.require('canvas_token');
  const baseUrl = config.require('canvas_base_url');

  const governor = new RateLimitGovernor(ctx.log);
  const rawStore = createRawStore({
    runId: ctx.runId,
    enabled: config.getBoolean('raw_capture_enabled', true),
    log: ctx.log,
    clock: ctx.clock,
  });

  const http = new CanvasHttp({ baseUrl, token, log: ctx.log, clock: ctx.clock, governor, rawStore });
  const client = new CanvasClient(http);

  const warnings: string[] = [];

  const days = tokenDaysRemaining(config, ctx.clock.now());
  if (days === null) {
    warnings.push(
      'canvas_token_expires_at is not set. NUS caps Canvas tokens at 90 days and there is no ' +
        'non-expiring option, so without this the expiry alerts in Phase 2 cannot fire.',
    );
  } else if (days <= 14) {
    warnings.push(`Canvas token expires in ${days} day(s). Rotate it: npm run set-config canvas_token`);
  }

  const self = await client.getSelf();
  if (self.kind !== 'ok') {
    reportFailure(ctx, '/users/self', self);
    return { ok: false, userId: null, courses: [], tokenDaysRemaining: days, warnings };
  }
  ctx.log.info('probe.authenticated', { canvas_user_id: self.value.id });

  const courses = await client.listActiveCourses();
  if (courses.kind !== 'ok') {
    reportFailure(ctx, '/courses', courses);
    return { ok: false, userId: self.value.id, courses: [], tokenDaysRemaining: days, warnings };
  }

  const rows = courses.value.map((course: CanvasCourse) => ({
    // Canvas IDs are kept: they are meaningless without a token, and they are
    // what makes a suppressed line actionable.
    id: course.id,
    course_code: maskIdentity(ctx.ci, course.course_code ?? null),
    name: maskIdentity(ctx.ci, course.name ?? null),
    term: maskIdentity(ctx.ci, courseTermName(course)),
    workflow_state: course.workflow_state ?? null,
    access_restricted: isAccessRestricted(course),
  }));

  const restricted = rows.filter((row) => row.access_restricted).length;
  if (restricted > 0) {
    warnings.push(
      `${restricted} course(s) were returned but are access-restricted by date. They are listed ` +
        'with reduced detail and will need explicit handling in Phase 1 discovery.',
    );
  }

  const snapshot = governor.snapshot();
  ctx.log.info('probe.complete', {
    courses: rows.length,
    rate_ceiling: snapshot.ceiling,
    rate_remaining: snapshot.remaining,
    rate_pauses: snapshot.pauses,
  });

  const outcome: ProbeOutcome = {
    ok: true,
    userId: self.value.id,
    courses: rows,
    tokenDaysRemaining: days,
    warnings,
  };

  if (ctx.ci) {
    ctx.log.info('probe.output_suppressed', { reason: 'ci', courses: rows.length });
  }

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
  } else {
    printTable(outcome, ctx.ci);
  }

  return outcome;
}

function reportFailure(ctx: RunContext, endpoint: string, result: Result<unknown>): void {
  ctx.log.error('probe.failed', { endpoint, outcome: describe(result) });

  if (result.kind === 'denied_or_absent') {
    process.stderr.write(
      `\n${endpoint} returned ${result.status}. Canvas uses 404 for permission denial as well as\n` +
        'for genuinely absent resources, so this is NOT being treated as "nothing there".\n' +
        `Detail: ${result.detail}\n\n`,
    );
    return;
  }
  if (result.kind === 'error' && result.code === 'auth') {
    process.stderr.write(
      '\nCanvas rejected the token (401).\n' +
        'Generate a new one at Canvas > Account > Settings > New Access Token, then:\n' +
        '  npm run set-config canvas_token\n' +
        '  npm run set-config canvas_token_expires_at\n\n',
    );
    return;
  }
  if (result.kind === 'error') {
    process.stderr.write(`\n${endpoint} failed: ${result.message}\n\n`);
  }
}

function printTable(outcome: ProbeOutcome, ci: boolean): void {
  const out = process.stdout;

  const notice = suppressionNotice(ci);
  if (notice !== null) out.write(`\n${notice}\n`);

  if (outcome.courses.length === 0) {
    out.write('\nNo active courses returned.\n');
    out.write('This is a real answer, not an error: enrollment_state=active found nothing.\n\n');
    return;
  }

  const header = ['ID', 'CODE', 'TERM', 'NAME'];
  const rows = outcome.courses.map((c) => [
    String(c.id),
    c.course_code ?? '-',
    c.term ?? '-',
    `${c.name ?? '-'}${c.access_restricted ? '  [access restricted]' : ''}`,
  ]);

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ').trimEnd();

  out.write(`\n${line(header)}\n`);
  out.write(`${widths.map((w) => '-'.repeat(w)).join('  ')}\n`);
  for (const row of rows) out.write(`${line(row)}\n`);
  out.write(`\n${outcome.courses.length} active course(s).\n`);

  if (outcome.tokenDaysRemaining !== null) {
    out.write(`Canvas token expires in ${outcome.tokenDaysRemaining} day(s).\n`);
  }
  for (const warning of outcome.warnings) {
    out.write(`\nWARNING: ${warning}\n`);
  }
  out.write('\nNext: Phase 1 -- npm run discover (not built yet).\n\n');
}
