/**
 * `npm run seed-groups` (DECISIONS.md D-72): a switched project group is
 * carried from a fresh discovery into the reviewed seed file, and nothing
 * else is touched. Invented module codes and ids throughout.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { mergeGroups } from '../../src/discover/merge-groups.ts';
import { validate } from '../../src/cli/seed-courses.ts';
import type { SeedContext, SeedFile } from '../../src/discover/seed.ts';

const ctx = (type: 'course' | 'group', id: number, code: string | null, enabled: boolean, parent?: number): SeedContext => ({
  context_type: type, canvas_id: id, display_name: `${type} ${id}`, course_code: null, term_code: '2610', term_name: null,
  section_id: null, section_name: null, coverage_status: 'full', coverage_probed: true, coverage_detail: '',
  shares_module_code_with: [], ...(type === 'group' ? { parent_canvas_course_id: parent ?? null, concluded: false } : {}),
  proposed: { module_code: code, module_code_alternatives: [], site_role: type === 'group' ? 'group' : 'lecture', enabled, reason: 'reviewed', explanation: '' },
});
const file = (contexts: SeedContext[]): SeedFile => ({ $comment: [], generated_at: '2026-09-25T00:00:00Z', generated_by_run: 'r', canvas_user_id: 1, contexts } as unknown as SeedFile);

// Reviewed: course 100 renamed by hand to ZZ1001 (the fresh proposal says ZZ1001X); old group 500.
const reviewed = file([ctx('course', 100, 'ZZ1001', true), ctx('course', 200, 'YY2002', false), ctx('group', 500, 'ZZ1001', true, 100), ctx('group', 700, 'YY2002', false, 200)]);
const fresh = file([ctx('course', 100, 'ZZ1001X', true), ctx('course', 200, 'YY2002', false), ctx('group', 600, 'ZZ1001X', true, 100)]);

describe('seed-groups: carry a switched group into the reviewed seed file', () => {
  it('adds the new group following its parent AS REVIEWED, and disables the group left', () => {
    const { merged, changes } = mergeGroups(reviewed, fresh);
    assert.deepEqual(changes.map((c) => [c.action, c.moduleCode, c.enabled, c.reason]), [
      ['disable', 'ZZ1001', false, 'no_longer_a_member'],
      ['add', 'ZZ1001', true, 'follows_parent'],
    ]);
    const added = merged.contexts.find((c) => c.canvas_id === 600)!;
    assert.equal(added.proposed.module_code, 'ZZ1001', 'the reviewed code, not the fresh proposal');
    const left = merged.contexts.find((c) => c.canvas_id === 500)!;
    assert.equal(left.proposed.enabled, false);
    assert.equal(left.proposed.module_code, 'ZZ1001', 'disabled, not re-filed');
    assert.deepEqual(merged.contexts.flatMap((c) => validate(c, merged.contexts)), [], 'the result loads');
  });

  it('touches nothing else: courses as reviewed, an already-disabled group left alone, nothing deleted', () => {
    const { merged } = mergeGroups(reviewed, fresh);
    assert.deepEqual(merged.contexts.filter((c) => c.context_type === 'course'), reviewed.contexts.filter((c) => c.context_type === 'course'));
    assert.deepEqual(merged.contexts.find((c) => c.canvas_id === 700), reviewed.contexts.find((c) => c.canvas_id === 700));
    assert.equal(merged.contexts.length, reviewed.contexts.length + 1);
  });

  it('adds a group whose parent is not reviewed DISABLED, for review', () => {
    const { changes } = mergeGroups(reviewed, file([...fresh.contexts, ctx('group', 800, 'XX3003', true, 999)]));
    assert.deepEqual(changes.find((c) => c.reason === 'parent_not_reviewed'), { action: 'add', moduleCode: 'XX3003', enabled: false, reason: 'parent_not_reviewed' });
  });

  it('reports nothing when the groups are the same', () => {
    assert.deepEqual(mergeGroups(reviewed, reviewed).changes, []);
  });
});
