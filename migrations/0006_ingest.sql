-- Phase 2: ingest, watermarks, notification queue, operational alerts, lock.
-- SPEC.md sections 6, 7 and 12; DECISIONS.md D-03, D-04, D-05, D-07, D-38, D-41.

-- Per (context, resource) change-detection state. Canvas offers no server-side
-- updated_since filter (D-03), so this is a comparand, not a request parameter.
CREATE TABLE IF NOT EXISTS watermarks (
  context_id       INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  resource_type    TEXT    NOT NULL CHECK (resource_type IN ('announcement', 'assignment', 'grade', 'comment')),
  last_seen_max_ts TEXT,
  last_run_at      TEXT,
  -- 'unverified' is D-38: /announcements returned an empty success, but no
  -- other endpoint confirmed the context is readable in the same run.
  last_status      TEXT CHECK (last_status IN ('ok', 'denied_or_absent', 'error', 'unverified')),
  last_ok_at       TEXT,
  -- Set by silent_sync (D-41) when the first successful sync baselines this
  -- resource. NULL means the next successful sync is a baseline, not news.
  baselined_at     TEXT,
  PRIMARY KEY (context_id, resource_type)
);

CREATE TABLE IF NOT EXISTS items (
  id                TEXT PRIMARY KEY,   -- sha256(context_id, resource_type, external_id)
  context_id        INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  resource_type     TEXT    NOT NULL CHECK (resource_type IN ('announcement', 'assignment', 'grade', 'comment')),
  external_id       TEXT    NOT NULL,
  title             TEXT,
  body_text         TEXT,
  body_hash         TEXT,
  -- Hash of exactly the fields whose change is worth telling me about. An
  -- assignment's updated_at moves for reasons I do not care about; its due
  -- date moving is the reason this system exists.
  content_hash      TEXT    NOT NULL,
  canvas_url        TEXT,
  posted_at         TEXT,
  updated_at_canvas TEXT,
  due_at            TEXT,
  meta              TEXT,               -- JSON, resource-specific
  first_seen_at     TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL,
  revised_at        TEXT,
  notified_at       TEXT,
  state             TEXT    NOT NULL CHECK (state IN ('new', 'seen', 'revised', 'deleted_upstream')),
  -- Idempotency at the database level (SPEC.md section 2.4), not in code.
  UNIQUE (context_id, resource_type, external_id)
);

CREATE INDEX IF NOT EXISTS idx_items_context ON items(context_id, resource_type);

-- The delivery queue. Every notification passes through here, including the
-- ones sent immediately, so delivery is at-least-once and a crash between
-- "decided to notify" and "Telegram accepted it" leaves a row the next run
-- retries (D-04). Quiet-hours holds live here because there is no long-lived
-- process to hold them in (D-05).
CREATE TABLE IF NOT EXISTS notifications (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  -- sha256 of the sorted (item_id, content_hash) pairs. Content version is part
  -- of the key: with item ids alone, an assignment whose due date moves twice
  -- would collide on this UNIQUE constraint and its second change would be
  -- silently dropped -- idempotency causing the very loss it exists to prevent.
  batch_key     TEXT    NOT NULL UNIQUE,
  channel       TEXT    NOT NULL CHECK (channel IN ('content', 'ops')),
  context_id    INTEGER REFERENCES contexts(context_id),
  state         TEXT    NOT NULL CHECK (state IN ('queued', 'sent', 'suppressed', 'failed')),
  urgent        INTEGER NOT NULL DEFAULT 0 CHECK (urgent IN (0, 1)),
  release_after TEXT,                   -- NULL: send at the next flush
  created_at    TEXT    NOT NULL,
  sent_at       TEXT,
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_error    TEXT,
  item_ids      TEXT    NOT NULL,       -- JSON array
  payload       TEXT    NOT NULL        -- JSON render input; rendered at send time
);

CREATE INDEX IF NOT EXISTS idx_notifications_due ON notifications(state, channel, release_after);

-- Operational alert state, so one outage pages once rather than every 20
-- minutes. A bot that pages on every run of a known outage gets muted, and a
-- muted ops channel is the silent failure SPEC.md section 2.1 forbids.
CREATE TABLE IF NOT EXISTS ops_alerts (
  alert_key       TEXT PRIMARY KEY,
  severity        TEXT NOT NULL CHECK (severity IN ('warn', 'critical')),
  summary         TEXT NOT NULL,
  first_raised_at TEXT NOT NULL,
  last_raised_at  TEXT NOT NULL,
  last_sent_at    TEXT,
  resolved_at     TEXT,
  occurrences     INTEGER NOT NULL DEFAULT 1
);

-- Backstop mutex for manual local runs. In Actions the real mutex is the
-- workflow concurrency group plus timeout-minutes (D-07).
CREATE TABLE IF NOT EXISTS sync_lock (
  id           INTEGER PRIMARY KEY CHECK (id = 1),
  holder       TEXT,
  locked_at    TEXT,
  heartbeat_at TEXT
);
INSERT OR IGNORE INTO sync_lock (id) VALUES (1);
