/**
 * Answer-sheet follow-ups (DECISIONS.md D-61): the classifier and the planner.
 * Invented module codes and names throughout.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classify, extractNumber, isAnswerName, tokensOf } from '../../src/followups/classify.ts';
import { describeItems, planFollowups, type ExistingFollowup, type PlanInput, type TrackedFile } from '../../src/followups/plan.ts';
import { lastLessonBefore, lessonsOn, planReminder, sgtInstant, type OpenItem, type Timetable } from '../../src/followups/timetable.ts';
import { tunePatterns } from '../../src/followups/tune.ts';

describe('answer detection: whole words only', () => {
  it('never fires on a substring', () => {
    for (const name of ['Transient analysis.pdf', 'Ansell reading.pdf', 'Answering techniques.pdf', 'Resolution notes.pdf', 'Tutorial 3 transient.pdf']) {
      assert.equal(isAnswerName(tokensOf(name)), false, name);
    }
  });

  it('fires on the answer words, split on _ and - like routing', () => {
    for (const name of ['AB1234-T1-Answers.zip', 'Practical Lab 01 - Suggested Solutions.pdf', 'Exercise set with answers.pdf', 'T2_soln.pdf']) {
      assert.equal(isAnswerName(tokensOf(name)), true, name);
    }
  });

  it('fires on a module phrase from the database, as whole words only', () => {
    assert.equal(isAnswerName(tokensOf('T3 marking scheme.pdf'), ['marking scheme']), true);
    assert.equal(isAnswerName(tokensOf('T3 remarking schemes.pdf'), ['marking scheme']), false);
  });
});

describe('which files take part: a category number or nothing', () => {
  const n = (name: string, cat: 'Tutorials' | 'Labs' = 'Tutorials') => extractNumber(tokensOf(name), cat);

  it('reads tutorial and lab numbers in their usual forms, normalised', () => {
    assert.deepEqual(
      [n('AB1234-T3.pdf'), n('Tutorial 1 - Blank.pdf'), n('Tut 2.pdf'), n('Tutorial03.pdf'), n('Lab 04.pdf', 'Labs'), n('Lab4.pdf', 'Labs'), n('AB1234 - AY2627S1 - Practical Lab 03.pdf', 'Labs'), n('Practical 2.pdf', 'Labs')],
      ['3', '1', '2', '3', '4', '4', '3', '2'],
    );
  });

  it('finds no number in files that have none, so they never open a follow-up', () => {
    for (const name of ['starter-kit.zip', 'boilerplate.zip', 'webroot.zip', 'Class roster.pdf', 'dataset.xlsx', 'Company records.zip', 'AB1234.pdf']) {
      assert.deepEqual(classify(name, 'Tutorials'), { role: 'ignored', reason: 'no number' }, name);
      assert.deepEqual(classify(name, 'Labs'), { role: 'ignored', reason: 'no number' }, name);
    }
  });

  it('is not fooled by weeks, years, dates or the other category', () => {
    assert.equal(n('src (Week 03).zip'), null);
    assert.equal(n('Tutorial 2 (Week 03).pdf'), '2');
    assert.equal(n('Notes (uploaded 2026-09-18).pdf'), null);
    assert.equal(n('Tutorial 2026 overview.pdf'), null);
    assert.equal(n('Lab 2.pdf', 'Tutorials'), null);
    assert.equal(n('T3.pdf', 'Labs'), null);
  });

  it('flags a partial answer', () => {
    assert.deepEqual(classify('AB1234 Practical Lab 04 Part 1 - Suggested Solutions.zip', 'Labs'), { role: 'answer', number: '4', partial: true });
    assert.deepEqual(classify('Lab 04 - Suggested Solutions.zip', 'Labs'), { role: 'answer', number: '4', partial: false });
  });
});

// --- the planner ---------------------------------------------------------------

let seq = 0;
const file = (title: string, firstSeenAt: string, category = 'Tutorials', contextId = 1, postedAt: string | null = null): TrackedFile =>
  ({ itemId: `i${(seq += 1)}`, contextId, moduleCode: contextId === 1 ? 'AB1234' : 'CD5678', category, title, firstSeenAt, postedAt });
const NOW = new Date('2026-10-20T12:00:00Z');
const input = (files: TrackedFile[], over: Partial<PlanInput> = {}): PlanInput =>
  ({ files, existing: [], phrases: new Map(), partialPolicy: 'keep_open', termEnds: new Map([[1, '2027-01-09T15:59:00Z']]), now: NOW, ...over });
const open = (id: number, number: string, openedAt: string, over: Partial<ExistingFollowup> = {}): ExistingFollowup =>
  ({ id, contextId: 1, category: 'Tutorials', number, state: 'open', openedAt, ...over });

describe('pairing on (context, category, number)', () => {
  it('opens a follow-up for a numbered question with no answers, aged from its Canvas posted date', () => {
    const p = planFollowups(input([file('AB1234-T3.pdf', '2026-10-18T00:00:00Z', 'Tutorials', 1, '2026-08-05T02:00:00Z'), file('AB1234-T4.pdf', '2026-10-18T00:00:00Z')]));
    assert.deepEqual(p.opens.map((o) => [o.label, o.postedAt, o.ageDays]), [['Tutorial 3', '2026-08-05T02:00:00Z', 76], ['Tutorial 4', '2026-10-18T00:00:00Z', 2]]);
  });

  it('ignores a module whose tracking is switched off, entirely', () => {
    const p = planFollowups(input([file('Tutorial 1.pdf', '2026-10-01T00:00:00Z', 'Tutorials', 2)], { trackingOff: new Set([2]) }));
    assert.deepEqual([p.opens.length, p.ignored.length, p.trackingOff.map((f) => f.title)], [0, 0, ['Tutorial 1.pdf']]);
  });

  it('opens nothing when the answers came first, or in the same run', () => {
    const before = planFollowups(input([file('AB1234-T3-Answers.zip', '2026-10-01T00:00:00Z'), file('AB1234-T3.pdf', '2026-10-05T00:00:00Z')]));
    const same = planFollowups(input([file('AB1234-T4.pdf', '2026-10-05T00:00:00Z'), file('AB1234-T4-Answers.zip', '2026-10-05T00:00:00Z')]));
    assert.deepEqual([before.opens.length, before.closedOnArrival.length, same.opens.length, same.closedOnArrival.length], [0, 1, 0, 1]);
  });

  it('closes with the first answer file; the rest do nothing', () => {
    const p = planFollowups(input(
      [file('AB1234-T3.pdf', '2026-10-01T00:00:00Z'), file('AB1234-T3-Answers.zip', '2026-10-06T00:00:00Z'), file('T3 Solutions (scanned).pdf', '2026-10-07T00:00:00Z')],
      { existing: [open(7, '3', '2026-10-01T00:00:00Z')] },
    ));
    assert.deepEqual(p.closes.map((c) => [c.followupId, c.answer.title]), [[7, 'AB1234-T3-Answers.zip']]);
    assert.deepEqual(p.extraAnswers.map((e) => e.file.title), ['T3 Solutions (scanned).pdf']);
  });

  it("never lets Tutorial 1's answers close Tutorial 11", () => {
    const p = planFollowups(input([file('T11.pdf', '2026-10-01T00:00:00Z'), file('T1 Answers.pdf', '2026-10-02T00:00:00Z')], { existing: [open(11, '11', '2026-10-01T00:00:00Z')] }));
    assert.deepEqual([p.closes.length, p.answersWithoutQuestion.map((a) => a.label)], [0, ['Tutorial 1']]);
  });

  it('pairs "Lab 04" with "Lab 4"', () => {
    const p = planFollowups(input([file('Lab 04.pdf', '2026-10-01T00:00:00Z', 'Labs'), file('Lab 4 Solutions.pdf', '2026-10-01T00:00:00Z', 'Labs')]));
    assert.deepEqual(p.closedOnArrival.map((c) => c.label), ['Lab 4']);
  });

  it('opens no second follow-up for a revised question under a dated or week name', () => {
    const p = planFollowups(input(
      [file('Tutorial 3.pdf', '2026-10-01T00:00:00Z'), file('Tutorial 3 (Week 06).pdf', '2026-10-08T00:00:00Z'), file('Tutorial 3 (uploaded 2026-10-09).pdf', '2026-10-09T00:00:00Z')],
      { existing: [open(3, '3', '2026-10-01T00:00:00Z')] },
    ));
    assert.deepEqual([p.opens.length, p.closes.length], [0, 0]);
  });

  it('keeps modules and categories apart', () => {
    const p = planFollowups(input([file('T3.pdf', '2026-10-01T00:00:00Z', 'Tutorials', 1), file('T3 Answers.pdf', '2026-10-02T00:00:00Z', 'Tutorials', 2)]));
    assert.deepEqual([p.opens.map((o) => o.moduleCode), p.answersWithoutQuestion.map((a) => a.moduleCode)], [['AB1234'], ['CD5678']]);
  });

  it('ignores everything numberless in Tutorials and Labs, and everything outside them', () => {
    const p = planFollowups(input([file('starter-kit.zip', '2026-10-01T00:00:00Z', 'Labs'), file('Class roster.pdf', '2026-10-01T00:00:00Z', 'Labs'), file('T3.pdf', '2026-10-01T00:00:00Z', 'Lectures')]));
    assert.deepEqual([p.opens.length, p.ignored.map((i) => i.file.title)], [0, ['starter-kit.zip', 'Class roster.pdf']]);
  });
});

describe('the partial-answer case is the owner\'s ruling', () => {
  const files = () => [file('Lab 04.pdf', '2026-10-01T00:00:00Z', 'Labs'), file('Lab 04 Part 1 - Suggested Solutions.zip', '2026-10-03T00:00:00Z', 'Labs')];
  it('unruled: shown as a case, and it closes nothing', () => {
    const p = planFollowups(input(files(), { partialPolicy: null }));
    assert.deepEqual([p.partial.map((x) => x.effect), p.opens.length, p.closedOnArrival.length], [['awaiting ruling'], 1, 0]);
  });
  it('ruled "close" closes; ruled "keep_open" waits for the full answers', () => {
    assert.equal(planFollowups(input(files(), { partialPolicy: 'close' })).closedOnArrival.length, 1);
    assert.equal(planFollowups(input(files(), { partialPolicy: 'keep_open' })).opens.length, 1);
  });
});

describe('lifecycle: expiry at term end', () => {
  it('expires what is still open at term end, and opens nothing after it', () => {
    const after = new Date('2027-01-10T00:00:00Z');
    const p = planFollowups(input([file('T5.pdf', '2026-10-01T00:00:00Z'), file('T6.pdf', '2027-01-09T20:00:00Z')], { now: after, existing: [open(5, '5', '2026-10-01T00:00:00Z')] }));
    assert.deepEqual([p.expires.map((e) => e.label), p.opens.length, p.ignored.map((i) => i.reason)], [['Tutorial 5'], 0, ['arrived after term end']]);
  });
});

describe('describing open items with their real age', () => {
  it('groups by module and category, with each posted date and age', () => {
    const at = (n: string, cat: 'Tutorials' | 'Labs', postedAt: string) => ({ moduleCode: 'AB1234', category: cat, number: n, postedAt });
    assert.deepEqual(describeItems([at('5', 'Tutorials', '2026-08-05T02:00:00Z'), at('3', 'Tutorials', '2026-08-05T02:00:00Z'), at('4', 'Tutorials', '2026-08-05T02:00:00Z'), at('4', 'Labs', '2026-10-14T02:00:00Z')], NOW), [
      'AB1234 Tutorials 3, 4 and 5, posted 5 Aug (76 days)',
      'AB1234 Lab 4, posted 14 Oct (6 days)',
    ]);
    assert.deepEqual(describeItems([at('1', 'Labs', '2026-10-01T02:00:00Z'), at('2', 'Labs', '2026-10-08T02:00:00Z')], NOW, { withModule: false }), [
      'Labs 1, posted 1 Oct (19 days) and 2, posted 8 Oct (12 days)',
    ]);
  });
});

// --- lesson-day reminders (D-62) --------------------------------------------------

// Invented timetable: module 1 Thursdays 09:00, module 2 Thursdays 12:00, 2026-08-13 .. 2026-11-12.
const TT: Timetable = {
  slots: [
    { contextId: 1, weekday: 4, startTime: '09:00', firstDate: '2026-08-13', lastDate: '2026-11-12', label: 'lab' },
    { contextId: 2, weekday: 4, startTime: '12:00', firstDate: '2026-08-13', lastDate: '2026-11-12', label: 'lab' },
  ],
  exceptions: [{ contextId: null, date: '2026-09-24' }, { contextId: 2, date: '2026-10-08' }],
};
const item = (id: number, contextId: number, number: string, openedAt: string): OpenItem =>
  ({ followupId: id, contextId, moduleCode: contextId === 1 ? 'AB1234' : 'CD5678', category: 'Labs', number, openedAt });
const at7 = (date: string) => sgtInstant(date, '07:00');
const LIVE = '2026-09-01T00:00:00Z';

describe('the timetable', () => {
  it('knows lesson days, and the days without one', () => {
    assert.equal(lessonsOn(TT, 1, '2026-10-01').length, 1);
    assert.equal(lessonsOn(TT, 1, '2026-09-30').length, 0, 'a Wednesday');
    assert.equal(lessonsOn(TT, 1, '2026-09-24').length, 0, 'recess, for every module');
    assert.deepEqual([lessonsOn(TT, 1, '2026-10-08').length, lessonsOn(TT, 2, '2026-10-08').length], [1, 0], 'one module\'s cancelled lab');
    assert.equal(lessonsOn(TT, 1, '2026-11-19').length, 0, 'after the last lesson');
  });

  it('finds the last lesson strictly before a moment, skipping recess', () => {
    assert.equal(lastLessonBefore(TT, 1, at7('2026-10-01'))?.toISOString(), '2026-09-17T01:00:00.000Z');
    assert.equal(lastLessonBefore(TT, 1, sgtInstant('2026-10-01', '09:30'))?.toISOString(), '2026-10-01T01:00:00.000Z');
  });
});

describe('the lesson-day reminder', () => {
  it('lists, at 07:00, what a lesson has already passed since it was posted -- all modules in one', () => {
    const d = planReminder({ now: at7('2026-10-01'), timetable: TT, liveSince: LIVE, open: [
      item(1, 1, '3', '2026-09-10T01:00:00Z'), // a lab on 17 Sep has passed: overdue
      item(2, 1, '4', '2026-09-18T01:00:00Z'), // posted after the last lesson (17 Sep): not yet
      item(3, 2, '2', '2026-08-05T01:00:00Z'),
    ] });
    assert.ok(d.plan !== null);
    assert.deepEqual(d.plan.modules.map((m) => [m.moduleCode, m.items.map((i) => i.number)]), [['AB1234', ['3']], ['CD5678', ['2']]]);
  });

  it('sends nothing before any lesson has passed since posting', () => {
    const d = planReminder({ now: at7('2026-10-01'), timetable: TT, liveSince: LIVE, open: [item(2, 1, '4', '2026-09-18T01:00:00Z')] });
    assert.deepEqual([d.plan, 'reason' in d ? d.reason : ''], [null, 'nothing is overdue']);
  });

  it('sends nothing on a day without a lesson: not a weekday lesson, not recess, not a cancelled lab', () => {
    const open = [item(3, 2, '2', '2026-08-05T01:00:00Z')];
    for (const date of ['2026-09-30', '2026-09-24', '2026-10-08']) {
      const d = planReminder({ now: at7(date), timetable: TT, liveSince: LIVE, open });
      assert.equal(d.plan, null, date);
    }
  });

  it('sends nothing before 07:00, and nothing on the morning follow-ups went live after 07:00', () => {
    const open = [item(3, 2, '2', '2026-08-05T01:00:00Z')];
    assert.equal(planReminder({ now: sgtInstant('2026-10-01', '06:40'), timetable: TT, liveSince: LIVE, open }).plan, null);
    assert.equal(planReminder({ now: sgtInstant('2026-10-01', '10:00'), timetable: TT, liveSince: sgtInstant('2026-10-01', '09:30').toISOString(), open }).plan, null);
    assert.notEqual(planReminder({ now: sgtInstant('2026-10-01', '10:00'), timetable: TT, liveSince: LIVE, open }).plan, null, 'a late 07:00 run still sends');
  });
});

describe('tune-patterns: pairs from names, numbers-only differences ignored', () => {
  it('ranks the extra words of question/answer pairs within a module', () => {
    const f = (contextId: number, moduleCode: string, title: string) => ({ contextId, moduleCode, title });
    const { tokens, pairs } = tunePatterns([
      f(1, 'AB1234', 'AB1234-T1.pdf'), f(1, 'AB1234', 'AB1234-T1-Answers.zip'), f(1, 'AB1234', 'AB1234-T2.pdf'), f(1, 'AB1234', 'AB1234-T2-Answers.zip'),
      f(2, 'CD5678', 'Practical Lab 01.pdf'), f(2, 'CD5678', 'Practical Lab 01 - Suggested Solutions.pdf'),
      f(2, 'CD5678', 'Deck.pptx'), f(2, 'CD5678', 'Deck-1.pptx'), f(2, 'CD5678', 'Deck-2.pptx'),
      f(3, 'EF9012', 'T1.pdf'), // no partner across modules
    ]);
    assert.deepEqual(tokens.map((t) => [t.token, t.pairs, t.generic]), [['answers', 2, true], ['solutions', 1, true], ['suggested', 1, false]]);
    assert.equal(pairs.length, 3, 'the -1/-2 re-uploads are not pairs');
  });
});
