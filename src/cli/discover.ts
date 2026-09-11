import { runDiscover, type DiscoverOutcome } from '../discover/run.ts';
import { maskIdentity, suppressionNotice } from '../core/presentation.ts';
import type { RunContext } from '../core/run-context.ts';

export async function runDiscoverCommand(
  ctx: RunContext,
  options: { json: boolean; out?: string | undefined; overwrite: boolean },
): Promise<number> {
  const outcome = await runDiscover(ctx, { out: options.out, overwrite: options.overwrite });
  if (!outcome.ok) return 1;

  if (options.json) {
    process.stdout.write(`${JSON.stringify(outcome, null, 2)}\n`);
    return 0;
  }

  const out = process.stdout;
  const notice = suppressionNotice(ctx.ci);
  if (notice !== null) out.write(`\n${notice}\n`);

  out.write(`\n${outcome.contexts} context(s) discovered, ${outcome.enabled} proposed enabled.\n`);
  out.write(
    ctx.dryRun
      ? `\nDRY RUN: ${outcome.seedPath} was NOT written.\n`
      : `\nWrote ${maskIdentity(ctx.ci, outcome.seedPath)}. Review and edit it, then: npm run seed-courses\n`,
  );

  out.write('\nEmpirical questions\n');
  out.write('-------------------\n');
  for (const finding of outcome.findings) {
    out.write(`\n${finding.ref}  ${finding.question}\n`);
    out.write(`  ${finding.conclusive ? 'ANSWERED' : 'BOUNDED ONLY'}: ${finding.answer}\n`);
    for (const line of finding.detail) out.write(`    - ${line}\n`);
  }
  out.write('\n');

  const open = outcome.findings.filter((f) => !f.conclusive);
  if (open.length > 0) {
    out.write(
      `${open.length} question(s) could not be settled from the data available. They stay open in\n` +
        'DECISIONS.md rather than being resolved by assumption.\n\n',
    );
  }
  return 0;
}

export type { DiscoverOutcome };
