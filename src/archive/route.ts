/**
 * Where a file goes, decided once (SPEC.md section 8; DECISIONS.md D-40, D-57).
 *
 * Order of decision:
 *   1. Group files go to `Group`.
 *   2. Per-module rules from the `routing_rules` table, by priority. These are
 *      data, never code: they name real folders and files (D-39). A rule may
 *      target a standard category or a custom folder under <term>/<module>/.
 *   3. The generic defaults below, folder before module before filename.
 *   4. Otherwise `_unsorted`: "we don't know yet", the only placement that may
 *      later be re-routed, once, and only after a preview is approved.
 *
 * Every value is matched with each run of non-alphanumerics collapsed to one
 * space, so `Tutorials_Practicals` reads as "Tutorials Practicals" and `AB-T1` as "AB T1".
 * Word boundaries then hold: "Lab" matches "Practical Lab", "tut" does not
 * match "institute".
 */

import { safeSegment } from './filename.ts';

export const STANDARD_CATEGORIES = ['Lectures', 'Tutorials', 'Labs', 'Readings', 'Assignments'] as const;
export type Category = (typeof STANDARD_CATEGORIES)[number] | 'Group' | '_unsorted';
/** A standard category, or a custom folder name from a stored rule. */
export type Destination = Category | (string & {});

export interface RouteInput {
  contextType: 'course' | 'group';
  /** Canvas folder path below the root, e.g. "Week 06/Practical Lab". */
  folder: string | null;
  /** Module name, for files found through the Modules fallback. */
  module: string | null;
  fileName: string;
}

export interface RouteDecision {
  category: Destination;
  /** Which rule decided: `<default>:<field>` (e.g. `lab:folder`), `db:<id>`, `group` or `none`. */
  rule: string;
  /** stored rule 1.0; default folder 1.0, module 0.8, filename 0.6; unsorted 0. */
  confidence: number;
  /** Only `_unsorted` placements may be re-routed later (D-40). */
  reroutable: boolean;
}

export type RuleField = 'folder' | 'module' | 'filename' | 'extension';

/** A row of `routing_rules`, for one context. */
export interface StoredRule {
  id: number;
  field: RuleField;
  pattern: string;
  target: string;
  priority: number;
}

interface DefaultRule {
  id: string;
  fields: ReadonlyArray<'folder' | 'module' | 'filename'>;
  pattern: RegExp;
  category: Category;
}

const DEFAULTS: DefaultRule[] = [
  // Filename matching for tutorials too (D-57): "Week 1 Tutorial - Blank.pdf"
  // is unambiguous wherever it sits.
  { id: 'tutorial', fields: ['folder', 'module', 'filename'], pattern: /\b(tut|tutorials?)\b/i, category: 'Tutorials' },
  { id: 'lab', fields: ['folder', 'module'], pattern: /\b(labs?|practicals?)\b/i, category: 'Labs' },
  { id: 'lecture', fields: ['folder', 'module'], pattern: /\b(lectures?|slides)\b/i, category: 'Lectures' },
  { id: 'reading', fields: ['folder', 'module'], pattern: /\b(readings?|papers?)\b/i, category: 'Readings' },
  { id: 'assignment', fields: ['filename'], pattern: /\b(assignments?|projects?)\b/i, category: 'Assignments' },
];

const CONFIDENCE = { folder: 1, module: 0.8, filename: 0.6 } as const;
const FIELD_ORDER = ['folder', 'module', 'filename'] as const;

/** Anything a rule matches below this goes to `_unsorted` instead. */
export const ROUTE_CONFIDENCE_THRESHOLD = 0.5;

/** Collapse every run of non-alphanumerics to one space. */
export function words(value: string): string {
  return value.normalize('NFC').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot <= 0 ? '' : fileName.slice(dot + 1).toLowerCase();
}

/**
 * Why a rule's target is unacceptable, or null. Used when a rule is added and
 * again when one is applied, so a bad row can never place a file.
 */
export function targetProblem(target: string): string | null {
  if (target === '_unsorted' || target === 'Group') return `"${target}" is reserved`;
  if (target.startsWith('_')) return 'custom folders may not start with "_"';
  if (target.length > 60) return 'longer than 60 characters';
  if (safeSegment(target) !== target) return 'not a safe single folder name (no / \\ : * ? " < > |, no trailing dot or space, no reserved names)';
  return null;
}

/** Why a rule's pattern is unusable, or null. */
export function patternProblem(field: RuleField, pattern: string): string | null {
  if (field === 'extension') {
    return /^[a-z0-9]{1,8}(,[a-z0-9]{1,8})*$/i.test(pattern) ? null : 'extension rules take a comma list such as "pptx,ppt"';
  }
  try {
    new RegExp(pattern, 'iu');
    return null;
  } catch (error) {
    return `not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function storedMatches(rule: StoredRule, input: RouteInput): boolean {
  if (rule.field === 'extension') return rule.pattern.toLowerCase().split(',').includes(extensionOf(input.fileName));
  const raw = rule.field === 'folder' ? input.folder : rule.field === 'module' ? input.module : input.fileName;
  if (raw === null || raw === '') return false;
  return new RegExp(rule.pattern, 'iu').test(words(raw));
}

export function route(input: RouteInput, rules: readonly StoredRule[] = []): RouteDecision {
  // Group files are the project's own; no lecture/tutorial taxonomy applies.
  if (input.contextType === 'group') {
    return { category: 'Group', rule: 'group', confidence: 1, reroutable: false };
  }

  const ordered = [...rules].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const rule of ordered) {
    if (targetProblem(rule.target) !== null || patternProblem(rule.field, rule.pattern) !== null) continue;
    if (storedMatches(rule, input)) {
      return { category: rule.target, rule: `db:${rule.id}`, confidence: 1, reroutable: false };
    }
  }

  const values = { folder: input.folder, module: input.module, filename: input.fileName };
  for (const field of FIELD_ORDER) {
    const value = values[field];
    if (value === null || value === '' || CONFIDENCE[field] < ROUTE_CONFIDENCE_THRESHOLD) continue;
    const text = words(value);
    for (const rule of DEFAULTS) {
      if (rule.fields.includes(field) && rule.pattern.test(text)) {
        return { category: rule.category, rule: `${rule.id}:${field}`, confidence: CONFIDENCE[field], reroutable: false };
      }
    }
  }
  return { category: '_unsorted', rule: 'none', confidence: 0, reroutable: true };
}
