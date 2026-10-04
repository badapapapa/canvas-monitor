/**
 * Mirror stalls (DECISIONS.md D-74): a macOS notification when a file has been
 * waiting to be copied for more than 24 hours, how many and why, and another
 * when that clears.
 *
 * The Mac gains no secret and no access for this: the mirror keeps read-only
 * database access and no Telegram token. The notice is shown with the system's
 * own `osascript`, on this Mac only -- it cannot reach the phone, by design.
 *
 * State lives beside the mirror's own, in var/mirror/stall.json: when each
 * waiting file was FIRST deferred (a file that copies, or stops being deferred,
 * is forgotten), and when the last notice went out.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import type { MirrorReport } from './mirror.ts';

export const STALL_AFTER_MS = 24 * 3600_000;
const REMIND_MS = 24 * 3600_000;

export type StallReason = 'not_here' | 'online_only' | 'unreadable' | 'syncing';

export interface StallState {
  version: 1;
  /** File id -> when it was first deferred, and why it is deferred now. */
  waiting: Record<string, { since: string; reason: StallReason }>;
  /** When the last "waiting" notice went out; absent when nothing is stalled. */
  notifiedAt?: string;
}

export interface Notice {
  title: string;
  body: string;
}

/** Why the mirror deferred a file, from its report's wording. Error -11 is macOS refusing to download an online-only file (D-73). */
export function classify(reason: string): StallReason {
  if (reason.startsWith('not on this Mac yet')) return 'not_here';
  if (reason.startsWith('source does not match')) return 'syncing';
  if (/-11\b|EDEADLK|deadlock/i.test(reason)) return 'online_only';
  return 'unreadable';
}

const WORDS: Record<StallReason, string> = {
  not_here: 'not on this Mac yet',
  online_only: 'online-only; macOS refused the download',
  unreadable: 'could not be read (offline, or still syncing)',
  syncing: 'still syncing',
};

/** The next stall state, and the notice to show, if any. Pure: no I/O. */
export function evaluateStall(prev: StallState | null, report: Pick<MirrorReport, 'deferred'>, now: Date): { next: StallState; notice: Notice | null } {
  const before = prev?.waiting ?? {};
  const waiting: StallState['waiting'] = {};
  for (const d of report.deferred) {
    waiting[d.id] = { since: before[d.id]?.since ?? now.toISOString(), reason: classify(d.reason) };
  }
  const stalled = Object.values(waiting).filter((w) => now.getTime() - new Date(w.since).getTime() >= STALL_AFTER_MS);

  if (stalled.length === 0) {
    const next: StallState = { version: 1, waiting };
    const notice = prev?.notifiedAt !== undefined
      ? { title: 'Canvas mirror: cleared', body: 'Nothing has been waiting more than 24 hours to be copied any more.' }
      : null;
    return { next, notice };
  }

  const due = prev?.notifiedAt === undefined || now.getTime() - new Date(prev.notifiedAt).getTime() >= REMIND_MS;
  const next: StallState = { version: 1, waiting, ...(due ? { notifiedAt: now.toISOString() } : prev?.notifiedAt !== undefined ? { notifiedAt: prev.notifiedAt } : {}) };
  if (!due) return { next, notice: null };
  const counts = new Map<StallReason, number>();
  for (const s of stalled) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  const why = [...counts].map(([r, n]) => `${n} ${WORDS[r]}`).join('; ');
  const n = stalled.length;
  return {
    next,
    notice: { title: 'Canvas mirror: files waiting', body: `${n} file${n === 1 ? ' has' : 's have'} been waiting more than 24 hours to be copied: ${why}.` },
  };
}

export function loadStall(file: string): StallState | null {
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as StallState;
    return parsed.version === 1 && typeof parsed.waiting === 'object' ? parsed : null;
  } catch {
    return null; // a damaged file only costs the "first deferred" times
  }
}

export function saveStall(file: string, state: StallState): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Show a notice with the system's own osascript: arguments, never a shell, so nothing in the text can run. */
export function notifyMac(notice: Notice, run: typeof spawnSync = spawnSync): boolean {
  const q = (s: string) => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const result = run('/usr/bin/osascript', ['-e', `display notification ${q(notice.body)} with title ${q(notice.title)}`], { stdio: 'ignore', timeout: 10_000 });
  return result.status === 0;
}
