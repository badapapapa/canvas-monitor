-- Migration bookkeeping.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  applied_at  TEXT NOT NULL,
  checksum    TEXT NOT NULL
);
