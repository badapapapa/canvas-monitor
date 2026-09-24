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

export type PartialPolicy = 'close' | 'keep_open' | null;

export interface TrackedFile {
  itemId: string;
  contextId: number;
  moduleCode: string;
  /** The file's route: files.route_category, or what routing would decide. */
  category: string;
  title: string;
  firstSeenAt: string;
  /** Canvas's own upload time. Ages and "overdue" run from this (D-62). */
  postedAt: string | null;
}

/** When the question was posted, falling back to when the monitor first saw it. */
export const postedOf = (f: TrackedFile): string => f.postedAt ?? f.firstSeenAt;

export interface ExistingFollowup {
  id: number;
  contextId: number;
  category: FollowupCategory;
  number: string;
  state: 'open' | 'closed' | 'dismissed' | 'expired';
  openedAt: string;
}

export interface PlanInput {
  files: readonly TrackedFile[];
  existing: readonly ExistingFollowup[];
  phrases: ReadonlyMap<number, readonly string[]>;
  partialPolicy: PartialPolicy;
  termEnds: ReadonlyMap<number, string | null>;
  now: Date;
  /** Contexts whose answer tracking is switched off: they take no part at all. */
  trackingOff?: ReadonlySet<number>;
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
  opens: Array<Key & { question: TrackedFile; postedAt: string; ageDays: number }>;
  /** New rows recorded closed at once: answers were already there. */
  closedOnArrival: Array<Key & { question: TrackedFile; answer: TrackedFile }>;
  /** Open follow-ups the earliest matching answer now closes. */
  closes: Array<Key & { followupId: number; answer: TrackedFile }>;
  expires: Array<Key & { followupId: number }>;
  /** Files in Tutorials or Labs that deliberately take no part. */
  ignored: Array<{ file: TrackedFile; reason: string }>;
  /** Partial answer files: an owner ruling (followup_partial_answers). */
  partial: Array<Key & { file: TrackedFile; effect: 'awaiting ruling' | 'closes' | 'does not close' }>;
  answersWithoutQuestion: Array<Key & { file: TrackedFile }>;
  /** Further answer files for a key already answered: they do nothing. */
  extraAnswers: Array<Key & { file: TrackedFile }>;
  /** Files in modules with tracking off (listed by the preview only). */
  trackingOff: TrackedFile[];
}

// Order by when the monitor saw them: that is the order the runs processed them in.
const order = (a: TrackedFile, b: TrackedFile) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.itemId.localeCompare(b.itemId);
const days = (ms: number) => Math.floor(ms / (24 * 3600_000));

export function planFollowups(input: PlanInput): Plan {
  const plan: Plan = { opens: [], closedOnArrival: [], closes: [], expires: [], ignored: [], partial: [], answersWithoutQuestion: [], extraAnswers: [], trackingOff: [] };
  const groups = new Map<string, { key: Key; questions: TrackedFile[]; answers: TrackedFile[] }>();
  const now = input.now.getTime();

  for (const file of input.files) {
    if (!FOLLOWUP_CATEGORIES.has(file.category)) continue;
    if (input.trackingOff?.has(file.contextId) === true) {
      plan.trackingOff.push(file);
      continue;
    }
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
      const postedAt = postedOf(question);
      plan.opens.push({ ...key, question, postedAt, ageDays: days(now - new Date(postedAt).getTime()) });
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
    if (termOver) plan.expires.push({ ...key, followupId: row.id });
  }
  return plan;
}

// "5 Aug", in SGT. By hand, not Intl: locale data differs between machines ("Sep" vs "Sept").
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = {
  format(d: Date): string {
    const sgt = new Date(d.getTime() + 8 * 3600_000);
    return `${sgt.getUTCDate()} ${MONTHS[sgt.getUTCMonth()]!}`;
  },
};

export interface Describable {
  moduleCode: string;
  category: FollowupCategory;
  number: string;
  postedAt: string;
}

/**
 * "AB1234 Tutorials 3, 4 and 5, posted 5 Aug (50 days)" -- one phrase per
 * module and category, with each item's real age from its posted date.
 */
export function describeItems(items: readonly Describable[], now: Date, opts: { withModule?: boolean } = {}): string[] {
  const byGroup = new Map<string, Describable[]>();
  for (const o of items) byGroup.set(`${o.moduleCode}|${o.category}`, [...(byGroup.get(`${o.moduleCode}|${o.category}`) ?? []), o]);
  const age = (iso: string) => `posted ${shortDate.format(new Date(iso))} (${days(now.getTime() - new Date(iso).getTime())} days)`;
  const list = (xs: string[]) => (xs.length === 1 ? xs[0]! : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)!}`);
  const phrases: string[] = [];
  for (const group of byGroup.values()) {
    group.sort((a, b) => Number(a.number) - Number(b.number));
    const first = group[0]!;
    const noun = first.category === 'Tutorials' ? 'Tutorial' : 'Lab';
    const plural = `${opts.withModule === false ? '' : `${first.moduleCode} `}${group.length === 1 ? noun : `${noun}s`}`;
    const sameDay = new Set(group.map((g) => shortDate.format(new Date(g.postedAt)))).size === 1;
    phrases.push(sameDay
      ? `${plural} ${list(group.map((g) => g.number))}, ${age(first.postedAt)}`
      : `${plural} ${list(group.map((g) => `${g.number}, ${age(g.postedAt)}`))}`);
  }
  return phrases;
}
