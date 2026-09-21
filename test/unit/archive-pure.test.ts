import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alternateName, collisionKey, fitPath, safeSegment, splitExtension } from '../../src/archive/filename.ts';
import { route } from '../../src/archive/route.ts';
import { GuardError, RequestGuard, rootedPath, SCOPES, type RootSpec } from '../../src/graph/guard.ts';

describe('filename sanitising (SPEC.md section 5, required by section 15)', () => {
  it('strips every character Windows or OneDrive forbids', () => {
    assert.equal(safeSegment('a\\b/c:d*e?f"g<h>i|j.pdf'), 'a_b_c_d_e_f_g_h_i_j.pdf');
  });

  it('drops control characters', () => {
    const withControls = `Lab${String.fromCharCode(7)}${String.fromCharCode(0)} 04.pdf`;
    assert.equal(safeSegment(withControls), 'Lab 04.pdf');
  });

  it('trims trailing dots and spaces, which Windows silently removes', () => {
    assert.equal(safeSegment('Notes. . '), 'Notes');
    assert.equal(safeSegment('Slides ..pdf'), 'Slides ..pdf', 'a real extension survives');
  });

  it('renames Windows reserved device names, with or without an extension', () => {
    assert.equal(safeSegment('CON'), 'CON_');
    assert.equal(safeSegment('con.txt'), 'con_.txt');
    assert.equal(safeSegment('LPT9.pdf'), 'LPT9_.pdf');
    assert.equal(safeSegment('CONSOLE.pdf'), 'CONSOLE.pdf', 'only the exact stems are reserved');
  });

  it('normalises Unicode to NFC, so visually equal names collide as they should', () => {
    const decomposed = 'Cafe\u0301.pdf'; // e + combining acute
    const composed = 'Caf\u00e9.pdf';
    assert.equal(safeSegment(decomposed), composed);
    assert.equal(collisionKey(decomposed), collisionKey(composed));
  });

  it('compares case-insensitively, as OneDrive and Windows do', () => {
    assert.equal(collisionKey('Lecture 06.PDF'), collisionKey('lecture 06.pdf'));
  });

  it('never produces an empty, "." or ".." segment', () => {
    for (const raw of ['', '   ', '.', '..', '...', '???']) {
      const out = safeSegment(raw);
      assert.ok(out !== '' && out !== '.' && out !== '..', `${JSON.stringify(raw)} became ${JSON.stringify(out)}`);
    }
  });

  it('truncates the stem and always keeps the extension', () => {
    const long = `${'Very Long Lecture Title '.repeat(10)}.pptx`;
    const out = safeSegment(long, 60);
    assert.ok(out.length <= 60);
    assert.ok(out.endsWith('.pptx'));
  });

  it('only treats a short plain suffix as an extension', () => {
    assert.deepEqual(splitExtension('Lab 03.pdf'), { stem: 'Lab 03', ext: '.pdf' });
    assert.deepEqual(splitExtension('Report v1.2 final'), { stem: 'Report v1.2 final', ext: '' });
    assert.deepEqual(splitExtension('.env'), { stem: '.env', ext: '' });
  });

  it('names a colliding upload by its Canvas date, never replacing', () => {
    assert.equal(alternateName('Lab 04.pdf', '2026-09-18', 1), 'Lab 04 (uploaded 2026-09-18).pdf');
    assert.equal(alternateName('Lab 04.pdf', '2026-09-18', 2), 'Lab 04 (uploaded 2026-09-18 2).pdf');
  });

  it('keeps a whole path under the length budget', () => {
    const out = fitPath(['2610', 'AB1234', 'Lectures'], `${'x'.repeat(300)}.pdf`, 200);
    assert.ok(out.join('/').length <= 200);
    assert.ok((out[3] ?? '').endsWith('.pdf'));
  });
});

describe('routing seed defaults (SPEC.md section 8, D-40)', () => {
  const r = (folder: string | null, fileName: string, module: string | null = null) =>
    route({ contextType: 'course', folder, module, fileName });

  it('routes by folder first', () => {
    assert.equal(r('Weekly Learning Materials/Week 06/Lecture Notes', 'x.pdf').category, 'Lectures');
    assert.equal(r('Weekly Learning Materials/Week 05/Practical Lab', 'Lab 03 - Suggested Solutions.pdf').category, 'Labs');
    assert.equal(r('Tutorials', 'T6.pdf').category, 'Tutorials');
    assert.equal(r('Readings', 'paper.pdf').category, 'Readings');
  });

  it('matches on word boundaries, not substrings', () => {
    assert.equal(r('Institute Materials', 'x.pdf').category, '_unsorted', '"tut" inside "Institute" is not a tutorial');
    assert.equal(r('Collaboration', 'x.pdf').category, '_unsorted', '"lab" inside "Collaboration" is not a lab');
  });

  it('uses the module name when there is no folder (Modules fallback)', () => {
    const d = r(null, 'x.pdf', 'Week 6 Tutorial');
    assert.equal(d.category, 'Tutorials');
    assert.equal(d.confidence, 0.8);
  });

  it('uses the filename only for assignments and projects', () => {
    assert.equal(r('unfiled', 'Assignment 3 brief.pdf').category, 'Assignments');
    assert.equal(r('unfiled', 'Lecture 3.pdf').category, '_unsorted', 'filename never routes lectures');
  });

  it('sends everything unmatched to _unsorted, the only re-routable placement', () => {
    const d = r('unfiled', 'Midterm revision.pdf');
    assert.equal(d.category, '_unsorted');
    assert.equal(d.reroutable, true);
    assert.equal(r('Lectures', 'x.pdf').reroutable, false);
  });

  it('files group documents under Group, whatever their folder says', () => {
    assert.equal(route({ contextType: 'group', folder: 'Lecture copies', module: null, fileName: 'x.pdf' }).category, 'Group');
  });
});

// --- the confinement guard ---------------------------------------------------

const G = 'https://graph.microsoft.com/v1.0';
const APP: RootSpec = { mode: 'appfolder' };
const FOLDER: RootSpec = { mode: 'folder', name: 'Canvas Archive' };
const auth = { authorization: 'Bearer x' };
const refused = (guard: RequestGuard, method: string, url: string, body?: unknown, headers: Record<string, string> = auth) =>
  assert.throws(
    () => guard.check({ method, url, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }),
    GuardError,
    `${method} ${url} should have been refused`,
  );
const allowed = (guard: RequestGuard, method: string, url: string, body?: unknown, headers: Record<string, string> = auth) =>
  assert.doesNotThrow(() =>
    guard.check({ method, url, headers, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) }),
  );
const session = (name: string) => ({ item: { '@microsoft.graph.conflictBehavior': 'fail', name } });
const folder = (name: string) => ({ name, folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
const FAIL = '?%40microsoft.graph.conflictBehavior=fail';

describe('OneDrive guard: what is allowed', () => {
  for (const root of [APP, FOLDER]) {
    const guard = new RequestGuard({ root });
    const p = (segs: string[], action?: 'children' | 'createUploadSession') => `${G}${rootedPath(root, segs, action)}`;

    it(`[${root.mode}] reads the root, an item under it, and the quota`, () => {
      allowed(guard, 'GET', p([]));
      allowed(guard, 'GET', p(['2610', 'AB1234', 'Labs', 'Lab 04.pdf']));
      allowed(guard, 'GET', `${G}/me/drive?%24select=quota,driveType`);
    });

    it(`[${root.mode}] creates folders and upload sessions that fail on conflict`, () => {
      allowed(guard, 'POST', `${p([], 'children')}${FAIL}`, folder('2610'));
      allowed(guard, 'POST', `${p(['2610'], 'children')}${FAIL}`, folder('AB1234'));
      allowed(guard, 'POST', `${p(['2610', 'AB1234', 'Labs', 'Lab 04.pdf'], 'createUploadSession')}${FAIL}`, session('Lab 04.pdf'));
    });
  }

  it('lets folder mode create its own root folder in the drive root, and nothing else there', () => {
    const guard = new RequestGuard({ root: FOLDER });
    allowed(guard, 'POST', `${G}/me/drive/root/children${FAIL}`, folder('Canvas Archive'));
    refused(guard, 'POST', `${G}/me/drive/root/children${FAIL}`, folder('Documents'));
  });

  it('writes to an upload URL Graph issued, and only without a bearer token', () => {
    const guard = new RequestGuard({ root: APP });
    const upload = 'https://api.onedrive.com/up/abc123';
    refused(guard, 'PUT', upload, 'bytes', {});
    guard.registerUploadUrl(upload);
    allowed(guard, 'PUT', upload, 'bytes', {});
    allowed(guard, 'GET', upload, undefined, {});
    refused(guard, 'PUT', upload, 'bytes', auth);
    refused(guard, 'DELETE', upload, undefined, {});
  });

  it('signs in through /consumers only, with exactly the configured scope', () => {
    const guard = new RequestGuard({ root: APP });
    const L = 'https://login.microsoftonline.com';
    allowed(guard, 'POST', `${L}/consumers/oauth2/v2.0/token`, `grant_type=refresh_token&scope=${encodeURIComponent(SCOPES.appfolder)}`);
    allowed(guard, 'POST', `${L}/consumers/oauth2/v2.0/devicecode`, `scope=${encodeURIComponent(SCOPES.appfolder)}`);
    refused(guard, 'POST', `${L}/organizations/oauth2/v2.0/token`, 'grant_type=refresh_token', {});
    refused(guard, 'POST', `${L}/common/oauth2/v2.0/token`, 'grant_type=refresh_token', {});
    refused(guard, 'POST', `${L}/consumers/oauth2/v2.0/token`, `scope=${encodeURIComponent(SCOPES.folder)}`, {});
  });
});

describe('OneDrive guard: every way out is refused', () => {
  const app = new RequestGuard({ root: APP });
  const fold = new RequestGuard({ root: FOLDER });

  it('refuses anything outside the root', () => {
    refused(app, 'GET', `${G}/me/drive/root`);
    refused(app, 'GET', `${G}/me/drive/root:/Documents/Taxes 2025.pdf`);
    refused(app, 'GET', `${G}/me/drive/root/children`);
    refused(app, 'GET', `${G}/me/drive/special/documents`);
    refused(fold, 'GET', `${G}/me/drive/root:/Canvas Archive Backup/x.pdf`, undefined);
    refused(fold, 'GET', `${G}/me/drive/root:/Documents`);
    refused(app, 'GET', `${G}/me/drives/abc/root`);
    refused(app, 'GET', `${G}/users/someone/drive`);
  });

  it('refuses item-id addressing, which can name anything in the drive', () => {
    refused(app, 'GET', `${G}/me/drive/items/ABC123`);
    refused(app, 'POST', `${G}/me/drive/items/ABC123:/x.pdf:/createUploadSession${FAIL}`, session('x.pdf'));
  });

  it('refuses every write verb, even inside the root', () => {
    const inside = `${G}${rootedPath(APP, ['2610', 'AB1234', 'Labs', 'Lab 04.pdf'])}`;
    refused(app, 'PUT', `${inside}:/content`, 'bytes');
    refused(app, 'PUT', inside, 'bytes');
    refused(app, 'PATCH', inside, { name: 'renamed.pdf' });
    refused(app, 'PATCH', inside, { parentReference: { path: '/drive/root:/Documents' } });
    refused(app, 'DELETE', inside);
  });

  it('refuses path traversal in every spelling', () => {
    const base = `${G}/me/drive/special/approot:/`;
    for (const trick of ['..', '../Documents', '2610/../../Documents', '%2e%2e', '%2E%2E/Documents', '2610%2F..%2F..', '.', 'a//b', '2610/%2e%2e/x']) {
      refused(app, 'GET', `${base}${trick}`);
    }
  });

  it('refuses non-canonical and unsafe segments', () => {
    const base = `${G}/me/drive/special/approot:/`;
    refused(app, 'GET', `${base}a%5Cb`, undefined); // backslash
    refused(app, 'GET', `${base}CON`, undefined); // reserved name, not canonical-safe
    refused(app, 'GET', `${base}Lab%2004.pdf`.replace('%20', '%20').replace('Lab', 'L%61b')); // alternative encoding of "a"
  });

  it('refuses an upload that could replace, rename, or defer', () => {
    const url = `${G}${rootedPath(APP, ['x.pdf'], 'createUploadSession')}`;
    refused(app, 'POST', `${url}${FAIL}`, { item: { '@microsoft.graph.conflictBehavior': 'replace', name: 'x.pdf' } });
    refused(app, 'POST', `${url}${FAIL}`, { item: { '@microsoft.graph.conflictBehavior': 'rename', name: 'x.pdf' } });
    refused(app, 'POST', `${url}${FAIL}`, { item: { name: 'x.pdf' } });
    refused(app, 'POST', url, session('x.pdf')); // missing the URL-level fail
    refused(app, 'POST', `${url}?%40microsoft.graph.conflictBehavior=replace`, session('x.pdf'));
    refused(app, 'POST', `${url}${FAIL}`, session('other.pdf'));
    refused(app, 'POST', `${url}${FAIL}`, { ...session('x.pdf'), deferCommit: true });
  });

  it('refuses a children POST that is anything but an empty folder', () => {
    const url = `${G}${rootedPath(APP, ['2610'], 'children')}${FAIL}`;
    refused(app, 'POST', url, { name: 'x.pdf', file: {}, '@microsoft.graph.conflictBehavior': 'fail' });
    refused(app, 'POST', url, { name: 'x.pdf', '@microsoft.graph.sourceUrl': 'https://evil', folder: {}, '@microsoft.graph.conflictBehavior': 'fail' });
    refused(app, 'POST', url, { name: 'Labs', folder: {}, '@microsoft.graph.conflictBehavior': 'replace' });
  });

  it('refuses unknown hosts and unknown query parameters', () => {
    refused(app, 'GET', 'https://evil.example/v1.0/me/drive');
    refused(app, 'GET', `${G}/me/drive?%24expand=children`);
    refused(app, 'GET', `${G}${rootedPath(APP, ['x'])}?%24select=id&foo=bar`);
  });

  it('refuses a root folder name that is not itself a safe segment', () => {
    assert.throws(() => new RequestGuard({ root: { mode: 'folder', name: '../Documents' } }), GuardError);
    assert.throws(() => new RequestGuard({ root: { mode: 'folder', name: 'a/b' } }), GuardError);
  });
});

// --- structural: the guard is the only way out -------------------------------

describe('structure: only src/graph talks to Microsoft, and only through the guard', () => {
  const SRC = path.resolve(fileURLToPath(new URL('../../src', import.meta.url)));
  const sources = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sources(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
    );

  it('names the Microsoft hosts in exactly one place', () => {
    const hits = sources(SRC).filter((f) => /graph\.microsoft\.com|login\.microsoftonline\.com|onedrive\.live\.com|1drv\.ms/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(hits.map((f) => path.relative(SRC, f)), [path.join('graph', 'guard.ts')]);
  });

  it('checks every Graph request against the guard immediately before sending it', () => {
    for (const file of sources(path.join(SRC, 'graph'))) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!/\bdoFetch\(/.test(line) || /^\s*(private|this\.doFetch =|const doFetch =)/.test(line)) return;
        const window = lines.slice(Math.max(0, i - 6), i).join('\n');
        assert.match(window, /guard\.check\(/, `${path.relative(SRC, file)}:${i + 1} sends without a guard check`);
      });
    }
  });
});
