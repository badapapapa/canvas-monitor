import { createClient, type Client } from '@libsql/client';
import type { Bootstrap } from '../env.ts';

export function openClient(bootstrap: Bootstrap): Client {
  const client = bootstrap.authToken === undefined
    ? createClient({ url: bootstrap.databaseUrl })
    : createClient({ url: bootstrap.databaseUrl, authToken: bootstrap.authToken });
  return client;
}

/** Foreign keys are off by default in SQLite and must be enabled per connection. */
export async function enableForeignKeys(client: Client): Promise<void> {
  await client.execute('PRAGMA foreign_keys = ON');
}
