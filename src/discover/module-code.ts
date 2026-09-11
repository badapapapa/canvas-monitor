/**
 * Inference helpers for `npm run discover` (SPEC.md section 16).
 *
 * Every function here produces a SUGGESTION. The seed file is the human
 * checkpoint and the spec is explicit that inference will always have edge
 * cases: "do not regex your way to a final answer here." Nothing in this module
 * writes to the database.
 */

/**
 * NUS module codes: 2-4 letters, 4 digits, an optional trailing letter.
 *
 * SPEC.md originally specified `[A-Z]{2,3}`. Observed 2026-09-10, that is
 * wrong: NUS uses four-letter prefixes (GESS, GEXS), and against a code such as `ABCD1234`
 * the three-letter form does not fail -- it silently matches `BCD1234`, one
 * character in. A wrong module code is a wrong OneDrive folder name, decided
 * once and never revisited (SPEC.md section 8's route-once rule), so this is
 * exactly the class of quiet error worth an anchor.
 *
 * The `\b` matters as much as the `{2,4}`: without it the engine still finds a
 * shorter match inside a longer code.
 */
const MODULE_CODE = /\b[A-Z]{2,4}\d{4}[A-Z]?\b/g;

/** Terms arrive as `[2610] 2026/2027 Semester 1`. Non-academic sites have no code. */
const TERM_CODE = /^\s*\[(\d{4})\]/;

export interface ExtractedCodes {
  /** First match, the conventional primary. Still only a proposal. */
  primary: string | null;
  /** Every match, in order. Combined offerings yield more than one. */
  all: string[];
}

export function extractModuleCodes(...sources: Array<string | null | undefined>): ExtractedCodes {
  const seen: string[] = [];
  for (const source of sources) {
    if (source === null || source === undefined) continue;
    for (const match of source.toUpperCase().matchAll(MODULE_CODE)) {
      const code = match[0];
      if (code !== undefined && !seen.includes(code)) seen.push(code);
    }
  }
  return { primary: seen[0] ?? null, all: seen };
}

export interface ParsedTerm {
  /** `2610`, the stable sort and grouping key. Null for non-academic sites. */
  code: string | null;
  /** The full Canvas string, kept for the seed file so I can sanity-check it. */
  name: string | null;
}

/**
 * The bracketed code -- not the full term name -- is what
 * `Canvas/<term>/<module_code>/` uses. The full string contains slashes
 * (`2026/2027`) that SPEC.md section 5's path sanitising would strip anyway,
 * turning a meaningful label into mush.
 */
export function parseTerm(termName: string | null | undefined): ParsedTerm {
  if (termName === null || termName === undefined || termName === '') {
    return { code: null, name: null };
  }
  return { code: TERM_CODE.exec(termName)?.[1] ?? null, name: termName };
}

/**
 * A site with no bracketed term code is administrative, not academic.
 *
 * Observed 2026-09-10: four of eight active courses were mandatory admin sites
 * (orientation, consent training, travel preparedness), all carrying the term
 * literal `Non-Academic`. Keying on the ABSENCE of a term code rather than on
 * that literal string means a renamed label does not break the heuristic.
 */
export function isNonAcademic(term: ParsedTerm): boolean {
  return term.code === null;
}

export type EnabledReason =
  | 'current_term'
  | 'prior_term'
  | 'non_academic'
  | 'no_term_code';

export interface EnabledProposal {
  enabled: boolean;
  reason: EnabledReason;
  explanation: string;
}

/**
 * `enrollment_state=active` is not a proxy for "modules I am taking now".
 *
 * Observed 2026-09-10: of eight active courses, three were current, one was a
 * prior semester still un-concluded, and four were admin sites that persist
 * indefinitely. Polling all eight would spend rate-limit budget on noise and
 * bury real notifications under it.
 */
export function proposeEnabled(term: ParsedTerm, currentTermCode: string | null): EnabledProposal {
  if (term.code === null) {
    return {
      enabled: false,
      reason: 'non_academic',
      explanation: 'No term code: administrative site, not a module.',
    };
  }
  if (currentTermCode === null) {
    return {
      enabled: false,
      reason: 'no_term_code',
      explanation: 'No current term could be determined; defaulting to disabled for review.',
    };
  }
  if (term.code === currentTermCode) {
    return {
      enabled: true,
      reason: 'current_term',
      explanation: `Term ${term.code} is the current term.`,
    };
  }
  return {
    enabled: false,
    reason: 'prior_term',
    explanation: `Term ${term.code} predates the current term ${currentTermCode}.`,
  };
}

/**
 * The highest term code present. Codes are ordered integers (2520 < 2610), so
 * "highest" is "most recent" without needing a calendar.
 */
export function currentTermCode(terms: readonly ParsedTerm[]): string | null {
  const codes = terms.map((t) => t.code).filter((c): c is string => c !== null).sort();
  return codes[codes.length - 1] ?? null;
}

/**
 * Courses sharing an extracted module code are candidate lecture/tutorial site
 * splits (SPEC.md section 16 step 5).
 *
 * UNEXERCISED as of 2026-09-10: every module is a single Canvas site, so this
 * has never fired against real data. It stays built for a semester that splits,
 * and must not be presumed correct until it does.
 */
export function findSharedCodeGroups(
  entries: ReadonlyArray<{ canvasId: number; codes: readonly string[] }>,
): Map<string, number[]> {
  const byCode = new Map<string, number[]>();
  for (const entry of entries) {
    for (const code of entry.codes) {
      const existing = byCode.get(code);
      if (existing === undefined) byCode.set(code, [entry.canvasId]);
      else existing.push(entry.canvasId);
    }
  }
  for (const [code, ids] of [...byCode]) {
    if (ids.length < 2) byCode.delete(code);
  }
  return byCode;
}
