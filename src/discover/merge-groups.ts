/**
 * Carry group changes from a fresh discovery into the reviewed seed file
 * (DECISIONS.md D-72), without disturbing anything reviewed.
 *
 * A project group can be switched mid-semester: the old one starts refusing
 * the token, and a new one appears. The fresh discovery knows the new group;
 * the reviewed `courses.seed.json` knows your decisions. This merges only the
 * group membership:
 *   - a group in the fresh file but not the reviewed one is ADDED, and follows
 *     its parent course AS REVIEWED (module code, enabled), never the fresh
 *     proposal, which may not match your edits;
 *   - an enabled group in the reviewed file that the fresh discovery no longer
 *     lists is DISABLED ("no longer a member"), never deleted: its archived
 *     files and history stay;
 *   - every other entry is left exactly as it is.
 */

import type { SeedContext, SeedFile } from './seed.ts';

export interface GroupChange {
  action: 'add' | 'disable';
  moduleCode: string | null;
  enabled: boolean;
  reason: string;
}

export function mergeGroups(reviewed: SeedFile, fresh: SeedFile): { merged: SeedFile; changes: GroupChange[] } {
  const key = (c: SeedContext) => `${c.context_type}:${c.canvas_id}`;
  const reviewedKeys = new Set(reviewed.contexts.map(key));
  const freshKeys = new Set(fresh.contexts.map(key));
  const changes: GroupChange[] = [];

  const contexts = reviewed.contexts.map((c): SeedContext => {
    if (c.context_type !== 'group' || !c.proposed.enabled || freshKeys.has(key(c))) return c;
    changes.push({ action: 'disable', moduleCode: c.proposed.module_code, enabled: false, reason: 'no_longer_a_member' });
    return {
      ...c,
      proposed: {
        ...c.proposed,
        enabled: false,
        reason: 'no_longer_a_member',
        explanation: 'A fresh discovery no longer lists this group: you have left it or been moved to another. Disabled, not deleted: what was archived stays.',
      },
    };
  });

  for (const g of fresh.contexts) {
    if (g.context_type !== 'group' || reviewedKeys.has(key(g))) continue;
    const parentId = g.parent_canvas_course_id ?? null;
    const parent = parentId === null ? undefined : reviewed.contexts.find((c) => c.context_type === 'course' && c.canvas_id === parentId);
    const proposed = parent === undefined
      ? { ...g.proposed, enabled: false, reason: 'parent_not_reviewed', explanation: 'Its parent course is not in the reviewed seed file, so it is added disabled. Review it before enabling.' }
      : {
          ...g.proposed,
          module_code: parent.proposed.module_code,
          enabled: parent.proposed.enabled,
          reason: parent.proposed.enabled ? 'follows_parent' : 'parent_disabled',
          explanation: 'A new group, following its parent course as reviewed.',
        };
    changes.push({ action: 'add', moduleCode: proposed.module_code, enabled: proposed.enabled, reason: proposed.reason });
    contexts.push({ ...g, proposed });
  }

  return { merged: { ...reviewed, contexts }, changes };
}
