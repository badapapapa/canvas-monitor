/**
 * Notification payloads -> Telegram HTML (SPEC.md section 12).
 *
 * Payloads are stored in the queue and rendered at SEND time, not enqueue
 * time, so that several held notifications can be merged into one morning
 * digest, and so "due in 8h" is computed when I read it rather than when it was
 * decided.
 *
 * Every dynamic string is escaped. Instructor-authored text reaches here only
 * as plain text (core/html.ts) and is escaped again on the way out, so it can
 * never inject markup into a message.
 */

import { toSgtParts } from '../core/time.ts';
import { MESSAGE_LIMIT } from './telegram.ts';
import type { ChangeDetail } from '../ingest/classify.ts';
import type { ResourceType } from '../ingest/normalise.ts';

export interface RenderItem {
  resourceType: ResourceType;
  kind: 'new' | 'revised';
  title: string | null;
  url: string | null;
  change: ChangeDetail | null;
  postedAt: string | null;
  dueAt: string | null;
  otherDueDates?: string[];
  preview?: string;
  grade?: { score: number | null; grade: string | null; pointsPossible: number | null; excused: boolean };
  file?: { folder: string | null; size: number | null; module: string | null; unlockAt: string | null };
}

export interface ContentPayload {
  kind: 'content';
  contextLabel: string;
  items: RenderItem[];
  /**
   * Shown under the header when coverage is partial (SPEC.md section 2.2): a
   * message from a course read through Modules must say so every time, not
   * only in the one-off ops alert.
   */
  note?: string;
}

export interface WatchingPayload {
  kind: 'watching';
  contexts: Array<{ label: string; counts: Partial<Record<ResourceType, number>> }>;
}

export interface OpsPayload {
  kind: 'ops';
  severity: 'warn' | 'critical';
  summary: string;
  detail?: string;
  resolved?: boolean;
}

export type Payload = ContentPayload | WatchingPayload | OpsPayload;

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(text: string): string {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function link(title: string | null, url: string | null): string {
  const label = escapeHtml(title ?? '(untitled)');
  return url === null ? `<b>${label}</b>` : `<a href="${escapeAttr(url)}"><b>${label}</b></a>`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Fri 19 Sep, 23:59", always in SGT (SPEC.md section 4). */
export function formatSgt(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const p = toSgtParts(at);
  // Day of week in SGT: shift by the fixed +08:00 offset, then read UTC.
  const weekday = WEEKDAYS[new Date(at.getTime() + 8 * 3600_000).getUTCDay()] ?? '';
  const hh = String(p.hour).padStart(2, '0');
  const mm = String(p.minute).padStart(2, '0');
  return `${weekday} ${p.day} ${MONTHS[p.month - 1] ?? ''}, ${hh}:${mm}`;
}

export function relativeTo(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 0) return 'overdue';
  const hours = ms / 3600_000;
  if (hours < 1) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (hours < 48) return `in ${Math.round(hours)}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function due(iso: string | null, now: Date): string {
  if (iso === null) return 'no due date';
  return `due ${formatSgt(iso)} (${relativeTo(iso, now)})`;
}

const FIELD_LABEL: Record<string, string> = {
  due_at: 'due date',
  name: 'title',
  points_possible: 'points',
  lock_at: 'lock date',
  unlock_at: 'unlock date',
  description_hash: 'details',
};

function fieldValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return 'none';
  if ((field === 'due_at' || field === 'lock_at' || field === 'unlock_at') && typeof value === 'string') {
    return formatSgt(value);
  }
  return String(value);
}

/** "1.3 MB", "812 KB". */
export function humanSize(bytes: number | null): string | null {
  if (bytes === null) return null;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function renderItem(item: RenderItem, now: Date): string {
  const lines: string[] = [];
  const target = link(item.title, item.url);

  switch (item.resourceType) {
    case 'announcement': {
      const verb = item.kind === 'new' ? '📢' : '📢 <i>edited:</i>';
      lines.push(`${verb} ${target}`);
      if (item.preview !== undefined && item.preview !== '') lines.push(`<i>${escapeHtml(item.preview)}</i>`);
      break;
    }
    case 'assignment': {
      if (item.kind === 'new') {
        lines.push(`📝 New: ${target} — ${escapeHtml(due(item.dueAt, now))}`);
      } else if (item.change?.kind === 'assignment') {
        const moved = item.change.changes.find((c) => c.field === 'due_at');
        if (moved !== undefined) {
          lines.push(
            `⚠️ Due date changed: ${target}\n` +
              `${escapeHtml(fieldValue('due_at', moved.from))} → <b>${escapeHtml(fieldValue('due_at', moved.to))}</b>` +
              (typeof moved.to === 'string' ? ` (${escapeHtml(relativeTo(moved.to, now))})` : ''),
          );
        } else {
          lines.push(`✏️ Updated: ${target}`);
        }
        const rest = item.change.changes.filter((c) => c.field !== 'due_at');
        if (rest.length > 0) {
          const labels = rest.map((c) =>
            c.field === 'description_hash'
              ? 'details'
              : `${FIELD_LABEL[c.field] ?? c.field}: ${fieldValue(c.field, c.from)} → ${fieldValue(c.field, c.to)}`,
          );
          lines.push(escapeHtml(labels.join('; ')));
        }
      } else {
        lines.push(`✏️ Updated: ${target}`);
      }
      if (item.otherDueDates !== undefined && item.otherDueDates.length > 0) {
        // D-13: never pick one silently. Show what Canvas says, both ways.
        const others = item.otherDueDates.map((d) => (d === null ? 'none' : formatSgt(d))).join(', ');
        lines.push(`⚠️ Canvas also lists ${escapeHtml(others)} for this assignment. Check which applies to you.`);
      }
      break;
    }
    case 'grade': {
      const g = item.grade;
      const verb = item.change?.kind === 'grade' && item.change.transition === 'changed' ? 'Grade changed' : 'Grade posted';
      let value = '';
      if (g !== undefined) {
        if (g.excused) value = 'excused';
        else if (g.score !== null) value = g.pointsPossible === null ? `${g.score}` : `${g.score} / ${g.pointsPossible}`;
        else if (g.grade !== null) value = g.grade;
      }
      lines.push(`✅ ${verb}: ${target}${value === '' ? '' : ` — <b>${escapeHtml(value)}</b>`}`);
      break;
    }
    case 'file': {
      const f = item.file;
      const where = f?.folder ?? (f?.module === null || f?.module === undefined ? null : `module: ${f.module}`);
      const detail = [humanSize(f?.size ?? null), where].filter((x): x is string => x !== null).join(' · ');
      const change = item.change?.kind === 'file' ? item.change : null;
      if (change?.transition === 'updated') {
        const renamed = change.changes.find((c) => c.field === 'name');
        const resized = change.changes.find((c) => c.field === 'size');
        const note = renamed !== undefined
          ? `renamed from “${String(renamed.from)}”`
          : resized !== undefined
            ? `new version (${humanSize(Number(resized.from))} → ${humanSize(Number(resized.to))})`
            : 'new version';
        lines.push(`📄 Updated: ${target} — ${escapeHtml(note)}`);
      } else {
        const verb = change?.transition === 'available' ? '📄 Now available: ' : '📄 ';
        lines.push(`${verb}${target}${detail === '' ? '' : ` — ${escapeHtml(detail)}`}`);
      }
      break;
    }
    case 'comment': {
      lines.push(`💬 ${item.kind === 'new' ? 'Feedback' : 'Feedback edited'}: ${target}`);
      if (item.preview !== undefined && item.preview !== '') lines.push(`<i>${escapeHtml(item.preview)}</i>`);
      break;
    }
  }
  return lines.join('\n');
}

function summarise(items: RenderItem[]): string {
  const created = items.filter((i) => i.kind === 'new').length;
  const changed = items.length - created;
  const parts: string[] = [];
  if (created > 0) parts.push(`${created} new`);
  if (changed > 0) parts.push(`${changed} changed`);
  return parts.join(', ');
}

/**
 * Pack blocks into messages under the limit, splitting only between blocks.
 * A block larger than the limit on its own is truncated rather than dropped:
 * a clipped announcement preview is fine, a missing one is not.
 */
export function pack(header: string, continuation: string, blocks: string[]): string[] {
  const messages: string[] = [];
  let current = header;
  for (const raw of blocks) {
    const block = raw.length > MESSAGE_LIMIT - continuation.length - 4
      ? `${raw.slice(0, MESSAGE_LIMIT - continuation.length - 8)}…`
      : raw;
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > MESSAGE_LIMIT && current !== header && current !== continuation) {
      messages.push(current);
      current = `${continuation}\n\n${block}`;
    } else {
      current = candidate;
    }
  }
  messages.push(current);
  return messages;
}

export function renderContent(payload: ContentPayload, now: Date): string[] {
  const label = escapeHtml(payload.contextLabel);
  const note = payload.note === undefined ? '' : `\n<i>${escapeHtml(payload.note)}</i>`;
  return pack(
    `<b>${label}</b> · ${escapeHtml(summarise(payload.items))}${note}`,
    `<b>${label}</b> · continued`,
    payload.items.map((item) => renderItem(item, now)),
  );
}

export function renderWatching(payload: WatchingPayload): string[] {
  const names: Record<ResourceType, [string, string]> = {
    announcement: ['announcement', 'announcements'],
    assignment: ['assignment', 'assignments'],
    grade: ['posted grade', 'posted grades'],
    file: ['file', 'files'],
    comment: ['feedback comment', 'feedback comments'],
  };
  const blocks = payload.contexts.map((c) => {
    const counts = Object.entries(c.counts)
      .filter(([, n]) => (n ?? 0) > 0)
      .map(([type, n]) => {
        const [one, many] = names[type as ResourceType];
        return `${n} ${n === 1 ? one : many}`;
      });
    return `• <b>${escapeHtml(c.label)}</b>${counts.length > 0 ? ` — ${escapeHtml(counts.join(', '))}` : ' — nothing posted yet'}`;
  });
  return pack(
    '👀 <b>Now watching</b>\n' +
      'What is already on Canvas has been recorded as seen, so you will not be ' +
      'notified about it. From here on, only new and changed items are sent.',
    '👀 <b>Now watching</b> · continued',
    blocks,
  );
}

export function renderOps(payload: OpsPayload): string[] {
  const icon = payload.resolved === true ? '✅' : payload.severity === 'critical' ? '🚨' : '⚠️';
  const head = payload.resolved === true ? `${icon} <b>Resolved</b>: ${escapeHtml(payload.summary)}` : `${icon} ${escapeHtml(payload.summary)}`;
  return pack(head, `${icon} continued`, payload.detail === undefined ? [] : [escapeHtml(payload.detail)]);
}

export function render(payload: Payload, now: Date): string[] {
  switch (payload.kind) {
    case 'content':
      return renderContent(payload, now);
    case 'watching':
      return renderWatching(payload);
    case 'ops':
      return renderOps(payload);
  }
}

/**
 * The morning digest: every held content notification merged into one run of
 * messages, one section per course, rather than a burst of separate pings the
 * moment quiet hours end.
 */
export function renderDigest(payloads: ContentPayload[], now: Date): string[] {
  const byContext = new Map<string, RenderItem[]>();
  for (const p of payloads) {
    byContext.set(p.contextLabel, [...(byContext.get(p.contextLabel) ?? []), ...p.items]);
  }
  const total = [...byContext.values()].reduce((n, items) => n + items.length, 0);
  const blocks: string[] = [];
  for (const [label, items] of byContext) {
    blocks.push(`<b>${escapeHtml(label)}</b> · ${escapeHtml(summarise(items))}`);
    for (const item of items) blocks.push(renderItem(item, now));
  }
  return pack(`🌅 <b>Overnight</b> · ${total} update${total === 1 ? '' : 's'}`, '🌅 <b>Overnight</b> · continued', blocks);
}
