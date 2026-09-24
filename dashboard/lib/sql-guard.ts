/**
 * The dashboard reads; it never writes (DECISIONS.md D-65). Three layers:
 *   1. Turso: its token is READ-ONLY, for the read-model database only
 *      (`npm run readmodel -- verify` proves Turso refuses a write);
 *   2. this guard: every statement must be one SELECT (or WITH ... SELECT),
 *      with no write keyword anywhere;
 *   3. a test that fails the build if write SQL, or any client method that
 *      could write (batch, transaction, executeMultiple, migrate, sync),
 *      appears anywhere in the dashboard's code.
 */

export class WriteRefused extends Error {}

const WRITE_WORDS = /\b(insert|update|delete|replace|upsert|create|drop|alter|attach|detach|pragma|vacuum|reindex|analyze|truncate|begin|commit|rollback|savepoint|release)\b/i;

export function assertReadOnly(sql: string): string {
  const text = sql.trim();
  if (!/^(select|with)\b/i.test(text)) throw new WriteRefused('only SELECT statements');
  if (text.includes(';')) throw new WriteRefused('one statement only');
  if (WRITE_WORDS.test(text.replace(/'(?:[^']|'')*'/g, "''"))) throw new WriteRefused('a write keyword');
  return text;
}
