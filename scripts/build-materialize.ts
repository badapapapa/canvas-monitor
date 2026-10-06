/**
 * Build the mirror's materialize helper (DECISIONS.md D-77) from the committed,
 * reviewable source, native/materialize.c, into var/runtime/bin/materialize.
 * The binary is never committed: var/ is gitignored and blocked by the commit hook.
 *
 *   node scripts/build-materialize.ts            # build, then show what was built
 *   node scripts/build-materialize.ts --check    # show what is there, build nothing
 *
 * Uses Apple's own compiler (xcrun clang, from the Command Line Tools) with
 * every warning an error. The linker signs the result ad hoc, as for any local
 * build; nothing is downloaded.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = path.join(repo, 'native', 'materialize.c');
const out = path.join(repo, 'var', 'runtime', 'bin', 'materialize');

if (process.env['CI'] !== undefined || process.env['GITHUB_ACTIONS'] !== undefined) {
  process.stderr.write('build-materialize is for this Mac only.\n');
  process.exit(2);
}
if (process.platform !== 'darwin') {
  process.stderr.write('build-materialize needs macOS.\n');
  process.exit(2);
}

if (!process.argv.includes('--check')) {
  mkdirSync(path.dirname(out), { recursive: true });
  execFileSync('xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-o', out, source], { stdio: 'inherit' });
}
if (!existsSync(out)) {
  process.stderr.write(`No helper at ${out}. Build it: node scripts/build-materialize.ts\n`);
  process.exit(1);
}
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
const sig = spawnSync('codesign', ['-dv', out], { encoding: 'utf8' }).stderr.split('\n').find((l) => l.startsWith('Signature=')) ?? 'Signature=unknown';
const usage = spawnSync(out, [], { encoding: 'utf8' }).status;
process.stdout.write(
  `helper:  ${out}\nsource:  native/materialize.c  sha256 ${sha(source)}\nbinary:  sha256 ${sha(out)}  ${sig}\n` +
  `self-test (no arguments -> usage, exit 2): exit ${String(usage)}${usage === 2 ? '  ok' : '  UNEXPECTED'}\n`,
);
process.exit(usage === 2 ? 0 : 1);
