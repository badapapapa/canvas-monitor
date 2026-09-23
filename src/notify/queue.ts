/**
 * The notification queue (SPEC.md section 12; DECISIONS.md D-04, D-05).
 *
 * Delivery is at-least-once, and the queue is what makes it so. A content
 * notification is inserted in the SAME transaction that records its items and
 * stamps their `notified_at`, then sent by a separate flush. A crash between
 * the two leaves a queued row the next run sends; there is no window in which
 * an item is marked notified but no notification exists to deliver it.
 *
 * The residual duplicate window is "Telegram accepted it, then the process
 * died before marking it sent": one message, re-sent once. That is the
 * at-least-once cost, stated rather than hidden.
 */

import { followupLabel, type FollowupCategory } from '../followups/classify.ts';
import { sha256 } from '../ingest/normalise.ts';
import { isQuietHours, quietHoursReleaseAt } from '../core/time.ts';
import type { Db, TxHandle } from '../core/db/writer.ts';
import type { Logger } from '../core/log.ts';
import { render, renderDigest, type ContentPayload, type NoticePayload, type OpsPayload, type Payload, type WatchingPayload } from './render.ts';
import type { TelegramClient } from './telegram.ts';

/** After this many retryable failures a notification is marked failed. */
export const MAX_ATTEMPTS = 5;

export interface ItemRef {
  id: string;
  contentHash: string;
}

/**
 * Includes each item's CONTENT version, not only its id. An assignment whose
 * due date moves twice has the same id both times; an id-only key would
 * collide on the UNIQUE constraint and the second change would be silently
 * dropped -- idempotency causing the loss it exists to prevent.
 */
export function batchKey(scope: string, refs: readonly ItemRef[]): string {
  const parts = refs.map((r) => `${r.id}:${r.contentHash}`).sort();
  return sha256(`${scope}\n${parts.join('\n')}`);
}

function releaseAfter(now: Date, urgent: boolean): string | null {
  if (urgent || !isQuietHours(now)) return null;
  return quietHoursReleaseAt(now).toISOString();
}

type Writer = Pick<TxHandle, 'write'>;

export async function enqueueContent(
  tx: Writer,
  args: { contextId: number; refs: ItemRef[]; payload: ContentPayload; urgent: boolean; now: Date },
): Promise<void> {
  const nowIso = args.now.toISOString();
  await tx.write.execute('enqueue content notification', {
    sql: `INSERT INTO notifications
            (batch_key, channel, context_id, state, urgent, release_after, created_at, item_ids, payload)
          VALUES (?, 'content', ?, 'queued', ?, ?, ?, ?, ?)
          ON CONFLICT(batch_key) DO NOTHING`,
    args: [
      batchKey('content', args.refs),
      args.contextId,
      args.urgent ? 1 : 0,
      releaseAfter(args.now, args.urgent),
      nowIso,
      JSON.stringify(args.refs.map((r) => r.id)),
      JSON.stringify(args.payload),
    ],
  });
  // A conflict above means this exact content was already queued or sent, so
  // stamping the items as notified is correct either way.
  const placeholders = args.refs.map(() => '?').join(', ');
  await tx.write.execute('mark items notified', {
    sql: `UPDATE items SET notified_at = ?, state = 'seen' WHERE id IN (${placeholders})`,
    args: [nowIso, ...args.refs.map((r) => r.id)],
  });
}

export async function enqueueWatching(
  tx: Writer,
  args: { scopeKey: string; payload: WatchingPayload; now: Date },
): Promise<void> {
  await tx.write.execute('enqueue now-watching summary', {
    sql: `INSERT INTO notifications
            (batch_key, channel, context_id, state, urgent, release_after, created_at, item_ids, payload)
          VALUES (?, 'content', NULL, 'queued', 0, ?, ?, '[]', ?)
          ON CONFLICT(batch_key) DO NOTHING`,
    args: [
      sha256(`watching\n${args.scopeKey}`),
      releaseAfter(args.now, false),
      args.now.toISOString(),
      JSON.stringify(args.payload),
    ],
  });
}

/** A one-off content-chat notice, e.g. "archive caught up". Keyed by `sendKey`. */
export async function enqueueNotice(tx: Writer, args: { sendKey: string; payload: NoticePayload; now: Date }): Promise<void> {
  await tx.write.execute('enqueue notice', {
    sql: `INSERT INTO notifications
            (batch_key, channel, context_id, state, urgent, release_after, created_at, item_ids, payload)
          VALUES (?, 'content', NULL, 'queued', 0, ?, ?, '[]', ?)
          ON CONFLICT(batch_key) DO NOTHING`,
    args: [sha256(`notice\n${args.sendKey}`), releaseAfter(args.now, false), args.now.toISOString(), JSON.stringify(args.payload)],
  });
}

/**
 * Join each file in a content payload to its archive state, at send time.
 * The archive stage runs before the flush in the same sync, so a file
 * uploaded in this run already carries its OneDrive link (D-52).
 */
async function enrichFiles(db: Db, payload: Payload): Promise<void> {
  if (payload.kind !== 'content') return;
  const ids = payload.items.filter((i) => i.resourceType === 'file' && i.itemId !== undefined).map((i) => i.itemId as string);
  if (ids.length === 0) return;
  const rows = await db.read({
    sql: `SELECT id, route_category, share_url, download_state FROM files WHERE id IN (${ids.map(() => '?').join(', ')})`,
    args: ids,
  });
  const byId = new Map(rows.rows.map((r) => [String(r['id']), r]));
  for (const item of payload.items) {
    const row = item.itemId === undefined ? undefined : byId.get(item.itemId);
    if (row === undefined || item.file === undefined) continue;
    item.file.route = row['route_category'] === null ? null : String(row['route_category']);
    item.file.archiveUrl = row['share_url'] === null ? null : String(row['share_url']);
    item.file.archiveState = String(row['download_state']);
  }
  // The follow-up this file closed, if any (D-61): a line on this message,
  // never a message of its own. Only a live close by answers ('answers'),
  // including of a follow-up the first run opened. A pair recorded silently
  // ('answered_on_arrival') closes nothing anyone saw open.
  const closes = await db.read({
    sql: `SELECT f.closed_by_file_id, f.category, f.number, c.module_code
            FROM followups f JOIN courses c ON c.context_id = f.context_id
           WHERE f.closed_by_file_id IN (${ids.map(() => '?').join(', ')}) AND f.close_reason = 'answers'`,
    args: ids,
  });
  const closing = new Map(closes.rows.map((r) => [String(r['closed_by_file_id']), `${String(r['module_code'])} ${followupLabel(String(r['category']) as FollowupCategory, String(r['number']))}`]));
  for (const item of payload.items) {
    const label = item.itemId === undefined ? undefined : closing.get(item.itemId);
    if (label !== undefined && item.file !== undefined) item.file.closes = label;
  }
}

export async function enqueueOps(tx: Writer, args: { sendKey: string; payload: OpsPayload; now: Date }): Promise<void> {
  await tx.write.execute('enqueue ops alert', {
    sql: `INSERT INTO notifications
            (batch_key, channel, context_id, state, urgent, release_after, created_at, item_ids, payload)
          VALUES (?, 'ops', NULL, 'queued', 0, NULL, ?, '[]', ?)
          ON CONFLICT(batch_key) DO NOTHING`,
    args: [sha256(`ops\n${args.sendKey}`), args.now.toISOString(), JSON.stringify(args.payload)],
  });
}

interface QueuedRow {
  id: number;
  channel: 'content' | 'ops';
  held: boolean;
  attempts: number;
  payload: Payload;
}

export interface FlushOutcome {
  sent: number;
  retrying: number;
  failed: number;
  stillHeld: number;
  messages: number;
  /** Rendered messages, populated only under dry-run, for preview. */
  preview: Array<{ channel: 'content' | 'ops'; text: string }>;
}

export interface Chats {
  content: string;
  ops: string;
}

/**
 * Send everything due. Content held through quiet hours is merged into one
 * digest; operational alerts are never held, but are delivered silently
 * during quiet hours (DECISIONS.md D-42).
 */
export async function flush(
  env: { db: Db; log: Logger; now: Date; dryRun: boolean },
  telegram: TelegramClient | null,
  chats: Chats | null,
): Promise<FlushOutcome> {
  const nowIso = env.now.toISOString();
  const outcome: FlushOutcome = { sent: 0, retrying: 0, failed: 0, stillHeld: 0, messages: 0, preview: [] };

  const due = await env.db.read({
    sql: `SELECT id, channel, release_after, attempts, payload FROM notifications
           WHERE state = 'queued' AND (release_after IS NULL OR release_after <= ?)
           ORDER BY id`,
    args: [nowIso],
  });
  const held = await env.db.read({
    sql: `SELECT count(*) AS n FROM notifications WHERE state = 'queued' AND release_after > ?`,
    args: [nowIso],
  });
  outcome.stillHeld = Number(held.rows[0]?.['n'] ?? 0);

  const rows: QueuedRow[] = due.rows.map((r) => ({
    id: Number(r['id']),
    channel: r['channel'] === 'ops' ? 'ops' : 'content',
    held: r['release_after'] !== null,
    attempts: Number(r['attempts'] ?? 0),
    payload: JSON.parse(String(r['payload'])) as Payload,
  }));
  for (const row of rows) await enrichFiles(env.db, row.payload);

  // Group into send units: one per notification, except that content held
  // through quiet hours is merged into a single morning digest.
  const units: Array<{ ids: number[]; channel: 'content' | 'ops'; messages: string[]; attempts: number }> = [];
  const heldContent = rows.filter((r) => r.channel === 'content' && r.held && r.payload.kind === 'content');
  if (heldContent.length > 1) {
    units.push({
      ids: heldContent.map((r) => r.id),
      channel: 'content',
      messages: renderDigest(heldContent.map((r) => r.payload as ContentPayload), env.now),
      attempts: Math.max(...heldContent.map((r) => r.attempts)),
    });
  }
  const merged = new Set(heldContent.length > 1 ? heldContent.map((r) => r.id) : []);
  for (const row of rows) {
    if (merged.has(row.id)) continue;
    units.push({ ids: [row.id], channel: row.channel, messages: render(row.payload, env.now), attempts: row.attempts });
  }

  const silent = isQuietHours(env.now);

  for (const unit of units) {
    if (env.dryRun || telegram === null || chats === null) {
      for (const text of unit.messages) outcome.preview.push({ channel: unit.channel, text });
      if (!env.dryRun) {
        env.log.error('notify.not_configured', { notifications: unit.ids.length });
      }
      continue;
    }

    const chat = unit.channel === 'ops' ? chats.ops : chats.content;
    let failure: { retryable: boolean; description: string } | null = null;
    for (const text of unit.messages) {
      // Content is never sent during quiet hours unless urgent -- held content
      // simply is not due yet. So `silent` only ever applies to ops alerts.
      const result = await telegram.send(chat, text, { silent: unit.channel === 'ops' && silent });
      if (!result.ok) {
        failure = { retryable: result.retryable, description: result.description };
        break;
      }
      outcome.messages += 1;
    }

    const placeholders = unit.ids.map(() => '?').join(', ');
    if (failure === null) {
      await env.db.write.execute('mark notifications sent', {
        sql: `UPDATE notifications SET state = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id IN (${placeholders})`,
        args: [nowIso, ...unit.ids],
      });
      outcome.sent += unit.ids.length;
    } else {
      const giveUp = !failure.retryable || unit.attempts + 1 >= MAX_ATTEMPTS;
      await env.db.write.execute('record notification failure', {
        sql: `UPDATE notifications SET state = ?, attempts = attempts + 1, last_error = ? WHERE id IN (${placeholders})`,
        args: [giveUp ? 'failed' : 'queued', failure.description, ...unit.ids],
      });
      env.log.error('notify.send_failed', {
        channel: unit.channel,
        notifications: unit.ids.length,
        retryable: failure.retryable,
        gave_up: giveUp,
        reason: failure.description,
      });
      if (giveUp) outcome.failed += unit.ids.length;
      else outcome.retrying += unit.ids.length;
    }
  }

  return outcome;
}
