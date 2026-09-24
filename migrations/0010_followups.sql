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
  -- When the question file was POSTED on Canvas (first seen, if Canvas gave no
  -- date): the age shown, and what a lesson must come after to make it overdue.
  opened_at         TEXT NOT NULL,
  recorded_at       TEXT NOT NULL,
  -- Written by the silent first run.
  baseline          INTEGER NOT NULL DEFAULT 0 CHECK (baseline IN (0, 1)),
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

-- My timetable (D-62): when each module has a lesson. Personal data, so it
-- lives only here, entered with `npm run timetable`. Times are SGT.
CREATE TABLE IF NOT EXISTS lesson_slots (
  id          INTEGER PRIMARY KEY,
  context_id  INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  weekday     INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),      -- ISO: 1 = Monday
  start_time  TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  first_date  TEXT NOT NULL CHECK (first_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  last_date   TEXT NOT NULL CHECK (last_date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]' AND last_date >= first_date),
  label       TEXT NOT NULL DEFAULT 'lesson',
  created_at  TEXT NOT NULL
);
-- Dates with no lesson: a cancelled lab, a holiday; context_id NULL = every module (recess).
CREATE TABLE IF NOT EXISTS lesson_exceptions (
  id          INTEGER PRIMARY KEY,
  context_id  INTEGER REFERENCES contexts(context_id) ON DELETE CASCADE,
  date        TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  note        TEXT,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_lesson_exceptions ON lesson_exceptions (COALESCE(context_id, 0), date);

-- Canvas's own term.end_at, refreshed by sync. Open follow-ups close at term end.
ALTER TABLE courses ADD COLUMN term_end_at TEXT;
-- Per module: 0 turns answer tracking off entirely (a module that never posts answers).
ALTER TABLE courses ADD COLUMN followups_tracking INTEGER NOT NULL DEFAULT 1 CHECK (followups_tracking IN (0, 1));
