/**
 * The follow-up planner (DECISIONS.md D-61): a pure function from what is
 * archived, and what is already tracked, to what should change now. The live
 * sync stage and the read-only preview both call it, so the preview shows
 * exactly what going live would do.
 *
 * Pairing key: (context, category, normalised number). Within a key:
 *   - answers present when the question is first tracked -- arriving before
 *     it, or in the same run -- mean no follow-up opens: the pair is recorded
 *     closed, silently;
 *   - the earliest answer closes an open follow-up; later ones do nothing;
 *   - a second question file with the same number (a revision, a dated or
 *     week-named copy) finds the key already tracked: no second follow-up.
 */

import { classify, followupLabel, FOLLOWUP_CATEGORIES, type FollowupCategory } from './classify.ts';

export const NUDGE_AFTER_MS = 10 * 24 * 3600_000;

export type PartialPolicy = 'close' | 'keep_open' | null;

export interface TrackedFile {
  itemId: string;
  contextId: number;
  moduleCode: string;
  /** The file's route: files.route_category, or what routing would decide. */
  category: string;
  title: string;
  firstSeenAt: string;
}

export interface ExistingFollowup {
  id: number;
  contextId: number;
  category: FollowupCategory;
  number: string;
  state: 'open' | 'closed' | 'dismissed' | 'expired';
  openedAt: string;
  nudgedAt: string | null;
}

export interface PlanInput {
  files: readonly TrackedFile[];
  existing: readonly ExistingFollowup[];
  phrases: ReadonlyMap<number, readonly string[]>;
  partialPolicy: PartialPolicy;
  termEnds: ReadonlyMap<number, string | null>;
  now: Date;
  /** The silent first run: nothing is announced, nothing is nudged. */
  baseline: boolean;
}

export interface Key {
  contextId: number;
  moduleCode: string;
  category: FollowupCategory;
  number: string;
  label: string;
}

export interface Plan {
  /** New follow-ups: a numbered question with no answers yet. */
  opens: Array<Key & { question: TrackedFile; ageDays: number; pastNudge: boolean }>;
  /** New rows recorded closed at once: answers were already there. */
  closedOnArrival: Array<Key & { question: TrackedFile; answer: TrackedFile }>;
  /** Open follow-ups the earliest matching answer now closes. */
  closes: Array<Key & { followupId: number; answer: TrackedFile }>;
  nudges: Array<Key & { followupId: number; ageDays: number }>;
  expires: Array<Key & { followupId: number }>;
  /** Files in Tutorials or Labs that deliberately take no part. */
  ignored: Array<{ file: TrackedFile; reason: string }>;
  /** Partial answer files: an owner ruling (followup_partial_answers). */
  partial: Array<Key & { file: TrackedFile; effect: 'awaiting ruling' | 'closes' | 'does not close' }>;
  answersWithoutQuestion: Array<Key & { file: TrackedFile }>;
  /** Further answer files for a key already answered: they do nothing. */
  extraAnswers: Array<Key & { file: TrackedFile }>;
}

const order = (a: TrackedFile, b: TrackedFile) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.itemId.localeCompare(b.itemId);
const days = (ms: number) => Math.floor(ms / (24 * 3600_000));

export function planFollowups(input: PlanInput): Plan {
  const plan: Plan = { opens: [], closedOnArrival: [], closes: [], nudges: [], expires: [], ignored: [], partial: [], answersWithoutQuestion: [], extraAnswers: [] };
  const groups = new Map<string, { key: Key; questions: TrackedFile[]; answers: TrackedFile[] }>();
  const now = input.now.getTime();

  for (const file of input.files) {
    if (!FOLLOWUP_CATEGORIES.has(file.category)) continue;
    const category = file.category as FollowupCategory;
    const c = classify(file.title, category, input.phrases.get(file.contextId) ?? []);
    if (c.role === 'ignored') {
      plan.ignored.push({ file, reason: c.reason });
      continue;
    }
    const id = `${file.contextId}|${category}|${c.number}`;
    const key: Key = { contextId: file.contextId, moduleCode: file.moduleCode, category, number: c.number, label: followupLabel(category, c.number) };
    const group = groups.get(id) ?? { key, questions: [], answers: [] };
    groups.set(id, group);
    if (c.role === 'question') {
      group.questions.push(file);
      continue;
    }
    if (c.partial) {
      const effect = input.partialPolicy === 'close' ? 'closes' : input.partialPolicy === 'keep_open' ? 'does not close' : 'awaiting ruling';
      plan.partial.push({ ...key, file, effect });
      if (input.partialPolicy !== 'close') continue;
    }
    group.answers.push(file);
  }

  const existing = new Map(input.existing.map((e) => [`${e.contextId}|${e.category}|${e.number}`, e]));
  for (const [id, { key, questions, answers }] of groups) {
    questions.sort(order);
    answers.sort(order);
    const row = existing.get(id);
    const termEnd = input.termEnds.get(key.contextId) ?? null;
    const termOver = termEnd !== null && now >= new Date(termEnd).getTime();

    if (row === undefined) {
      if (questions.length === 0) {
        if (answers.length > 0) plan.answersWithoutQuestion.push({ ...key, file: answers[0]! });
        continue;
      }
      const question = questions[0]!;
      if (answers.length > 0) {
        plan.closedOnArrival.push({ ...key, question, answer: answers[0]! });
        for (const extra of answers.slice(1)) plan.extraAnswers.push({ ...key, file: extra });
        continue;
      }
      if (termOver) {
        plan.ignored.push({ file: question, reason: 'arrived after term end' });
        continue;
      }
      const age = now - new Date(question.firstSeenAt).getTime();
      plan.opens.push({ ...key, question, ageDays: days(age), pastNudge: age >= NUDGE_AFTER_MS });
      continue;
    }

    if (row.state !== 'open') {
      for (const extra of answers) plan.extraAnswers.push({ ...key, file: extra });
      continue;
    }
    if (answers.length > 0) {
      plan.closes.push({ ...key, followupId: row.id, answer: answers[0]! });
      for (const extra of answers.slice(1)) plan.extraAnswers.push({ ...key, file: extra });
      continue;
    }
    if (termOver) {
      plan.expires.push({ ...key, followupId: row.id });
      continue;
    }
    const age = now - new Date(row.openedAt).getTime();
    if (!input.baseline && row.nudgedAt === null && age >= NUDGE_AFTER_MS) {
      plan.nudges.push({ ...key, followupId: row.id, ageDays: days(age) });
    }
  }
  return plan;
}

/** "BT0000 Tutorials 3, 4 and 5" -- one phrase per module and category. */
export function describeOpen(opens: ReadonlyArray<Key & { ageDays: number; pastNudge: boolean }>): string[] {
  const byGroup = new Map<string, Array<Key & { ageDays: number; pastNudge: boolean }>>();
  for (const o of opens) {
    const g = `${o.moduleCode}|${o.category}`;
    byGroup.set(g, [...(byGroup.get(g) ?? []), o]);
  }
  const phrases: string[] = [];
  for (const group of byGroup.values()) {
    group.sort((a, b) => Number(a.number) - Number(b.number));
    const first = group[0]!;
    const noun = first.category === 'Tutorials' ? 'Tutorial' : 'Lab';
    const nums = group.map((g) => g.number);
    const list = nums.length === 1 ? nums[0]! : `${nums.slice(0, -1).join(', ')} and ${nums.at(-1)!}`;
    const aged = group.filter((g) => g.pastNudge).map((g) => `${noun} ${g.number}: ${g.ageDays} days`);
    phrases.push(`${first.moduleCode} ${noun}${nums.length === 1 ? '' : 's'} ${list}${aged.length > 0 ? ` (${aged.join(', ')})` : ''}`);
  }
  return phrases;
}
