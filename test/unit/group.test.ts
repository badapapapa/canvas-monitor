import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { proposeGroup } from '../../src/discover/group.ts';
import type { SeedContext } from '../../src/discover/seed.ts';
import type { CanvasGroup } from '../../src/canvas/types.ts';

// Shapes mirror real /users/self/groups responses observed 2026-09-10, with
// synthetic ids and codes (this repository is public -- DECISIONS.md D-39).

function course(id: number, code: string | null, enabled: boolean): SeedContext {
  return {
    context_type: 'course', canvas_id: id, display_name: `${code} Synthetic [2610]`,
    course_code: code, term_code: '2610', term_name: '[2610] 2026/2027 Semester 1',
    section_id: null, section_name: null, coverage_status: 'full', coverage_probed: true,
    coverage_detail: '', shares_module_code_with: [],
    proposed: {
      module_code: code, module_code_alternatives: [], site_role: 'lecture',
      enabled, reason: 'current_term', explanation: '',
    },
  };
}

const courses = [course(10001, 'AB1234', true), course(10002, 'CD3456', true), course(10003, 'EF5678', false)];

const g = (over: Partial<CanvasGroup>): CanvasGroup => ({
  id: 20001, name: 'Group 1', context_type: 'Course', course_id: 10001, concluded: false, ...over,
});

describe('group proposals', () => {
  it('inherits module code and term from the parent course Canvas names', () => {
    // Canvas states the parent as `course_id`. Before D-37 this was ignored
    // and every group was proposed enabled with module_code null.
    const seeded = proposeGroup(g({}), courses);
    assert.equal(seeded.proposed.module_code, 'AB1234');
    assert.equal(seeded.term_code, '2610');
    assert.equal(seeded.proposed.enabled, true);
    assert.equal(seeded.proposed.reason, 'follows_parent');
    assert.equal(seeded.parent_canvas_course_id, 10001);
  });

  it('disables a concluded group, from the flag Canvas already returns', () => {
    // Seen live: `concluded: true`, and browsing to it says "Cannot access
    // group in concluded course". No access-error probe is needed.
    const seeded = proposeGroup(g({ id: 20003, course_id: 99999, concluded: true }), courses);
    assert.equal(seeded.proposed.enabled, false);
    assert.equal(seeded.proposed.reason, 'concluded');
    assert.equal(seeded.concluded, true);
  });

  it('checks concluded before anything else, even when the parent is active', () => {
    const seeded = proposeGroup(g({ concluded: true }), courses);
    assert.equal(seeded.proposed.enabled, false);
    assert.equal(seeded.proposed.reason, 'concluded');
  });

  it('disables a group whose parent is not an active course', () => {
    const seeded = proposeGroup(g({ course_id: 88888 }), courses);
    assert.equal(seeded.proposed.enabled, false);
    assert.equal(seeded.proposed.reason, 'parent_not_active');
    assert.equal(seeded.proposed.module_code, null);
  });

  it('follows a disabled parent', () => {
    const seeded = proposeGroup(g({ course_id: 10003 }), courses);
    assert.equal(seeded.proposed.enabled, false);
    assert.equal(seeded.proposed.reason, 'parent_disabled');
    assert.equal(seeded.proposed.module_code, 'EF5678', 'still inherited, ready if re-enabled');
  });

  it('never proposes an enabled group without a module code', () => {
    const noCode = [course(10001, null, true)];
    const seeded = proposeGroup(g({}), noCode);
    assert.equal(seeded.proposed.enabled, false);
    assert.equal(seeded.proposed.reason, 'parent_has_no_module_code');
  });

  it('disables an account-level group with no parent course', () => {
    const seeded = proposeGroup(g({ course_id: null, context_type: 'Account' }), courses);
    assert.equal(seeded.proposed.enabled, false);
    assert.equal(seeded.proposed.reason, 'no_parent_course');
  });

  it('treats an absent concluded flag as not concluded', () => {
    const { concluded: _omit, ...rest } = g({});
    const seeded = proposeGroup(rest as CanvasGroup, courses);
    assert.equal(seeded.proposed.enabled, true);
  });
});
