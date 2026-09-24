/**
 * The dashboard's read model (DECISIONS.md D-65): a SEPARATE database holding
 * only what the dashboard displays. The dashboard can reach this database and
 * nothing else. It is never given the main database, which holds my Canvas
 * token, OneDrive refresh token and Telegram token.
 *
 * What cannot get in, by construction:
 *   - no table or column for configuration, tokens, secrets or bodies: the
 *     column list below is exhaustive and tested;
 *   - health rows only under a fixed list of names (CHECK), values numbers
 *     or timestamps;
 *   - URLs only https, and never with a credential in them (CHECK): no Canvas
 *     `verifier=`, no OneDrive `tempauth`, no `access_token`/`token=`;
 *     OneDrive links only as the plain webUrl form;
 *   - no grade scores, no announcement or feedback text: titles only.
 */

export const READMODEL_SCHEMA_VERSION = '1';

/** Every column the read model has. Nothing else may exist (tested). */
export const READMODEL_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  rm_meta: ['name', 'value'],
  rm_modules: ['id', 'code', 'kind', 'coverage', 'answers_tracked'],
  rm_deadlines: ['ref', 'module_id', 'title', 'due_at', 'canvas_url', 'revised_at'],
  rm_activity: ['ref', 'module_id', 'kind', 'change', 'title', 'at', 'seen_at', 'canvas_url', 'file_route', 'file_size', 'onedrive_url'],
  rm_followups: ['id', 'module_id', 'label', 'posted_at'],
  rm_health: ['name', 'value'],
};

export const META_NAMES = ['schema_version', 'published_at'] as const;

export const HEALTH_NAMES = [
  'last_sync_at', 'last_sync_status', 'runs_7d', 'failed_runs_7d', 'drift_p95_seconds',
  'active_alerts', 'active_critical_alerts', 'archived_files', 'archived_bytes',
  'unsorted_files', 'too_large_files',
] as const;

const list = (xs: readonly string[]) => xs.map((x) => `'${x}'`).join(', ');

/** A URL column that can never hold a credential. */
const safeUrl = (col: string) =>
  `CHECK (${col} IS NULL OR (${col} LIKE 'https://%' AND instr(lower(${col}), 'verifier=') = 0 AND instr(lower(${col}), 'tempauth') = 0 ` +
  `AND instr(lower(${col}), 'access_token') = 0 AND instr(lower(${col}), 'token=') = 0 AND instr(${col}, '@') = 0))`;

export const READMODEL_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS rm_meta (
     name  TEXT PRIMARY KEY CHECK (name IN (${list(META_NAMES)})),
     value TEXT NOT NULL CHECK (length(value) <= 40)
   )`,
  `CREATE TABLE IF NOT EXISTS rm_modules (
     id              INTEGER PRIMARY KEY,
     code            TEXT NOT NULL CHECK (length(code) <= 40),
     kind            TEXT NOT NULL CHECK (kind IN ('course', 'group')),
     coverage        TEXT NOT NULL CHECK (length(coverage) <= 20),
     answers_tracked INTEGER NOT NULL CHECK (answers_tracked IN (0, 1))
   )`,
  `CREATE TABLE IF NOT EXISTS rm_deadlines (
     ref        TEXT PRIMARY KEY,
     module_id  INTEGER NOT NULL,
     title      TEXT NOT NULL CHECK (length(title) <= 300),
     due_at     TEXT NOT NULL,
     canvas_url TEXT ${safeUrl('canvas_url')},
     revised_at TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS rm_activity (
     ref          TEXT PRIMARY KEY,
     module_id    INTEGER NOT NULL,
     kind         TEXT NOT NULL CHECK (kind IN ('announcement', 'assignment', 'file', 'grade', 'feedback')),
     change       TEXT NOT NULL CHECK (change IN ('new', 'revised')),
     title        TEXT CHECK (title IS NULL OR length(title) <= 300),
     at           TEXT NOT NULL,
     seen_at      TEXT NOT NULL,
     canvas_url   TEXT ${safeUrl('canvas_url')},
     file_route   TEXT CHECK (file_route IS NULL OR length(file_route) <= 60),
     file_size    INTEGER,
     onedrive_url TEXT ${safeUrl('onedrive_url')}
                  CHECK (onedrive_url IS NULL OR onedrive_url LIKE 'https://onedrive.live.com/%' OR onedrive_url LIKE 'https://onedrive.live.com?%')
   )`,
  `CREATE TABLE IF NOT EXISTS rm_followups (
     id        INTEGER PRIMARY KEY,
     module_id INTEGER NOT NULL,
     label     TEXT NOT NULL CHECK (length(label) <= 30),
     posted_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS rm_health (
     name  TEXT PRIMARY KEY CHECK (name IN (${list(HEALTH_NAMES)})),
     value TEXT NOT NULL CHECK (length(value) <= 40)
   )`,
];
