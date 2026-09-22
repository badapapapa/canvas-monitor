/**
 * The local mirror (DECISIONS.md D-58), on temporary folders standing in for
 * the archive's synced folder and my own module folders.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MirrorGuard, MirrorGuardError, type MirrorRoots } from '../../src/mirror/guard.ts';
import { MirrorRefusal, runMirror, type ArchiveFile, type MirrorState } from '../../src/mirror/mirror.ts';

const temps: string[] = [];
after(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

/** Every file and folder under `dir`, with content hashes: to prove what did not change. */
function snapshot(dir: string, skip: (p: string) => boolean = () => false): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      const p = path.join(d, name);
      if (skip(p)) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out.push(`d ${path.relative(dir, p)}`);
        walk(p);
      } else out.push(`f ${path.relative(dir, p)} ${st.isSymbolicLink() ? 'link' : sha(readFileSync(p)).slice(0, 12)}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

function world() {
  const base = mkdtempSync(path.join(tmpdir(), 'mirror-'));
  temps.push(base);
  const archiveRoot = path.join(base, 'OneDrive', 'Apps', 'Canvas Archive');
  const destinationRoot = path.join(base, 'OneDrive', 'Uni');
  for (const m of ['ab1234', 'cd5678']) mkdirSync(path.join(destinationRoot, 'year2-sem1', m), { recursive: true });
  // My own files, which must never change.
  writeFileSync(path.join(destinationRoot, 'year2-sem1', 'ab1234', 'my notes.md'), 'MINE');
  mkdirSync(path.join(destinationRoot, 'year2-sem1', 'ab1234', 'Lectures'));
  writeFileSync(path.join(destinationRoot, 'year2-sem1', 'ab1234', 'Lectures', 'L1.pdf'), 'MY HAND DOWNLOAD');
  const roots: MirrorRoots = { archiveRoot, destinationRoot, subfolder: 'Downloaded from Canvas', terms: { '2610': 'year2-sem1' }, modules: { AB1234: 'ab1234', CD5678: 'cd5678' } };
  const files: ArchiveFile[] = [];
  let state: MirrorState | null = null;
  const archive = (id: string, targetPath: string, content: string): ArchiveFile => {
    const p = path.join(archiveRoot, ...targetPath.split('/'));
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, content);
    const f = { id, canvasFileId: Number(id.replace(/\D/g, '') || 1), targetPath, sha256: sha(content) };
    files.push(f);
    return f;
  };
  /** The archive re-routes a file: it moves on disk and its row changes. */
  const reroute = (id: string, to: string) => {
    const f = files.find((x) => x.id === id)!;
    const from = path.join(archiveRoot, ...f.targetPath.split('/'));
    const dest = path.join(archiveRoot, ...to.split('/'));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(from));
    rmSync(from);
    f.targetPath = to;
  };
  const run = (opts: { mode?: 'baseline' | 'run'; dryRun?: boolean } = {}) =>
    runMirror({
      archiveRoot, guard: new MirrorGuard(roots), files: [...files], state, mode: opts.mode ?? 'run', dryRun: opts.dryRun ?? false,
      now: () => new Date('2026-09-22T10:00:00Z'), tmpDir: path.join(base, 'var', 'mirror', 'tmp'),
      saveState: (s) => void (state = structuredClone(s)),
    });
  const sub = (m = 'ab1234') => path.join(destinationRoot, 'year2-sem1', m, 'Downloaded from Canvas');
  const outside = () => snapshot(base, (p) => p.includes(`${path.sep}Downloaded from Canvas`) || p.startsWith(path.join(base, 'var')));
  return { base, roots, archiveRoot, destinationRoot, files, archive, reroute, run, sub, outside, getState: () => state, setState: (s: MirrorState | null) => void (state = s) };
}

describe('mirror: baseline first', () => {
  it('records every archived file as seen and copies nothing', async () => {
    const w = world();
    w.archive('f1', '2610/AB1234/Lectures/L1.pdf', 'lecture one');
    w.archive('f2', '2610/AB1234/_unsorted/T1.pdf', 'tutorial one');
    const before = snapshot(w.base);
    const report = await w.run({ mode: 'baseline' });
    assert.equal(report.baselined, 2);
    assert.equal(snapshot(w.base), before, 'not a byte written anywhere');
    assert.deepEqual(Object.keys(w.getState()!.entries).sort(), ['f1', 'f2']);
  });

  it('refuses a real run with no baseline, and a second baseline', async () => {
    const w = world();
    w.archive('f1', '2610/AB1234/Lectures/L1.pdf', 'x');
    await assert.rejects(() => w.run(), MirrorRefusal);
    await w.run({ mode: 'baseline' });
    await assert.rejects(() => w.run({ mode: 'baseline' }), MirrorRefusal);
  });

  it('previews the baseline under --dry-run and saves nothing', async () => {
    const w = world();
    w.archive('f1', '2610/AB1234/Lectures/L1.pdf', 'x');
    const report = await w.run({ dryRun: true });
    assert.equal(report.baselined, 1);
    assert.equal(w.getState(), null);
  });
});

describe('mirror: new files only, by archive identity', () => {
  it('copies a file archived after the baseline, keeping the archive folder, custom folders included', async () => {
    const w = world();
    w.archive('f1', '2610/AB1234/Lectures/L1.pdf', 'lecture one');
    await w.run({ mode: 'baseline' });
    w.archive('f3', '2610/AB1234/Harbour Case Study/case.pdf', 'case study');
    w.archive('f4', '2610/CD5678/Tutorials/T2.pdf', 'tutorial two');
    const before = w.outside();
    const report = await w.run();
    assert.equal(report.copied.length, 2);
    assert.equal(readFileSync(path.join(w.sub(), 'Harbour Case Study', 'case.pdf'), 'utf8'), 'case study');
    assert.equal(readFileSync(path.join(w.sub('cd5678'), 'Tutorials', 'T2.pdf'), 'utf8'), 'tutorial two');
    assert.equal(w.outside(), before, 'nothing outside the subfolders changed, the archive included');
  });

  it('never treats a re-routed baselined file as new', async () => {
    const w = world();
    w.archive('f2', '2610/AB1234/_unsorted/T1.pdf', 'tutorial one');
    await w.run({ mode: 'baseline' });
    w.reroute('f2', '2610/AB1234/Tutorials/T1.pdf');
    const report = await w.run();
    assert.deepEqual([report.copied.length, report.followed.length], [0, 0]);
    assert.equal(existsSync(w.sub()), false, 'not even the subfolder was created');
  });

  it('never overwrites: a different file keeps its name; an identical one is just recorded', async () => {
    const w = world();
    await w.run({ mode: 'baseline' });
    mkdirSync(path.join(w.sub(), 'Tutorials'), { recursive: true });
    writeFileSync(path.join(w.sub(), 'Tutorials', 'T1.pdf'), 'MY ANNOTATED COPY');
    writeFileSync(path.join(w.sub(), 'Tutorials', 'T2.pdf'), 'tutorial two');
    w.archive('f5', '2610/AB1234/Tutorials/T1.pdf', 'tutorial one');
    w.archive('f6', '2610/AB1234/Tutorials/T2.pdf', 'tutorial two');
    const report = await w.run();
    assert.equal(readFileSync(path.join(w.sub(), 'Tutorials', 'T1.pdf'), 'utf8'), 'MY ANNOTATED COPY');
    assert.equal(readFileSync(path.join(w.sub(), 'Tutorials', 'T1 (2).pdf'), 'utf8'), 'tutorial one');
    assert.deepEqual(report.adopted.map((a) => path.basename(a.to)), ['T2.pdf']);
  });

  it('defers a file not yet on this Mac, or not matching the archive yet, and copies it later', async () => {
    const w = world();
    await w.run({ mode: 'baseline' });
    const f = w.archive('f7', '2610/AB1234/Labs/lab.pdf', 'final bytes');
    const onDisk = path.join(w.archiveRoot, '2610', 'AB1234', 'Labs', 'lab.pdf');
    writeFileSync(onDisk, 'half-synced');
    assert.equal((await w.run()).deferred.length, 1);
    rmSync(onDisk);
    assert.match((await w.run()).deferred[0]?.reason ?? '', /not on this Mac/);
    writeFileSync(onDisk, 'final bytes');
    assert.equal((await w.run()).copied.length, 1);
    assert.equal(sha(readFileSync(path.join(w.sub(), 'Labs', 'lab.pdf'))), f.sha256);
  });

  it('skips unmapped modules and never copies .DS_Store', async () => {
    const w = world();
    await w.run({ mode: 'baseline' });
    w.archive('f8', '2610/ZZ9999/Lectures/x.pdf', 'x');
    w.archive('f9', '2610/AB1234/Lectures/.DS_Store', 'finder junk');
    const report = await w.run();
    assert.equal(report.copied.length, 0);
    assert.match(report.skipped[0]?.reason ?? '', /not in the mapping/);
    assert.equal(existsSync(w.sub()), false);
  });

  it('writes nothing at all under --dry-run', async () => {
    const w = world();
    await w.run({ mode: 'baseline' });
    const state = structuredClone(w.getState());
    w.archive('f3', '2610/AB1234/Lectures/L3.pdf', 'three');
    const before = snapshot(w.base);
    const report = await w.run({ dryRun: true });
    assert.equal(report.copied.length, 1);
    assert.equal(snapshot(w.base), before);
    assert.deepEqual(w.getState(), state);
  });
});

describe('mirror: following re-routes of its own untouched copies (rule 8)', () => {
  async function copiedThenRerouted(modify: boolean) {
    const w = world();
    await w.run({ mode: 'baseline' });
    w.archive('f10', '2610/AB1234/_unsorted/notes.pdf', 'notes');
    await w.run();
    const copy = path.join(w.sub(), '_unsorted', 'notes.pdf');
    if (modify) writeFileSync(copy, 'notes + MY ANNOTATIONS');
    w.reroute('f10', '2610/AB1234/Readings/notes.pdf');
    return { w, copy, report: await w.run() };
  }

  it('moves an unchanged copy to match', async () => {
    const { w, copy, report } = await copiedThenRerouted(false);
    assert.equal(report.followed.length, 1);
    assert.equal(existsSync(copy), false);
    assert.equal(readFileSync(path.join(w.sub(), 'Readings', 'notes.pdf'), 'utf8'), 'notes');
  });

  it('never touches a copy I have changed', async () => {
    const { w, copy, report } = await copiedThenRerouted(true);
    assert.equal(report.followed.length, 0);
    assert.match(report.left[0]?.reason ?? '', /changed this copy/);
    assert.equal(readFileSync(copy, 'utf8'), 'notes + MY ANNOTATIONS');
    assert.equal(existsSync(path.join(w.sub(), 'Readings', 'notes.pdf')), false);
  });
});

describe('mirror guard: writes only inside the "Downloaded from Canvas" folders', () => {
  it('refuses every path outside them, including via symlinks and into the archive', () => {
    const w = world();
    mkdirSync(w.archiveRoot, { recursive: true });
    const g = new MirrorGuard(w.roots);
    const sub = w.sub();
    mkdirSync(sub, { recursive: true });
    symlinkSync(w.archiveRoot, path.join(sub, 'sneaky-link'));
    symlinkSync(path.join(w.destinationRoot, 'year2-sem1', 'ab1234'), path.join(sub, 'up-link'));
    const refusedPaths = [
      path.join(w.destinationRoot, 'year2-sem1', 'ab1234', 'my notes.md'), // my module folder
      path.join(w.destinationRoot, 'year2-sem1', 'ab1234', 'Lectures', 'L1.pdf'), // my own category folder
      sub, // the subfolder itself (only things inside it)
      path.join(w.destinationRoot, 'year2-sem1', 'zz9999', 'Downloaded from Canvas', 'x.pdf'), // unmapped module
      path.join(w.destinationRoot, 'year2-sem1', 'ab1234', 'Downloaded from Canvas2', 'x.pdf'), // look-alike
      path.join(sub, '..', 'escape.pdf'),
      path.join(sub, 'Lectures', '..', '..', 'escape.pdf'),
      path.join(w.archiveRoot, '2610', 'AB1234', 'x.pdf'), // the archive
      path.join(sub, 'sneaky-link', 'x.pdf'), // symlink into the archive
      path.join(sub, 'up-link', 'x.pdf'), // symlink back out to my folder
      path.join(sub, 'Lectures', '.DS_Store'),
      '/tmp/elsewhere.pdf',
    ];
    for (const p of refusedPaths) assert.throws(() => g.writable(p), MirrorGuardError, p);
    assert.doesNotThrow(() => g.writable(path.join(sub, 'Lectures', 'L2.pdf')));
    assert.doesNotThrow(() => g.writable(path.join(sub, 'Harbour Case Study', 'x.pdf')));
  });

  it('refuses a configuration where the destination overlaps the archive', () => {
    const w = world();
    assert.throws(() => new MirrorGuard({ ...w.roots, destinationRoot: path.join(w.archiveRoot, 'inside') }), MirrorGuardError);
    assert.throws(() => new MirrorGuard({ ...w.roots, subfolder: '../x' }), MirrorGuardError);
    assert.throws(() => new MirrorGuard({ ...w.roots, modules: { AB1234: '../../x' } }), MirrorGuardError);
  });

  it('leaves the archive byte-identical through baseline, copies and follows', async () => {
    const w = world();
    w.archive('f1', '2610/AB1234/_unsorted/a.pdf', 'a');
    await w.run({ mode: 'baseline' });
    w.archive('f2', '2610/AB1234/_unsorted/b.pdf', 'b');
    await w.run();
    const archiveBefore = snapshot(w.archiveRoot);
    const statBefore = statSync(path.join(w.archiveRoot, '2610', 'AB1234', '_unsorted', 'b.pdf')).mtimeMs;
    await w.run();
    assert.equal(snapshot(w.archiveRoot), archiveBefore);
    assert.equal(statSync(path.join(w.archiveRoot, '2610', 'AB1234', '_unsorted', 'b.pdf')).mtimeMs, statBefore);
  });
});
