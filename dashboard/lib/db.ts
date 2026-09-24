/**
 * The dashboard's only database access (DECISIONS.md D-65).
 *
 * - One client, to the READ-MODEL database only, with a READ-ONLY token. The
 *   main database's URL and token are never given to the dashboard at all.
 * - `readRows` is the one way to query: it needs a VerifiedSession (so no code
 *   path reads data without having checked the session) and a statement that
 *   passes the read-only guard. There is no batch, transaction or write export.
 * - Errors are reduced to a generic failure: a driver message can quote SQL or
 *   a URL, and Vercel's logs must never hold course data.
 */

import { createClient, type Client, type InValue } from '@libsql/client';
import type { Secrets } from './env.ts';
import type { VerifiedSession } from './session.ts';
import { assertReadOnly } from './sql-guard.ts';

export class ReadModelUnavailable extends Error {}

let client: Client | null = null;
let clientFor = '';

function connect(s: Secrets): Client {
  if (client === null || clientFor !== s.readModelUrl) {
    client = createClient({ url: s.readModelUrl, authToken: s.readModelToken });
    clientFor = s.readModelUrl;
  }
  return client;
}

export async function readRows(
  session: VerifiedSession,
  secrets: Secrets,
  sql: string,
  args: InValue[] = [],
): Promise<Array<Record<string, unknown>>> {
  if (session.kind !== 'verified-session') throw new ReadModelUnavailable('no session');
  const statement = assertReadOnly(sql);
  try {
    const result = await connect(secrets).execute({ sql: statement, args });
    return result.rows as unknown as Array<Record<string, unknown>>;
  } catch {
    throw new ReadModelUnavailable('read model query failed');
  }
}
