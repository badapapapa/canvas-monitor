/**
 * Operational alerts (SPEC.md sections 2.1 and 12).
 *
 * Desired-state reconciliation: each run computes every alert condition that
 * is currently TRUE, and the difference from stored state drives what is sent.
 *
 *   condition true, not active   -> raise   (send)
 *   condition true, active       -> remind  (send, at most once per cadence)
 *   condition false, active      -> resolve (send "resolved")
 *
 * So a known outage pages once and then reminds on a slow cadence, instead of
 * every 20 minutes. A bot that pages on every run of a known outage gets
 * muted, and a muted ops channel is the silent failure section 2.1 forbids.
 *
 * Only conditions actually EVALUATED this run may be resolved: if Canvas auth
 * failed, context staleness could not be assessed, and an unassessed alert
 * must not be declared fixed.
 */

import type { Db } from '../core/db/writer.ts';
import { enqueueOps } from './queue.ts';

export interface AlertCondition {
  /**
   * `family@rung` keys form a LADDER (e.g. token_expiry@14, token_expiry@7):
   * climbing a rung resolves the previous one silently, and "resolved" is
   * announced only when the whole family clears. Otherwise crossing from T-14
   * to T-7 would send "Resolved: expires in 14 days" beside "expires in 7".
   */
  key: string;
  severity: 'warn' | 'critical';
  summary: string;
  detail?: string;
  /** Override the reminder cadence. `null` means never remind. */
  remindEveryMs?: number | null;
}

const REMIND_MS: Record<AlertCondition['severity'], number> = {
  critical: 6 * 3600_000,
  warn: 24 * 3600_000,
};

export interface ReconcileOutcome {
  raised: string[];
  reminded: string[];
  resolved: string[];
}

function family(key: string): string | null {
  const at = key.indexOf('@');
  return at === -1 ? null : key.slice(0, at);
}

/**
 * True when `key` was evaluated this run. An entry ending in ':' or '@' is a
 * family prefix; anything else must match exactly. Plain prefix matching would
 * let `coverage:1` claim `coverage:10` -- and resolve another course's alert.
 */
export function evaluated(key: string, entries: readonly string[]): boolean {
  return entries.some((p) => (p.endsWith(':') || p.endsWith('@') ? key.startsWith(p) : key === p));
}

export async function reconcileAlerts(
  db: Db,
  now: Date,
  active: readonly AlertCondition[],
  evaluatedPrefixes: readonly string[],
): Promise<ReconcileOutcome> {
  const nowIso = now.toISOString();
  const outcome: ReconcileOutcome = { raised: [], reminded: [], resolved: [] };

  const stored = await db.read('SELECT alert_key, last_sent_at, resolved_at, summary FROM ops_alerts');
  const byKey = new Map(
    stored.rows.map((r) => [
      String(r['alert_key']),
      {
        lastSentAt: r['last_sent_at'] === null ? null : String(r['last_sent_at']),
        resolved: r['resolved_at'] !== null,
        summary: String(r['summary']),
      },
    ]),
  );
  const activeKeys = new Set(active.map((c) => c.key));
  const activeFamilies = new Set(active.map((c) => family(c.key)).filter((f): f is string => f !== null));

  await db.transaction('reconcile ops alerts', async (tx) => {
    for (const condition of active) {
      const existing = byKey.get(condition.key);
      const isActive = existing !== undefined && !existing.resolved;

      if (!isActive) {
        await tx.write.execute('raise ops alert', {
          sql: `INSERT INTO ops_alerts
                  (alert_key, severity, summary, first_raised_at, last_raised_at, last_sent_at, resolved_at, occurrences)
                VALUES (?, ?, ?, ?, ?, ?, NULL, 1)
                ON CONFLICT(alert_key) DO UPDATE SET
                  severity = excluded.severity, summary = excluded.summary,
                  first_raised_at = excluded.first_raised_at, last_raised_at = excluded.last_raised_at,
                  last_sent_at = excluded.last_sent_at, resolved_at = NULL,
                  occurrences = ops_alerts.occurrences + 1`,
          args: [condition.key, condition.severity, condition.summary, nowIso, nowIso, nowIso],
        });
        await enqueueOps(tx, {
          sendKey: `${condition.key} raised ${nowIso}`,
          payload: {
            kind: 'ops',
            severity: condition.severity,
            summary: condition.summary,
            ...(condition.detail === undefined ? {} : { detail: condition.detail }),
          },
          now,
        });
        outcome.raised.push(condition.key);
        continue;
      }

      const cadence = condition.remindEveryMs === undefined ? REMIND_MS[condition.severity] : condition.remindEveryMs;
      const due =
        cadence !== null &&
        (existing.lastSentAt === null || now.getTime() - new Date(existing.lastSentAt).getTime() >= cadence);

      await tx.write.execute('refresh ops alert', {
        sql: `UPDATE ops_alerts SET last_raised_at = ?, severity = ?, summary = ?${due ? ', last_sent_at = ?' : ''}
               WHERE alert_key = ?`,
        args: due
          ? [nowIso, condition.severity, condition.summary, nowIso, condition.key]
          : [nowIso, condition.severity, condition.summary, condition.key],
      });
      if (due) {
        await enqueueOps(tx, {
          sendKey: `${condition.key} reminder ${nowIso}`,
          payload: {
            kind: 'ops',
            severity: condition.severity,
            summary: `Still unresolved: ${condition.summary}`,
            ...(condition.detail === undefined ? {} : { detail: condition.detail }),
          },
          now,
        });
        outcome.reminded.push(condition.key);
      }
    }

    for (const [key, row] of byKey) {
      if (row.resolved || activeKeys.has(key) || !evaluated(key, evaluatedPrefixes)) continue;

      await tx.write.execute('resolve ops alert', {
        sql: 'UPDATE ops_alerts SET resolved_at = ? WHERE alert_key = ?',
        args: [nowIso, key],
      });
      outcome.resolved.push(key);

      // A ladder rung resolving while its family is still active is a climb,
      // not a recovery. Say nothing.
      const f = family(key);
      if (f !== null && activeFamilies.has(f)) continue;

      await enqueueOps(tx, {
        sendKey: `${key} resolved ${nowIso}`,
        payload: { kind: 'ops', severity: 'warn', summary: row.summary, resolved: true },
        now,
      });
    }
  });

  return outcome;
}

/** One credential's expiry ladder: T-14, T-7, T-3, T-1, expired, and unknown. */
interface ExpiryLadder {
  family: string;
  /** Sentence subject, e.g. "The Canvas token". */
  subject: string;
  unknown: string;
  record: string;
  expired: string;
  rotate: string;
}

function expiryLadder(l: ExpiryLadder, daysRemaining: number | null): AlertCondition | null {
  if (daysRemaining === null) {
    return { key: `${l.family}@unknown`, severity: 'warn', summary: l.unknown, detail: l.record, remindEveryMs: null };
  }
  if (daysRemaining <= 0) {
    return { key: `${l.family}@expired`, severity: 'critical', summary: l.expired, detail: l.rotate };
  }
  const rung = daysRemaining <= 1 ? 1 : daysRemaining <= 3 ? 3 : daysRemaining <= 7 ? 7 : daysRemaining <= 14 ? 14 : null;
  if (rung === null) return null;
  return {
    key: `${l.family}@${rung}`,
    severity: rung <= 3 ? 'critical' : 'warn',
    summary: `${l.subject} expires in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'}.`,
    detail: l.rotate,
    remindEveryMs: null,
  };
}

/**
 * Canvas token expiry ladder: T-14, T-7, T-3, T-1 (SPEC.md section 12), plus
 * expired and unknown. Each rung is sent once, never reminded, except expired,
 * which reminds on the critical cadence because nothing works until it is
 * fixed.
 */
export function tokenExpiryCondition(daysRemaining: number | null): AlertCondition | null {
  return expiryLadder({
    family: 'token_expiry',
    subject: 'The Canvas token',
    unknown: 'Canvas token expiry is not recorded, so expiry alerts cannot fire.',
    record: 'Record the date Canvas showed when the token was created: npm run set-config canvas_token_expires_at',
    expired: 'The Canvas token has EXPIRED. Nothing is being synced.',
    rotate: 'Generate a new token in Canvas, then: npm run set-config canvas_token (and canvas_token_expires_at).',
  }, daysRemaining);
}

/**
 * The dashboard's read-only Turso token (DECISIONS.md D-66): the same ladder.
 * Only its expiry DATE is in the main database, never the token.
 */
export function dashboardTokenExpiryCondition(daysRemaining: number | null): AlertCondition | null {
  return expiryLadder({
    family: 'dashboard_token_expiry',
    subject: "The dashboard's read-only token",
    unknown: "The dashboard's read-only token expiry is not recorded, so its expiry alerts cannot fire.",
    record: 'Record it: npm run set-config dashboard_read_token_expires_at (npm run readmodel -- verify prints the date).',
    expired: "The dashboard's read-only token has EXPIRED. The dashboard shows nothing until it is rotated.",
    rotate: "Rotate it: README, 'Rotating the dashboard's read-only token'.",
  }, daysRemaining);
}
