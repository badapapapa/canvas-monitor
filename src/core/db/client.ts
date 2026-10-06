import { createClient, type Client } from '@libsql/client';
import type { Bootstrap } from '../env.ts';
import { fetchWithTimeout } from './timeout-fetch.ts';

/** The main database. Every request over the network times out (D-77); a local file needs none. */
export function openClient(bootstrap: Bootstrap): Client {
  const client = bootstrap.authToken === undefined
    ? createClient({ url: bootstrap.databaseUrl, fetch: fetchWithTimeout() })
    : createClient({ url: bootstrap.databaseUrl, authToken: bootstrap.authToken, fetch: fetchWithTimeout() });
  return client;
}

/** Foreign keys are off by default in SQLite and must be enabled per connection. */
export async function enableForeignKeys(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');
}
