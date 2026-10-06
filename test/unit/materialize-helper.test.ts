/**
 * The materialize helper's C source (DECISIONS.md D-77), compiled and run:
 * it reads files through and writes nothing, refuses a symlink, and says so
 * by exit code. Skipped where Apple's compiler is not available.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'materialize-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const bin = path.join(dir, 'materialize');
const built = process.platform === 'darwin' &&
  spawnSync('xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', '-o', bin, 'native/materialize.c'], { stdio: 'ignore' }).status === 0;

describe('materialize helper', { skip: built ? false : 'needs macOS and xcrun clang' }, () => {
  it('reads each file through and changes nothing', () => {
    const a = path.join(dir, 'a.pdf');
    writeFileSync(a, Buffer.alloc(200_000, 7));
    const before = statSync(a).mtimeMs;
    const r = spawnSync(bin, [a], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(statSync(a).mtimeMs, before);
    assert.equal(readFileSync(a).length, 200_000);
  });

  it('refuses to follow a symlink, never prints a path, and says which file failed by number only', () => {
    const target = path.join(dir, 'target.pdf');
    writeFileSync(target, 'x');
    const link = path.join(dir, 'link.pdf');
    symlinkSync(target, link);
    const r = spawnSync(bin, [link], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /file 1: open:/);
    assert.ok(!r.stderr.includes(dir), 'no path printed');
  });

  it('exit codes: 1 when a file cannot be read, 2 for no arguments', () => {
    assert.equal(spawnSync(bin, [path.join(dir, 'missing.pdf')]).status, 1);
    assert.equal(spawnSync(bin, []).status, 2);
  });

  it('the source allows materialization for itself only, and opens read-only, never following links', () => {
    const c = readFileSync('native/materialize.c', 'utf8');
    assert.match(c, /setiopolicy_np\(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS,\s*IOPOL_MATERIALIZE_DATALESS_FILES_ON\)/);
    assert.match(c, /open\(argv\[i\], O_RDONLY \| O_NOFOLLOW \| O_CLOEXEC\)/);
    assert.doesNotMatch(c, /\b(write|unlink|rename|O_WRONLY|O_RDWR|O_CREAT|system|exec[lv]p?)\s*\(/, 'nothing that writes, deletes or runs');
  });
});
