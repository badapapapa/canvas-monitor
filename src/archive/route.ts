/**
 * Where a file goes, decided once (SPEC.md section 8; DECISIONS.md D-40).
 *
 * Phase 4 ships the seed defaults so most files land correctly from their
 * first download. The rules are code, not a table, until Phase 5 makes them
 * editable. A file nothing matches goes to `_unsorted`: the "we don't know
 * yet" state, which is the only placement that may later be re-routed, once.
 *
 * Matching is on word boundaries: "Lab" matches "Practical Lab", but "tut"
 * does not match "institute".
 */

export type Category = 'Lectures' | 'Tutorials' | 'Labs' | 'Readings' | 'Assignments' | 'Group' | '_unsorted';

export interface RouteInput {
  contextType: 'course' | 'group';
  /** Canvas folder path below the root, e.g. "Week 06/Practical Lab". */
  folder: string | null;
  /** Module name, for files found through the Modules fallback. */
  module: string | null;
  fileName: string;
}

export interface RouteDecision {
  category: Category;
  /** Which rule decided, for the record and for Phase 5 tuning. */
  rule: string;
  /** folder 1.0, module 0.8, filename 0.6, unsorted 0. */
  confidence: number;
  /** Only `_unsorted` placements may be re-routed later (D-40). */
  reroutable: boolean;
}

interface Rule {
  id: string;
  fields: Array<'folder' | 'module' | 'filename'>;
  pattern: RegExp;
  category: Category;
}

const RULES: Rule[] = [
  { id: 'tutorial', fields: ['folder', 'module'], pattern: /\b(tut|tutorials?)\b/i, category: 'Tutorials' },
  { id: 'lab', fields: ['folder', 'module'], pattern: /\b(labs?|practicals?)\b/i, category: 'Labs' },
  { id: 'lecture', fields: ['folder', 'module'], pattern: /\b(lectures?|slides)\b/i, category: 'Lectures' },
  { id: 'reading', fields: ['folder', 'module'], pattern: /\b(readings?|papers?)\b/i, category: 'Readings' },
  { id: 'assignment', fields: ['filename'], pattern: /\b(assignments?|projects?)\b/i, category: 'Assignments' },
];

const CONFIDENCE = { folder: 1, module: 0.8, filename: 0.6 } as const;

/** Anything a rule matches below this goes to `_unsorted` instead. */
export const ROUTE_CONFIDENCE_THRESHOLD = 0.5;

export function route(input: RouteInput): RouteDecision {
  // Group files are the project's own; no lecture/tutorial taxonomy applies.
  if (input.contextType === 'group') {
    return { category: 'Group', rule: 'group', confidence: 1, reroutable: false };
  }
  const values = { folder: input.folder, module: input.module, filename: input.fileName };
  for (const rule of RULES) {
    for (const field of rule.fields) {
      const value = values[field];
      if (value !== null && rule.pattern.test(value) && CONFIDENCE[field] >= ROUTE_CONFIDENCE_THRESHOLD) {
        return { category: rule.category, rule: `${rule.id}:${field}`, confidence: CONFIDENCE[field], reroutable: false };
      }
    }
  }
  return { category: '_unsorted', rule: 'none', confidence: 0, reroutable: true };
}
