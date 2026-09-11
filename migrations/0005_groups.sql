-- Group-specific attributes. One row per context where context_type='group'.
--
-- DECISIONS.md D-37. Before this table existed, the seed loader wrote
-- module_code only into `courses`, which groups never get a row in -- so a
-- group's module code was silently discarded on load. Phase 3 files a group's
-- documents under Canvas/<term>/<module_code>/..., and under the route-once
-- rule (SPEC.md section 8) a missing or wrong folder is permanent.
--
-- A group's module code and term are inherited from its parent course, which
-- Canvas states directly as `course_id` on the group object. They are stored
-- here rather than joined at read time so that a later hand edit in the seed
-- file is authoritative, and so the value is fixed at first sight.
CREATE TABLE IF NOT EXISTS groups (
  context_id              INTEGER PRIMARY KEY REFERENCES contexts(context_id) ON DELETE CASCADE,
  canvas_group_id         INTEGER NOT NULL UNIQUE,

  -- Canvas's own statement of the parent course. May reference a course that
  -- is not in `courses` at all: a concluded group's parent is typically an
  -- older course that never appears in the active list.
  parent_canvas_course_id INTEGER,
  parent_context_id       INTEGER REFERENCES contexts(context_id),

  module_code             TEXT,
  term                    TEXT,
  display_name            TEXT,
  group_category_id       INTEGER,

  -- Canvas's own flag. A concluded group's content is unreadable; seen live on
  -- 2026-09-10 as "Cannot access group in concluded course".
  concluded               INTEGER NOT NULL DEFAULT 0 CHECK (concluded IN (0, 1))
);

CREATE INDEX IF NOT EXISTS idx_groups_parent ON groups(parent_context_id);
