/**
 * `npm run tune-patterns` and `npm run followups -- preview | list | dismiss <id> | phrases [add]`
 * (DECISIONS.md D-61).
 *
 * All print real module codes and file names, so all refuse under CI. `preview`
 * and `tune-patterns` are read-only (the database is opened through the dry-run
 * writer) and work BEFORE migration 0010 is applied: they read only the tables
 * that already exist, and take term ends from Canvas directly.
 */

import { CanvasClient } from '../canvas/client.ts';
import { CanvasHttp } from '../canvas/http.ts';
import { RateLimitGovernor } from '../canvas/rate-limit.ts';
import { createRawStore } from '../canvas/raw-store.ts';
import { Config } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import type { RunContext } from '../core/run-context.ts';
import type { Db } from '../core/db/writer.ts';
import { followupLabel, type FollowupCategory } from '../followups/classify.ts';
import { planFollowups, type ExistingFollowup, type Plan } from '../followups/plan.ts';
import { fetchTermEnds, loadExisting, loadPhrases, loadTrackedFiles, trackingSummary } from '../followups/stage.ts';
import { tunePatterns } from '../followups/tune.ts';

function refuseUnderCi(): void {
  if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') {
    throw new AppError('usage', 'follow-up commands print real names and are refused under CI (public logs).');
  }
}

async function tableExists(db: Db, name: string): Promise<boolean> {
  const r = await db.read({ sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", args: [name] });
  return r.rows.length > 0;
}

function canvasFor(ctx: RunContext, config: Config): CanvasClient {
  return new CanvasClient(new CanvasHttp({
    baseUrl: config.require('canvas_base_url'), token: config.require('canvas_token'), log: ctx.log, clock: ctx.clock,
    governor: new RateLimitGovernor(ctx.log), rawStore: createRawStore({ runId: ctx.runId, enabled: false, log: ctx.log, clock: ctx.clock }),
  }));
}

const day = (iso: string) => iso.slice(0, 10);

export async function runTunePatterns(ctx: RunContext): Promise<number> {
  refuseUnderCi();
  const rows = await ctx.db.read(
    `SELECT i.context_id, i.title, c.module_code FROM items i JOIN courses c ON c.context_id = i.context_id
      WHERE i.resource_type = 'file' ORDER BY c.module_code, i.title`,
  );
  const { tokens, pairs } = tunePatterns(rows.rows.map((r) => ({ contextId: Number(r['context_id']), moduleCode: String(r['module_code'] ?? '?'), title: String(r['title'] ?? '') })));
  const out = process.stdout;
  out.write(`\ntune-patterns (read-only): ${rows.rows.length} files, ${pairs.length} candidate question/answer pairs.\n`);
  out.write('A pair is two files in one module where one name is the other plus 1-3 words.\n\n');
  out.write('RANKED DISTINGUISHING WORDS\n');
  for (const t of tokens) {
    out.write(`  ${String(t.pairs).padStart(3)}  ${t.token.padEnd(14)} ${t.generic ? 'generic (already in code)' : 'NOT in code'}   modules: ${t.modules.join(', ')}\n`);
  }
  out.write('\nTHE PAIRS\n');
  for (const t of tokens) {
    out.write(`\n  "${t.token}"\n`);
    for (const p of t.examples) out.write(`    ${p.moduleCode}  ${p.question}\n      ->  ${p.answer}   (+ ${p.extra.join(' ')})\n`);
  }
  out.write('\nNothing stored. Generic words live in code (src/followups/classify.ts); a module-specific phrase would be added with\n  npm run followups -- phrases add --module <code> --phrase "<words>"\n\n');
  return 0;
}

export async function runFollowupsCli(ctx: RunContext, args: { action: string | undefined; rest: string[]; module?: string; phrase?: string }): Promise<number> {
  refuseUnderCi();
  const out = process.stdout;
  const config = await Config.load(ctx.db);

  if (args.action === 'preview' || args.action === undefined) {
    const migrated = await tableExists(ctx.db, 'followups');
    const existing: ExistingFollowup[] = migrated ? await loadExisting(ctx.db) : [];
    const phrases = (await tableExists(ctx.db, 'answer_patterns')) ? await loadPhrases(ctx.db) : new Map<number, string[]>();
    const files = await loadTrackedFiles(ctx.db);
    const termEnds = (await fetchTermEnds(ctx.db, canvasFor(ctx, config))) ?? new Map<number, string | null>();
    const now = ctx.clock.now();
    const baseline = (config.get('followups_baselined_at') ?? '') === '';
    const policy = (config.get('followup_partial_answers') ?? null) as 'close' | 'keep_open' | null;
    const plan = planFollowups({ files, existing, phrases, partialPolicy: policy, termEnds, now, baseline });

    out.write(`\nFollow-up preview${baseline ? ' of the FIRST RUN' : ''} (read-only: nothing stored, nothing sent). ${now.toISOString()}\n`);
    out.write(`Partial-answer ruling (followup_partial_answers): ${policy ?? 'NOT SET: follow-ups will not run until it is'}\n`);
    section(out, 'WOULD OPEN', plan.opens.map((o) =>
      `${o.moduleCode} ${o.label}   ${o.question.title}   first seen ${day(o.question.firstSeenAt)} (${o.ageDays} days)` +
      (o.pastNudge ? (baseline ? '   past 10 days: age shown in the summary, no nudge' : '   past 10 days') : '')));
    section(out, 'WOULD RECORD AS ALREADY ANSWERED (closed, silently)', plan.closedOnArrival.map((c) =>
      `${c.moduleCode} ${c.label}   ${c.question.title}\n        answered by  ${c.answer.title}`));
    section(out, 'PARTIAL ANSWERS: YOUR RULING', partialCases(plan, { files, existing, phrases, termEnds, now, baseline }));
    section(out, 'IGNORED IN TUTORIALS / LABS (deliberately)', plan.ignored.map((i) => `${i.file.moduleCode}  ${i.file.category.padEnd(9)}  ${i.file.title}   (${i.reason})`));
    section(out, 'ANSWER FILES WITH NO QUESTION YET', plan.answersWithoutQuestion.map((a) => `${a.moduleCode} ${a.label}   ${a.file.title}`));
    section(out, 'FURTHER ANSWER FILES (do nothing)', plan.extraAnswers.map((a) => `${a.moduleCode} ${a.label}   ${a.file.title}`));
    // Only the modules follow-ups actually look at (enabled courses).
    const tracked = new Map(files.map((f) => [f.contextId, f.moduleCode]));
    const ends = [...termEnds.entries()].filter(([id]) => tracked.has(id)).map(([id, end]) => `${tracked.get(id)}: ${end ?? 'none given: never auto-closed'}`);
    section(out, 'TERM ENDS (from Canvas, live; open follow-ups expire then)', ends);
    if (baseline) {
      const s = trackingSummary(plan);
      out.write(`\nTHE ONE MESSAGE THE FIRST RUN WOULD SEND\n  ${s.title}: ${s.lines.join(' ')}\n`);
    }
    out.write(migrated ? '\n' : '\n(Migration 0010 is not applied yet; this preview needs none of it.)\n\n');
    return 0;
  }

  if (!(await tableExists(ctx.db, 'followups'))) throw new AppError('usage', 'Migration 0010 is not applied yet: run npm run migrate first.');

  if (args.action === 'list') {
    const all = args.rest.includes('--all');
    const r = await ctx.db.read({
      sql: `SELECT f.id, f.category, f.number, f.state, f.opened_at, f.nudged_at, f.close_reason, c.module_code, i.title
              FROM followups f JOIN courses c ON c.context_id = f.context_id JOIN items i ON i.id = f.question_file_id
             WHERE f.state = 'open' OR ? = 1 ORDER BY c.module_code, f.category, CAST(f.number AS INTEGER)`,
      args: [all ? 1 : 0],
    });
    if (r.rows.length === 0) out.write(`\nNo ${all ? '' : 'open '}follow-ups.\n\n`);
    for (const x of r.rows) {
      const label = `${String(x['module_code'])} ${followupLabel(String(x['category']) as FollowupCategory, String(x['number']))}`;
      out.write(`#${String(x['id']).padEnd(4)} ${label.padEnd(22)} ${String(x['state']).padEnd(9)} since ${day(String(x['opened_at']))}` +
        `${x['nudged_at'] === null ? '' : '  nudged'}${x['close_reason'] === null ? '' : `  (${String(x['close_reason'])})`}   ${String(x['title'])}\n`);
    }
    return 0;
  }

  if (args.action === 'dismiss') {
    const id = Number(args.rest[0]);
    if (!Number.isInteger(id)) throw new AppError('usage', 'Usage: npm run followups -- dismiss <id>');
    const r = await ctx.db.write.execute('dismiss follow-up', {
      sql: `UPDATE followups SET state = 'dismissed', closed_at = ?, close_reason = 'dismissed' WHERE id = ? AND state = 'open'`,
      args: [ctx.clock.now().toISOString(), id],
    });
    out.write(ctx.dryRun ? `\nDRY RUN: would dismiss #${id}.\n` : r.rowsAffected === 1 ? `\nDismissed #${id}.\n` : `\n#${id} is not an open follow-up; nothing changed.\n`);
    return 0;
  }

  if (args.action === 'phrases') {
    if (args.rest[0] === 'add') {
      if (args.module === undefined || args.phrase === undefined) throw new AppError('usage', 'Usage: npm run followups -- phrases add --module <code> --phrase "<words>"');
      const c = await ctx.db.read({ sql: 'SELECT context_id FROM courses WHERE module_code = ?', args: [args.module] });
      if (c.rows.length !== 1) throw new AppError('usage', `No single course with module code "${args.module}".`);
      await ctx.db.write.execute('add answer phrase', {
        sql: 'INSERT INTO answer_patterns (context_id, phrase, created_at) VALUES (?, ?, ?)',
        args: [Number(c.rows[0]!['context_id']), args.phrase, ctx.clock.now().toISOString()],
      });
      out.write(ctx.dryRun ? '\nDRY RUN: phrase validated, not saved.\n' : `\nAdded "${args.phrase}" for ${args.module}.\n`);
      return 0;
    }
    const r = await ctx.db.read('SELECT p.id, c.module_code, p.phrase FROM answer_patterns p JOIN courses c ON c.context_id = p.context_id ORDER BY c.module_code, p.id');
    if (r.rows.length === 0) out.write('\nNo module-specific answer phrases. Generic words only.\n\n');
    for (const x of r.rows) out.write(`#${String(x['id'])}  ${String(x['module_code'])}  "${String(x['phrase'])}"\n`);
    return 0;
  }
  throw new AppError('usage', `Unknown followups action "${args.action}". Use preview, list, dismiss or phrases.`);
}

function section(out: NodeJS.WriteStream, title: string, lines: string[]): void {
  out.write(`\n${title} (${lines.length})\n`);
  for (const l of lines) out.write(`  ${l}\n`);
}

/** Each partial answer, and what each possible ruling would do with its follow-up. */
function partialCases(plan: Plan, input: Omit<Parameters<typeof planFollowups>[0], 'partialPolicy'>): string[] {
  if (plan.partial.length === 0) return [];
  const ifClose = planFollowups({ ...input, partialPolicy: 'close' });
  const ifKeep = planFollowups({ ...input, partialPolicy: 'keep_open' });
  const outcome = (p: Plan, k: { contextId: number; category: string; number: string }) => {
    const same = (x: { contextId: number; category: string; number: string }) => x.contextId === k.contextId && x.category === k.category && x.number === k.number;
    if (p.closedOnArrival.some(same) || p.closes.some(same)) return 'recorded answered, nothing tracked';
    if (p.opens.some(same)) return 'opens, waiting for the full answers';
    return 'no question file yet: nothing tracked either way';
  };
  return plan.partial.map((c) =>
    `${c.moduleCode} ${c.label}   ${c.file.title}   [now: ${c.effect}]\n` +
    `        if you rule "close":      ${outcome(ifClose, c)}\n` +
    `        if you rule "keep_open":  ${outcome(ifKeep, c)}`);
}
