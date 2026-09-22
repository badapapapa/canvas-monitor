/**
 * The local one-way mirror (DECISIONS.md D-58): copies files archived AFTER a
 * baseline from the archive's synced folder into my own NUS folders.
 *
 *   source       <archiveRoot>/<term>/<module>/<folder>/<name>
 *   destination  <destinationRoot>/<term folder>/<module folder>/<subfolder>/<folder>/<name>
 *
 * Rules, each enforced here or by MirrorGuard:
 *   1. The first run only records a baseline: every archived file is "seen",
 *      nothing is copied. It needs --baseline, given deliberately.
 *   2. Files are identified by the archive's own id (files.id, derived from
 *      the Canvas file id), never by path. A baselined file that is re-routed
 *      later is still baselined, and is never copied.
 *   3. One-way: the archive is only ever read.
 *   4. Nothing in the destination is ever deleted or overwritten. A taken name
 *      gets " (2)", " (3)"...; an identical file already there is recorded.
 *   5. Writes only inside the "Downloaded from Canvas" folders (MirrorGuard).
 *   6. The archive's folders are kept, custom ones included.
 *   7. .DS_Store is never copied.
 *   8. A copy the mirror made follows its file when the archive re-routes it --
 *      only if the copy is byte-identical to what the mirror wrote (SHA-256).
 *      A copy I have changed, moved or deleted is left exactly as it is.
 *
 * The source is verified against the archive's recorded SHA-256 before any
 * copy, which also catches OneDrive files that are online-only and not yet
 * downloaded, or still syncing: those are deferred to the next run.
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { copyFile, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { splitExtension } from '../archive/filename.ts';
import type { MirrorGuard } from './guard.ts';

export interface ArchiveFile {
  /** The archive's identity for this file (files.id). */
  id: string;
  canvasFileId: number;
  /** "<term>/<module>/<folder>/<name>", as archived. */
  targetPath: string;
  sha256: string;
}

export interface MirrorEntry {
  status: 'baselined' | 'copied';
  canvasFileId: number;
  /** The archive path when this entry was last reconciled. */
  archivePath: string;
  copiedTo?: string;
  copiedSha256?: string;
  at: string;
  note?: string;
}

export interface MirrorState {
  version: 1;
  baselineAt: string;
  entries: Record<string, MirrorEntry>;
}

export interface MirrorReport {
  mode: 'baseline' | 'run';
  dryRun: boolean;
  baselined: number;
  copied: Array<{ id: string; from: string; to: string }>;
  adopted: Array<{ id: string; to: string }>;
  deferred: Array<{ id: string; from: string; reason: string }>;
  skipped: Array<{ id: string; from: string; reason: string }>;
  followed: Array<{ id: string; from: string; to: string }>;
  left: Array<{ id: string; at: string; reason: string }>;
}

export interface MirrorDeps {
  archiveRoot: string;
  guard: MirrorGuard;
  files: readonly ArchiveFile[];
  state: MirrorState | null;
  mode: 'baseline' | 'run';
  dryRun: boolean;
  now: () => Date;
  /** Local scratch, outside OneDrive, for staging a copy before it lands. */
  tmpDir: string;
  saveState: (state: MirrorState) => void;
  /** Per-file read timeout: an online-only file that will not download in time is deferred. */
  readTimeoutMs?: number;
}

export class MirrorRefusal extends Error {}

const MAX_NAME_VARIANTS = 9;

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

/** Stream `src` to `dst` hashing as it goes; a stalled read (online-only file, offline Mac) aborts. */
async function stageCopy(src: string, dst: string, timeoutMs: number): Promise<string> {
  const hash = createHash('sha256');
  const tap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(createReadStream(src), tap, createWriteStream(dst, { flags: 'wx' }), { signal: AbortSignal.timeout(timeoutMs) });
  return hash.digest('hex');
}

function variant(dest: string, n: number): string {
  const { stem, ext } = splitExtension(path.basename(dest));
  return path.join(path.dirname(dest), `${stem} (${n})${ext}`);
}

export async function runMirror(deps: MirrorDeps): Promise<MirrorReport> {
  const { guard, files, dryRun } = deps;
  const report: MirrorReport = { mode: deps.mode, dryRun, baselined: 0, copied: [], adopted: [], deferred: [], skipped: [], followed: [], left: [] };
  const at = deps.now().toISOString();

  // --- 1. Baseline.
  if (deps.mode === 'baseline' || deps.state === null) {
    if (deps.mode === 'baseline' && deps.state !== null) throw new MirrorRefusal('a baseline already exists; the mirror never re-baselines over its own history');
    if (deps.mode === 'run' && !dryRun) throw new MirrorRefusal('no baseline yet: run once with --baseline (it copies nothing)');
    const state: MirrorState = { version: 1, baselineAt: at, entries: {} };
    for (const f of files) state.entries[f.id] = { status: 'baselined', canvasFileId: f.canvasFileId, archivePath: f.targetPath, at };
    report.baselined = files.length;
    if (!dryRun) deps.saveState(state);
    return report;
  }

  const state = deps.state;
  const byId = new Map(files.map((f) => [f.id, f]));

  // --- 2. New files: identity is the archive id, never the path.
  for (const f of files) {
    if (state.entries[f.id] !== undefined) continue;
    const segs = f.targetPath.split('/');
    if (segs.length < 3 || segs.some((s) => s === '' || s === '.' || s === '..')) {
      report.skipped.push({ id: f.id, from: f.targetPath, reason: 'not a <term>/<module>/... path' });
      continue;
    }
    if (segs[segs.length - 1] === '.DS_Store') continue;
    const subtree = guard.subtreeFor(segs[0]!, segs[1]!);
    if (subtree === null) {
      report.skipped.push({ id: f.id, from: f.targetPath, reason: 'term or module not in the mapping' });
      continue;
    }
    if (!existsSync(path.dirname(subtree))) {
      report.skipped.push({ id: f.id, from: f.targetPath, reason: `module folder missing: ${path.dirname(subtree)}` });
      continue;
    }
    const src = guard.readable(path.join(deps.archiveRoot, ...segs));
    let dest = guard.writable(path.join(subtree, ...segs.slice(2)));
    if (!existsSync(src)) {
      report.deferred.push({ id: f.id, from: f.targetPath, reason: 'not on this Mac yet' });
      continue;
    }
    if (dryRun) {
      report.copied.push({ id: f.id, from: f.targetPath, to: dest });
      continue;
    }

    mkdirSync(deps.tmpDir, { recursive: true });
    const staged = path.join(deps.tmpDir, `${f.id}.part`);
    rmSync(staged, { force: true }); // our own scratch file, outside OneDrive
    let hash: string;
    try {
      hash = await stageCopy(src, staged, deps.readTimeoutMs ?? 120_000);
    } catch (error) {
      rmSync(staged, { force: true });
      report.deferred.push({ id: f.id, from: f.targetPath, reason: `could not read the source (online-only and offline, or syncing): ${error instanceof Error ? error.message : String(error)}` });
      continue;
    }
    if (hash !== f.sha256) {
      rmSync(staged, { force: true });
      report.deferred.push({ id: f.id, from: f.targetPath, reason: 'source does not match the archive yet (still syncing?)' });
      continue;
    }

    // Never overwrite: an identical file already there is recorded; a
    // different one keeps its name and ours takes the next free variant.
    let adopted = false;
    for (let n = 2; existsSync(dest); n += 1) {
      if (sha256Of(dest) === f.sha256) {
        adopted = true;
        break;
      }
      if (n > MAX_NAME_VARIANTS + 1) break;
      dest = guard.writable(variant(path.join(subtree, ...segs.slice(2)), n));
    }
    if (existsSync(dest) && !adopted) {
      rmSync(staged, { force: true });
      report.skipped.push({ id: f.id, from: f.targetPath, reason: `every name up to (${MAX_NAME_VARIANTS + 1}) is taken` });
      continue;
    }
    if (!adopted) {
      const dir = path.dirname(dest);
      if (dir !== subtree) guard.writable(dir);
      mkdirSync(dir, { recursive: true });
      await copyFile(staged, dest, fsConstants.COPYFILE_EXCL); // fails rather than overwrite
      if (sha256Of(dest) !== f.sha256) throw new Error(`copy verification failed at ${dest}`);
    }
    rmSync(staged, { force: true });
    state.entries[f.id] = { status: 'copied', canvasFileId: f.canvasFileId, archivePath: f.targetPath, copiedTo: dest, copiedSha256: f.sha256, at };
    deps.saveState(state); // after every copy: a crash never forgets one
    if (adopted) report.adopted.push({ id: f.id, to: dest });
    else report.copied.push({ id: f.id, from: f.targetPath, to: dest });
  }

  // --- 3. Follow re-routes of the mirror's OWN copies, if untouched.
  for (const [id, entry] of Object.entries(state.entries)) {
    const f = byId.get(id);
    if (entry.status !== 'copied' || f === undefined || f.targetPath === entry.archivePath || entry.copiedTo === undefined) continue;
    const segs = f.targetPath.split('/');
    const subtree = guard.subtreeFor(segs[0]!, segs[1]!);
    const from = entry.copiedTo;
    const leave = (reason: string) => {
      report.left.push({ id, at: from, reason });
      if (!dryRun) {
        entry.archivePath = f.targetPath;
        entry.note = reason;
        deps.saveState(state);
      }
    };
    if (subtree === null) {
      leave('the new archive location is not in the mapping');
      continue;
    }
    const to = guard.writable(path.join(subtree, ...segs.slice(2)));
    if (!existsSync(from)) {
      leave('your copy is no longer where the mirror put it; left alone');
      continue;
    }
    guard.writable(from);
    if (sha256Of(from) !== entry.copiedSha256) {
      leave('you have changed this copy; it stays where it is');
      continue;
    }
    if (existsSync(to)) {
      leave('the new location already has a file of that name; nothing moved');
      continue;
    }
    if (dryRun) {
      report.followed.push({ id, from, to });
      continue;
    }
    const dir = path.dirname(to);
    if (dir !== subtree) guard.writable(dir);
    mkdirSync(dir, { recursive: true });
    renameSync(from, to);
    entry.copiedTo = to;
    entry.archivePath = f.targetPath;
    entry.at = at;
    deps.saveState(state);
    report.followed.push({ id, from, to });
  }
  return report;
}

// --- state file -------------------------------------------------------------

export function loadState(file: string): MirrorState | null {
  if (!existsSync(file)) return null;
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as MirrorState;
  if (parsed.version !== 1 || typeof parsed.entries !== 'object') throw new Error(`unrecognised mirror state in ${file}`);
  return parsed;
}

/** Atomic: write a temp file beside it, then rename over. The state lives in var/, never in OneDrive. */
export function saveStateFile(file: string, state: MirrorState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 1)}\n`);
  renameSync(tmp, file);
}
