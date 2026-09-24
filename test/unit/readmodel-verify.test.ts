/**
 * `npm run readmodel -- verify` (DECISIONS.md D-66), against fake Turso
 * servers: a refusal counts only when it is an AUTHORISATION refusal (HTTP 401
 * or 403). A server fault, a network failure or an accepted request is a FAIL.
 * The real Turso answers a read-only write with BLOCKED at HTTP 200 (D-67),
 * which counts only when the write token's identical write succeeds just
 * before it (the control). And the recorded expiry must match the token's own.
 *
 * Invented tokens, built at runtime; nothing here is a real credential.
 */

import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient } from '@libsql/client';
import { migrate } from '../../src/core/db/migrate.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { startRun } from '../../src/core/run-context.ts';
import { expiryCheck, runReadModelCli, tokenExpiry } from '../../src/readmodel/cli.ts';

const clock = fixedClock('2026-09-24T13:00:00Z');
const EXP = Date.parse('2026-12-23T12:04:31Z') / 1000;
const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** A JWT-shaped invented token with the given claims. */
const token = (claims: object, tag: string) => [b64({ alg: 'EdDSA', typ: 'JWT' }), b64(claims), `sig${tag}`].join('.');
const READ = token({ a: 'ro', exp: EXP }, 'read');
const WRITE = token({}, 'write');
const MAIN = token({}, 'main');

const servers: Server[] = [];
const temps: string[] = [];
after(async () => {
  for (const s of servers) s.close();
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

interface FakeTurso {
  /** token -> what it may do here */
  tokens: Record<string, 'rw' | 'ro'>;
  /** status for a token this database does not know */
  foreign: number;
  /**
   * A write on a read-only token: an HTTP status; 'blocked', as the real Turso
   * answers (HTTP 200, a statement error with code BLOCKED); or 'accept', the
   * failure verify must catch.
   */
  readOnlyWrite: number | 'blocked' | 'accept';
  /** Writes blocked for EVERY token (a usage limit), with this reason. */
  writesBlocked?: string;
  /**
   * The reason text on a read-only BLOCKED. Turso's names the read-only
   * permission (the owner's verify run, D-68); its exact wording is never
   * printed, so the fakes use their own.
   */
  readOnlyReason?: string | undefined;
}

/** How Turso reports a blocked statement: HTTP 200, the error inside the pipeline results. */
const blockedResult = (reason?: string) => ({ type: 'error', error: { message: `Operation was blocked${reason === undefined ? '' : `: ${reason}`}`, code: 'BLOCKED' } });

/** Just enough of Hrana-over-HTTP v2 (JSON) for `client.execute`. */
async function fakeTurso(f: FakeTurso): Promise<string> {
  const server = createServer((req, res) => {
    if (req.method === 'GET') { res.writeHead(404).end(); return; } // no v3: the client falls back to v2 JSON
    let body = '';
    req.on('data', (d: Buffer) => (body += d.toString()));
    req.on('end', () => {
      const bearer = (req.headers['authorization'] ?? '').replace(/^Bearer /, '');
      const deny = (status: number): void => { res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'Unauthorized' })); };
      const role = f.tokens[bearer];
      if (role === undefined) { deny(f.foreign); return; }
      const requests = (JSON.parse(body) as { requests: Array<{ type: string; stmt?: { sql: string } }> }).requests;
      const isWrite = (r: { stmt?: { sql: string } }) => /^\s*insert/i.test(r.stmt?.sql ?? '');
      if (requests.some(isWrite) && role === 'ro' && typeof f.readOnlyWrite === 'number') { deny(f.readOnlyWrite); return; }
      const results = requests.map((r) => {
        if (r.type !== 'execute') return { type: 'ok', response: { type: r.type } };
        if (isWrite(r) && f.writesBlocked !== undefined) return blockedResult(f.writesBlocked);
        if (isWrite(r) && role === 'ro' && f.readOnlyWrite === 'blocked') return blockedResult(f.readOnlyReason);
        return { type: 'ok', response: { type: 'execute', result: { cols: [{ name: 'value', decltype: null }], rows: [[{ type: 'text', value: '1' }]], affected_row_count: 0, last_insert_rowid: null } } };
      });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ baton: null, base_url: null, results }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** A port nothing listens on: a network failure. */
async function deadUrl(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}`;
}

async function verify(opts: { main: string; readModel: string; recorded?: string; readToken?: string }): Promise<{ code: number; out: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'rm-verify-'));
  temps.push(dir);
  const url = `file:${path.join(dir, 'main.sqlite')}`;
  const db = createClient({ url });
  await migrate(db, silentLogger(), clock, { dryRun: false });
  if (opts.recorded !== undefined) {
    await db.execute({ sql: "INSERT INTO config (key, value, secret, updated_at) VALUES ('dashboard_read_token_expires_at', ?, 0, ?)", args: [opts.recorded, clock.now().toISOString()] });
  }
  db.close();
  const ctx = await startRun({
    command: 'test', dryRun: false, recordRun: false, clock, sink: () => {},
    bootstrap: { databaseUrl: url, authToken: undefined, logLevel: 'error', ci: false, scheduledFor: undefined, cronSchedule: undefined, host: 'test' },
  });

  const env = {
    TURSO_DATABASE_URL: opts.main, TURSO_AUTH_TOKEN: MAIN,
    READMODEL_DATABASE_URL: opts.readModel, READMODEL_WRITE_TOKEN: WRITE, READMODEL_READ_TOKEN: opts.readToken ?? READ,
    CI: undefined, GITHUB_ACTIONS: undefined,
  };
  const saved = Object.fromEntries(Object.keys(env).map((k) => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const write = process.stdout.write.bind(process.stdout);
  let out = '';
  process.stdout.write = ((chunk: string | Uint8Array) => ((out += String(chunk)), true)) as typeof process.stdout.write;
  try {
    return { code: await runReadModelCli(ctx, 'verify'), out };
  } finally {
    process.stdout.write = write;
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

const RECORDED = '2026-12-23T12:00:00Z';
/** As the real Turso behaved (2026-09-24): 401 for a wrong-database token, BLOCKED for a read-only write. */
const good = (): FakeTurso => ({ tokens: {}, foreign: 401, readOnlyWrite: 'blocked', readOnlyReason: 'the token is read-only' });
const worlds = async (main: Partial<FakeTurso> = {}, readModel: Partial<FakeTurso> = {}) => ({
  main: await fakeTurso({ ...good(), tokens: { [MAIN]: 'rw' }, ...main }),
  readModel: await fakeTurso({ ...good(), tokens: { [WRITE]: 'rw', [READ]: 'ro' }, ...readModel }),
});
const lines = (out: string) => out.split('\n').filter((l) => /^(PASS|FAIL)/.test(l));

describe('readmodel verify: only an authorisation refusal is a pass', () => {
  it('passes all six checks as the real Turso answers (401 across databases, BLOCKED with a passing control), and prints no token or URL', async () => {
    const w = await worlds();
    const r = await verify({ ...w, recorded: RECORDED });
    assert.equal(r.code, 0, r.out);
    assert.equal(lines(r.out).length, 6);
    assert.ok(lines(r.out).every((l) => l.startsWith('PASS')), r.out);
    assert.match(r.out, /MAIN database: refused \(SERVER_ERROR HTTP 401\)/);
    assert.match(r.out, /PASS {2}read-only token WRITES to the read model \(a no-op insert\): refused \(BLOCKED; reason names read-only\)/);
    assert.match(r.out, /control: the write token's identical write succeeded just before/);
    assert.ok(!r.out.includes('Operation was blocked'), 'no error message text is printed');
    assert.match(r.out, /expires 2026-12-23T12:04:31\.000Z/);
    for (const secret of [READ, WRITE, MAIN, 'sigread', 'sigwrite', 'sigmain', w.main, w.readModel, '127.0.0.1']) {
      assert.ok(!r.out.includes(secret), 'verify printed a token or a URL');
    }
  });

  it('accepts 401 and 403 as authorisation refusals too', async () => {
    assert.equal((await verify({ ...(await worlds({}, { readOnlyWrite: 401 })), recorded: RECORDED })).code, 0);
    const w = await worlds({ foreign: 403 }, { foreign: 403, readOnlyWrite: 403 });
    assert.equal((await verify({ ...w, recorded: RECORDED })).code, 0);
  });

  it('FAILS when the refusal is a server fault (HTTP 500), not an authorisation refusal', async () => {
    const w = await worlds({ foreign: 500 }, { foreign: 502, readOnlyWrite: 500 });
    const r = await verify({ ...w, recorded: RECORDED });
    assert.equal(r.code, 1);
    const fails = lines(r.out).filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 4, r.out);
    assert.ok(fails.every((l) => /error, not an authorisation refusal \(SERVER_ERROR HTTP 50[02]\)/.test(l)), r.out);
  });

  it('FAILS when a database cannot be reached at all (a network failure)', async () => {
    const w = await worlds();
    const r = await verify({ main: await deadUrl(), readModel: w.readModel, recorded: RECORDED });
    assert.equal(r.code, 1);
    const fails = lines(r.out).filter((l) => l.startsWith('FAIL'));
    assert.equal(fails.length, 2, r.out);
    assert.ok(fails.every((l) => /MAIN database: error, not an authorisation refusal/.test(l)), r.out);
  });

  it('FAILS when the read-only token is allowed to write', async () => {
    const w = await worlds({}, { readOnlyWrite: 'accept' });
    const r = await verify({ ...w, recorded: RECORDED });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}read-only token WRITES to the read model \(a no-op insert\): allowed/);
  });

  it('FAILS when a token reaches the other database', async () => {
    const w = await worlds({ tokens: { [MAIN]: 'rw', [READ]: 'ro' } });
    const r = await verify({ ...w, recorded: RECORDED });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}read-only token reaches the MAIN database: allowed/);
  });
});

describe('readmodel verify: the recorded expiry matches the read-only token', () => {
  const exp = new Date(EXP * 1000);
  it('reads the expiry claim from the token, and nothing else', () => {
    assert.equal(tokenExpiry(READ)?.toISOString(), '2026-12-23T12:04:31.000Z');
    assert.equal(tokenExpiry(WRITE), null);
    assert.equal(tokenExpiry('not-a-jwt'), null);
  });
  it('passes when recorded no later than the token, and less than a day earlier', () => {
    assert.equal(expiryCheck(exp, '2026-12-23T12:00:00Z').pass, true);
    assert.equal(expiryCheck(exp, '2026-12-23T12:04:31Z').pass, true);
  });
  it('fails when not recorded, later than the token, a day or more early, or the token never expires', () => {
    assert.match(expiryCheck(exp, undefined).line, /not recorded; the token expires 2026-12-23T12:04:31\.000Z/);
    assert.match(expiryCheck(exp, '2026-12-24T00:00:00Z').line, /LATER/);
    assert.equal(expiryCheck(exp, '2026-12-22T12:00:00Z').pass, false);
    assert.match(expiryCheck(null, RECORDED).line, /NO expiry/);
  });
  it('fails verify as a whole when the expiry is not recorded', async () => {
    const w = await worlds();
    const r = await verify({ ...w });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}recorded expiry matches the read-only token: not recorded/);
  });
});

describe('readmodel verify: BLOCKED counts only with the control (D-67)', () => {
  it('FAILS when writes are blocked for every token (a usage limit): the control fails, and says so', async () => {
    // A database-wide block with no stated reason: BLOCKED for the read-only token AND the write token.
    const w = await worlds({}, { writesBlocked: '' });
    const r = await verify({ ...w, recorded: RECORDED });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}read-only token WRITES to the read model \(a no-op insert\): blocked, but the control failed \(BLOCKED\)/);
    assert.match(r.out, /control FAILED: the write token's identical write was refused too \(BLOCKED\)/);
    assert.equal(lines(r.out).filter((l) => l.startsWith('FAIL')).length, 1, r.out);
  });

  it('FAILS a BLOCKED whose reason names a usage limit, even with a passing control', async () => {
    const w = await worlds({}, { readOnlyReason: 'monthly write quota exceeded' });
    const r = await verify({ ...w, recorded: RECORDED });
    assert.equal(r.code, 1);
    assert.match(r.out, /FAIL {2}read-only token WRITES to the read model \(a no-op insert\): blocked, and the reason names a usage limit/);
    assert.ok(!r.out.includes('quota'), 'the reason text itself is not printed');
  });

  it('FAILS a BLOCKED whose reason does not name the read-only permission, even with a passing control (D-68)', async () => {
    for (const reason of [undefined, 'maintenance']) {
      const w = await worlds({}, { readOnlyReason: reason });
      const r = await verify({ ...w, recorded: RECORDED });
      assert.equal(r.code, 1, String(reason));
      assert.match(r.out, /FAIL {2}read-only token WRITES to the read model \(a no-op insert\): blocked, but the reason does not name the read-only permission \(BLOCKED\)/);
      assert.match(r.out, /control: the write token's identical write succeeded just before/);
      assert.ok(!r.out.includes('maintenance') && !r.out.includes('Operation was blocked'), 'the reason text is not printed');
    }
  });

});
