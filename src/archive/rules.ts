/**
 * Per-module routing rules, as data (DECISIONS.md D-57). The rows name real
 * folders and files, so they live only in the database, never in this
 * repository.
 */

import type { Db } from '../core/db/writer.ts';
import type { Clock } from '../core/clock.ts';
import { AppError } from '../core/errors.ts';
import { patternProblem, targetProblem, type RuleField, type StoredRule } from './route.ts';

export interface RuleRow extends StoredRule {
  contextId: number;
  moduleCode: string | null;
}

export async function listRules(db: Db, contextIds?: readonly number[]): Promise<RuleRow[]> {
  const rows = await db.read(
    `SELECT r.id, r.context_id, r.match_field, r.pattern, r.target_folder, r.priority, c.module_code
       FROM routing_rules r LEFT JOIN courses c ON c.context_id = r.context_id
      ${contextIds === undefined ? '' : `WHERE r.context_id IN (${contextIds.map((n) => Number(n)).join(',') || 'NULL'})`}
      ORDER BY r.context_id, r.priority, r.id`,
  );
  return rows.rows.map((r) => ({
    id: Number(r['id']),
    contextId: Number(r['context_id']),
    field: String(r['match_field']) as RuleField,
    pattern: String(r['pattern']),
    target: String(r['target_folder']),
    priority: Number(r['priority']),
    moduleCode: r['module_code'] === null ? null : String(r['module_code']),
  }));
}

/** Rules grouped by context, for routing. */
export async function loadRules(db: Db): Promise<Map<number, StoredRule[]>> {
  const out = new Map<number, StoredRule[]>();
  for (const r of await listRules(db)) {
    const list = out.get(r.contextId) ?? [];
    list.push(r);
    out.set(r.contextId, list);
  }
  return out;
}

export async function addRule(
  db: Db,
  clock: Clock,
  rule: { moduleCode: string; field: RuleField; pattern: string; target: string; priority: number },
): Promise<number> {
  const ctx = await db.read({ sql: 'SELECT context_id FROM courses WHERE module_code = ?', args: [rule.moduleCode] });
  if (ctx.rows.length !== 1) throw new AppError('usage', `No single course with module code "${rule.moduleCode}" (found ${ctx.rows.length}).`);
  const t = targetProblem(rule.target);
  if (t !== null) throw new AppError('usage', `Target folder "${rule.target}": ${t}.`);
  const p = patternProblem(rule.field, rule.pattern);
  if (p !== null) throw new AppError('usage', `Pattern: ${p}.`);
  const result = await db.write.execute('add routing rule', {
    sql: `INSERT INTO routing_rules (context_id, match_field, pattern, target_folder, priority, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    args: [Number(ctx.rows[0]!['context_id']), rule.field, rule.pattern, rule.target, rule.priority, clock.now().toISOString()],
  });
  return Number(result?.lastInsertRowid ?? 0);
}

export async function removeRule(db: Db, id: number): Promise<void> {
  await db.write.execute('remove routing rule', { sql: 'DELETE FROM routing_rules WHERE id = ?', args: [id] });
}
