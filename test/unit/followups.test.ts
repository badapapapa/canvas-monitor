/**
 * Answer-sheet follow-ups (DECISIONS.md D-61): the classifier and the planner.
 * Invented module codes and names throughout.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classify, extractNumber, isAnswerName, tokensOf } from '../../src/followups/classify.ts';
import { describeOpen, planFollowups, type ExistingFollowup, type PlanInput, type TrackedFile } from '../../src/followups/plan.ts';
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
const file = (title: string, firstSeenAt: string, category = 'Tutorials', contextId = 1): TrackedFile =>
  ({ itemId: `i${(seq += 1)}`, contextId, moduleCode: contextId === 1 ? 'AB1234' : 'CD5678', category, title, firstSeenAt });
const NOW = new Date('2026-10-20T12:00:00Z');
const input = (files: TrackedFile[], over: Partial<PlanInput> = {}): PlanInput =>
  ({ files, existing: [], phrases: new Map(), partialPolicy: 'keep_open', termEnds: new Map([[1, '2027-01-09T15:59:00Z']]), now: NOW, baseline: false, ...over });
const open = (id: number, number: string, openedAt: string, over: Partial<ExistingFollowup> = {}): ExistingFollowup =>
  ({ id, contextId: 1, category: 'Tutorials', number, state: 'open', openedAt, nudgedAt: null, ...over });

describe('pairing on (context, category, number)', () => {
  it('opens a follow-up for a numbered question with no answers', () => {
    const p = planFollowups(input([file('AB1234-T3.pdf', '2026-10-18T00:00:00Z')]));
    assert.deepEqual(p.opens.map((o) => [o.label, o.ageDays, o.pastNudge]), [['Tutorial 3', 2, false]]);
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

describe('lifecycle: one nudge at 10 days, expiry at term end', () => {
  it('nudges once, at 10 days, never before and never again', () => {
    const q = [file('T5.pdf', '2026-10-05T00:00:00Z')];
    assert.equal(planFollowups(input(q, { existing: [open(5, '5', '2026-10-11T00:00:00Z')] })).nudges.length, 0, '9 days');
    assert.equal(planFollowups(input(q, { existing: [open(5, '5', '2026-10-10T00:00:00Z')] })).nudges.length, 1, '10 days');
    assert.equal(planFollowups(input(q, { existing: [open(5, '5', '2026-10-01T00:00:00Z', { nudgedAt: '2026-10-11T00:00:00Z' })] })).nudges.length, 0, 'already nudged');
  });

  it('sends no nudge at all during the first run', () => {
    assert.equal(planFollowups(input([file('T5.pdf', '2026-09-01T00:00:00Z')], { baseline: true, existing: [open(5, '5', '2026-09-01T00:00:00Z')] })).nudges.length, 0);
  });

  it('expires what is still open at term end, and opens nothing after it', () => {
    const after = new Date('2027-01-10T00:00:00Z');
    const p = planFollowups(input([file('T5.pdf', '2026-10-01T00:00:00Z'), file('T6.pdf', '2027-01-09T20:00:00Z')], { now: after, existing: [open(5, '5', '2026-10-01T00:00:00Z')] }));
    assert.deepEqual([p.expires.map((e) => e.label), p.opens.length, p.ignored.map((i) => i.reason)], [['Tutorial 5'], 0, ['arrived after term end']]);
  });
});

describe('the first-run summary', () => {
  it('reads "AB1234 Tutorials 3, 4 and 5", with the age of anything past 10 days', () => {
    const p = planFollowups(input(
      [file('T3.pdf', '2026-10-05T00:00:00Z'), file('T4.pdf', '2026-10-12T00:00:00Z'), file('T5.pdf', '2026-10-19T00:00:00Z'), file('Lab 2.pdf', '2026-10-19T00:00:00Z', 'Labs')],
      { baseline: true },
    ));
    assert.deepEqual(describeOpen(p.opens), ['AB1234 Tutorials 3, 4 and 5 (Tutorial 3: 15 days)', 'AB1234 Lab 2']);
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
