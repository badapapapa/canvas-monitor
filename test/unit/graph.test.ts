import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { randomBytes } from 'node:crypto';
import { deviceCodeLogin, GraphError, TokenProvider } from '../../src/graph/auth.ts';
import { GraphDrive } from '../../src/graph/drive.ts';
import { GuardError, RequestGuard, SCOPES, type RootSpec } from '../../src/graph/guard.ts';
import { silentLogger } from '../../src/core/log.ts';
import { systemClock } from '../../src/core/clock.ts';
import { FakeGraph, type Recorded } from '../helpers/fake-graph.ts';

const fakes: FakeGraph[] = [];
after(async () => {
  await Promise.all(fakes.map((f) => f.stop()));
});

const noSleep = async (): Promise<void> => {};

async function setup(root: RootSpec, state: ConstructorParameters<typeof FakeGraph>[0] = {}) {
  const fake = await new FakeGraph(state).start();
  fakes.push(fake);
  const guard = new RequestGuard({ root, graphBase: fake.graphBase, loginBase: fake.loginBase });
  const saved: string[] = [];
  const events: string[] = [];
  let current = 'rt-initial';
  const tokens = new TokenProvider({
    clientId: '00000000-0000-0000-0000-000000000001',
    scope: SCOPES[root.mode],
    guard,
    log: silentLogger(),
    clock: systemClock,
    loginBase: fake.loginBase,
    refreshToken: () => current,
    saveRefreshToken: async (t) => {
      events.push(`saved ${t}`);
      saved.push(t);
      current = t;
    },
  });
  const drive = new GraphDrive({ root, guard, tokens, log: silentLogger(), clock: systemClock, graphBase: fake.graphBase, sleep: noSleep });
  const rootPath = root.mode === 'appfolder' ? `/Apps/${fake.state.appName}` : `/${root.name}`;
  const before = fake.snapshotOutsideRoot(rootPath);
  return { fake, guard, tokens, drive, saved, events, rootPath, before };
}

const APP: RootSpec = { mode: 'appfolder' };
const FOLDER: RootSpec = { mode: 'folder', name: 'Canvas Archive' };

describe('tokens', () => {
  it('persists the rotated refresh token before the new access token is used', async () => {
    const { drive, saved, events, fake } = await setup(APP);
    await drive.rootItem();
    assert.deepEqual(saved, ['rt-1']);
    const firstGraphCall = fake.requests.findIndex((r) => r.path.startsWith('/v1.0/'));
    const tokenCall = fake.requests.findIndex((r) => r.path.endsWith('/token'));
    assert.ok(tokenCall < firstGraphCall, 'the exchange happens first');
    assert.equal(events[0], 'saved rt-1', 'and is saved before anything uses it');
  });

  it('reports a revoked refresh token as an auth failure, not a crash', async () => {
    const { drive } = await setup(APP, { refreshRevoked: true });
    await assert.rejects(() => drive.rootItem(), (e: unknown) => e instanceof GraphError && e.code === 'auth');
  });

  it('signs in with the device code flow against /consumers', async () => {
    const fake = await new FakeGraph({ devicePendingPolls: 2 }).start();
    fakes.push(fake);
    const guard = new RequestGuard({ root: APP, graphBase: fake.graphBase, loginBase: fake.loginBase });
    const prompts: string[] = [];
    const result = await deviceCodeLogin({
      clientId: 'id', scope: SCOPES.appfolder, guard, clock: systemClock, loginBase: fake.loginBase,
      prompt: (m) => prompts.push(m), sleep: noSleep,
    });
    assert.match(result.refreshToken, /^rt-/);
    assert.match(prompts[0] ?? '', /devicelogin/);
    assert.ok(fake.requests.every((r) => r.path.startsWith('/login/consumers/')));
  });
});

describe('uploads', () => {
  it('uploads a small file into the root, byte for byte', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    const bytes = randomBytes(10_000);
    await drive.ensureFolders(['2610', 'AB1234', 'Labs']);
    const item = await drive.upload(['2610', 'AB1234', 'Labs', 'Lab 04.pdf'], bytes);
    assert.equal(item.name, 'Lab 04.pdf');
    assert.ok(item.webUrl?.startsWith('https://'));
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/AB1234/Labs/Lab 04.pdf`), bytes);
  });

  it('splits a large file into 320 KiB-multiple fragments and reassembles it exactly', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    const bytes = randomBytes(12 * 1024 * 1024 + 12345);
    await drive.ensureFolders(['2610']);
    await drive.upload(['2610', 'big.pptx'], bytes);
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/big.pptx`), bytes);
    const puts = fake.requests.filter((r) => r.method === 'PUT');
    assert.equal(puts.length, 3, '5 MiB + 5 MiB + remainder');
  });

  it('never overwrites: a name clash is a conflict and the existing file is untouched', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    await drive.ensureFolders(['2610']);
    fake.plant(`${rootPath}/2610/Notes.pdf`, Buffer.from('ORIGINAL'));
    await assert.rejects(
      () => drive.upload(['2610', 'Notes.pdf'], Buffer.from('NEW CONTENT')),
      (e: unknown) => e instanceof GraphError && e.code === 'conflict',
    );
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/Notes.pdf`), Buffer.from('ORIGINAL'));
  });

  it('treats a case-only difference as a clash, as OneDrive does', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    await drive.ensureFolders(['2610']);
    fake.plant(`${rootPath}/2610/notes.PDF`, Buffer.from('ORIGINAL'));
    await assert.rejects(() => drive.upload(['2610', 'Notes.pdf'], Buffer.from('x')), (e: unknown) => e instanceof GraphError && e.code === 'conflict');
  });

  it('resumes after a dropped connection mid-upload', async () => {
    const { drive, fake, rootPath } = await setup(APP, { dropNextPut: true });
    const bytes = randomBytes(11 * 1024 * 1024);
    await drive.ensureFolders(['x']);
    await drive.upload(['x', 'f.bin'], bytes);
    assert.deepEqual(fake.fileBytes(`${rootPath}/x/f.bin`), bytes);
  });

  it('restarts cleanly when the upload session is lost', async () => {
    const { drive, fake, rootPath } = await setup(APP, { loseSessionNextPut: true });
    const bytes = randomBytes(40_000);
    await drive.ensureFolders(['x']);
    await drive.upload(['x', 'f.bin'], bytes);
    assert.deepEqual(fake.fileBytes(`${rootPath}/x/f.bin`), bytes);
  });

  it('retries 503s and 429s', async () => {
    const { drive, fake, rootPath } = await setup(APP, { failNextPuts: 2, throttleNext: 2 });
    const bytes = randomBytes(30_000);
    await drive.ensureFolders(['x']);
    await drive.upload(['x', 'f.bin'], bytes);
    assert.deepEqual(fake.fileBytes(`${rootPath}/x/f.bin`), bytes);
  });

  it('reports a full drive as a quota error', async () => {
    const { drive } = await setup(APP, { quotaFullOnFinal: true });
    await drive.ensureFolders(['x']);
    await assert.rejects(() => drive.upload(['x', 'f.bin'], Buffer.from('x')), (e: unknown) => e instanceof GraphError && e.code === 'quota');
  });

  it('recognises the 2026 AppFolder provisioning regression by name', async () => {
    const { drive } = await setup(APP, { provisioningBroken: true });
    await assert.rejects(() => drive.rootItem(), (e: unknown) => e instanceof GraphError && e.code === 'provisioning');
  });
});

describe('quota', () => {
  it('reads the real quota rather than assuming one', async () => {
    const { drive } = await setup(APP, { quota: { total: 1024 ** 4, used: 123 * 1024 ** 3 } });
    const q = await drive.quota();
    assert.ok(q !== 'unreadable');
    assert.equal(q.total, 1024 ** 4);
  });

  it('says "unreadable" when the scope does not allow reading it', async () => {
    const { drive } = await setup(APP, { quota: 'forbidden' });
    assert.equal(await drive.quota(), 'unreadable');
  });
});

describe('folder mode', () => {
  it('creates its own root folder in the drive root, and only that', async () => {
    const { drive, fake } = await setup(FOLDER);
    await drive.rootItem();
    await drive.ensureFolders(['2610']);
    await drive.upload(['2610', 'a.pdf'], Buffer.from('a'));
    assert.deepEqual(fake.filesUnder('/Canvas Archive'), ['2610/a.pdf 1']);
    assert.deepEqual(fake.filesUnder('/Canvas Archive Backup'), [], 'a folder sharing the name as a prefix is not the root');
  });
});

// --- the confinement property -----------------------------------------------
//
// Written independently of the guard, from first principles: given the fake's
// request log, is every request something this app is allowed to do?

function insideRoot(r: Recorded, root: RootSpec, fake: FakeGraph, rootPath: string): string | null {
  const path = decodeURIComponent(r.path.split('?')[0] ?? '');
  if (path.startsWith('/login/')) {
    return r.method === 'POST' && path.startsWith('/login/consumers/') ? null : `login ${r.method} ${path}`;
  }
  if (path.startsWith('/upload/')) {
    if (r.hasAuth) return `bearer token sent to an upload URL: ${path}`;
    return r.method === 'PUT' || r.method === 'GET' ? null : `${r.method} on an upload URL`;
  }
  if (!['GET', 'POST', 'PATCH'].includes(r.method)) return `${r.method} ${path}`;
  if (path === '/v1.0/me/drive') return r.method === 'GET' ? null : `${r.method} /me/drive`;
  // Folder create by parent id (D-54): allowed only if the FAKE's own records
  // put that id at or under the root -- independent of what the guard believed.
  const byId = /^\/v1\.0\/me\/drive\/items\/([^/:]+)\/children$/.exec(path);
  if (byId !== null) {
    const where = fake.pathOfId(byId[1]!);
    if (r.method !== 'POST') return `${r.method} by id`;
    return where !== null && (where === rootPath || where.startsWith(`${rootPath}/`)) ? null : `id outside root: ${where}`;
  }
  // The re-route move (D-57): the item and its new parent must both be inside
  // the root by the fake's own records -- independent of the guard.
  const moved = /^\/v1\.0\/me\/drive\/items\/([^/:]+)$/.exec(path);
  if (moved !== null && r.method === 'PATCH') {
    const inside = (p: string | null) => p !== null && (p === rootPath || p.startsWith(`${rootPath}/`));
    const parentId = (JSON.parse(r.body) as { parentReference?: { id?: string } }).parentReference?.id ?? '';
    return inside(fake.pathOfId(moved[1]!)) && inside(fake.pathOfId(parentId)) ? null : `move outside root: ${path}`;
  }
  if (/\/items(\/|$)/.test(path)) return `id addressing: ${path}`;
  if (path.split(/[/:]/).includes('..')) return `traversal: ${path}`;
  const prefix = root.mode === 'appfolder' ? '/v1.0/me/drive/special/approot' : `/v1.0/me/drive/root:/${root.name}`;
  if (root.mode === 'folder' && path === '/v1.0/me/drive/root/children') {
    return r.method === 'POST' && (JSON.parse(r.body) as { name?: string }).name === root.name ? null : 'drive-root write';
  }
  if (path === prefix || path.startsWith(`${prefix}/`) || path.startsWith(`${prefix}:`)) return null;
  return `outside root: ${r.method} ${path}`;
}

describe('confinement: every request stays inside the root, and personal files are untouched', () => {
  for (const root of [APP, FOLDER]) {
    it(`[${root.mode}] across every flow, success and failure`, async () => {
      const { drive, fake, rootPath, before } = await setup(root, { dropNextPut: true, failNextPuts: 1, throttleNext: 1 });
      await drive.rootItem();
      await drive.quota();
      await drive.ensureFolders(['2610', 'AB1234', 'Lectures']);
      await drive.ensureFolders(['2610', 'AB1234', 'Lectures']); // idempotent
      await drive.upload(['2610', 'AB1234', 'Lectures', 'L01.pdf'], randomBytes(7 * 1024 * 1024));
      fake.plant(`${rootPath}/2610/AB1234/Lectures/L02.pdf`, Buffer.from('existing'));
      await drive.upload(['2610', 'AB1234', 'Lectures', 'L02.pdf'], Buffer.from('new')).catch(() => undefined);
      await drive.itemAt(['2610', 'AB1234', 'Lectures', 'L01.pdf']);
      await drive.itemAt(['2610', 'does not exist.pdf']);
      drive.allowMoveDestinations(['Tutorials']);
      await drive.ensureFolders(['2610', 'AB1234', '_unsorted']);
      await drive.upload(['2610', 'AB1234', '_unsorted', 'T1.pdf'], Buffer.from('tutorial'));
      await drive.move(['2610', 'AB1234', '_unsorted', 'T1.pdf'], ['2610', 'AB1234', 'Tutorials']);

      const violations = fake.requests.map((r) => insideRoot(r, root, fake, rootPath)).filter((v): v is string => v !== null);
      assert.deepEqual(violations, [], `requests outside the root:\n${violations.join('\n')}`);
      assert.equal(fake.snapshotOutsideRoot(rootPath), before, 'something outside the root changed');
      assert.ok(fake.requests.length > 10, 'the flows actually ran');
    });
  }
});

describe('the re-route move (D-57)', () => {
  it('moves an _unsorted file into a sibling folder, keeping its id and bytes', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    drive.allowMoveDestinations(['Harbour Case Study']);
    await drive.ensureFolders(['2610', 'AB1234', '_unsorted']);
    const uploaded = await drive.upload(['2610', 'AB1234', '_unsorted', 'case.pdf'], Buffer.from('case study'));
    const moved = await drive.move(['2610', 'AB1234', '_unsorted', 'case.pdf'], ['2610', 'AB1234', 'Harbour Case Study']);
    assert.equal(moved.id, uploaded.id);
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/AB1234/Harbour Case Study/case.pdf`), Buffer.from('case study'));
    assert.deepEqual(fake.filesUnder(`${rootPath}/2610/AB1234/_unsorted`), []);
  });

  it('refuses a taken destination name and leaves both files exactly as they were', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    drive.allowMoveDestinations(['Tutorials']);
    await drive.ensureFolders(['2610', 'AB1234', '_unsorted']);
    await drive.upload(['2610', 'AB1234', '_unsorted', 'T1.pdf'], Buffer.from('new'));
    fake.plant(`${rootPath}/2610/AB1234/Tutorials/T1.pdf`, Buffer.from('already here'));
    await assert.rejects(
      () => drive.move(['2610', 'AB1234', '_unsorted', 'T1.pdf'], ['2610', 'AB1234', 'Tutorials']),
      (e: unknown) => e instanceof GraphError && e.code === 'conflict',
    );
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/AB1234/Tutorials/T1.pdf`), Buffer.from('already here'));
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/AB1234/_unsorted/T1.pdf`), Buffer.from('new'));
    assert.equal(fake.requests.filter((r) => r.method === 'PATCH').length, 0, 'no move was even attempted');
  });

  it('cannot move a file that is not in _unsorted, whatever the caller asks', async () => {
    const { drive, fake } = await setup(APP);
    drive.allowMoveDestinations(['Tutorials']);
    await drive.ensureFolders(['2610', 'AB1234', 'Lectures']);
    await drive.upload(['2610', 'AB1234', 'Lectures', 'L1.pdf'], Buffer.from('placed'));
    await assert.rejects(() => drive.move(['2610', 'AB1234', 'Lectures', 'L1.pdf'], ['2610', 'AB1234', 'Tutorials']), GuardError);
    assert.equal(fake.requests.filter((r) => r.method === 'PATCH').length, 0);
  });
});

describe('the re-route move under a race (D-57)', () => {
  it('reports a name taken between the check and the move as a conflict, and overwrites nothing', async () => {
    const { drive, fake, rootPath } = await setup(APP);
    drive.allowMoveDestinations(['Tutorials']);
    await drive.ensureFolders(['2610', 'AB1234', '_unsorted']);
    await drive.upload(['2610', 'AB1234', '_unsorted', 'T1.pdf'], Buffer.from('mine'));
    await assert.rejects(
      () => drive.move(['2610', 'AB1234', '_unsorted', 'T1.pdf'], ['2610', 'AB1234', 'Tutorials'], {
        beforePatch: async () => void fake.plant(`${rootPath}/2610/AB1234/Tutorials/T1.pdf`, Buffer.from('raced in')),
      }),
      (e: unknown) => e instanceof GraphError && e.code === 'conflict',
    );
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/AB1234/Tutorials/T1.pdf`), Buffer.from('raced in'));
    assert.deepEqual(fake.fileBytes(`${rootPath}/2610/AB1234/_unsorted/T1.pdf`), Buffer.from('mine'));
  });
});
