-- Phase 6: answer-sheet follow-ups (SPEC.md section 10; DECISIONS.md D-61).
--
-- One row per (context, category, number), ever. A revised question file with
-- the same number finds its row already there, so no second follow-up opens.
CREATE TABLE IF NOT EXISTS followups (
  id                INTEGER PRIMARY KEY,
  context_id        INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  category          TEXT NOT NULL CHECK (category IN ('Tutorials', 'Labs')),
  -- Normalised: '4', never '04'. Compared exactly: '1' never matches '11'.
  number            TEXT NOT NULL CHECK (number GLOB '[1-9]' OR number GLOB '[1-9][0-9]' OR number = '0'),
  question_file_id  TEXT NOT NULL REFERENCES items(id),
  state             TEXT NOT NULL CHECK (state IN ('open', 'closed', 'dismissed', 'expired')),
  -- When the question file was first seen: the clock the 10-day nudge runs on.
  opened_at         TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  -- Written by the silent first run: never announced, never nudged for.
  baseline          INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0, 1)),
  -- Set once the nudge is sent (or, for a baseline row already past 10 days,
  -- when the summary shows its age instead). Never cleared: one nudge, ever.
  nudged_at         TEXT,
  closed_at         TEXT,
  closed_by_file_id TEXT REFERENCES items(id),
  close_reason      TEXT CHECK (close_reason IN ('answers', 'answered_on_arrival', 'dismissed', 'term_end')),
  UNIQUE (context_id, category, number)
);
CREATE INDEX IF NOT EXISTS idx_followups_open ON followups (state, context_id);
CREATE INDEX IF NOT EXISTS idx_followups_closed_by ON followups (closed_by_file_id);

-- Module-specific answer phrases, when a tutor uses one the generic words miss.
-- Real phrases name real modules' conventions, so they live here, never in code.
CREATE TABLE IF NOT EXISTS answer_patterns (
  id          INTEGER PRIMARY KEY,
  context_id  INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  phrase      TEXT NOT NULL CHECK (length(phrase) BETWEEN 2 AND 60),
  created_at  TEXT NOT NULL,
  UNIQUE (context_id, phrase)
);

-- Canvas's own term.end_at, refreshed by sync. Open follow-ups close at term end.
ALTER TABLE courses ADD COLUMN term_end_at TEXT;
