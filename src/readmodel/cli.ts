/**
 * `npm run readmodel -- migrate | verify | publish` (DECISIONS.md D-65). Run by
 * the owner, locally: each touches the read-model database.
 *
 *   migrate  create the read model's tables (write token)
 *   verify   prove the separation is enforced BY TURSO, not by our code:
 *              1. the read-only token can read the read model;
 *              2. the read-only token is REFUSED a write (a no-op INSERT ... ON
 *                 CONFLICT DO NOTHING, so even a wrongly accepted write changes
 *                 nothing);
 *              3. the read-only token is REFUSED by the main database;
 *              4. the write token is REFUSED by the main database;
 *              5. the main database's token is REFUSED by the read model.
 *            A refusal counts only if it is an AUTHORISATION refusal: HTTP 401 or
 *            403, which is how Turso answers a wrong-database token. Any other
 *            failure -- a network blip, a server fault, a timeout -- is a FAIL,
 *            never a pass (D-66).
 *            Turso answers a write on the read-only token with BLOCKED (D-67),
 *            the same code it uses when a database's writes are blocked for
 *            everyone (a usage limit). So BLOCKED counts only with a CONTROL:
 *            immediately before, the WRITE token sends the IDENTICAL statement
 *            to the read model, and it must succeed. A block on the database
 *            would refuse the control too. And a BLOCKED whose reason names a
 *            limit or quota fails whatever the control says.
 *              6. the expiry recorded in the main database matches the
 *                 read-only token's own (read from the token; the date only).
 *            Prints PASS/FAIL, HTTP statuses, error codes and that date only --
 *            never a token or URL.
 *   publish  publish once now, from the main database (the sync does this each run)
 *
 * Tokens come from the environment (.env locally), never from argv or the
 * config table: READMODEL_DATABASE_URL, READMODEL_WRITE_TOKEN, READMODEL_READ_TOKEN.
 */

import { createClient, type Client } from '@libsql/client';
import { AppError } from '../core/errors.ts';
import { Config } from '../core/config.ts';
import type { RunContext } from '../core/run-context.ts';
import { publishReadModel } from './publish.ts';
import { READMODEL_DDL, READMODEL_SCHEMA_VERSION } from './schema.ts';

const env = (k: string): string => {
  const v = process.env[k];
  if (v === undefined || v.trim() === '') throw new AppError('config_missing', `${k} is not set (put it in .env; never on the command line).`);
  return v.trim();
};

/** Whether this process has been given the read model's URL and write token. */
export function readModelConfigured(): boolean {
  return (process.env['READMODEL_DATABASE_URL'] ?? '').trim() !== '' && (process.env['READMODEL_WRITE_TOKEN'] ?? '').trim() !== '';
}

/** The read model's URL and a token for it; the publisher's client. */
export function readModelClient(token: 'write' | 'read'): Client {
  return createClient({ url: env('READMODEL_DATABASE_URL'), authToken: env(token === 'write' ? 'READMODEL_WRITE_TOKEN' : 'READMODEL_READ_TOKEN') });
}

/** The HTTP status behind a libsql error, if any: the client keeps it on the error's `cause`. */
function httpStatus(error: unknown): number | null {
  let e: unknown = error;
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth += 1) {
    const status = (e as { status?: unknown }).status;
    if (typeof status === 'number') return status;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** Short, token-free description of a failure: its code and HTTP status, never its message text. */
function describe(error: unknown): string {
  const e = error as { code?: unknown; name?: unknown };
  const status = httpStatus(error);
  const code = [e.code, e.name].find((x) => typeof x === 'string' && x !== '') as string | undefined;
  return [code ?? 'error', status === null ? null : `HTTP ${status}`].filter((x) => x !== null).join(' ');
}

/**
 * What a BLOCKED refusal's reason says, classified here and never printed:
 * 'usage' (a limit, quota or plan block: never read-only enforcement),
 * 'read-only' (it names the token's permission), or 'unstated'.
 */
export type BlockedReason = 'usage' | 'read-only' | 'unstated';

export function blockedReason(error: unknown): BlockedReason | null {
  let e: unknown = error;
  let blocked = false;
  const texts: string[] = [];
  for (let depth = 0; depth < 5 && e !== null && typeof e === 'object'; depth += 1) {
    const x = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (x.code === 'BLOCKED') blocked = true;
    if (typeof x.message === 'string') texts.push(x.message);
    e = x.cause;
  }
  if (!blocked) return null;
  const text = texts.join(' ');
  if (/quota|limit|usage|exceed|billing|plan\b|storage|upgrade|suspend/i.test(text)) return 'usage';
  if (/read[- ]?only|readonly|permission|not authori[sz]ed|forbidden|write access/i.test(text)) return 'read-only';
  return 'unstated';
}

export type Outcome =
  | { ok: true }
  | { ok: false; authRefusal: boolean; blocked: BlockedReason | null; detail: string };

/** Run one request. A failure is an authorisation refusal only if the server answered 401 or 403. */
export async function attempt(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    const status = httpStatus(error);
    return { ok: false, authRefusal: status === 401 || status === 403, blocked: blockedReason(error), detail: describe(error) };
  }
}

/** The read-only write probe, and its control: the same statement, sent by each token. */
export const NO_OP_WRITE = {
  sql: "INSERT INTO rm_meta (name, value) VALUES ('schema_version', ?) ON CONFLICT (name) DO NOTHING",
  args: [READMODEL_SCHEMA_VERSION],
};

/**
 * Check 2's verdict. 401/403 passes on its own. BLOCKED passes only if the
 * write token's identical write succeeded just before, and the reason does not
 * name a usage limit. Anything else fails.
 */
export function readOnlyWriteVerdict(probe: Outcome, control: Outcome): { pass: boolean; got: string; control: string } {
  const controlLine = control.ok
    ? "control: the write token's identical write succeeded just before (it changed nothing)"
    : `control FAILED: the write token's identical write was refused too (${control.detail}), so writes are blocked for everyone and this proves nothing about the read-only token`;
  if (probe.ok) return { pass: false, got: 'allowed', control: controlLine };
  if (probe.authRefusal) return { pass: true, got: `refused (${probe.detail})`, control: controlLine };
  if (probe.blocked === 'usage') {
    return { pass: false, got: `blocked, and the reason names a usage limit, not the token (${probe.detail})`, control: controlLine };
  }
  if (probe.blocked !== null) {
    if (!control.ok) return { pass: false, got: `blocked, but the control failed (${probe.detail})`, control: controlLine };
    return { pass: true, got: `refused (${probe.detail}; reason ${probe.blocked === 'read-only' ? 'names read-only' : 'not stated'})`, control: controlLine };
  }
  return { pass: false, got: `error, not an authorisation refusal (${probe.detail})`, control: controlLine };
}

/** The `exp` claim of a Turso token (a JWT), as a Date; null if it has none. Reads the date, prints nothing. */
export function tokenExpiry(token: string): Date | null {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof payload.exp === 'number' ? new Date(payload.exp * 1000) : null;
  } catch {
    return null;
  }
}

const DAY_MS = 86_400_000;

/** Check 6: the recorded expiry is no later than the token's, and less than a day earlier. */
export function expiryCheck(tokenExp: Date | null, recorded: string | undefined): { pass: boolean; line: string } {
  const what = 'recorded expiry matches the read-only token';
  if (tokenExp === null) return { pass: false, line: `${what}: the token has NO expiry (create it with --expiration 90d)` };
  const actual = tokenExp.toISOString();
  if (recorded === undefined || recorded === '') {
    return { pass: false, line: `${what}: not recorded; the token expires ${actual}: npm run set-config dashboard_read_token_expires_at` };
  }
  const at = new Date(recorded).getTime();
  if (Number.isNaN(at)) return { pass: false, line: `${what}: the recorded value is not a date` };
  if (at > tokenExp.getTime()) return { pass: false, line: `${what}: recorded ${recorded} is LATER than the token's ${actual}, so alerts would come too late` };
  if (tokenExp.getTime() - at >= DAY_MS) return { pass: false, line: `${what}: recorded ${recorded} is a day or more before the token's ${actual}` };
  return { pass: true, line: `${what}: expires ${actual}` };
}

export async function runReadModelCli(ctx: RunContext, action: string | undefined): Promise<number> {
  if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') throw new AppError('usage', 'readmodel commands are for the owner, locally');
  const out = process.stdout;

  if (action === 'migrate') {
    const client = readModelClient('write');
    await client.batch([
      ...READMODEL_DDL,
      { sql: "INSERT INTO rm_meta (name, value) VALUES ('schema_version', ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value", args: [READMODEL_SCHEMA_VERSION] },
    ], 'write');
    out.write(`\nRead model schema ${READMODEL_SCHEMA_VERSION} is in place.\n\n`);
    return 0;
  }

  if (action === 'publish') {
    const result = await publishReadModel(ctx.db, readModelClient('write'), ctx.clock.now());
    out.write(`\nPublished: ${result.modules} modules, ${result.deadlines} deadlines, ${result.activity} activity items, ${result.followups} open follow-ups.\n\n`);
    return 0;
  }

  if (action === 'verify') {
    const read = readModelClient('read');
    const write = readModelClient('write'); // the control only: the read model, never the main database
    const readOnMain = createClient({ url: env('TURSO_DATABASE_URL'), authToken: env('READMODEL_READ_TOKEN') });
    const writeOnMain = createClient({ url: env('TURSO_DATABASE_URL'), authToken: env('READMODEL_WRITE_TOKEN') });
    const mainOnRead = createClient({ url: env('READMODEL_DATABASE_URL'), authToken: env('TURSO_AUTH_TOKEN') });

    const canRead = await attempt(() => read.execute("SELECT value FROM rm_meta WHERE name = 'schema_version'"));
    const control = await attempt(() => write.execute(NO_OP_WRITE)); // immediately before the probe
    const probe = await attempt(() => read.execute(NO_OP_WRITE));
    const writeVerdict = readOnlyWriteVerdict(probe, control);
    const checks: Array<{ what: string; want: 'allowed' | 'refused'; result: Outcome }> = [
      { what: 'read-only token reaches the MAIN database', want: 'refused', result: await attempt(() => readOnMain.execute('SELECT 1')) },
      { what: 'read-model write token reaches the MAIN database', want: 'refused', result: await attempt(() => writeOnMain.execute('SELECT 1')) },
      { what: 'main database token reaches the read model', want: 'refused', result: await attempt(() => mainOnRead.execute('SELECT 1')) },
    ];
    for (const c of [read, write, readOnMain, writeOnMain, mainOnRead]) c.close();

    let failed = 0;
    out.write('\n');
    if (!canRead.ok) failed += 1;
    out.write(`${canRead.ok ? 'PASS' : 'FAIL'}  read-only token reads the read model: ${canRead.ok ? 'allowed' : `refused (${canRead.detail})`}\n`);
    if (!writeVerdict.pass) failed += 1;
    out.write(`${writeVerdict.pass ? 'PASS' : 'FAIL'}  read-only token WRITES to the read model (a no-op insert): ${writeVerdict.got}\n`);
    out.write(`      ${writeVerdict.control}\n`);
    for (const c of checks) {
      const r = c.result;
      let pass: boolean;
      let got: string;
      if (r.ok) {
        pass = c.want === 'allowed';
        got = 'allowed';
      } else if (r.authRefusal) {
        pass = c.want === 'refused';
        got = `refused (${r.detail})`;
      } else {
        pass = false; // not an authorisation refusal: a fault proves nothing either way
        got = `error, not an authorisation refusal (${r.detail})`;
      }
      if (!pass) failed += 1;
      out.write(`${pass ? 'PASS' : 'FAIL'}  ${c.what}: ${got}\n`);
    }
    const config = await Config.load(ctx.db);
    const expiry = expiryCheck(tokenExpiry(env('READMODEL_READ_TOKEN')), config.get('dashboard_read_token_expires_at'));
    if (!expiry.pass) failed += 1;
    out.write(`${expiry.pass ? 'PASS' : 'FAIL'}  ${expiry.line}\n`);

    out.write(failed === 0 ? '\nAll checks pass: the separation is enforced by Turso.\n\n' : `\n${failed} check(s) FAILED. Do not deploy the dashboard.\n\n`);
    return failed === 0 ? 0 : 1;
  }

  throw new AppError('usage', 'Usage: npm run readmodel -- migrate | verify | publish');
}
