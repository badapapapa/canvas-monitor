/** Display formatting, in SGT, by hand (no locale data differences between machines). */

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SGT_MS = 8 * 3600_000;

function sgt(iso: string): Date | null {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : new Date(d.getTime() + SGT_MS);
}

/** "Fri 9 Oct, 23:59" */
export function when(iso: string): string {
  const d = sgt(iso);
  if (d === null) return '';
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

/** "9 Oct" */
export function day(iso: string): string {
  const d = sgt(iso);
  return d === null ? '' : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** "in 3 days", "in 5 hours", "2 days ago". */
export function relative(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  const abs = Math.abs(ms);
  const unit = abs >= 2 * 86_400_000 ? [Math.round(abs / 86_400_000), 'day'] as const
    : abs >= 2 * 3_600_000 ? [Math.round(abs / 3_600_000), 'hour'] as const
    : [Math.max(1, Math.round(abs / 60_000)), 'minute'] as const;
  const text = `${unit[0]} ${unit[1]}${unit[0] === 1 ? '' : 's'}`;
  return ms >= 0 ? `in ${text}` : `${text} ago`;
}

export function daysSince(iso: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000));
}

export function size(bytes: number | null): string {
  if (bytes === null) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}
