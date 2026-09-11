/**
 * Group proposals for the seed file (SPEC.md section 16, DECISIONS.md D-37).
 *
 * Everything here is read off the group object Canvas already returns. Before
 * this, discover proposed every group enabled with a null module code, and I
 * had to work out each group's parent course and concluded state by hand --
 * both of which Canvas states directly as `course_id` and `concluded`.
 *
 * Rules, first match wins. Every non-enabled outcome says why.
 *
 *   1. concluded             -> disabled. Content is unreadable; seen live.
 *   2. no parent course      -> disabled. Nothing to inherit a folder from.
 *   3. parent not active     -> disabled. Its module code is unknown to us.
 *   4. parent has no code    -> disabled. An enabled context needs a folder.
 *   5. otherwise             -> inherit module code and term; follow the
 *                               parent's enabled state.
 */

import type { CanvasGroup } from '../canvas/types.ts';
import type { SeedContext } from './seed.ts';

export function proposeGroup(group: CanvasGroup, courses: readonly SeedContext[]): SeedContext {
  const parentId = group.course_id ?? null;
  const parent = parentId === null ? undefined : courses.find((c) => c.canvas_id === parentId);

  const base = {
    context_type: 'group' as const,
    canvas_id: group.id,
    display_name: group.name ?? null,
    course_code: null,
    section_id: null,
    section_name: null,
    coverage_status: 'unknown' as const,
    coverage_probed: false,
    coverage_detail: 'Group coverage is probed in Phase 3, when group ingest is built.',
    shares_module_code_with: [],
    parent_canvas_course_id: parentId,
    concluded: group.concluded === true,
  };

  const disabled = (reason: string, explanation: string): SeedContext => ({
    ...base,
    term_code: parent?.term_code ?? null,
    term_name: parent?.term_name ?? null,
    proposed: {
      module_code: parent?.proposed.module_code ?? null,
      module_code_alternatives: [],
      site_role: 'group',
      enabled: false,
      reason,
      explanation,
    },
  });

  if (group.concluded === true) {
    return disabled(
      'concluded',
      `Canvas marks this group concluded (parent course ${parentId ?? 'unknown'}). ` +
        'Its content is unreadable, so there is nothing to watch.',
    );
  }
  if (parentId === null) {
    return disabled('no_parent_course', 'Not a course group, so there is no module folder to file it under.');
  }
  if (parent === undefined) {
    return disabled(
      'parent_not_active',
      `Parent course ${parentId} is not among your active courses, so its module code is unknown.`,
    );
  }
  const code = parent.proposed.module_code;
  if (code === null || code === '') {
    return disabled(
      'parent_has_no_module_code',
      `Parent course ${parentId} has no module code, and an enabled context needs a folder name.`,
    );
  }

  return {
    ...base,
    term_code: parent.term_code,
    term_name: parent.term_name,
    proposed: {
      module_code: code,
      module_code_alternatives: [],
      site_role: 'group',
      enabled: parent.proposed.enabled,
      reason: parent.proposed.enabled ? 'follows_parent' : 'parent_disabled',
      explanation: parent.proposed.enabled
        ? `Inherited from parent course ${parentId} (${code}). Project group files are exactly ` +
          'the category of thing that gets lost.'
        : `Parent course ${parentId} is proposed disabled, so this group follows it.`,
    },
  };
}
