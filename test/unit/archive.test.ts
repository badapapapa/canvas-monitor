/**
 * Phase 4 end to end: sync -> archive -> notify, against a fake Canvas, a fake
 * Canvas storage host, a fake Graph and a fake Telegram.
 */

import { strict as assert } from 'node:assert';
import { after, beforeEach, describe, it } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createClient, type Client } from '@libsql/client';
import { createDb } from '../../src/core/db/writer.ts';
import { migrate } from '../../src/core/db/migrate.ts';
import { Config, setConfig } from '../../src/core/config.ts';
import { silentLogger } from '../../src/core/log.ts';
import type { RunContext } from '../../src/core/run-context.ts';
import { runSync } from '../../src/sync/run.ts';
import { startServer, sendJson, type FakeServer } from '../helpers/fake-canvas.ts';
import { FakeGraph, type Recorded } from '../helpers/fake-graph.ts';

interface FakeFile {
  id: number;
  name: string;
  size: number;
  folder: number;
  mime?: string;
}

const servers: FakeServer[] = [];
const graphs: FakeGraph[] = [];
const temps: string[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
  await Promise.all(graphs.map((g) => g.stop()));
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

const FOLDERS = [
  { id: 1, full_name: 'course files' },
  { id: 7, full_name: 'course files/Week 06/Lecture Notes' },
  { id: 8, full_name: 'course files/Week 06/Practical Lab' },
];

/** Deterministic bytes per file id, so what lands can be checked exactly. */
function bytesFor(id: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i += 1) out[i] = (id * 31 + i) % 251;
  return out;
}

let canvasUrlValue = '';
const canvasUrl = () => canvasUrlValue;

async function harness(graphState: ConstructorParameters<typeof FakeGraph>[0] = {}, opts: { directStorage?: boolean } = {}) {
  const files: FakeFile[] = [];
  const brokenStorage = new Set<number>();
  const storageAuth: Array<string | undefined> = [];
  const storage = await startServer((req, res) => {
    storageAuth.push(req.headers.authorization);
    const id = Number(/\/files\/(\d+)\//.exec(req.url ?? '')?.[1]);
    const f = files.find((x) => x.id === id);
    if (f === undefined) return sendJson(res, 404, {});
    if (brokenStorage.has(id)) return sendJson(res, 500, {});
    const body = bytesFor(f.id, f.size);
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(body.length) });
    res.end(body);
  });
  servers.push(storage);

  const fileObject = (f: FakeFile) => ({
    id: f.id, display_name: f.name, filename: f.name, size: f.size, folder_id: f.folder,
    created_at: '2026-09-18T12:03:00Z', updated_at: '2026-09-18T12:03:00Z', modified_at: '2026-09-18T12:03:00Z',
    hidden_for_user: false, locked_for_user: false, upload_status: 'success', mime_class: f.mime ?? 'pdf',
    // Real Canvas hands back a URL on its own origin that redirects to storage.
    // `directStorage` models a Canvas that hands back the storage URL itself.
    url: opts.directStorage === true
      ? `${storage.url}/files/${f.id}/blob?verifier=v${f.id}`
      : `${canvasUrl()}/files/${f.id}/download?download_frd=1&verifier=v${f.id}`,
  });
  const canvasAuth: Array<string | undefined> = [];
  const canvas = await startServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    // As on the real instance: the download URL is on Canvas's origin and
    // redirects to the storage host, which is another origin.
    const dl = /^\/files\/(\d+)\/download$/.exec(url.pathname);
    if (dl !== null) {
      canvasAuth.push(req.headers.authorization);
      res.writeHead(302, { location: `${storage.url}/files/${dl[1]}/blob?sig=x` });
      return res.end();
    }
    if (url.pathname === '/api/v1/users/self') return sendJson(res, 200, { id: 42 });
    if (url.pathname === '/api/v1/announcements') return sendJson(res, 200, []);
    const one = /^\/api\/v1\/courses\/10001\/files\/(\d+)$/.exec(url.pathname);
    if (one !== null) {
      const f = files.find((x) => x.id === Number(one[1]));
      return f === undefined ? sendJson(res, 404, {}) : sendJson(res, 200, fileObject(f));
    }
    if (url.pathname === '/api/v1/courses/10001/files') return sendJson(res, 200, files.map(fileObject));
    if (url.pathname === '/api/v1/courses/10001/folders') return sendJson(res, 200, FOLDERS);
    if (/^\/api\/v1\/courses\/10001\/(assignments|students\/submissions|modules)$/.test(url.pathname)) return sendJson(res, 200, []);
    sendJson(res, 404, {});
  });
  servers.push(canvas);
  canvasUrlValue = canvas.url;

  const sent: Array<{ chat: string; text: string }> = [];
  const telegram = await startServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const b = JSON.parse(raw) as { chat_id: string; text: string };
      sent.push({ chat: String(b.chat_id), text: b.text });
      sendJson(res, 200, { ok: true, result: { message_id: sent.length } });
    });
  });
  servers.push(telegram);

  const graph = await new FakeGraph(graphState).start();
  graphs.push(graph);

  const dir = await mkdtemp(path.join(tmpdir(), 'canvas-archive-'));
  temps.push(dir);
  const client = createClient({ url: `file:${path.join(dir, 'a.db')}` });
  await client.execute('PRAGMA foreign_keys = ON');
  let now = new Date('2026-09-18T12:10:00Z'); // 20:10 SGT
  const clock = { now: () => new Date(now.getTime()), set: (iso: string) => void (now = new Date(iso)) };
  await migrate(client, silentLogger(), clock, { dryRun: false });
  const db = createDb(client, silentLogger(), false);
  for (const [k, v] of [
    ['canvas_base_url', `${canvas.url}/api/v1`], ['canvas_token', 'canvas-token'], ['canvas_token_expires_at', '2026-12-31T00:00:00Z'],
    ['raw_capture_enabled', 'false'], ['telegram_bot_token', ['123456789', 'B'.repeat(35)].join(':')],
    ['telegram_content_chat_id', '111'], ['telegram_ops_chat_id', '-222'],
    ['graph_client_id', '00000000-0000-0000-0000-000000000001'], ['graph_refresh_token', 'rt-initial'],
    ['graph_scope', 'appfolder'], ['archive_enabled', 'true'],
  ] as const) await setConfig(db, clock, k, v);
  await client.execute(`INSERT INTO contexts (context_id, context_type, canvas_id, enabled, coverage_status, first_seen_at)
                        VALUES (1, 'course', 10001, 1, 'full', '2026-09-10T00:00:00Z')`);
  await client.execute(`INSERT INTO courses (context_id, canvas_course_id, module_code, term) VALUES (1, 10001, 'AB1234', '2610')`);

  const ctx = (dryRun = false): RunContext => {
    const log = silentLogger();
    return {
      runId: randomUUID(), command: 'sync', dryRun, unsafeLog: false, ci: false, scheduledFor: undefined,
      startedAt: clock.now(), clock, log, db: createDb(client, log, dryRun), bootstrap: {} as RunContext['bootstrap'],
    };
  };
  const sync = (dryRun = false) =>
    runSync(ctx(dryRun), { telegramApiBase: telegram.url, graphBase: graph.graphBase, loginBase: graph.loginBase });
  const ROOT = `/Apps/${graph.state.appName}`;
  const personalBefore = graph.snapshotOutsideRoot(ROOT);
  return { files, brokenStorage, storageAuth, canvasAuth, graph, sent, client, clock, sync, ROOT, personalBefore, db };
}

type H = Awaited<ReturnType<typeof harness>>;
const content = (h: H) => h.sent.filter((s) => s.chat === '111').map((s) => s.text);
const ops = (h: H) => h.sent.filter((s) => s.chat === '-222').map((s) => s.text);
const graphCalls = (h: H) => h.graph.requests.filter((r) => r.path.startsWith('/v1.0/') || r.path.startsWith('/upload/'));

describe('Phase 4 archive, end to end', () => {
  let h: H;
  beforeEach(async () => {
    h = await harness();
  });

  it('archives files already on Canvas into term/module/category, byte for byte', async () => {
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 20_000, folder: 7 }, { id: 2, name: 'Lab 04.pdf', size: 9_000, folder: 8 });
    await h.sync(); // baseline + archive
    assert.deepEqual(h.graph.filesUnder(h.ROOT), ['2610/AB1234/Labs/Lab 04.pdf 9000', '2610/AB1234/Lectures/Lecture 06.pdf 20000']);
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Lectures/Lecture 06.pdf`), bytesFor(1, 20_000));
    const rows = await h.client.execute("SELECT download_state, share_url, content_sha256 FROM files ORDER BY canvas_file_id");
    assert.deepEqual(rows.rows.map((r) => r['download_state']), ['complete', 'complete']);
    assert.match(String(rows.rows[0]?.['share_url']), /^https:\/\/onedrive\.live\.com\//);
    assert.equal(rows.rows[0]?.['content_sha256'], createHash('sha256').update(bytesFor(1, 20_000)).digest('hex'));
  });

  it('announces a new file with where it went and a OneDrive link, in the same run', async () => {
    await h.sync(); // baseline, no files
    h.sent.length = 0;
    h.files.push({ id: 5, name: 'Lab 04 Part 1 - Suggested Solutions.zip', size: 4_000, folder: 8, mime: 'zip' });
    await h.sync();
    const msg = content(h).join('\n');
    assert.match(msg, /Lab 04 Part 1 - Suggested Solutions\.zip<\/b><\/a> — 4 KB · Week 06\/Practical Lab → Labs · <a href="https:\/\/onedrive\.live\.com\/[^"]+">OneDrive<\/a>/);
  });

  it('flags an unrouted file as needing a rule', async () => {
    await h.sync();
    h.sent.length = 0;
    h.files.push({ id: 6, name: 'Revision pack.pdf', size: 1000, folder: 1 });
    await h.sync();
    assert.match(content(h).join('\n'), /Revision pack\.pdf.* → _unsorted ⚠ needs a routing rule/);
    assert.ok(h.graph.filesUnder(h.ROOT).includes('2610/AB1234/_unsorted/Revision pack.pdf 1000'));
  });

  it('never overwrites: a clash is archived alongside, with the upload date', async () => {
    h.graph.plant(`${h.ROOT}/2610/AB1234/Labs/Lab 04.pdf`, Buffer.from('SOMETHING ELSE ALREADY HERE'));
    h.files.push({ id: 2, name: 'Lab 04.pdf', size: 9_000, folder: 8 });
    await h.sync();
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Labs/Lab 04.pdf`), Buffer.from('SOMETHING ELSE ALREADY HERE'));
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Labs/Lab 04 (uploaded 2026-09-18).pdf`), bytesFor(2, 9_000));
    const row = await h.client.execute('SELECT target_path FROM files');
    assert.equal(row.rows[0]?.['target_path'], '2610/AB1234/Labs/Lab 04 (uploaded 2026-09-18).pdf');
  });

  it('adopts a file an earlier crashed run already uploaded, instead of duplicating it', async () => {
    h.files.push({ id: 2, name: 'Lab 04.pdf', size: 9_000, folder: 8 });
    // A previous run reserved the path, counted an attempt, uploaded -- and died.
    await h.sync(); // creates the item and archives it normally...
    await h.client.execute("UPDATE files SET download_state = 'pending', onedrive_item_id = NULL, share_url = NULL");
    const putsBefore = h.graph.requests.filter((r) => r.method === 'PUT').length;
    await h.sync();
    assert.equal(h.graph.requests.filter((r) => r.method === 'PUT').length, putsBefore, 'nothing uploaded a second time');
    assert.equal(h.graph.filesUnder(h.ROOT).length, 1, 'no duplicate');
    const row = await h.client.execute('SELECT download_state, share_url FROM files');
    assert.equal(row.rows[0]?.['download_state'], 'complete');
    assert.ok(row.rows[0]?.['share_url'] !== null);
  });

  it('skips files over the size gate without downloading them, and says so', async () => {
    await h.sync();
    h.sent.length = 0;
    await setConfig(h.db, h.clock, 'archive_max_file_bytes', '5000');
    h.files.push({ id: 9, name: 'Huge recording notes.pdf', size: 8000, folder: 7 });
    await h.sync();
    assert.equal(h.storageAuth.length, 0, 'never downloaded');
    assert.match(content(h).join('\n'), /Huge recording notes\.pdf.*not archived: over the size limit/);
    const row = await h.client.execute('SELECT download_state FROM files');
    assert.equal(row.rows[0]?.['download_state'], 'skipped_size');
  });

  it('skips video entirely, whatever its size', async () => {
    h.files.push({ id: 10, name: 'Lecture recording.mp4', size: 100, folder: 7, mime: 'video' });
    await h.sync();
    assert.equal(h.storageAuth.length, 0);
    assert.deepEqual(h.graph.filesUnder(h.ROOT), []);
  });

  it('sends the Canvas token to Canvas and not across the redirect to storage', async () => {
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 1000, folder: 7 });
    await h.sync();
    assert.deepEqual(h.canvasAuth, ['Bearer canvas-token'], 'Canvas itself gets the token');
    assert.ok(h.storageAuth.length > 0);
    assert.ok(h.storageAuth.every((a) => a === undefined), 'the storage host is another origin: no bearer token');
  });

  it('rotates the refresh token and persists the new one', async () => {
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 1000, folder: 7 });
    await h.sync();
    const config = await Config.load(h.db);
    assert.match(config.get('graph_refresh_token') ?? '', /^rt-\d+$/);
    assert.notEqual(config.get('graph_refresh_token'), 'rt-initial');
  });

  it('touches nothing outside its root across a whole sync', async () => {
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 7 * 1024 * 1024, folder: 7 }, { id: 2, name: 'Lab 04.pdf', size: 9_000, folder: 8 });
    await h.sync();
    const outside = graphCalls(h).filter((r: Recorded) => {
      const p = decodeURIComponent(r.path.split('?')[0] ?? '');
      return !(p === '/v1.0/me/drive' || p.startsWith('/v1.0/me/drive/special/approot') || p.startsWith('/upload/'));
    });
    assert.deepEqual(outside.map((r) => `${r.method} ${r.path}`), []);
    assert.ok(graphCalls(h).every((r) => r.method === 'GET' || r.method === 'POST' || (r.method === 'PUT' && r.path.startsWith('/upload/'))));
    assert.equal(h.graph.snapshotOutsideRoot(h.ROOT), h.personalBefore);
  });

  it('works through a backlog within the per-run budget, then finishes it', async () => {
    await setConfig(h.db, h.clock, 'archive_max_files_per_run', '4');
    for (let i = 1; i <= 6; i += 1) h.files.push({ id: 100 + i, name: `Slide ${i}.pdf`, size: 500, folder: 7 });
    const first = await h.sync();
    assert.equal(first.archive?.archived.length, 4);
    assert.equal(first.archive?.stopped, 'budget');
    const second = await h.sync();
    assert.equal(second.archive?.archived.length, 2);
    assert.equal(h.graph.filesUnder(h.ROOT).length, 6);
  });

  it('sends one "saved to OneDrive" summary when a backlog is archived', async () => {
    for (let i = 1; i <= 12; i += 1) h.files.push({ id: 200 + i, name: `Doc ${i}.pdf`, size: 300, folder: 7 });
    await h.sync();
    assert.equal(content(h).filter((t) => t.includes('Saved to OneDrive')).length, 1);
    assert.match(content(h).join('\n'), /12 files \(4 KB\) archived this run/);
  });

  it('touches nothing on OneDrive under --dry-run', async () => {
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 1000, folder: 7 });
    const outcome = await h.sync(true);
    assert.equal(h.graph.requests.length, 0, 'not even a token exchange');
    assert.equal(outcome.archive?.planned, 0, 'a first-seen file is baselined in dry run, so not yet a candidate');
    const rows = await h.client.execute('SELECT count(*) AS n FROM files');
    assert.equal(Number(rows.rows[0]?.['n']), 0);
  });
});

describe('Phase 4 archive: failures are loud, and never block notification', () => {
  it('pages once when OneDrive access is revoked, and still announces the file', async () => {
    const h = await harness({ refreshRevoked: true });
    await h.sync();
    h.files.push({ id: 5, name: 'Lab 05.pdf', size: 1000, folder: 8 });
    await h.sync();
    assert.match(content(h).join('\n'), /Lab 05\.pdf/, 'the notification still goes out');
    assert.doesNotMatch(content(h).join('\n'), /OneDrive<\/a>/, 'but with no link to a file that is not there');
    assert.equal(ops(h).filter((t) => t.includes('OneDrive access has expired')).length, 1);
    await h.sync();
    assert.equal(ops(h).filter((t) => t.includes('OneDrive access has expired')).length, 1, 'not every run');
  });

  it('names the AppFolder provisioning regression and its workaround', async () => {
    const h = await harness({ provisioningBroken: true });
    await h.sync();
    assert.match(ops(h).join('\n'), /read-only or &quot;pending provisioning&quot;|read-only or "pending provisioning"/);
    assert.match(ops(h).join('\n'), /account\.live\.com\/consent\/Manage/);
  });

  it('alerts at 80% of the REAL quota, read from the drive', async () => {
    const h = await harness({ quota: { total: 1000 * 1024 ** 3, used: 850 * 1024 ** 3 } });
    h.files.push({ id: 1, name: 'x.pdf', size: 100, folder: 7 });
    await h.sync();
    assert.match(ops(h).join('\n'), /OneDrive is 85% of 1000\.0 GB full|OneDrive is 85% of/);
  });

  it('says once when the quota cannot be read, instead of going quiet', async () => {
    const h = await harness({ quota: 'forbidden' });
    h.files.push({ id: 1, name: 'x.pdf', size: 100, folder: 7 });
    await h.sync();
    await h.sync();
    assert.equal(ops(h).filter((t) => t.includes('quota is not readable')).length, 1);
  });

  it('pages when the drive is full', async () => {
    const h = await harness({ quotaFullOnFinal: true });
    await h.sync();
    h.files.push({ id: 1, name: 'Lab 09.pdf', size: 100, folder: 8 });
    await h.sync();
    assert.match(ops(h).join('\n'), /OneDrive is full/);
    const msg = content(h).join('\n');
    assert.match(msg, /Lab 09\.pdf/, 'still announced');
    assert.doesNotMatch(msg, /→|OneDrive<\/a>/, 'but claims no destination for a file that did not land');
  });

  it('gives up on a file after five attempts, counting each one before trying, and says so once', async () => {
    const h = await harness();
    h.files.push({ id: 3, name: 'Lab 03.pdf', size: 100, folder: 8 });
    h.brokenStorage.add(3);
    for (let i = 0; i < 7; i += 1) await h.sync();
    const row = await h.client.execute('SELECT download_state, attempts FROM files');
    assert.equal(row.rows[0]?.['download_state'], 'failed');
    assert.equal(Number(row.rows[0]?.['attempts']), 5);
    assert.equal(h.storageAuth.length, 5, 'no sixth download');
    assert.equal(ops(h).filter((t) => t.includes('could not be archived after 5 attempts')).length, 1);
  });
});

describe('Phase 4 archive: the NUS token goes to the Canvas origin and nowhere else', () => {
  it('sends no token when Canvas hands back a URL on another origin directly', async () => {
    const h = await harness({}, { directStorage: true });
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 1000, folder: 7 });
    await h.sync();
    assert.equal(h.canvasAuth.length, 0, 'the download never touched the Canvas origin');
    assert.equal(h.storageAuth.length, 1);
    assert.equal(h.storageAuth[0], undefined, 'a foreign origin never gets the bearer token');
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Lectures/Lecture 06.pdf`), bytesFor(1, 1000), 'and the download still works');
  });
});

describe('Phase 4 archive: a lost app registration or an unreachable drive is never silent (D-53)', () => {
  for (const gone of ['deleted', 'tenant_blocked'] as const) {
    it(`[${gone}] pages once, says sign-in will not fix it, and still announces files`, async () => {
      const h = await harness({ appGone: gone });
      await h.sync();
      h.files.push({ id: 5, name: 'Lab 05.pdf', size: 1000, folder: 8 });
      await h.sync();
      assert.match(content(h).join('\n'), /Lab 05\.pdf/);
      const pages = ops(h).filter((t) => t.includes('app registration is missing'));
      assert.equal(pages.length, 1);
      assert.match(pages[0] ?? '', gone === 'deleted' ? /AADSTS700016/ : /AADSTS5000225/);
      assert.match(pages[0] ?? '', /Signing in again will not fix this/);
      assert.equal(ops(h).filter((t) => t.includes('OneDrive access has expired')).length, 0, 'not misreported as an expired sign-in');
    });
  }

  it('alerts when OneDrive has been unreachable for a day, not on the first bad run, and resolves', async () => {
    const h = await harness({ driveBroken: true });
    await h.sync();
    h.clock.set('2026-09-18T20:00:00Z');
    await h.sync();
    assert.equal(ops(h).filter((t) => t.includes('not been reachable')).length, 0, 'eight hours: not yet');
    h.clock.set('2026-09-19T12:30:00Z');
    await h.sync();
    assert.equal(ops(h).filter((t) => t.includes('OneDrive has not been reachable for 24 hours')).length, 1);
    h.graph.state.driveBroken = false;
    h.clock.set('2026-09-19T13:00:00Z');
    await h.sync();
    assert.ok(ops(h).some((t) => /resolved|✅/i.test(t) && /reachable/.test(t)), `expected a resolution:\n${ops(h).join('\n---\n')}`);
  });
});
