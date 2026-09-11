-- Mutable configuration and secrets.
--
-- SPEC.md section 12: the Canvas token lives here, not in an environment
-- variable, so it can be rotated by pasting a value in rather than by
-- redeploying. `secret = 1` keys are masked by `npm run config-list`.
--
-- Accepted risk (DECISIONS.md D-06): values are stored in plaintext. Turso
-- encrypts at rest; this is a single-user system; the blast radius of the
-- Canvas token is bounded by its 90-day maximum lifetime.
CREATE TABLE IF NOT EXISTS config (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  secret      INTEGER NOT NULL DEFAULT 0 CHECK (secret IN (0, 1)),
  updated_at  TEXT NOT NULL
);
