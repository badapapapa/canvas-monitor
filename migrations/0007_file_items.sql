-- Phase 3: files become a resource type. DECISIONS.md D-47.
--
-- File DETECTION reuses the items pipeline (classify, queue, silent_sync,
-- watermarks), so a file is an item with resource_type = 'file' and
-- external_id = its Canvas file id. That makes items.id equal to the files.id
-- D-23 specifies, so the Phase 4 `files` table (download state) can share it.
--
-- SQLite cannot alter a CHECK constraint in place, so both tables are rebuilt.
-- The runner applies this file in one transaction with foreign keys off
-- (libSQL migrate()): the rebuild either completes or leaves nothing changed.

CREATE TABLE items_new (
  id                TEXT PRIMARY KEY,
  context_id        INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  resource_type     TEXT    NOT NULL CHECK (resource_type IN ('announcement', 'assignment', 'grade', 'comment', 'file')),
  external_id       TEXT    NOT NULL,
  title             TEXT,
  body_text         TEXT,
  body_hash         TEXT,
  content_hash      TEXT    NOT NULL,
  canvas_url        TEXT,
  posted_at         TEXT,
  updated_at_canvas TEXT,
  due_at            TEXT,
  meta              TEXT,
  first_seen_at     TEXT    NOT NULL,
  last_seen_at      TEXT    NOT NULL,
  revised_at        TEXT,
  notified_at       TEXT,
  state             TEXT    NOT NULL CHECK (state IN ('new', 'seen', 'revised', 'deleted_upstream')),
  UNIQUE (context_id, resource_type, external_id)
);

INSERT INTO items_new
  (id, context_id, resource_type, external_id, title, body_text, body_hash, content_hash,
   canvas_url, posted_at, updated_at_canvas, due_at, meta,
   first_seen_at, last_seen_at, revised_at, notified_at, state)
SELECT
   id, context_id, resource_type, external_id, title, body_text, body_hash, content_hash,
   canvas_url, posted_at, updated_at_canvas, due_at, meta,
   first_seen_at, last_seen_at, revised_at, notified_at, state
FROM items;

DROP TABLE items;
ALTER TABLE items_new RENAME TO items;
CREATE INDEX IF NOT EXISTS idx_items_context ON items(context_id, resource_type);

CREATE TABLE watermarks_new (
  context_id       INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  resource_type    TEXT    NOT NULL CHECK (resource_type IN ('announcement', 'assignment', 'grade', 'comment', 'file')),
  last_seen_max_ts TEXT,
  last_run_at      TEXT,
  last_status      TEXT CHECK (last_status IN ('ok', 'denied_or_absent', 'error', 'unverified')),
  last_ok_at       TEXT,
  baselined_at     TEXT,
  PRIMARY KEY (context_id, resource_type)
);

INSERT INTO watermarks_new
  (context_id, resource_type, last_seen_max_ts, last_run_at, last_status, last_ok_at, baselined_at)
SELECT
   context_id, resource_type, last_seen_max_ts, last_run_at, last_status, last_ok_at, baselined_at
FROM watermarks;

DROP TABLE watermarks;
ALTER TABLE watermarks_new RENAME TO watermarks;
