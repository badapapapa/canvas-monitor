/**
 * `npm run rules -- list | add | remove` and `npm run reroute -- --preview | --apply <fp>`
 * (DECISIONS.md D-57).
 *
 * Both print real module codes, folder and file names, so both refuse to run
 * under CI: this repository's Actions logs are public (D-10).
 */

import { Config } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import type { RunContext } from '../core/run-context.ts';
import { addRule, listRules, removeRule } from '../archive/rules.ts';
import { applyReroutes, planReroutes } from '../archive/reroute.ts';
import type { RuleField } from '../archive/route.ts';
import { buildDriveForCli } from './graph-drive.ts';

function refuseUnderCi(): void {
  if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') {
    throw new AppError('usage', 'rules and reroute print real names and are refused under CI (public logs).');
  }
}

export async function runRules(ctx: RunContext, args: { action: string | undefined; rest: string[]; opts: Record<string, string | undefined> }): Promise<number> {
  refuseUnderCi();
  const out = process.stdout;
  if (args.action === 'list' || args.action === undefined) {
    const rows = await listRules(ctx.db);
    if (rows.length === 0) out.write('\nNo routing rules. Generic defaults only.\n\n');
    for (const r of rows) out.write(`#${r.id}  ${r.moduleCode ?? r.contextId}  p${r.priority}  ${r.field} /${r.pattern}/  ->  ${r.target}\n`);
    return 0;
  }
  if (args.action === 'add') {
    const { module, field, pattern, target, priority } = args.opts;
    if (module === undefined || field === undefined || pattern === undefined || target === undefined) {
      throw new AppError('usage', 'Usage: npm run rules -- add --module <code> --field folder|module|filename|extension --pattern <regex|ext,list> --target <folder> [--priority N]');
    }
    if (!['folder', 'module', 'filename', 'extension'].includes(field)) throw new AppError('usage', `--field must be folder, module, filename or extension`);
    const id = await addRule(ctx.db, ctx.clock, { moduleCode: module, field: field as RuleField, pattern, target, priority: priority === undefined ? 100 : Number(priority) });
    out.write(ctx.dryRun ? '\nDRY RUN: rule validated, not saved.\n' : `\nAdded rule #${id}. It routes NEW files now; _unsorted files move only via reroute --apply.\n`);
    return 0;
  }
  if (args.action === 'remove') {
    const id = Number(args.rest[0]);
    if (!Number.isInteger(id)) throw new AppError('usage', 'Usage: npm run rules -- remove <id>');
    await removeRule(ctx.db, id);
    out.write(`\nRemoved rule #${id}.\n`);
    return 0;
  }
  throw new AppError('usage', `Unknown rules action "${args.action}". Use list, add or remove.`);
}

export async function runReroute(ctx: RunContext, args: { preview: boolean; apply: string | undefined }): Promise<number> {
  refuseUnderCi();
  const out = process.stdout;
  if (args.apply === undefined) {
    const plan = await planReroutes(ctx);
    out.write(`\nRe-route preview (nothing moved). Each file below can be re-routed ONCE (D-40).\n\n`);
    let module = '';
    for (const m of plan.moves) {
      if (m.moduleCode !== module) out.write(`${(module = m.moduleCode)}\n`);
      out.write(`  ${m.from.split('/').slice(2).join('/')}\n      -> ${m.destination}/   (${m.rule})\n`);
    }
    if (plan.staying.length > 0) {
      out.write(`\nStaying in _unsorted (no rule matches yet):\n`);
      for (const s of plan.staying) out.write(`  ${s.moduleCode}  ${s.from.split('/').slice(2).join('/')}\n`);
    }
    out.write(`\n${plan.moves.length} to move, ${plan.staying.length} staying.  Fingerprint: ${plan.fingerprint}\n`);
    out.write(`To apply exactly this plan:  npm run reroute -- --apply ${plan.fingerprint}\n\n`);
    return 0;
  }
  if (ctx.dryRun) throw new AppError('usage', '--apply with --dry-run makes no sense: use --preview.');
  const config = await Config.load(ctx.db);
  const drive = buildDriveForCli(ctx, config);
  const result = await applyReroutes(ctx, drive, args.apply);
  out.write(`\nMoved ${result.moved}, recovered ${result.recovered}, failed ${result.failed.length}.\n`);
  for (const f of result.failed) out.write(`  failed ${f.fileId}: ${f.reason}\n`);
  out.write('\n');
  return result.failed.length === 0 ? 0 : 1;
}
