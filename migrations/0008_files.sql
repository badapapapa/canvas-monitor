-- Phase 4: download and archive state. SPEC.md sections 5, 6 and 7.
--
-- Detection lives in `items` (D-47). This table holds what happened to each
-- file on its way to OneDrive, keyed by the same id: the file's items.id,
-- which is hash(context_id, 'file', canvas_file_id) per D-23.
CREATE TABLE IF NOT EXISTS files (
  id               TEXT PRIMARY KEY REFERENCES items(id),
  context_id       INTEGER NOT NULL REFERENCES contexts(context_id) ON DELETE CASCADE,
  canvas_file_id   INTEGER NOT NULL,
  display_name     TEXT,
  size_bytes       INTEGER,
  mime_class       TEXT,

  -- Route once (SPEC.md section 8). Decided on first sight and never changed,
  -- except that an `_unsorted` placement may be re-routed exactly once (D-40).
  route_category   TEXT NOT NULL,
  route_rule       TEXT NOT NULL,
  route_confidence REAL NOT NULL,
  route_decided_at TEXT NOT NULL,
  route_reroutable INTEGER NOT NULL DEFAULT 0 CHECK (route_reroutable IN (0, 1)),

  -- Segments under the app root, '/'-joined. Reserved BEFORE the upload, so a
  -- run that dies mid-upload leaves the name the next run should look for.
  target_path      TEXT,

  download_state   TEXT NOT NULL CHECK (download_state IN (
                     'pending', 'complete', 'failed',
                     'skipped_size', 'skipped_type', 'skipped_locked',
                     'deleted_upstream', 'deleted_by_user')),
  -- Incremented BEFORE any network work: attempts > 0 means an earlier run
  -- may already have uploaded this file, so look before uploading again.
  attempts         INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,

  content_sha256   TEXT,
  content_sha1     TEXT,
  onedrive_item_id TEXT,
  -- The item's webUrl: opens in the OneDrive app, requires my sign-in. Never
  -- an anonymous sharing link (D-02).
  share_url        TEXT,

  first_seen_at    TEXT NOT NULL,
  downloaded_at    TEXT,
  archived_at      TEXT,

  UNIQUE (context_id, canvas_file_id)
);

CREATE INDEX IF NOT EXISTS idx_files_state ON files(download_state);
