/**
 * `npm run mirror -- [--dry-run] [--baseline] [--config <path>]` (DECISIONS.md D-58).
 *
 * Local only: refuses under CI. Reads the archive database (read-only: it does
 * not even record a run) and the archive's synced folder; writes only inside
 * the "Downloaded from Canvas" folders, its own state in var/mirror/, and its
 * log in var/mirror/mirror.log.
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { startRun } from '../core/run-context.ts';
import { AppError } from '../core/errors.ts';
import { MirrorGuard, type MirrorRoots } from '../mirror/guard.ts';
import { loadState, runMirror, saveStateFile, type ArchiveFile, type MirrorReport } from '../mirror/mirror.ts';

const STATE_FILE = path.join('var', 'mirror', 'state.json');
const LOG_FILE = path.join('var', 'mirror', 'mirror.log');
const TMP_DIR = path.join('var', 'mirror', 'tmp');

const expand = (p: string): string => (p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p);

export function loadMirrorConfig(file: string): MirrorRoots {
  if (!existsSync(file)) throw new AppError('usage', `No mirror config at ${file}. Copy mirror.config.example.json to mirror.config.json and fill in the mapping.`);
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<MirrorRoots>;
  for (const k of ['archiveRoot', 'destinationRoot', 'subfolder', 'terms', 'modules'] as const) {
    if (raw[k] === undefined) throw new AppError('usage', `mirror config: "${k}" is missing`);
  }
  return { ...(raw as MirrorRoots), archiveRoot: expand(raw.archiveRoot!), destinationRoot: expand(raw.destinationRoot!) };
}

export async function runMirrorCli(opts: { dryRun: boolean; baseline: boolean; config: string | undefined }): Promise<number> {
  if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') throw new AppError('usage', 'the mirror is local only');
  const roots = loadMirrorConfig(opts.config ?? 'mirror.config.json');
  try {
    readdirSync(roots.archiveRoot);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new AppError('usage', code === 'EPERM' || code === 'EACCES'
      ? `macOS refused access to the OneDrive folder (${code}). The binary asking is ${realpathSync(process.execPath)}. ` +
        'If a prompt appeared, allow it; otherwise System Settings > Privacy & Security > Files and Folders, and tick OneDrive for that binary. ' +
        'Under launchd it should be the mirror\'s own node (var/runtime/bin/node): see scripts/mirror-runtime.ts (D-59).'
      : `archive folder not readable (${code ?? 'unknown'}; is OneDrive running?): ${roots.archiveRoot}`);
  }
  const guard = new MirrorGuard(roots);

  // dry_run in the log means --dry-run, nothing else. The archive database is
  // opened read-only whatever the flag says, so this command cannot write to
  // it; that is logged as db_access: "read-only" (D-59). The mirror's own state
  // file is not the archive, and is written on a real run.
  const ctx = await startRun({ command: 'mirror', dryRun: opts.dryRun, recordRun: false, readOnlyDb: true });
  const rows = await ctx.db.read(
    `SELECT id, canvas_file_id, target_path, content_sha256 FROM files
      WHERE download_state = 'complete' AND target_path IS NOT NULL AND content_sha256 IS NOT NULL
      ORDER BY target_path`,
  );
  const files: ArchiveFile[] = rows.rows.map((r) => ({
    id: String(r['id']), canvasFileId: Number(r['canvas_file_id']), targetPath: String(r['target_path']), sha256: String(r['content_sha256']),
  }));

  const report = await runMirror({
    archiveRoot: roots.archiveRoot,
    guard,
    files,
    state: loadState(STATE_FILE),
    mode: opts.baseline ? 'baseline' : 'run',
    dryRun: opts.dryRun,
    now: () => ctx.clock.now(),
    tmpDir: TMP_DIR,
    saveState: (s) => saveStateFile(STATE_FILE, s),
  });
  print(report, files.length);
  if (!opts.dryRun) {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    appendFileSync(LOG_FILE, `${JSON.stringify({ at: ctx.clock.now().toISOString(), ...report })}\n`);
  }
  return 0;
}

function print(r: MirrorReport, archived: number): void {
  const out = process.stdout;
  const dry = r.dryRun ? 'DRY RUN: ' : '';
  if (r.mode === 'baseline' || r.baselined > 0) {
    out.write(`\n${dry}baseline: ${r.baselined} of ${archived} archived files recorded as already seen. 0 copied.\n`);
    out.write(r.dryRun ? `Nothing written. To take it for real:  npm run mirror -- --baseline\n\n` : `State saved to ${STATE_FILE}.\n\n`);
    return;
  }
  out.write(`\n${dry}${r.copied.length} ${r.dryRun ? 'to copy' : 'copied'}, ${r.adopted.length} already there, ${r.followed.length} ${r.dryRun ? 'to follow' : 'followed'} a re-route, ${r.deferred.length} deferred, ${r.skipped.length} skipped, ${r.left.length} left alone.\n`);
  for (const c of r.copied) out.write(`  copy    ${c.from}\n       -> ${c.to}\n`);
  for (const f of r.followed) out.write(`  follow  ${f.from}\n       -> ${f.to}\n`);
  for (const d of r.deferred) out.write(`  defer   ${d.from}: ${d.reason}\n`);
  for (const s of r.skipped) out.write(`  skip    ${s.from}: ${s.reason}\n`);
  for (const l of r.left) out.write(`  left    ${l.at}: ${l.reason}\n`);
  out.write('\n');
}
