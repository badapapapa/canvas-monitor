/**
 * New / unchanged / revised, and whether it is worth a message (SPEC.md
 * section 7, step b).
 *
 * Pure: takes what Canvas returned and what is stored, returns a decision per
 * item. The judgement lives here, where it can be tested without a network or
 * a database.
 */

import type { AssignmentFacts, GradeFacts, ItemRecord } from './normalise.ts';

export interface StoredItem {
  contentHash: string;
  meta: Record<string, unknown>;
}

export type ChangeDetail =
  | { kind: 'assignment'; changes: Array<{ field: keyof AssignmentFacts; from: unknown; to: unknown }> }
  | { kind: 'grade'; transition: 'posted' | 'changed' }
  | { kind: 'edited' };

export interface Classified {
  record: ItemRecord;
  kind: 'new' | 'revised' | 'unchanged';
  notify: boolean;
  change: ChangeDetail | null;
}

/** Most consequential first: a moved due date leads the message. */
const ASSIGNMENT_FIELDS: ReadonlyArray<keyof AssignmentFacts> = [
  'due_at',
  'name',
  'points_possible',
  'lock_at',
  'unlock_at',
  'description_hash',
];

export function classify(
  record: ItemRecord,
  stored: StoredItem | undefined,
  options: { baseline: boolean },
): Classified {
  if (stored === undefined) {
    // silent_sync (D-41): on a resource's first sync, everything already there
    // is recorded as seen. Otherwise the first run notifies every announcement
    // since week 1, and the bot gets muted in its first week.
    return { record, kind: 'new', notify: !options.baseline && record.notifiable, change: null };
  }

  if (stored.contentHash === record.contentHash) {
    return { record, kind: 'unchanged', notify: false, change: null };
  }

  const change = describeChange(record, stored);
  return {
    record,
    kind: 'revised',
    notify: !options.baseline && record.notifiable && change !== null,
    change,
  };
}

function describeChange(record: ItemRecord, stored: StoredItem): ChangeDetail | null {
  switch (record.resourceType) {
    case 'assignment': {
      const before = stored.meta['facts'] as AssignmentFacts | undefined;
      const after = record.meta['facts'] as AssignmentFacts | undefined;
      if (before === undefined || after === undefined) return { kind: 'edited' };
      const changes = ASSIGNMENT_FIELDS.filter((f) => before[f] !== after[f]).map((f) => ({
        field: f,
        from: before[f],
        to: after[f],
      }));
      // A description-only edit still notifies ("details updated"): changed
      // requirements are exactly the kind of quiet edit that matters.
      return changes.length === 0 ? null : { kind: 'assignment', changes };
    }
    case 'grade': {
      const before = stored.meta['facts'] as GradeFacts | undefined;
      const after = record.meta['facts'] as GradeFacts | undefined;
      if (after === undefined || !after.posted) return null; // hidden again: not news
      if (before === undefined || !before.posted) return { kind: 'grade', transition: 'posted' };
      return { kind: 'grade', transition: 'changed' };
    }
    case 'announcement':
    case 'comment':
      return { kind: 'edited' };
  }
}
