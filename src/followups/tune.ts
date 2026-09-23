/**
 * `tune-patterns` (SPEC.md section 10; DECISIONS.md D-61): evidence, not
 * guesses, for which words mark an answer file. Read-only.
 *
 * Within each module, a file whose words are a strict superset of another
 * file's words, by one to three extra words, is a candidate question/answer
 * pair ("T1" -> "T1 Answers"; "Practical Lab 01" -> "Practical Lab 01
 * Suggested Solutions"). The extra words are ranked by how many pairs they
 * explain. Extras that are only numbers are dropped: those are Canvas's own
 * "-1"/"-2" re-upload suffixes, or versions -- Phase 7's business, not answers.
 */

import { GENERIC_ANSWER_TOKENS, tokensOf } from './classify.ts';

export interface TuneFile {
  contextId: number;
  moduleCode: string;
  title: string;
}

export interface TunePair {
  moduleCode: string;
  question: string;
  answer: string;
  extra: string[];
}

export interface TokenStat {
  token: string;
  pairs: number;
  modules: string[];
  /** Already recognised by the generic words in code. */
  generic: boolean;
  examples: TunePair[];
}

export const MAX_EXTRA_WORDS = 3;

export function tunePatterns(files: readonly TuneFile[]): { tokens: TokenStat[]; pairs: TunePair[] } {
  const byContext = new Map<number, TuneFile[]>();
  for (const f of files) byContext.set(f.contextId, [...(byContext.get(f.contextId) ?? []), f]);

  const pairs: TunePair[] = [];
  for (const group of byContext.values()) {
    const sets = group.map((f) => ({ f, tokens: tokensOf(f.title) }));
    for (const b of sets) {
      // For each would-be answer, the closest question: the fewest extra words.
      let best: TunePair | null = null;
      for (const a of sets) {
        if (a === b || a.tokens.length === 0) continue;
        const bSet = new Set(b.tokens);
        const aSet = new Set(a.tokens);
        if (aSet.size >= bSet.size || ![...aSet].every((t) => bSet.has(t))) continue;
        const extra = b.tokens.filter((t, i) => !aSet.has(t) && b.tokens.indexOf(t) === i);
        if (extra.length === 0 || extra.length > MAX_EXTRA_WORDS || extra.every((t) => /^\d+$/.test(t))) continue;
        if (best === null || extra.length < best.extra.length) best = { moduleCode: b.f.moduleCode, question: a.f.title, answer: b.f.title, extra };
      }
      if (best !== null) pairs.push(best);
    }
  }

  const stats = new Map<string, TokenStat>();
  for (const p of pairs) {
    for (const token of p.extra) {
      if (/^\d+$/.test(token)) continue;
      const s = stats.get(token) ?? { token, pairs: 0, modules: [], generic: GENERIC_ANSWER_TOKENS.has(token), examples: [] };
      s.pairs += 1;
      if (!s.modules.includes(p.moduleCode)) s.modules.push(p.moduleCode);
      s.examples.push(p);
      stats.set(token, s);
    }
  }
  const tokens = [...stats.values()].sort((x, y) => y.pairs - x.pairs || x.token.localeCompare(y.token));
  return { tokens, pairs };
}
