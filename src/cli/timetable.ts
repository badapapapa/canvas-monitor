/**
 * `npm run timetable -- list | add | skip | remove <id> | unskip <id> | import <draft.json>`
 * (DECISIONS.md D-62). My timetable is personal data: it lives only in the
 * database, entered here, and this command refuses to run under CI.
 */

import { readFileSync } from 'node:fs';
import { AppError } from '../core/errors.ts';
import type { RunContext } from '../core/run-context.ts';
import { contextOf, parseDate, resolveSlot, weekdayName, type SlotInput } from '../followups/draft.ts';

export interface TimetableArgs {
  action: string | undefined;
  rest: string[];
  module?: string;
  weekday?: string;
  time?: string;
  from?: string;
  to?: string;
  label?: string;
  date?: string;
  note?: string;
  all?: boolean;
}

export async function runTimetableCli(ctx: RunContext, a: TimetableArgs): Promise<number> {
  if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') throw new AppError('usage', 'the timetable is personal data: refused under CI');
  const out = process.stdout;
  const now = ctx.clock.now().toISOString();
  const done = (what: string) => out.write(ctx.dryRun ? `\nDRY RUN: ${what} validated, not saved.\n` : `\n${what}.\n`);

  const addSlot = async (s: SlotInput) => {
    const slot = await resolveSlot(ctx.db, s);
    await ctx.db.write.execute('add lesson slot', {
      sql: 'INSERT INTO lesson_slots (context_id, weekday, start_time, first_date, last_date, label, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [slot.contextId, slot.weekday, slot.startTime, slot.firstDate, slot.lastDate, slot.label, now],
    });
  };
  const addSkip = async (module: string | null, date: string, note: string | undefined) => {
    await ctx.db.write.execute('add no-lesson date', {
      sql: 'INSERT INTO lesson_exceptions (context_id, date, note, created_at) VALUES (?, ?, ?, ?)',
      args: [module === null ? null : await contextOf(ctx.db, module), parseDate(date), note ?? null, now],
    });
  };

  switch (a.action ?? 'list') {
    case 'list': {
      const slots = await ctx.db.read(
        `SELECT s.id, c.module_code, s.weekday, s.start_time, s.first_date, s.last_date, s.label
           FROM lesson_slots s JOIN courses c ON c.context_id = s.context_id ORDER BY c.module_code, s.weekday, s.start_time`,
      );
      const skips = await ctx.db.read(
        `SELECT e.id, COALESCE(c.module_code, 'ALL MODULES') AS module_code, e.date, e.note
           FROM lesson_exceptions e LEFT JOIN courses c ON c.context_id = e.context_id ORDER BY e.date`,
      );
      out.write('\nWeekly lessons (SGT)\n');
      if (slots.rows.length === 0) out.write('  none\n');
      for (const s of slots.rows) {
        out.write(`  #${String(s['id']).padEnd(3)} ${String(s['module_code']).padEnd(8)} ${weekdayName(Number(s['weekday']))} ${String(s['start_time'])}  ${String(s['label']).padEnd(9)} ${String(s['first_date'])} .. ${String(s['last_date'])}\n`);
      }
      out.write('\nNo lesson on\n');
      if (skips.rows.length === 0) out.write('  none\n');
      for (const e of skips.rows) out.write(`  #${String(e['id']).padEnd(3)} ${String(e['date'])}  ${String(e['module_code']).padEnd(12)} ${e['note'] === null ? '' : String(e['note'])}\n`);
      out.write('\n');
      return 0;
    }
    case 'add': {
      if (a.module === undefined || a.weekday === undefined || a.time === undefined || a.from === undefined || a.to === undefined) {
        throw new AppError('usage', 'Usage: npm run timetable -- add --module <code> --weekday thu --time 09:00 --from YYYY-MM-DD --to YYYY-MM-DD [--label lab]');
      }
      await addSlot({ module: a.module, weekday: a.weekday, time: a.time, from: a.from, to: a.to, ...(a.label === undefined ? {} : { label: a.label }) });
      done(`Added ${a.module} ${a.weekday} ${a.time}`);
      return 0;
    }
    case 'skip': {
      if (a.date === undefined || (a.module === undefined) === (a.all !== true)) {
        throw new AppError('usage', 'Usage: npm run timetable -- skip (--module <code> | --all) --date YYYY-MM-DD [--note "..."]');
      }
      await addSkip(a.all === true ? null : a.module!, a.date, a.note);
      done(`No lesson for ${a.all === true ? 'any module' : a.module} on ${a.date}`);
      return 0;
    }
    case 'remove':
    case 'unskip': {
      const id = Number(a.rest[0]);
      if (!Number.isInteger(id)) throw new AppError('usage', `Usage: npm run timetable -- ${a.action} <id>`);
      const table = a.action === 'remove' ? 'lesson_slots' : 'lesson_exceptions';
      const r = await ctx.db.write.execute(`remove from ${table}`, { sql: `DELETE FROM ${table} WHERE id = ?`, args: [id] });
      out.write(ctx.dryRun ? `\nDRY RUN: would remove #${id}.\n` : r.rowsAffected === 1 ? `\nRemoved #${id}.\n` : `\nNo #${id}; nothing changed.\n`);
      return 0;
    }
    case 'import': {
      const file = a.rest[0];
      if (file === undefined) throw new AppError('usage', 'Usage: npm run timetable -- import <draft.json>');
      const raw = JSON.parse(readFileSync(file, 'utf8')) as { trackingOff?: string[]; slots?: SlotInput[]; noLesson?: Array<{ module: string | null; date: string; note?: string }> };
      const existing = await ctx.db.read('SELECT (SELECT count(*) FROM lesson_slots) + (SELECT count(*) FROM lesson_exceptions) AS n');
      if (Number(existing.rows[0]!['n']) > 0) throw new AppError('usage', 'The timetable is not empty. Import is for a first entry only; use add/skip, or remove what is there first.');
      for (const s of raw.slots ?? []) await addSlot(s);
      for (const e of raw.noLesson ?? []) await addSkip(e.module, e.date, e.note);
      for (const m of raw.trackingOff ?? []) {
        await ctx.db.write.execute('tracking off', { sql: 'UPDATE courses SET followups_tracking = 0 WHERE context_id = ?', args: [await contextOf(ctx.db, m)] });
      }
      done(`Imported ${raw.slots?.length ?? 0} weekly lessons, ${raw.noLesson?.length ?? 0} no-lesson dates, tracking off for ${raw.trackingOff?.length ?? 0} module(s)`);
      return 0;
    }
    default:
      throw new AppError('usage', `Unknown timetable action "${a.action}". Use list, add, skip, remove, unskip or import.`);
  }
}
