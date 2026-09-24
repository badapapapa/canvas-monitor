/**
 * Lesson-day reminders (DECISIONS.md D-62), replacing the 10-day nudge.
 *
 * Answers are released after the lesson, so "overdue" means: at least one
 * lesson for the module has happened since the question was posted. On a day
 * I have a lesson, at 07:00 SGT, ONE message lists every overdue item for the
 * modules with a lesson that day. Nothing on days without a lesson, nothing if
 * nothing is overdue. It repeats each lesson day until answered or dismissed.
 *
 * The timetable is personal data: rows in `lesson_slots` and
 * `lesson_exceptions`, never code. Times are SGT, which has no daylight saving.
 */

export interface LessonSlot {
  contextId: number;
  /** ISO weekday, 1 = Monday. */
  weekday: number;
  /** "HH:MM", SGT. */
  startTime: string;
  firstDate: string;
  lastDate: string;
  label: string;
}

export interface LessonException {
  /** null: no lesson for any module that day (recess, a holiday). */
  contextId: number | null;
  date: string;
}

export interface Timetable {
  slots: readonly LessonSlot[];
  exceptions: readonly LessonException[];
}

export interface OpenItem {
  followupId: number;
  contextId: number;
  moduleCode: string;
  category: 'Tutorials' | 'Labs';
  number: string;
  /** When the question was posted: a lesson must come after this. */
  openedAt: string;
}

export const REMINDER_TIME_SGT = '07:00';
const DAY_MS = 24 * 3600_000;
const SGT_MS = 8 * 3600_000;

/** The SGT calendar date of an instant, "YYYY-MM-DD". */
export function sgtDate(at: Date): string {
  return new Date(at.getTime() + SGT_MS).toISOString().slice(0, 10);
}

/** An SGT wall-clock time on an SGT date, as an instant. */
export function sgtInstant(date: string, time: string): Date {
  return new Date(Date.parse(`${date}T${time}:00+08:00`));
}

function isoWeekday(date: string): number {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** This module's lessons on this date: weekly slots in range, minus no-lesson dates. */
export function lessonsOn(tt: Timetable, contextId: number, date: string): LessonSlot[] {
  if (tt.exceptions.some((e) => e.date === date && (e.contextId === null || e.contextId === contextId))) return [];
  const weekday = isoWeekday(date);
  return tt.slots.filter((s) => s.contextId === contextId && s.weekday === weekday && s.firstDate <= date && date <= s.lastDate);
}

/** The start of this module's most recent lesson strictly before `at`, or null. */
export function lastLessonBefore(tt: Timetable, contextId: number, at: Date): Date | null {
  const earliest = tt.slots.filter((s) => s.contextId === contextId).map((s) => s.firstDate).sort()[0];
  if (earliest === undefined) return null;
  for (let date = sgtDate(at); date >= earliest; date = addDays(date, -1)) {
    const starts = lessonsOn(tt, contextId, date)
      .map((s) => sgtInstant(date, s.startTime))
      .filter((d) => d.getTime() < at.getTime())
      .sort((a, b) => b.getTime() - a.getTime());
    if (starts.length > 0) return starts[0]!;
  }
  return null;
}

export interface ReminderPlan {
  date: string;
  sendAt: Date;
  modules: Array<{ contextId: number; moduleCode: string; lessons: LessonSlot[]; items: OpenItem[] }>;
}

export type ReminderDecision = { plan: ReminderPlan } | { plan: null; reason: string };

/**
 * What this morning's reminder should say, if anything. `open` must be the
 * follow-ups open NOW -- answered and dismissed ones are never in it.
 * `liveSince`: when follow-ups went live; a day whose 07:00 came before that
 * gets no reminder, so going live mid-morning sends nothing extra.
 */
export function planReminder(input: { now: Date; timetable: Timetable; open: readonly OpenItem[]; liveSince: string | null }): ReminderDecision {
  const date = sgtDate(input.now);
  const sendAt = sgtInstant(date, REMINDER_TIME_SGT);
  if (input.now.getTime() < sendAt.getTime()) return { plan: null, reason: `before ${REMINDER_TIME_SGT} SGT` };
  if (input.liveSince === null || new Date(input.liveSince).getTime() >= sendAt.getTime()) {
    return { plan: null, reason: 'follow-ups went live after this morning\'s reminder time' };
  }

  const modules: ReminderPlan['modules'] = [];
  const contexts = [...new Set(input.timetable.slots.map((s) => s.contextId))];
  let anyLesson = false;
  for (const contextId of contexts) {
    const lessons = lessonsOn(input.timetable, contextId, date);
    if (lessons.length === 0) continue;
    anyLesson = true;
    // Overdue: a lesson for this module happened after the question was posted.
    const last = lastLessonBefore(input.timetable, contextId, sendAt);
    const items = input.open.filter((o) => o.contextId === contextId && last !== null && last.getTime() > new Date(o.openedAt).getTime());
    if (items.length > 0) modules.push({ contextId, moduleCode: items[0]!.moduleCode, lessons, items });
  }
  if (!anyLesson) return { plan: null, reason: 'no lesson today' };
  if (modules.length === 0) return { plan: null, reason: 'nothing is overdue' };
  // In the order of the day: earliest lesson first.
  const first = (m: ReminderPlan['modules'][number]) => m.lessons.map((l) => l.startTime).sort()[0]!;
  modules.sort((a, b) => first(a).localeCompare(first(b)) || a.moduleCode.localeCompare(b.moduleCode));
  return { plan: { date, sendAt, modules } };
}
