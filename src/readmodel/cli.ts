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
 *            Prints PASS/FAIL and error codes only -- never a token or URL.
 *   publish  publish once now, from the main database (the sync does this each run)
 *
 * Tokens come from the environment (.env locally), never from argv or the
 * config table: READMODEL_DATABASE_URL, READMODEL_WRITE_TOKEN, READMODEL_READ_TOKEN.
 */

import { createClient, type Client } from '@libsql/client';
import { AppError } from '../core/errors.ts';
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

/** Short, token-free description of a failure: its code or class, never its message text. */
function codeOf(error: unknown): string {
  const e = error as { code?: unknown; rawCode?: unknown; name?: unknown };
  return [e.code, e.rawCode, e.name].filter((x) => x !== undefined && x !== null && x !== '').map(String).join('/') || 'error';
}

async function outcome(run: () => Promise<unknown>): Promise<{ ok: true } | { ok: false; code: string }> {
  try {
    await run();
    return { ok: true };
  } catch (error) {
    return { ok: false, code: codeOf(error) };
  }
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
    const readOnMain = createClient({ url: env('TURSO_DATABASE_URL'), authToken: env('READMODEL_READ_TOKEN') });
    const writeOnMain = createClient({ url: env('TURSO_DATABASE_URL'), authToken: env('READMODEL_WRITE_TOKEN') });
    const mainOnRead = createClient({ url: env('READMODEL_DATABASE_URL'), authToken: env('TURSO_AUTH_TOKEN') });

    const checks: Array<{ what: string; want: 'allowed' | 'refused'; result: Awaited<ReturnType<typeof outcome>> }> = [
      { what: 'read-only token reads the read model', want: 'allowed', result: await outcome(() => read.execute("SELECT value FROM rm_meta WHERE name = 'schema_version'")) },
      {
        what: 'read-only token WRITES to the read model (a no-op insert)', want: 'refused',
        result: await outcome(() => read.execute({ sql: "INSERT INTO rm_meta (name, value) VALUES ('schema_version', ?) ON CONFLICT (name) DO NOTHING", args: [READMODEL_SCHEMA_VERSION] })),
      },
      { what: 'read-only token reaches the MAIN database', want: 'refused', result: await outcome(() => readOnMain.execute('SELECT 1')) },
      { what: 'read-model write token reaches the MAIN database', want: 'refused', result: await outcome(() => writeOnMain.execute('SELECT 1')) },
      { what: 'main database token reaches the read model', want: 'refused', result: await outcome(() => mainOnRead.execute('SELECT 1')) },
    ];
    let failed = 0;
    out.write('\n');
    for (const c of checks) {
      const got = c.result.ok ? 'allowed' : 'refused';
      const pass = got === c.want;
      if (!pass) failed += 1;
      out.write(`${pass ? 'PASS' : 'FAIL'}  ${c.what}: ${got}${c.result.ok ? '' : ` (${c.result.code})`}\n`);
    }
    out.write(failed === 0 ? '\nAll separation checks pass: enforced by Turso.\n\n' : `\n${failed} check(s) FAILED. Do not deploy the dashboard.\n\n`);
    return failed === 0 ? 0 : 1;
  }

  throw new AppError('usage', 'Usage: npm run readmodel -- migrate | verify | publish');
}
