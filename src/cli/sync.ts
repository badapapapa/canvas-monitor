/**
 * `npm run sync` -- one polling run (SPEC.md section 7).
 *
 * `--dry-run` is the way to check notification wording against real data
 * before anything is sent: it performs every Canvas read, decides everything,
 * writes nothing, sends nothing, and prints the messages it would have sent.
 * Under CI the preview is suppressed, because Actions publishes stdout.
 */

import { runSync, type SyncOutcome } from '../sync/run.ts';
import { render } from '../notify/render.ts';
import type { RunContext, RunStatus } from '../core/run-context.ts';

export async function runSyncCommand(
  ctx: RunContext,
  options: { json: boolean },
): Promise<{ code: number; status: RunStatus }> {
  const outcome = await runSync(ctx);
  const out = process.stdout;

  if (options.json && !ctx.ci) {
    out.write(`${JSON.stringify(summaryOf(outcome), null, 2)}\n`);
  } else {
    out.write(`\n${line(outcome)}\n`);
    if (ctx.dryRun) preview(ctx, outcome);
    out.write('\n');
  }

  const status: RunStatus = outcome.status === 'skipped' ? 'ok' : outcome.status;
  return { code: outcome.status === 'failed' ? 1 : 0, status };
}

function summaryOf(o: SyncOutcome): Record<string, unknown> {
  return {
    status: o.status,
    contexts: o.contexts,
    failed_contexts: o.failedContexts,
    baselined: o.baselined,
    notified: o.notified,
    sent: o.flush?.sent ?? 0,
    held: o.flush?.stillHeld ?? 0,
    alerts: o.alerts,
    // Counts only: the JSON summary is printed under CI, where stdout is public.
    archive: o.archive === null ? null : {
      archived: o.archive.archived.length, adopted: o.archive.adopted, skipped: o.archive.skipped,
      failed: o.archive.failed, planned: o.archive.planned, stopped: o.archive.stopped,
    },
    followups: o.followups,
  };
}

function line(o: SyncOutcome): string {
  if (o.status === 'skipped') return 'Skipped: another sync holds the lock.';
  const parts = [
    `${o.status.toUpperCase()}: ${o.contexts} course(s)`,
    o.failedContexts > 0 ? `${o.failedContexts} failed` : null,
    o.baselined > 0 ? `${o.baselined} item(s) baselined silently` : null,
    `${o.notified} to notify`,
    o.flush === null ? null : `${o.flush.sent} sent`,
    o.flush !== null && o.flush.stillHeld > 0 ? `${o.flush.stillHeld} held for quiet hours` : null,
    o.alerts !== null && o.alerts.raised.length > 0 ? `${o.alerts.raised.length} alert(s) raised` : null,
    o.alerts !== null && o.alerts.resolved.length > 0 ? `${o.alerts.resolved.length} resolved` : null,
    archiveLine(o),
    followupLine(o),
  ];
  return parts.filter((p) => p !== null).join(', ');
}

function followupLine(o: SyncOutcome): string | null {
  const f = o.followups;
  if (f === null) return null;
  if (f.status === 'awaiting_ruling') return 'Follow-ups: waiting for followup_partial_answers';
  const bits = [
    f.baseline ? 'first run' : null,
    f.opened > 0 ? `${f.opened} opened` : null,
    f.closed > 0 ? `${f.closed} closed` : null,
    f.nudged > 0 ? `${f.nudged} nudged` : null,
    f.expired > 0 ? `${f.expired} expired` : null,
  ].filter((b) => b !== null);
  return bits.length === 0 ? null : `Follow-ups: ${bits.join(', ')}`;
}

function archiveLine(o: SyncOutcome): string | null {
  const a = o.archive;
  if (a === null) return null;
  const bits = [
    a.planned > 0 ? `${a.planned} would archive` : null,
    a.archived.length > 0 ? `${a.archived.length} archived` : null,
    a.adopted > 0 ? `${a.adopted} adopted` : null,
    a.skipped > 0 ? `${a.skipped} skipped` : null,
    a.failed > 0 ? `${a.failed} failed` : null,
    a.stopped !== null && a.stopped !== 'budget' ? `stopped: ${a.stopped}` : null,
    a.stopped === 'budget' ? `more next run (budget: ${(a.stopDetail ?? '').split(' ')[0]})` : null,
  ].filter((b) => b !== null);
  return bits.length === 0 ? null : `OneDrive: ${bits.join(', ')}`;
}

function preview(ctx: RunContext, o: SyncOutcome): void {
  const out = process.stdout;
  if (ctx.ci) {
    out.write('\nPreview suppressed: running under CI, where stdout is published.\n');
    return;
  }
  const now = ctx.clock.now();
  const planned = o.planned.flatMap((p) => render(p, now).map((text) => ({ channel: p.kind === 'ops' ? 'ops' : 'content', text })));
  const queued = o.flush?.preview ?? [];
  if (planned.length === 0 && queued.length === 0) {
    out.write('\nDRY RUN: nothing would be sent.\n');
    return;
  }
  out.write('\nDRY RUN: nothing was written or sent. This run would send:\n');
  for (const m of [...planned, ...queued]) {
    out.write(`\n--- to ${m.channel} chat ---\n${m.text}\n`);
  }
  if (queued.length > 0) {
    out.write(`\n(${queued.length} of these were already queued by an earlier run.)\n`);
  }
}
