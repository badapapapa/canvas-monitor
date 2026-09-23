/**
 * Which archived files matter to answer-sheet follow-ups, and how they pair
 * (SPEC.md section 10; DECISIONS.md D-61). Filenames only: no PDF text.
 *
 * Every name is read as words, split on anything that is not a letter or a
 * digit -- the same splitting as routing (D-57). Matching is on whole words,
 * never substrings: "transient" is not "answers", "Ansell" is not "ans".
 *
 * A file takes part only if it was routed into Tutorials or Labs AND its name
 * carries that category's number: "T3", "Tutorial 1", "Tut 2" for Tutorials;
 * "Lab 04", "Lab04", "Practical Lab 03", "Practical 2" for Labs. Anything
 * without one -- a starter kit, a dataset, a class roster -- is ignored,
 * so it can never sit open all term.
 *
 * The number is normalised ("04" -> "4") and compared exactly, so "Lab 04"
 * pairs with "Lab 4", and Tutorial 1's answers can never close Tutorial 11.
 */

import { words } from '../archive/route.ts';

/** Generic answer words, safe in code. Module-specific phrases live in the database. */
export const GENERIC_ANSWER_TOKENS: ReadonlySet<string> = new Set(['answer', 'answers', 'solution', 'solutions', 'soln', 'solns']);

export type FollowupCategory = 'Tutorials' | 'Labs';

export const FOLLOWUP_CATEGORIES: ReadonlySet<string> = new Set<FollowupCategory>(['Tutorials', 'Labs']);

export type Classification =
  | { role: 'question'; number: string }
  | { role: 'answer'; number: string; partial: boolean }
  | { role: 'ignored'; reason: 'no number' | 'answer file with no number' };

/** The words of a file name without its extension, lower-cased. */
export function tokensOf(fileName: string): string[] {
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 && /^\.[A-Za-z0-9]{1,8}$/.test(fileName.slice(dot)) ? fileName.slice(0, dot) : fileName;
  const text = words(stem).toLowerCase();
  return text === '' ? [] : text.split(' ');
}

/** "04" -> "4". One or two digits only: a year or a module code is never a tutorial number. */
function normalise(digits: string): string | null {
  return /^\d{1,2}$/.test(digits) ? String(Number(digits)) : null;
}

const DESIGNATORS: Record<FollowupCategory, { words: ReadonlySet<string>; joined: RegExp }> = {
  // "Tutorial 3", "Tut 3", and the joined forms "T3", "Tut3", "Tutorial3".
  Tutorials: { words: new Set(['tutorial', 'tut']), joined: /^(?:t|tut|tutorial)(\d{1,2})$/ },
  // "Lab 04", "Practical 2" ("Practical Lab 03" reads "lab 03"), and "Lab04".
  Labs: { words: new Set(['lab', 'practical']), joined: /^(?:lab|practical)(\d{1,2})$/ },
};

/** The category's number in this name, normalised, or null. The first designator wins. */
export function extractNumber(tokens: readonly string[], category: FollowupCategory): string | null {
  const d = DESIGNATORS[category];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i]!;
    const joined = d.joined.exec(t);
    if (joined !== null) return normalise(joined[1]!);
    if (d.words.has(t)) {
      const next = tokens[i + 1];
      if (next !== undefined && /^\d+$/.test(next)) return normalise(next);
    }
  }
  return null;
}

/** Word-boundary match of a module phrase against the name's words. */
function hasPhrase(tokens: readonly string[], phrase: string): boolean {
  const want = tokensOf(phrase);
  if (want.length === 0) return false;
  for (let i = 0; i + want.length <= tokens.length; i += 1) {
    if (want.every((w, j) => tokens[i + j] === w)) return true;
  }
  return false;
}

export function isAnswerName(tokens: readonly string[], modulePhrases: readonly string[] = []): boolean {
  return tokens.some((t) => GENERIC_ANSWER_TOKENS.has(t)) || modulePhrases.some((p) => hasPhrase(tokens, p));
}

/** "Part 1 - Suggested Solutions": answers to only part of the set. */
function isPartial(tokens: readonly string[]): boolean {
  return tokens.some((t, i) => (t === 'part' && /^\d+$/.test(tokens[i + 1] ?? '')) || /^part\d+$/.test(t));
}

export function classify(fileName: string, category: FollowupCategory, modulePhrases: readonly string[] = []): Classification {
  const tokens = tokensOf(fileName);
  const number = extractNumber(tokens, category);
  const answer = isAnswerName(tokens, modulePhrases);
  if (number === null) return { role: 'ignored', reason: answer ? 'answer file with no number' : 'no number' };
  return answer ? { role: 'answer', number, partial: isPartial(tokens) } : { role: 'question', number };
}

/** "Tutorial 3", "Lab 4": how a follow-up is named in messages. */
export function followupLabel(category: FollowupCategory, number: string): string {
  return `${category === 'Tutorials' ? 'Tutorial' : 'Lab'} ${number}`;
}
