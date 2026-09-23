/**
 * The mirror's own private copy of node (DECISIONS.md D-59).
 *
 * macOS grants file access to a binary, not to a project. Granting the shared
 * Homebrew node access to OneDrive would grant it to every script ever run
 * with that node; and a `brew upgrade node` replaces that binary, silently
 * dropping the grant. So the mirror runs a copy of node that lives here, in
 * var/runtime/ (gitignored), which nothing else replaces:
 *
 *   var/runtime/bin/node          the interpreter the LaunchAgent runs
 *   var/runtime/lib/libnode.*.dylib   loaded relative to it
 *
 * The copy still loads other libraries from Homebrew (openssl, icu4c, ...), so
 * a major upgrade of one of those can break it. That fails loudly in the
 * LaunchAgent log; re-run this script to refresh the copy.
 *
 *   node scripts/mirror-runtime.ts           # create or verify
 *   node scripts/mirror-runtime.ts --refresh # after a brew upgrade
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const runtime = path.join(repo, 'var', 'runtime');
const target = path.join(runtime, 'bin', 'node');
const stamp = path.join(runtime, 'source.json');
const refresh = process.argv.includes('--refresh');

const source = realpathSync(process.execPath);
const sourceLib = path.join(path.dirname(path.dirname(source)), 'lib');
const version = execFileSync(source, ['-v'], { encoding: 'utf8' }).trim();

if (existsSync(target) && !refresh) {
  const was = existsSync(stamp) ? (JSON.parse(readFileSync(stamp, 'utf8')) as { version?: string }) : {};
  const have = execFileSync(target, ['-v'], { encoding: 'utf8' }).trim();
  process.stdout.write(`Already present: ${target} (${have}, copied from ${was.version ?? 'unknown'}).\n`);
  if (have !== version) process.stdout.write(`The shared node is now ${version}. That is fine; --refresh only if this copy stops working.\n`);
  process.stdout.write(`\nGrant OneDrive access to this exact binary:\n  ${target}\n`);
  process.exit(0);
}

rmSync(runtime, { recursive: true, force: true });
mkdirSync(path.join(runtime, 'bin'), { recursive: true });
mkdirSync(path.join(runtime, 'lib'), { recursive: true });
copyFileSync(source, target);
// node resolves @rpath/libnode.<abi>.dylib relative to its own location.
for (const lib of readdirSync(sourceLib).filter((f) => /^libnode\.\d+\.dylib$/.test(f))) {
  copyFileSync(path.join(sourceLib, lib), path.join(runtime, 'lib', lib));
}
writeFileSync(stamp, `${JSON.stringify({ version, source, copiedAt: new Date().toISOString() }, null, 1)}\n`);

// Prove the copy runs and can reach the archive folder before anything depends on it.
const check = execFileSync(target, ['-e', 'process.stdout.write(process.version)'], { encoding: 'utf8' });
process.stdout.write(`Copied ${version} to ${target} (runs: ${check}).\n\n`);
process.stdout.write(`Grant OneDrive access to this exact binary, and nothing else:\n  ${target}\n`);
