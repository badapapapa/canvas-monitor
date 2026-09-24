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
import { createLogger, silentLogger } from '../../src/core/log.ts';
import type { RunContext } from '../../src/core/run-context.ts';
import { runSync } from '../../src/sync/run.ts';
import { startServer, sendJson, type FakeServer } from '../helpers/fake-canvas.ts';
import { FakeGraph, type Recorded } from '../helpers/fake-graph.ts';
import { addRule } from '../../src/archive/rules.ts';
import { applyReroutes, planReroutes } from '../../src/archive/reroute.ts';
import { TokenProvider } from '../../src/graph/auth.ts';
import { GraphDrive } from '../../src/graph/drive.ts';
import { RequestGuard, SCOPES, type RootSpec } from '../../src/graph/guard.ts';
import { READMODEL_DDL, READMODEL_SCHEMA_VERSION } from '../../src/readmodel/schema.ts';

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

  const logLines: string[] = [];
  const ctx = (dryRun = false): RunContext => {
    const log = createLogger({ runId: 'test', clock, level: 'debug', sink: (l) => logLines.push(l) });
    return {
      runId: randomUUID(), command: 'sync', dryRun, unsafeLog: false, ci: false, scheduledFor: undefined,
      startedAt: clock.now(), clock, log, db: createDb(client, log, dryRun), bootstrap: {} as RunContext['bootstrap'],
    };
  };
  const sync = (dryRun = false) =>
    runSync(ctx(dryRun), { telegramApiBase: telegram.url, graphBase: graph.graphBase, loginBase: graph.loginBase });
  const ROOT = `/Apps/${graph.state.appName}`;
  const personalBefore = graph.snapshotOutsideRoot(ROOT);
  return { telegramUrl: telegram.url, ctx, logLines, files, brokenStorage, storageAuth, canvasAuth, graph, sent, client, clock, sync, ROOT, personalBefore, db };
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

  it('never overwrites: a clash is archived alongside, with the Canvas week (D-57)', async () => {
    h.graph.plant(`${h.ROOT}/2610/AB1234/Labs/Lab 04.pdf`, Buffer.from('SOMETHING ELSE ALREADY HERE'));
    h.files.push({ id: 2, name: 'Lab 04.pdf', size: 9_000, folder: 8 });
    await h.sync();
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Labs/Lab 04.pdf`), Buffer.from('SOMETHING ELSE ALREADY HERE'));
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Labs/Lab 04 (Week 06).pdf`), bytesFor(2, 9_000));
    const row = await h.client.execute('SELECT target_path FROM files');
    assert.equal(row.rows[0]?.['target_path'], '2610/AB1234/Labs/Lab 04 (Week 06).pdf');
  });

  it('falls back to the upload date when the Canvas folder names no week', async () => {
    h.graph.plant(`${h.ROOT}/2610/AB1234/_unsorted/Notes.pdf`, Buffer.from('SOMETHING ELSE'));
    h.files.push({ id: 7, name: 'Notes.pdf', size: 500, folder: 1 });
    await h.sync();
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/_unsorted/Notes (uploaded 2026-09-18).pdf`), bytesFor(7, 500));
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
      // Folder create by parent id (D-54): the fake's own records must put the id inside the root.
      const byId = /^\/v1\.0\/me\/drive\/items\/([^/:]+)\/children$/.exec(r.path.split('?')[0] ?? '');
      if (byId !== null) {
        const where = h.graph.pathOfId(decodeURIComponent(byId[1]!));
        return !(r.method === 'POST' && where !== null && (where === h.ROOT || where.startsWith(`${h.ROOT}/`)));
      }
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
    assert.match(first.archive?.stopDetail ?? '', /^files \(files 4\/4, /, 'names the cap that bound');
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

describe('Phase 4 archive: every failure says why, and a run where everything fails pages at once', () => {
  const failedLines = (h: H) => h.logLines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l['event'] === 'archive.failed' || l['msg'] === 'archive.failed');

  it('logs one line per failure with step and status, and no names', async () => {
    const h = await harness();
    await h.sync();
    h.files.push({ id: 3, name: 'Lab 03 Secret Name.pdf', size: 100, folder: 8 }, { id: 4, name: 'Lecture 04 Secret Name.pdf', size: 100, folder: 7 });
    h.brokenStorage.add(3);
    await h.sync();
    const lines = failedLines(h);
    assert.equal(lines.length, 1, h.logLines.filter((l) => l.includes('archive')).join('\n'));
    assert.equal(lines[0]?.['step'], 'download');
    assert.equal(lines[0]?.['code'], 'http_500');
    assert.equal(lines[0]?.['status'], 500);
    const all = h.logLines.join('\n');
    assert.doesNotMatch(all, /Secret Name|Lab 03|AB1234|Practical Lab/, 'no file, module or folder names in the log');
  });

  it('pages in the same run when every attempt fails, naming the step and Graph code', async () => {
    const h = await harness({ folderCreateBroken: true });
    await h.sync();
    for (let i = 1; i <= 3; i += 1) h.files.push({ id: 300 + i, name: `Lab 0${i}.pdf`, size: 100, folder: 8 });
    await h.sync();
    const lines = failedLines(h);
    assert.equal(lines.length, 3);
    assert.ok(lines.every((l) => l['step'] === 'folder' && l['status'] === 400 && l['graphCode'] === 'invalidRequest'));
    const page = ops(h).filter((t) => t.includes('Every archive attempt this run failed'));
    assert.equal(page.length, 1, ops(h).join('\n---\n'));
    assert.match(page[0] ?? '', /3 of 3/);
    assert.match(page[0] ?? '', /folder server 400 invalidRequest ×3/);
    const summary = h.logLines.map((l) => JSON.parse(l) as Record<string, unknown>).findLast((l) => (l['event'] ?? l['msg']) === 'archive.summary');
    assert.deepEqual(summary?.['failures'], { 'folder server 400 invalidRequest': 3 });

    // Fixed: the next run archives, and the alert resolves.
    h.graph.state.folderCreateBroken = false;
    await h.sync();
    assert.equal(h.graph.filesUnder(h.ROOT).length, 3);
    assert.ok(ops(h).some((t) => /resolved|✅/i.test(t) && /archive attempt/i.test(t)), ops(h).join('\n---\n'));
  });

  it('does not page for a single failed attempt, or when anything in the run succeeded', async () => {
    const h = await harness();
    await h.sync();
    h.files.push({ id: 3, name: 'Lab 03.pdf', size: 100, folder: 8 });
    h.brokenStorage.add(3);
    await h.sync();
    h.files.push({ id: 4, name: 'Lab 04.pdf', size: 100, folder: 8 }, { id: 5, name: 'Lab 05.pdf', size: 100, folder: 8 });
    h.brokenStorage.add(4);
    await h.sync(); // 3 and 4 fail, 5 lands
    assert.equal(ops(h).filter((t) => t.includes('Every archive attempt')).length, 0);
  });

  it('verifies what landed by OneDrive\'s own hash, and never calls a corrupted upload archived', async () => {
    const h = await harness({ corruptNextUpload: true });
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 1000, folder: 7 });
    await h.sync();
    const row = await h.client.execute('SELECT download_state, share_url FROM files');
    assert.equal(row.rows[0]?.['download_state'], 'failed');
    assert.equal(row.rows[0]?.['share_url'], null);
    const lines = failedLines(h);
    assert.equal(lines[0]?.['step'], 'verify');
    assert.equal(lines[0]?.['graphCode'], 'verifyMismatch');
  });

  it('does not adopt a different file that happens to have the same name and size', async () => {
    const h = await harness();
    h.files.push({ id: 2, name: 'Lab 04.pdf', size: 9_000, folder: 8 });
    // Something of identical size, but different content, already sits at the name.
    h.graph.plant(`${h.ROOT}/2610/AB1234/Labs/Lab 04.pdf`, Buffer.alloc(9_000, 7));
    await h.sync();
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Labs/Lab 04.pdf`), Buffer.alloc(9_000, 7), 'untouched');
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Labs/Lab 04 (Week 06).pdf`), bytesFor(2, 9_000));
  });
});

describe('Phase 5: re-route after an approved preview (D-57)', () => {
  function driveFor(h: H) {
    const root: RootSpec = { mode: 'appfolder' };
    const guard = new RequestGuard({ root, graphBase: h.graph.graphBase, loginBase: h.graph.loginBase });
    let current = 'rt-initial';
    const tokens = new TokenProvider({
      clientId: '00000000-0000-0000-0000-000000000001', scope: SCOPES.appfolder, guard, log: silentLogger(), clock: h.clock,
      loginBase: h.graph.loginBase, refreshToken: () => current, saveRefreshToken: async (t) => void (current = t),
    });
    return new GraphDrive({ root, guard, tokens, log: silentLogger(), clock: h.clock, graphBase: h.graph.graphBase, sleep: async () => {} });
  }

  async function withUnsorted() {
    const h = await harness();
    h.files.push(
      { id: 11, name: 'Case notes.pdf', size: 300, folder: 1 },
      { id: 12, name: 'Unit-T1.pdf', size: 200, folder: 1 },
      { id: 13, name: 'Mystery.bin', size: 100, folder: 1 },
    );
    await h.sync();
    assert.deepEqual(h.graph.filesUnder(`${h.ROOT}/2610/AB1234/_unsorted`).length, 3);
    await addRule(h.db, h.clock, { moduleCode: 'AB1234', field: 'filename', pattern: '\\bcase notes\\b', target: 'Case Study', priority: 10 });
    await addRule(h.db, h.clock, { moduleCode: 'AB1234', field: 'filename', pattern: '\\bT\\d+\\b', target: 'Tutorials', priority: 20 });
    return h;
  }

  it('previews without touching anything, then applies exactly the approved plan', async () => {
    const h = await withUnsorted();
    const before = h.graph.requests.length;
    const plan = await planReroutes(h.ctx());
    assert.equal(h.graph.requests.length, before, 'the preview makes no Graph request');
    assert.deepEqual(plan.moves.map((m) => [m.to.split('/').slice(2).join('/'), m.rule.startsWith('db:')]), [
      ['Case Study/Case notes.pdf', true],
      ['Tutorials/Unit-T1.pdf', true],
    ]);
    assert.deepEqual(plan.staying.map((x) => x.from.split('/').pop()), ['Mystery.bin']);

    await assert.rejects(() => applyReroutes(h.ctx(), driveFor(h), 'not-the-fingerprint'), /plan changed since the preview/);
    assert.equal(h.graph.requests.filter((r) => r.method === 'PATCH').length, 0, 'a wrong fingerprint moves nothing');

    const result = await applyReroutes(h.ctx(), driveFor(h), plan.fingerprint);
    assert.deepEqual([result.moved, result.failed.length], [2, 0]);
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Case Study/Case notes.pdf`), bytesFor(11, 300));
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Tutorials/Unit-T1.pdf`), bytesFor(12, 200));
    assert.deepEqual(h.graph.filesUnder(`${h.ROOT}/2610/AB1234/_unsorted`), ['Mystery.bin 100']);
    const rows = await h.client.execute("SELECT target_path, route_category, route_reroutable FROM files WHERE route_category <> '_unsorted' ORDER BY target_path");
    assert.deepEqual(rows.rows.map((r) => [r['route_category'], r['route_reroutable']]), [['Case Study', 0], ['Tutorials', 0]]);
    assert.equal(h.graph.snapshotOutsideRoot(h.ROOT), h.personalBefore);
  });

  it('re-routes each file once: a moved file is never planned again, whatever the rules become', async () => {
    const h = await withUnsorted();
    await applyReroutes(h.ctx(), driveFor(h), (await planReroutes(h.ctx())).fingerprint);
    await addRule(h.db, h.clock, { moduleCode: 'AB1234', field: 'filename', pattern: '.*', target: 'Readings', priority: 1 });
    const again = await planReroutes(h.ctx());
    assert.deepEqual(again.moves.map((m) => m.from.split('/').pop()), ['Mystery.bin'], 'only the never-moved file');
  });

  it('changes of plan between preview and apply are refused', async () => {
    const h = await withUnsorted();
    const plan = await planReroutes(h.ctx());
    await addRule(h.db, h.clock, { moduleCode: 'AB1234', field: 'filename', pattern: '\\bmystery\\b', target: 'Readings', priority: 5 });
    await assert.rejects(() => applyReroutes(h.ctx(), driveFor(h), plan.fingerprint), /plan changed/);
  });

  it('records a move that happened before a crash, without moving anything again', async () => {
    const h = await withUnsorted();
    const plan = await planReroutes(h.ctx());
    await applyReroutes(h.ctx(), driveFor(h), plan.fingerprint);
    // Simulate a run that died after the move, before the database update.
    await h.client.execute("UPDATE files SET route_category = '_unsorted', route_reroutable = 1, target_path = '2610/AB1234/_unsorted/Case notes.pdf' WHERE route_category = 'Case Study'");
    const patches = h.graph.requests.filter((r) => r.method === 'PATCH').length;
    const replan = await planReroutes(h.ctx());
    const result = await applyReroutes(h.ctx(), driveFor(h), replan.fingerprint);
    assert.deepEqual([result.moved, result.recovered, result.failed.length], [0, 1, 0]);
    assert.equal(h.graph.requests.filter((r) => r.method === 'PATCH').length, patches);
  });

  it('never overwrites: a taken destination name fails that file and leaves both untouched', async () => {
    const h = await withUnsorted();
    h.graph.plant(`${h.ROOT}/2610/AB1234/Tutorials/Unit-T1.pdf`, Buffer.from('MINE'));
    const result = await applyReroutes(h.ctx(), driveFor(h), (await planReroutes(h.ctx())).fingerprint);
    assert.deepEqual([result.moved, result.failed.map((f) => f.reason)], [1, ['conflict 409 destinationTaken']]);
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Tutorials/Unit-T1.pdf`), Buffer.from('MINE'));
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/_unsorted/Unit-T1.pdf`), bytesFor(12, 200));
  });

  it('routes NEW files by stored rules at once, custom folders included, and says where', async () => {
    const h = await harness();
    await h.sync();
    await addRule(h.db, h.clock, { moduleCode: 'AB1234', field: 'filename', pattern: '\\bcase notes\\b', target: 'Case Study', priority: 10 });
    h.sent.length = 0;
    h.files.push({ id: 21, name: 'Case notes 2.pdf', size: 300, folder: 1 });
    await h.sync();
    assert.deepEqual(h.graph.fileBytes(`${h.ROOT}/2610/AB1234/Case Study/Case notes 2.pdf`), bytesFor(21, 300));
    assert.match(content(h).join('\n'), /Case notes 2\.pdf.* → Case Study · <a href=/);
  });
});

describe('Phase 6: follow-ups through a whole sync (D-61)', () => {
  const followupMessages = (h: H) => content(h).filter((t) => /Answer follow-ups/.test(t));
  async function enable(h: H) {
    await setConfig(h.db, h.clock, 'followups_enabled', 'true');
    await setConfig(h.db, h.clock, 'followup_partial_answers', 'keep_open');
  }
  const rows = async (h: H) =>
    (await h.client.execute('SELECT category, number, state, close_reason, baseline FROM followups ORDER BY number')).rows.map((r) =>
      [r['number'], r['state'], r['close_reason'], Number(r['baseline'])]);

  it('first run: records everything silently and sends ONE summary', async () => {
    const h = await harness();
    await enable(h);
    h.files.push(
      { id: 31, name: 'Lab 03.pdf', size: 100, folder: 8 },
      { id: 32, name: 'Lab 03 - Suggested Solutions.pdf', size: 100, folder: 8 },
      { id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 },
      { id: 34, name: 'starter-kit.zip', size: 100, folder: 8 },
    );
    await h.sync();
    assert.deepEqual(followupMessages(h).length, 1, content(h).join('\n---\n'));
    assert.match(followupMessages(h)[0]!, /Tracking 1 awaiting answers: AB1234 Lab 4, posted 18 Sep \(0 days\)\./);
    assert.doesNotMatch(content(h).join('\n'), /closes/, 'a pair recorded on the first run closes nothing anyone saw open');
    assert.deepEqual(await rows(h), [['3', 'closed', 'answered_on_arrival', 1], ['4', 'open', null, 1]]);
  });

  it('closes on the answer file\'s own notification, with no separate message', async () => {
    const h = await harness();
    await enable(h);
    h.files.push({ id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 });
    await h.sync();
    const before = followupMessages(h).length;
    h.files.push({ id: 35, name: 'Lab 04 - Suggested Solutions.pdf', size: 100, folder: 8 });
    await h.sync();
    assert.match(content(h).join('\n'), /Lab 04 - Suggested Solutions\.pdf[\s\S]*✅ closes AB1234 Lab 4/);
    assert.equal(followupMessages(h).length, before, 'no message of its own');
    assert.deepEqual((await rows(h)).map((r) => [r[0], r[1], r[2]]), [['4', 'closed', 'answers']]);
  });

  it('announces no close when question and answers arrive in the same run: nothing was open', async () => {
    const h = await harness();
    await enable(h);
    await h.sync();
    h.files.push({ id: 38, name: 'Lab 07.pdf', size: 100, folder: 8 }, { id: 39, name: 'Lab 07 - Suggested Solutions.pdf', size: 100, folder: 8 });
    await h.sync();
    assert.match(content(h).join('\n'), /Lab 07 - Suggested Solutions\.pdf/);
    assert.doesNotMatch(content(h).join('\n'), /closes/);
    assert.deepEqual((await rows(h)).map((r) => [r[0], r[1], r[2]]), [['7', 'closed', 'answered_on_arrival']]);
  });

  // Invented timetable: this module has a lab on Mondays at 09:00 SGT. The
  // harness files are posted Fri 18 Sep 2026, 20:03 SGT.
  async function mondayLabs(h: H) {
    await h.client.execute(`INSERT INTO lesson_slots (context_id, weekday, start_time, first_date, last_date, label, created_at)
                            VALUES (1, 1, '09:00', '2026-09-01', '2026-12-31', 'lab', '2026-09-01T00:00:00Z')`);
  }
  const reminders = (h: H) => content(h).filter((t) => /Answers still outstanding/.test(t));
  const at = (h: H, sgt: string) => h.clock.set(new Date(Date.parse(`${sgt}+08:00`)).toISOString());

  it('reminds on a lesson day at 07:00, only once a lesson has passed since posting, once a day, until answered', async () => {
    const h = await harness();
    await enable(h);
    await mondayLabs(h);
    h.files.push({ id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 });
    await h.sync(); // first run, Fri 18 Sep: Lab 4 opens
    at(h, '2026-09-21T07:10:00'); // Monday: the last lab (14 Sep) was BEFORE it was posted
    await h.sync();
    assert.equal(reminders(h).length, 0, 'not overdue yet');
    at(h, '2026-09-22T07:10:00'); // Tuesday: no lesson
    await h.sync();
    assert.equal(reminders(h).length, 0);
    at(h, '2026-09-28T06:40:00'); // Monday, before 07:00
    await h.sync();
    assert.equal(reminders(h).length, 0);
    at(h, '2026-09-28T07:10:00'); // the 21 Sep lab has passed since posting
    await h.sync();
    at(h, '2026-09-28T09:30:00');
    await h.sync();
    assert.equal(reminders(h).length, 1, 'once that day, whatever the number of runs');
    assert.match(reminders(h)[0]!, /AB1234 lab 09:00 today: Lab 4, posted 18 Sep \(9 days\)/);
    at(h, '2026-10-05T07:10:00'); // the next lab day: it repeats
    await h.sync();
    assert.equal(reminders(h).length, 2);
    h.files.push({ id: 35, name: 'Lab 04 - Suggested Solutions.pdf', size: 100, folder: 8 });
    at(h, '2026-10-07T12:00:00');
    await h.sync();
    at(h, '2026-10-12T07:10:00');
    await h.sync();
    assert.equal(reminders(h).length, 2, 'never for an answered item');
  });

  it('never reminds about a dismissed item', async () => {
    const h = await harness();
    await enable(h);
    await mondayLabs(h);
    h.files.push({ id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 });
    await h.sync();
    await h.client.execute("UPDATE followups SET state = 'dismissed', close_reason = 'dismissed', closed_at = '2026-09-20T00:00:00Z'");
    at(h, '2026-09-28T07:10:00');
    await h.sync();
    assert.equal(reminders(h).length, 0);
  });

  it('the first run sends its summary and no reminder, even on a lesson day with overdue items', async () => {
    const h = await harness();
    await mondayLabs(h);
    h.files.push({ id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 });
    await h.sync(); // follow-ups not on yet
    at(h, '2026-09-28T08:00:00'); // Monday, after 07:00, and the 21 Sep lab has passed
    await enable(h);
    await h.sync(); // the first run
    at(h, '2026-09-28T09:30:00');
    await h.sync(); // same morning: went live after 07:00, so nothing
    assert.deepEqual([followupMessages(h).length, reminders(h).length], [1, 0]);
    assert.match(followupMessages(h)[0]!, /Tracking 1 awaiting answers: AB1234 Lab 4, posted 18 Sep \(9 days\)\./);
    at(h, '2026-10-05T07:10:00');
    await h.sync();
    assert.equal(reminders(h).length, 1, 'from the next lesson day on');
  });

  it('a module with tracking switched off opens nothing and is never reminded about', async () => {
    const h = await harness();
    await enable(h);
    await mondayLabs(h);
    await h.client.execute('UPDATE courses SET followups_tracking = 0 WHERE context_id = 1');
    h.files.push({ id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 });
    await h.sync();
    at(h, '2026-09-28T07:10:00');
    await h.sync();
    assert.deepEqual(await rows(h), []);
    assert.match(followupMessages(h).join('\n'), /Tracking 0/);
    assert.equal(reminders(h).length, 0);
  });

  it('does nothing at all until the partial-answer ruling is set', async () => {
    const h = await harness();
    await setConfig(h.db, h.clock, 'followups_enabled', 'true');
    h.files.push({ id: 33, name: 'Lab 04.pdf', size: 100, folder: 8 });
    const outcome = await h.sync();
    assert.equal(outcome.followups?.status, 'awaiting_ruling');
    assert.equal(followupMessages(h).length, 0);
    assert.deepEqual(await rows(h), []);
  });
});

describe('Phase 8: the sync publishes the dashboard read model (D-65)', () => {
  async function readModel() {
    const dir = await mkdtemp(path.join(tmpdir(), 'rm-sync-'));
    temps.push(dir);
    const rm = createClient({ url: `file:${path.join(dir, 'rm.sqlite')}` });
    await rm.batch([...READMODEL_DDL, { sql: "INSERT INTO rm_meta (name, value) VALUES ('schema_version', ?)", args: [READMODEL_SCHEMA_VERSION] }], 'write');
    return rm;
  }

  it('publishes on a real run, and never on --dry-run', async () => {
    const h = await harness();
    h.files.push({ id: 1, name: 'Lecture 06.pdf', size: 1000, folder: 7 });
    const rm = await readModel();
    const dry = await runSync(h.ctx(true), { telegramApiBase: 'http://127.0.0.1:9', graphBase: h.graph.graphBase, loginBase: h.graph.loginBase, readModel: rm });
    assert.equal(dry.readModel, null);
    assert.equal((await rm.execute('SELECT count(*) AS n FROM rm_modules')).rows[0]?.['n'], 0);
    const real = await runSync(h.ctx(), { telegramApiBase: h.telegramUrl, graphBase: h.graph.graphBase, loginBase: h.graph.loginBase, readModel: rm });
    assert.equal(real.readModel, 'published');
    assert.deepEqual((await rm.execute('SELECT code, kind FROM rm_modules')).rows.map((r) => [r['code'], r['kind']]), [['AB1234', 'course']]);
    assert.ok(Number((await rm.execute("SELECT value FROM rm_health WHERE name = 'archived_files'")).rows[0]?.['value']) >= 1);
  });

  it('raises one ops alert, and carries on, when the read model cannot be published', async () => {
    const h = await harness();
    const dir = await mkdtemp(path.join(tmpdir(), 'rm-sync-'));
    temps.push(dir);
    const unmigrated = createClient({ url: `file:${path.join(dir, 'rm.sqlite')}` });
    const out = await runSync(h.ctx(), { telegramApiBase: h.telegramUrl, graphBase: h.graph.graphBase, loginBase: h.graph.loginBase, readModel: unmigrated });
    assert.equal(out.readModel, 'failed');
    assert.notEqual(out.status, 'failed', 'the sync itself is unaffected');
    assert.equal(ops(h).filter((t) => t.includes("dashboard's read model could not be updated")).length, 1);
  });
});
