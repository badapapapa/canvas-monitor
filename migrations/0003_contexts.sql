-- Canvas contexts.
--
-- SPEC.md section 6. Canvas course IDs and group IDs are separate namespaces:
-- course 4471 and group 4471 are different things. Every table that describes
-- content keys on `context_id`, never on a raw Canvas ID, so that groups
-- (section 4, from Phase 3) can share the same tables without collision.
--
-- This lands in Phase 0 despite groups not arriving until Phase 3 because
-- retrofitting it later means migrating every content table at once.
CREATE TABLE IF NOT EXISTS contexts (
  context_id      INTEGER PRIMARY KEY AUTOINCREMENT,
  context_type    TEXT    NOT NULL CHECK (context_type IN ('course', 'group')),
  canvas_id       INTEGER NOT NULL,
  display_name    TEXT,

  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),

  -- SPEC.md section 4: which discovery path actually worked for this context.
  -- 'unknown' until Phase 1 discovery probes it. Never assume 'full'.
  coverage_status TEXT    NOT NULL DEFAULT 'unknown'
                  CHECK (coverage_status IN ('unknown', 'full', 'modules_only', 'none')),
  coverage_checked_at TEXT,

  first_seen_at   TEXT    NOT NULL,
  last_seen_at    TEXT,
  archived_at     TEXT,

  UNIQUE (context_type, canvas_id)
);

-- Course-specific attributes. One row per context where context_type='course'.
CREATE TABLE IF NOT EXISTS courses (
  context_id           INTEGER PRIMARY KEY REFERENCES contexts(context_id) ON DELETE CASCADE,
  canvas_course_id     INTEGER NOT NULL UNIQUE,

  -- My canonical name, hand-mapped via courses.seed.json in Phase 1.
  -- Suggested by regex, confirmed by me. Never trusted from inference alone
  -- (SPEC.md section 16).
  module_code          TEXT,
  display_name         TEXT,
  course_code          TEXT,
  site_role            TEXT CHECK (site_role IS NULL OR site_role IN ('lecture', 'tutorial', 'common', 'group')),
  term                 TEXT,

  -- Resolved from /courses/:id/enrollments?user_id=self in Phase 1.
  section_id           INTEGER,
  section_name         TEXT,

  last_manual_check_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_contexts_enabled ON contexts(enabled, context_type);
