/**
 * The dry-run seam (SPEC.md section 15).
 *
 * Every mutation in this program goes through `Db.write`. `--dry-run` swaps in
 * an implementation that logs the statement it would have run and executes
 * nothing. Reads go through `Db.read` and always hit the real database, so a
 * dry run still sees real state and makes real decisions.
 *
 * This is deliberately a type-level split rather than an `if (dryRun)` at each
 * call site: "a --dry-run flag on every command" survives a hundred call sites
 * only if forgetting it is impossible, not merely discouraged.
 *
 * Known and accepted limitation: in dry-run, `lastInsertRowid` is undefined and
 * `rowsAffected` is 0. Code that chains on an insert's generated ID will not
 * produce a realistic trace. Dry-run reports intent, not consequences.
 */

import type { Client, InStatement, ResultSet, Transaction } from '@libsql/client';
import type { Logger } from '../log.ts';

const EMPTY_RESULT: ResultSet = {
  columns: [],
  columnTypes: [],
  rows: [],
  rowsAffected: 0,
  lastInsertRowid: undefined,
  toJSON: () => ({ columns: [], rows: [], rowsAffected: 0 }),
};

export interface Mutator {
  /** `intent` is a short human-readable label; it lands in the dry-run log. */
  execute(intent: string, stmt: InStatement): Promise<ResultSet>;
  batch(intent: string, stmts: InStatement[]): Promise<ResultSet[]>;
}

export interface TxHandle {
  read(stmt: InStatement): Promise<ResultSet>;
  readonly write: Mutator;
}

export interface Db {
  readonly dryRun: boolean;
  read(stmt: InStatement): Promise<ResultSet>;
  readonly write: Mutator;
  /**
   * SPEC.md section 7: the transaction wraps the final write only. Never do
   * network I/O inside this callback -- fetching and downloading happen first,
   * outside, and the transaction exists purely to commit items and their
   * watermark together.
   */
  transaction<T>(intent: string, fn: (tx: TxHandle) => Promise<T>): Promise<T>;
  close(): void;
}

function describeStatement(stmt: InStatement): Record<string, unknown> {
  if (typeof stmt === 'string') return { sql: stmt };
  return { sql: stmt.sql, args: stmt.args };
}

class LiveMutator implements Mutator {
  private readonly run: (stmt: InStatement) => Promise<ResultSet>;
  private readonly runBatch: (stmts: InStatement[]) => Promise<ResultSet[]>;
  private readonly log: Logger;

  constructor(
    run: (stmt: InStatement) => Promise<ResultSet>,
    runBatch: (stmts: InStatement[]) => Promise<ResultSet[]>,
    log: Logger,
  ) {
    this.run = run;
    this.runBatch = runBatch;
    this.log = log;
  }

  async execute(intent: string, stmt: InStatement): Promise<ResultSet> {
    const result = await this.run(stmt);
    this.log.debug('db.write', { intent, rows_affected: result.rowsAffected });
    return result;
  }

  async batch(intent: string, stmts: InStatement[]): Promise<ResultSet[]> {
    const results = await this.runBatch(stmts);
    this.log.debug('db.write_batch', { intent, statements: stmts.length });
    return results;
  }
}

class DryRunMutator implements Mutator {
  private readonly log: Logger;

  constructor(log: Logger) {
    this.log = log;
  }

  execute(intent: string, stmt: InStatement): Promise<ResultSet> {
    this.log.info('db.write.skipped', { intent, dry_run: true, ...describeStatement(stmt) });
    return Promise.resolve(EMPTY_RESULT);
  }

  batch(intent: string, stmts: InStatement[]): Promise<ResultSet[]> {
    for (const stmt of stmts) {
      this.log.info('db.write.skipped', { intent, dry_run: true, ...describeStatement(stmt) });
    }
    return Promise.resolve(stmts.map(() => EMPTY_RESULT));
  }
}

export function createDb(client: Client, log: Logger, dryRun: boolean): Db {
  const write: Mutator = dryRun
    ? new DryRunMutator(log)
    : new LiveMutator(
        (stmt) => client.execute(stmt),
        (stmts) => client.batch(stmts, 'write'),
        log,
      );

  return {
    dryRun,
    read: (stmt) => client.execute(stmt),
    write,
    async transaction<T>(intent: string, fn: (tx: TxHandle) => Promise<T>): Promise<T> {
      const tx: Transaction = await client.transaction('write');
      const txWrite: Mutator = dryRun
        ? new DryRunMutator(log)
        : new LiveMutator(
            (stmt) => tx.execute(stmt),
            async (stmts) => {
              const out: ResultSet[] = [];
              for (const stmt of stmts) out.push(await tx.execute(stmt));
              return out;
            },
            log,
          );

      const handle: TxHandle = {
        read: (stmt) => tx.execute(stmt),
        write: txWrite,
      };

      try {
        const value = await fn(handle);
        if (dryRun) {
          // Nothing mutating was executed, so this is a no-op. It stays as
          // defence in depth: if a raw statement ever slips past the Mutator,
          // the rollback still guarantees a dry run mutates nothing.
          await tx.rollback();
          log.info('db.transaction.rolled_back', { intent, dry_run: true });
        } else {
          await tx.commit();
          log.debug('db.transaction.committed', { intent });
        }
        return value;
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally {
        tx.close();
      }
    },
    close: () => client.close(),
  };
}
