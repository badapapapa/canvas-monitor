/**
 * The timetable and per-module tracking switches, as entered (D-62). One set of
 * validators for the CLI commands and for a draft file, so a draft can be
 * previewed before any of it is entered into the database -- and entered with
 * `npm run timetable -- import <file>` to get exactly what was previewed.
 *
 * Draft file shape (keep it in var/, which is gitignored: it is personal data):
 *   {
 *     "trackingOff": ["<module>"],
 *     "slots":    [{ "module": "<module>", "weekday": "thu", "time": "09:00",
 *                    "from": "2026-08-13", "to": "2026-11-12", "label": "lab" }],
 *     "noLesson": [{ "module": null, "date": "2026-09-24", "note": "recess" }]
 *   }
 */

import { readFileSync } from 'node:fs';
import type { Db } from '../core/db/writer.ts';
import { AppError } from '../core/errors.ts';
import type { LessonException, LessonSlot, Timetable } from './timetable.ts';

const WEEKDAYS: Record<string, number> = { mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7 };

export function parseWeekday(raw: string): number {
  const w = WEEKDAYS[raw.slice(0, 3).toLowerCase()];
  if (w === undefined) throw new AppError('usage', `weekday "${raw}": use mon, tue, wed, thu, fri, sat or sun`);
  return w;
}

export function weekdayName(n: number): string {
  return Object.keys(WEEKDAYS).find((k) => WEEKDAYS[k] === n) ?? String(n);
}

export function parseTime(raw: string): string {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(raw)) throw new AppError('usage', `time "${raw}": use HH:MM, 24-hour, SGT`);
  return raw;
}

export function parseDate(raw: string): string {
  const ok = /^\d{4}-\d{2}-\d{2}$/.test(raw) && new Date(`${raw}T00:00:00Z`).toISOString().slice(0, 10) === raw;
  if (!ok) throw new AppError('usage', `date "${raw}": use YYYY-MM-DD`);
  return raw;
}

export async function contextOf(db: Db, moduleCode: string): Promise<number> {
  const r = await db.read({ sql: 'SELECT context_id FROM courses WHERE module_code = ?', args: [moduleCode] });
  if (r.rows.length !== 1) throw new AppError('usage', `No single course with module code "${moduleCode}" (found ${r.rows.length}).`);
  return Number(r.rows[0]!['context_id']);
}

export interface SlotInput {
  module: string;
  weekday: string;
  time: string;
  from: string;
  to: string;
  label?: string;
}

export async function resolveSlot(db: Db, s: SlotInput): Promise<LessonSlot> {
  const firstDate = parseDate(s.from);
  const lastDate = parseDate(s.to);
  if (lastDate < firstDate) throw new AppError('usage', `slot for ${s.module}: "to" ${lastDate} is before "from" ${firstDate}`);
  const label = (s.label ?? 'lesson').trim();
  if (label === '' || label.length > 20) throw new AppError('usage', 'label: 1-20 characters, e.g. "lab" or "tutorial"');
  return { contextId: await contextOf(db, s.module), weekday: parseWeekday(s.weekday), startTime: parseTime(s.time), firstDate, lastDate, label };
}

export interface Draft {
  trackingOff: Set<number>;
  timetable: Timetable;
}

export async function loadDraft(db: Db, file: string): Promise<Draft> {
  const raw = JSON.parse(readFileSync(file, 'utf8')) as {
    trackingOff?: string[];
    slots?: SlotInput[];
    noLesson?: Array<{ module: string | null; date: string; note?: string }>;
  };
  const trackingOff = new Set<number>();
  for (const m of raw.trackingOff ?? []) trackingOff.add(await contextOf(db, m));
  const slots: LessonSlot[] = [];
  for (const s of raw.slots ?? []) slots.push(await resolveSlot(db, s));
  const exceptions: LessonException[] = [];
  for (const e of raw.noLesson ?? []) exceptions.push({ contextId: e.module === null ? null : await contextOf(db, e.module), date: parseDate(e.date) });
  return { trackingOff, timetable: { slots, exceptions } };
}
