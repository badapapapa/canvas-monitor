/**
 * `npm run seed-groups -- [--from <fresh discovery file>] [--write]`
 * (DECISIONS.md D-72). Local files only: no Canvas request, no database.
 *
 * Shows how a fresh discovery's GROUPS differ from the reviewed
 * courses.seed.json (a group added, a group left) and, with --write, applies
 * just that to courses.seed.json, after backing it up under var/. Then load it
 * with `npm run seed-courses` as usual.
 *
 * Prints module codes and actions only: no group names or ids.
 */

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { mergeGroups } from '../src/discover/merge-groups.ts';
import { SEED_PATH, type SeedFile } from '../src/discover/seed.ts';
import { validate } from '../src/cli/seed-courses.ts';

const fail = (message: string): never => {
  process.stderr.write(`seed-groups: ${message}\n`);
  process.exit(1);
};
if (process.env['CI'] !== undefined || process.env['GITHUB_ACTIONS'] !== undefined) fail('this reads your seed file: run it locally.');

const arg = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};
const reviewedPath = arg('--seed') ?? SEED_PATH;
const freshPath = arg('--from') ?? 'var/seed-new.json';
const read = (p: string): SeedFile => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as SeedFile;
  } catch {
    return fail(`cannot read ${p}.`);
  }
};

const { merged, changes } = mergeGroups(read(reviewedPath), read(freshPath));
if (changes.length === 0) {
  process.stdout.write('\nNo group changes: the fresh discovery lists the same groups as the reviewed seed file.\n\n');
  process.exit(0);
}
process.stdout.write('\nGroup changes:\n');
for (const c of changes) {
  process.stdout.write(`  ${c.action === 'add' ? 'ADD    ' : 'DISABLE'}  ${c.moduleCode ?? '(no module code)'} · group  -> enabled=${c.enabled}  (${c.reason})\n`);
}
const problems = merged.contexts.flatMap((c) => validate(c, merged.contexts));
if (problems.length > 0) fail(`the result would not load:\n  - ${problems.join('\n  - ')}`);

if (!process.argv.includes('--write')) {
  process.stdout.write(`\nNothing written. Re-run with --write to apply this to ${reviewedPath} (backed up under var/ first).\n\n`);
  process.exit(0);
}
mkdirSync('var', { recursive: true });
const backup = path.join('var', `${path.basename(reviewedPath, '.json')}.before-seed-groups.${Date.now()}.json`);
copyFileSync(reviewedPath, backup);
writeFileSync(reviewedPath, `${JSON.stringify(merged, null, 2)}\n`);
process.stdout.write(`\nWrote ${reviewedPath} (backup: ${backup}). Next: npm run seed-courses -- --dry-run, then npm run seed-courses.\n\n`);
