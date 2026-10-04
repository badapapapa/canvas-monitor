-- Archive integrity (DECISIONS.md D-74): whether each archived file is still
-- where the archive put it, with its original OneDrive identity.
--
-- One row per archived file once it has been checked. `since` is when the
-- current status was first seen, so "missing for 3 days" is a fact, not a
-- guess. Additive: nothing existing changes.
CREATE TABLE IF NOT EXISTS archive_checks (
  file_id     TEXT PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
  checked_at  TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('present', 'missing', 'different_item', 'size_changed')),
  since       TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_archive_checks_checked ON archive_checks(checked_at);
