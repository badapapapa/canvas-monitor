-- Run instrumentation.
--
-- DECISIONS.md D-10 / SPEC.md section 11. GitHub Actions schedules on a
-- best-effort basis and routinely delays or drops cron runs. The Phase 2
-- review needs numbers, not impressions, so every run records the time it was
-- scheduled for against the time it actually started, from Phase 0 onward.
CREATE TABLE IF NOT EXISTS runs (
  run_id        TEXT PRIMARY KEY,
  command       TEXT NOT NULL,
  dry_run       INTEGER NOT NULL CHECK (dry_run IN (0, 1)),

  scheduled_for TEXT,           -- from RUN_SCHEDULED_FOR; null for manual runs
  started_at    TEXT NOT NULL,
  finished_at   TEXT,
  drift_seconds INTEGER,        -- started_at - scheduled_for; the number that matters

  status        TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'failed')),
  error_code    TEXT,
  error_message TEXT,
  host          TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_started ON runs(started_at DESC);
