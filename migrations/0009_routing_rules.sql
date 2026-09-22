-- Phase 5: routing rules as data (SPEC.md section 8; DECISIONS.md D-57).
--
-- Per-module rules live HERE, never in the repository: their patterns and
-- target folders name real folders, files and modules, which is enrolment
-- data (D-39). The generic defaults stay in src/archive/route.ts.
--
-- A rule's target is a folder directly under <term>/<module>/: one of the
-- standard categories or a custom name (e.g. a case-study folder). Custom
-- names are validated as safe single segments when the rule is added.
CREATE TABLE IF NOT EXISTS routing_rules (
  id            INTEGER PRIMARY KEY,
  context_id    INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  match_field   TEXT NOT NULL CHECK (match_field IN ('folder', 'module', 'filename', 'extension')),
  -- A case-insensitive regular expression, matched against the value with
  -- every run of non-alphanumerics collapsed to one space. For `extension`,
  -- a comma-separated list of extensions without dots.
  pattern       TEXT NOT NULL,
  target_folder TEXT NOT NULL CHECK (length(target_folder) BETWEEN 1 AND 60 AND target_folder <> '_unsorted'),
  priority      INTEGER NOT NULL DEFAULT 100,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_routing_rules_context ON routing_rules (context_id, priority, id);
