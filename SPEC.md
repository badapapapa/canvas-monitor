# Canvas Monitor — build specification

Canonical document. Every correction agreed during review is folded in here;
`DECISIONS.md` records what changed from the original draft and why. If this
file and any other document disagree, this file wins.

**Revision 2** — 2026-08-27. Incorporates the Phase 0 review. Corrections are
marked in `DECISIONS.md` as D-01 … D-25.

---

## 1. The problem being solved

I am an NUS student. My lecturers upload files and post announcements on Canvas
at unpredictable times and Canvas gives me no useful notification. I regularly
find out on tutorial day that a document was posted four days earlier. Canvas's
own notification settings are too noisy to leave on and too coarse to tune.

This system polls Canvas on my behalf, downloads new files into my personal
OneDrive in an organised folder structure, and sends me a single batched
notification telling me what appeared, where it went, and whether it needs
follow-up.

**The primary deliverable is timely, trustworthy notification.** File management
is secondary. A dashboard is optional and comes last. If you have to choose,
always choose correctness of notification over features.

---

## 2. Non-negotiable design principles

1. **Never silently fail.** A poll that returns nothing because of an auth error
   must be indistinguishable from a poll that returns nothing because nothing
   happened — so make it distinguishable. Any error state pages me.
2. **Never claim more coverage than we have.** If a course's Files tab is
   inaccessible, say so in the UI and in the notification. A system that looks
   complete and isn't is worse than one that is visibly partial.
3. **Never overwrite.** No file on OneDrive is ever replaced. Versions are
   additive.
4. **Never re-notify for the same thing.** Idempotency is enforced at the
   database level, not by application logic hoping to be correct.
5. **Route once.** A file's destination folder is decided on first sight and
   recorded. If the lecturer reorganises Canvas in week 8, my OneDrive tree does
   not move.
6. **Degrade per-course, not globally.** One broken course must not stop the
   other five from syncing.

---

## 3. Stack

- **Language:** TypeScript, **Node 22.18+** (24 LTS or newer preferred). Strict
  mode on, plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- **No build step.** Node runs the `.ts` sources directly via native type
  stripping; `tsc` is used only for typechecking (`--noEmit`). This requires
  `erasableSyntaxOnly` — no parameter properties, no enums, no namespaces — and
  explicit `.ts` extensions on relative imports. See D-14.
- **Database:** Turso (libSQL). I already use it. Use the `@libsql/client`
  driver. A `file:` URL gives the same driver a local database for development
  and tests.
- **Storage:** Microsoft OneDrive (personal account) via Microsoft Graph. Not
  NUS OneDrive — see §5.
- **Notification:** Telegram Bot API.
- **Scheduling:** see §11. GitHub Actions on a **public** repository.
- **PDF text:** `pdfjs-dist` or `pdf-parse`. Must be optional and
  failure-isolated.
- **HTML sanitising:** `isomorphic-dompurify`.

No web framework in Phase 0–7. This is a CLI/cron program. If a UI happens, it
comes last and it's a separate Next.js app reading the same Turso DB.

The poller is a **library** with a thin CLI wrapper, not a monolithic script.
Individual stages must be runnable by hand.

---

## 4. Canvas API — required behaviours

Base URL: `https://canvas.nus.edu.sg/api/v1`. Auth: `Authorization: Bearer <token>`.

Build a Canvas client module that handles all of the following. Do not scatter
these concerns across call sites.

### Pagination
Canvas paginates via the `Link` header with `rel="next"`. Follow it until
exhausted. Set `per_page=100`. Never assume a single page. Parse the `Link`
header without splitting on commas inside the URL — `include[]` parameters
contain commas, and a naive split silently truncates a collection at one page.

A failure on page 3 fails the whole listing. A partially-read collection
reported as complete is precisely the §2.2 failure.

### Rate limiting — load-bearing, not defensive
Canvas uses a leaky-bucket limiter and returns `X-Rate-Limit-Remaining` and
`X-Request-Cost`. Read them on every response.

Because Canvas offers **no server-side incremental filter** on the endpoints
this system polls (see below), every run re-lists every resource in full. The
limiter is therefore on the critical path, not a safety net.

Do not hardcode a threshold. The bucket ceiling is per-token and
instance-configurable; the spec's original "sleep below 100" is meaningless
without a stated ceiling. Instead: record the highest `X-Rate-Limit-Remaining`
actually observed, log it on first sight, and pause when remaining falls below
a fraction of it. The bucket refills over time, so the response to a low reading
is to **wait**, not to retry a fixed number of times.

**Observed 2026-09-10: the NUS bucket is 700, and the pause threshold is 140**
(DECISIONS.md D-31). That value is a floor for threshold derivation, not a cap —
a larger observed ceiling still wins. On the first live probe, remaining never
moved from 700 across three requests, which a run that small cannot distinguish
from "the header reports the pre-decrement value". Phase 3 is the real test.

### Error semantics (important)
**Canvas returns 404 for permission denials, not 403.** "This course has no
files" and "you are not allowed to see this course's files" are
indistinguishable by status code alone. Never coerce a 404 into an empty array.
Model three states explicitly: `ok`, `denied_or_absent`, `error`.

Canvas also returns **403 for both rate limiting and permission denial**. Tell
them apart by the body text (`Rate Limit Exceeded`) and by
`X-Rate-Limit-Remaining` being at or below zero. One is retryable after a pause;
the other must never be retried and must reduce the recorded coverage for that
course.

A 401 is never retried. A dead token does not recover by waiting.

### Endpoints to use

| Purpose | Endpoint | Required params |
|---|---|---|
| Active courses | `/courses` | `enrollment_state=active`, `include[]=term` |
| My enrolment/section | `/courses/:id/enrollments` | `user_id=self` |
| Announcements | `/announcements` | `context_codes[]=course_N` (**chunked at 10**), explicit `start_date` and `end_date` |
| Assignments | `/courses/:id/assignments` | `include[]=all_dates`, `include[]=submission` |
| Submissions + feedback | `/courses/:id/students/submissions` | `student_ids[]=self`, `include[]=submission_comments` |
| Files | `/courses/:id/files` | `sort=updated_at`, `order=desc` |
| Folders | `/courses/:id/folders` | — |
| Modules | `/courses/:id/modules` | `include[]=items` |
| Pages | `/courses/:id/pages` | — |
| Syllabus | `/courses/:id` | `include[]=syllabus_body` |
| Discussions | `/courses/:id/discussion_topics` | — |
| My groups | `/users/self/groups` | — |
| Group files | `/groups/:id/files` | — |
| Group announcements | `/groups/:id/discussion_topics` | `only_announcements=true` |

### Canvas gotchas that must be handled

- **There is no `updated_since` filter.** `/files`, `/assignments`, `/modules`,
  `/pages` and `/discussion_topics` accept no incremental parameter. Full
  listings are fetched every run and diffed client-side against the stored
  `updated_at`. See §7 for what this means for watermarks. `/files` supports
  `sort=updated_at&order=desc` — **verified 2026-09-10** against a real course,
  results newest-first (DECISIONS.md D-32) — so pagination can stop at the first item older
  than the watermark; `/pages` returns `updated_at` in the list, so page bodies
  are fetched only for pages that actually changed (the list carries no `body`,
  and fetching every page every run is an N+1 the rate limiter cannot absorb).
- **`/announcements` returns 200 with an empty list for a course the token
  cannot read** (DECISIONS.md D-38) — while `/files` and `/modules` on the same
  course return 403. Canvas delivers the §2.2 failure itself, so an empty
  announcements result counts as "none posted" only for a context whose
  readability another endpoint confirmed in the same run. Otherwise it is
  `unverified`, and a context that stays unverified is surfaced as stale.
- **`/announcements` applies a default recent date window.** Without explicit
  `start_date`, the initial backfill will silently miss the first weeks of
  semester and look complete. Always pass dates. It filters on `posted_at` only,
  so an announcement **edited** outside the window is invisible to it — the
  weekly reconciliation (§7) is what catches those.
- **`/announcements` accepts COURSE context codes only.** Verified 2026-09-10:
  `context_codes[]=group_N` returns `400 {"message":"Invalid context_codes; only
  \`course\` codes are supported"}`. Group announcements come from
  `/groups/:id/discussion_topics?only_announcements=true`, which works
  (DECISIONS.md D-29). It is a **400**, not a 404: a malformed request, not a
  permission answer, and it must never be recorded as reduced coverage.
- **`/announcements` chunking.** The assumed cap of 10 `context_codes[]` could not
  be reached: 8 codes were accepted, and I have only 8 course contexts
  (DECISIONS.md D-30, bounded only). Chunk at 10 regardless — it is correct
  whether the real cap is 10 or higher.
- **Announcements have `delayed_post_at`.** `created_at` and `posted_at`
  diverge. Order and watermark on `posted_at`.
- **Assignments support per-section overrides — and none exist in my
  enrolment.** Observed 2026-09-11 across all 8 assignments in 3 courses:
  `has_overrides` never true, `all_dates` never more than one entry, always equal
  to `due_at`. Every module is a single Canvas site, so there are no sections for
  dates to differ between. `include[]=overrides` needs instructor permissions I
  do not have.

  So there is **no resolver** — building one against no data would be pure
  inference. There is a **cross-check**: if `all_dates` ever disagrees with
  `due_at`, the notification shows both dates with a warning and never picks
  one. The belief that a student token's `due_at` is already self-resolved is
  **still unverified**, and stays marked so until a real override appears
  (DECISIONS.md D-13).
- **Grades can be graded-but-unposted** under a manual posting policy. Check
  `posted_at` on the submission before showing a score. **Observed live
  2026-09-11:** a submission with `workflow_state: graded`, `posted_at: null`,
  `score: null`. A grade is notified only when `posted_at` becomes set, never on
  `graded` alone — that would say "graded" and then withhold the score.
- **Announcements have no `updated_at` field at all** (observed 2026-09-11). An
  edit is detectable only by hashing title and body, which is what `content_hash`
  does.
- **File `url` fields carry a time-limited verifier token.** Never persist them.
  Re-fetch the file object immediately before downloading. The verifier — not
  the bearer token — is what authorises the storage host; see §5.
- **Files can be `locked`, `hidden`, or `hidden_for_user`.** They appear in
  listings and fail to download. Handle `locked`, `lock_at`, `unlock_at` and
  terminate such files as `skipped_locked` rather than retrying forever.
- **Files tab is often disabled by instructors.** On `denied_or_absent` from
  `/files`, fall back to extracting `type == "File"` items from
  `/modules?include[]=items`, using `content_id` as the file identifier. Record
  which path succeeded per context as `coverage_status`:
  `full` | `modules_only` | `none`. Coverage is re-checked every run and changes
  **only on a definitive answer**, never on a transient error. A drop to
  `modules_only` or `none` raises one ops alert, and every content message from
  a `modules_only` course says so. When a course comes back, files that were
  there all along are baselined, not announced (DECISIONS.md D-47).
- **A file seen through Modules has no size or `modified_at`.** Judge a file
  change only on fields both observations report, or a Files tab being hidden
  makes every file look "updated".
- **File `updated_at` is noise**; it moves with no content change. Never use it
  to decide whether to notify. **`modified_at` is kept across course copies**,
  so it can be years *earlier* than `created_at`; that is normal.
- **A file can be hidden, locked or still uploading** (`hidden_for_user`,
  `locked_for_user`, `upload_status`). Hold it back, and announce it as "now
  available" when that changes.
- **Timezone.** Canvas returns UTC. I am in `Asia/Singapore` (UTC+8). Store UTC
  in the database. Convert to SGT before any date bucketing, day grouping, or
  display. A 23:59 SGT deadline is 15:59Z and will land on the wrong day if
  bucketed naively.
- **Groups are separate contexts,** not courses. Canvas group IDs and course IDs
  are different namespaces and will collide. Project group files are exactly the
  category of thing that gets lost. Include them from Phase 3, but model them
  from Phase 0 (§6).

---

## 5. Microsoft Graph / OneDrive

Use my **personal** Microsoft account, not my NUS account. Two reasons: the NUS
tenant will almost certainly block student app registrations, and NUS OneDrive
is deleted some months after graduation.

- Register an app in my own tenant; sign in with the device code flow against
  the `/consumers` authority as a public client. Delegated scope
  `Files.ReadWrite.AppFolder` plus `offline_access` by default, with
  `Files.ReadWrite` and a named root folder as the contingency
  (DECISIONS.md D-51).
- **This is my real OneDrive (~123GB of personal files). The app never reads,
  modifies, moves or deletes anything outside its own root.** Enforced by a
  request guard on every call and a test that watches the wire (D-50).
- **Refresh tokens rotate.** Microsoft returns a new refresh token with each
  exchange; the old one is *not* revoked but must be discarded (D-49 corrects
  the earlier claim here). Persist the new token before its first use.
- **Where the service departs from the docs (observed 2026-09-21, D-54):**
  folders under the app folder are created by parent item id (path forms
  return 400); upload sessions omit `fileSize` (400 on personal OneDrive);
  content is verified by `quickXorHash`, the only hash personal OneDrive returns.
- **Uploads use resumable upload sessions only**, with
  `conflictBehavior=fail`. Simple PUT (documented limit 250MB, checked
  2026-09-21) defaults to *replace*, so it is not used (D-52).
- Storage tier is **Microsoft 365 Family (1TB)**, shared with my personal
  files (D-12, amended). Enforce a per-file size gate (default 50MB — link
  instead of downloading above it). **Hardcode no quota:** read it from
  `GET /me/drive` and alert at 80% and 95% of what the drive reports; say so
  if it cannot be read. **Build no pruning logic.**
- Capture the OneDrive item ID and the item's **`webUrl`** per file. `webUrl` is
  returned free on upload, is tappable on a phone, opens the OneDrive app, and
  requires my account to be signed in.
  **Do not call `createLink`.** An anonymous-scope sharing link is a public URL
  to publisher PDFs and lecture slides — exactly the sharing feature §13
  prohibits.

### Filename sanitising
Satisfy both OneDrive and Windows rules, since files sync to a Windows machine:
- Strip `\ / : * ? " < > |` and control characters.
- Trim trailing dots and spaces.
- Normalise Unicode to NFC on write; compare normalised when detecting collisions.
- Avoid Windows reserved stems (`CON`, `PRN`, `AUX`, `NUL`, `COM1`–`COM9`, `LPT1`–`LPT9`).
- Cap total path length below 260 chars — truncate the stem, always preserve the extension.
- Compare case-insensitively when checking for collisions.

**Single writer rule:** only the poller writes to the synced folder. This is what
prevents OneDrive conflict copies (`filename-DESKTOP-ABC.pdf`). Note this in the
README.

### Bearer tokens and cross-origin redirects
Canvas file URLs redirect to an external storage host. Authorisation for that
hop is the `verifier` query parameter, **not** the bearer token. Node's built-in
`fetch` (undici) implements the WHATWG requirement to drop `Authorization` on a
cross-origin redirect, so the NUS token does not reach a CDN.

That is a property of the HTTP client, not of our code. Swapping in axios, got,
or node-fetch would leak the token on every download. A test asserts the
stripping behaviour against a real redirect. Do not delete it.

**Enforced in our code too (Phase 4, D-52):** the archive's downloader follows
redirects by hand and attaches the token only to a request whose origin is
the configured Canvas origin, on every hop. A download URL on any other origin,
whether handed back directly or reached by redirect, gets no Authorization
header. This does not depend on the HTTP client or on Canvas's behaviour.

---

## 6. Data model

Draft schema — refine as needed, but preserve the intent of every table.

**Everything content-bearing keys on `context_id`, never on a raw Canvas ID.**

```sql
contexts (
  context_id INTEGER PRIMARY KEY AUTOINCREMENT,
  context_type TEXT CHECK (context_type IN ('course','group')),
  canvas_id INTEGER,
  display_name TEXT,
  enabled INTEGER,
  coverage_status TEXT,        -- unknown | full | modules_only | none
  coverage_checked_at TEXT,
  first_seen_at TEXT, last_seen_at TEXT, archived_at TEXT,
  UNIQUE (context_type, canvas_id)
)

courses (
  context_id INTEGER PRIMARY KEY REFERENCES contexts(context_id),
  canvas_course_id INTEGER UNIQUE,
  module_code TEXT,            -- my canonical name, hand-mapped
  display_name TEXT, course_code TEXT,
  site_role TEXT,              -- lecture | tutorial | common | group
  term TEXT,
  section_id INTEGER, section_name TEXT,
  last_manual_check_at TEXT
)

watermarks (
  context_id INTEGER, resource_type TEXT,   -- announcement | assignment | grade | comment
  last_seen_max_ts TEXT, last_run_at TEXT,
  last_status TEXT,            -- ok | denied_or_absent | error | unverified (D-38)
  last_ok_at TEXT,             -- drives the 24h staleness alert
  baselined_at TEXT,           -- silent_sync (D-41): NULL means next success is a baseline
  PRIMARY KEY (context_id, resource_type)
)

items (                        -- announcements, assignments, grades, comments, files (D-47)
  id TEXT PRIMARY KEY,         -- hash of (context_id, resource_type, external_id)
  context_id INTEGER, resource_type TEXT, external_id TEXT,
  title TEXT, body_text TEXT, body_hash TEXT,
  canvas_url TEXT, posted_at TEXT, updated_at_canvas TEXT, due_at TEXT,
  content_hash TEXT,           -- only the fields whose change is worth a message
  meta TEXT,                   -- JSON, resource-specific
  first_seen_at TEXT, last_seen_at TEXT, revised_at TEXT, notified_at TEXT,
  state TEXT,                  -- new | seen | revised | deleted_upstream
  UNIQUE (context_id, resource_type, external_id)
)

files (                        -- Phase 4: download state. Detection lives in items (D-47)
                               -- As built: migrations/0008_files.sql (D-52) adds attempts,
                               -- content_sha1, mime_class, skipped_type, route_reroutable;
                               -- text/version columns arrive with Phases 6-7.
  id TEXT PRIMARY KEY,         -- hash of (context_id, 'file', canvas_file_id) = the file's items.id
  context_id INTEGER, canvas_file_id INTEGER,
  display_name TEXT, normalised_stem TEXT,
  size_bytes INTEGER, content_sha256 TEXT,
  canvas_folder_id INTEGER, canvas_folder_name TEXT, module_name TEXT,
  onedrive_path TEXT, onedrive_item_id TEXT, share_url TEXT,   -- share_url = item webUrl
  route_target TEXT, route_confidence REAL, route_decided_at TEXT,
  uploaded_at_canvas TEXT, first_seen_at TEXT, downloaded_at TEXT, notified_at TEXT,
  download_state TEXT,         -- pending | complete | failed | skipped_size
                               -- | skipped_locked | deleted_upstream | deleted_by_user
  page_count INTEGER, extracted_text TEXT, parse_state TEXT,
  supersedes_file_id TEXT, version_group TEXT
)

routing_rules (
  id INTEGER PRIMARY KEY, context_id INTEGER,  -- NULL = global
  match_field TEXT,            -- canvas_folder | module_name | filename
  pattern TEXT, target_folder TEXT, priority INTEGER
)

followups (
  id INTEGER PRIMARY KEY, file_id TEXT, context_id INTEGER,
  group_key TEXT, folder TEXT,
  state TEXT,                  -- awaiting | closed | escalated | dismissed
  opened_at TEXT, escalated_at TEXT, closed_at TEXT, closed_by_file_id TEXT
)

sync_lock (id INTEGER PRIMARY KEY CHECK (id=1), locked_at TEXT, holder TEXT)

config (key TEXT PRIMARY KEY, value TEXT, secret INTEGER, updated_at TEXT)
-- canvas_token, canvas_token_expires_at, graph_refresh_token, ...

notifications (
  id INTEGER PRIMARY KEY,
  batch_key TEXT UNIQUE,       -- hash of sorted (item_id, content_hash) pairs (D-04)
  channel TEXT,                -- content | ops
  context_id INTEGER,
  state TEXT,                  -- queued | sent | suppressed | failed
  urgent INTEGER,              -- a deadline inside 12h: overrides quiet hours
  release_after TEXT,          -- quiet-hours hold; there is no process to hold it in
  created_at TEXT, sent_at TEXT, attempts INTEGER, last_error TEXT,
  item_ids TEXT, payload TEXT  -- payload is rendered at SEND time, so held items merge
)

ops_alerts (                   -- one page per outage, not one per run (D-42)
  alert_key TEXT PRIMARY KEY,  -- `family@rung` marks a ladder, e.g. token_expiry@7
  severity TEXT, summary TEXT,
  first_raised_at TEXT, last_raised_at TEXT, last_sent_at TEXT, resolved_at TEXT,
  occurrences INTEGER
)

groups (                       -- one row per group context (D-37)
  context_id INTEGER PRIMARY KEY REFERENCES contexts(context_id),
  canvas_group_id INTEGER UNIQUE,
  parent_canvas_course_id INTEGER, parent_context_id INTEGER,
  module_code TEXT, term TEXT,  -- inherited from the parent course
  display_name TEXT, group_category_id INTEGER,
  concluded INTEGER
)

runs (                         -- scheduler instrumentation, from Phase 0
  run_id TEXT PRIMARY KEY, command TEXT, dry_run INTEGER,
  scheduled_for TEXT, started_at TEXT, finished_at TEXT, drift_seconds INTEGER,
  status TEXT, error_code TEXT, error_message TEXT, host TEXT
)
```

`files.id` is derived from `canvas_file_id`, and the modules fallback's
`content_id` **is** the Canvas file ID. The two discovery paths therefore
converge on one row instead of producing duplicates — that convergence is the
whole reason the fallback is safe.

Enable **FTS5** over `items.body_text`, `files.display_name`, and
`files.extracted_text`. This makes "which week did he cover normalisation?"
answerable and costs almost nothing since the text is already being extracted.

---

## 7. Sync algorithm

Per run:

1. **Acquire `sync_lock`.** If held and not stale, exit cleanly. Overlapping runs
   corrupt watermarks. `sync_lock` is **the** mutex: it is taken with a
   conditional UPDATE, and the job's `timeout-minutes: 10` is shorter than the
   lock's 15-minute staleness window, so a hung run cannot outlive its own lock.
   **Do not add a workflow `concurrency:` group** (DECISIONS.md D-46): a job that
   is never assigned a runner holds the group indefinitely, is invisible to
   `timeout-minutes`, and cancels every run queued behind it.
2. For each enabled context:
   a. **Fetch the full listing** for each resource type. Canvas offers no
      server-side incremental filter (§4), so the watermark is a
      **change-detection comparand**, not a request parameter: compare each
      returned row's `updated_at` against `last_seen_max_ts` and classify as
      new / unchanged / revised. Where an endpoint supports
      `sort=updated_at&order=desc`, stop paginating once rows fall below the
      watermark. Never derive the watermark from the current time — set it to
      the maximum timestamp actually present in the response, or leave it
      unchanged if the response was empty.
   b. Upsert by dedup key.
   c. **Commit this context's items and watermark together, in one transaction.**
      Fetching and downloading happen *outside* the transaction. Never hold a
      transaction open across network I/O — that is minutes of open transaction
      against a remote database.
3. Release lock, batch and send notifications, record the batch.

**Failure isolation:** a context that throws is logged, marked stale, and
skipped. The others commit normally. Never wrap the whole run in one
transaction.

### Idempotency and download atomicity
1. Insert the `files` row as `pending`, with its route and target path,
   **before** downloading. Increment `attempts` before each try (D-52).
2. Download into memory (bounded by the size gate), verify against
   `Content-Length` and Canvas's size.
3. If `attempts > 1` and an identical file (size + SHA-1) is already at the
   target path, adopt it. Otherwise upload via a session with
   `conflictBehavior=fail`; capture item ID and `webUrl`.
4. Mark `complete`. After 5 failed attempts, stop and alert once.

Any crash leaves either a `pending` row the next run retries, or a complete file
with a complete row. There is no state where the DB claims a file exists and it
doesn't.

### Reconciliation (weekly, separate command)
- Full scan of each context; compare returned ID sets to stored sets. Absent
  items become `deleted_upstream` — mark, don't delete. I want to know something
  vanished, especially if it was already archived.
- Re-check announcements over a wide date window, since `/announcements` cannot
  surface an edit that falls outside the polling window.
- Compare `files` rows marked `complete` against actual OneDrive contents.
  Missing → re-queue. Files I deleted manually → mark `deleted_by_user` and
  never re-download.
- Hash `syllabus_body` per course. Canvas gives no notification for syllabus
  edits, so this is a place where we're strictly better than the native UI.
- Diff enrolments: handle mid-semester add/drop by backfilling new courses and
  archiving dropped ones.

---

## 8. Routing

A file's destination is decided once, on first sight, and written to
`route_target` / `route_decided_at`. Later Canvas reorganisation must not move
it.

Evaluate `routing_rules` by priority, first match wins, matching against Canvas
folder name, module name, then filename. Seed sensible defaults per course:

```
folder|module contains "tutorial"|"tut"        -> Tutorials
folder|module contains "lab"|"practical"       -> Labs
folder|module contains "lecture"|"slides"      -> Lectures
folder|module contains "reading"|"paper"       -> Readings
filename contains "assignment"|"project"       -> Assignments
(no match)                                     -> _unsorted
```

Target tree: `<root>/<term>/<module_code>/<target_folder>/` (root per D-51).

**`_unsorted` is the pressure valve.** Anything unmatched goes there and appears
in the notification flagged as needing a rule. This converts silent misrouting
into a visible prompt.

`_unsorted` is the **"we don't know yet"** state, not a decision. A file there may
be re-routed **exactly once**, when a rule first matches it; every other
destination is final (DECISIONS.md D-40). Route-once stops Canvas reorganisation
from shuffling my tree — it does not make a placeholder permanent. The seed
defaults below ship with Phase 4, so most files never touch `_unsorted` at all. Attach a `route_confidence` score; anything below
threshold also goes to `_unsorted` even if a rule technically matched.

Files discovered via the modules fallback have no Canvas folder — use module
name as the routing signal instead.

---

## 9. Versioning and deconfliction

The goal: I should never open two files to work out which is current.

Group candidates by `normalised_stem` **within the same context and same
folder**. Same name in different folders (Lecture vs Tutorial) is usually two
different documents, not a version — check `canvas_folder_id` before assuming.

Normalisation: lowercase, strip punctuation and separators, strip week numbers,
strip known version and answer tokens.

Then, in order:

- **Tier 1 — identity.** Same `canvas_file_id` → definitively the same file,
  which has been renamed or moved. Collapse silently, no notification.
  Canvas file IDs are stable across renames and folder moves, which makes this
  the only signal at this tier that cannot be wrong.
  Same normalised stem + same `size_bytes` is a **candidate** only: a corrected
  v2 is frequently byte-identical in size, and a silent collapse is the one
  place in this system where a miss is invisible. Candidates must be confirmed
  by Tier 2 before collapsing.
- **Tier 2 — hash.** Compute SHA-256 during download. Identical hash is
  definitive; collapse. Also gives free cross-course dedup for readings
  distributed in two modules. Canvas exposes no checksum on the file object, so
  this requires the download — which is already the flow.
- **Tier 3 — content.** For PDFs, extract page count and text. Report a real
  delta: "v2, 42 pages vs 38, differs on pages 12, 19, 33." Also read the PDF's
  internal `ModDate` — that's when the lecturer actually saved it, often more
  meaningful than the Canvas upload time (though it is frequently absent or
  set by the export tool).
  - Tier 3 also catches the case Tier 1's candidate signal gets wrong:
    "Tutorial 6.pdf" replaced by a same-named file that is actually the
    *solutions*. Near-total text divergence means "different document, colliding
    name" — surface both separately rather than labelling it a revision.
- **Tier 4 — on demand.** A "what changed?" action that sends both extracted
  texts to the Anthropic API for a one-line summary. Only on my explicit
  request, never automatically.

Never overwrite. Newer versions are stored with an upload-date suffix; link them
via `supersedes_file_id` and `version_group` so the newest can be presented as
canonical with older ones collapsed behind it.

PDF parsing must be wrapped in try/catch with a timeout and write
`parse_state = 'failed'`. **A malformed PDF must never kill a poll run.**

---

## 10. Answer-sheet follow-ups

When a file lands in `Tutorials` or `Labs` and does not match an answer pattern,
open a `followups` row in state `awaiting`.

Answer detection: match against
`\b(ans|answer|answers|soln|solution|solutions|sol|key|worked|suggested|model)\b`
on the separator-split stem. **Word-boundary matching, not substring** — a naive
`includes('ans')` matches "transient" and "Ansell".

### group_key

`group_key = (context_id, folder, extracted_index)` where `extracted_index` is a
week or tutorial number pulled from the filename or module name. Fall back to
the normalised stem only when no number is found.

This matters because §9's normalisation strips week numbers — the exact token
that joins "Tutorial 6.pdf" to "T6 Solutions.pdf". Those two share no normalised
stem, so stem matching alone would never close the follow-up. Files with no
extractable number get a follow-up that can only be closed by manual dismissal.

### Pattern tuning

That seed list is a guess. Build `npm run tune-patterns` to replace guessing
with evidence: pull every file from my past and present courses, group by
normalised stem within folder, and find stems that appear exactly twice with a
small token delta between them. Those pairs are almost always question/answer
pairs. Report the distinguishing tokens ranked by frequency, so I can see that
(for example) my tutors actually use `_A`, `(suggested)`, or `w6soln`. Write the
confirmed patterns into a config table rather than hardcoding them, and make the
list editable without a redeploy. Run this once at the start of each semester —
tutors differ, and the patterns will drift.

**Historical access is gone. Verified 2026-09-10.**
`enrollment_state=completed` returns 13 courses and **all 13 are
`access_restricted_by_date`** — the endpoint works, the courses are listed, and
not one of them is readable. This confirms the premise the whole archive rests
on (§16), and it settles Phase 6:

`tune-patterns` has **no history to learn from**. It must tune on the current
semester's accumulated files instead, which means it cannot run at the *start*
of a semester as originally specified — there is nothing there yet. Run it once
several weeks in, when enough tutorials have been posted to form question/answer
pairs. Phase 6 is therefore gated on elapsed time, not just on Phase 5
completing.

Close the follow-up when a later file in the same context and folder shares the
`group_key` **and** matches an answer pattern. Notify: "Tutorial 6 answers
posted."

Also scan the first page of extracted PDF text for "solution" / "answer key"
headings — sometimes answers are appended to the same document rather than
posted separately.

Escalate once at 10 days: "Tutorial 6 answers still not posted — ask in class."
Auto-close everything outstanding at term end.

**Provide a manual dismiss.** Some tutors only work through answers live and
never upload anything. This case is genuinely unsolvable and needs a one-tap
exit, otherwise stale follow-ups accumulate and I stop trusting the list.

---

## 11. Scheduling

**GitHub Actions on a public repository**, cron schedule.

The repository is public so that Actions minutes are unlimited — and because
the alternative (GitHub Pro via the Student Developer Pack) is tied to student
eligibility that lapses at graduation, whereas public-repo minutes are not tied
to anything. The private-repo free allowance is 2000 minutes/month and Actions bills **rounded up to the whole
minute**; the adaptive cadence below is ~1,620 runs/month, which at a realistic
1.5–2.5 min per job is 2,400–4,000 billed minutes. It does not fit. Nothing
sensitive lives in the repository — the archive is in OneDrive, the data in
Turso, the secrets in Actions secrets — but **logs are public with it**, which is
why §15's logging strips bodies at every level above `debug`.

Caveats to handle explicitly:

- **Scheduled workflows are auto-disabled after 60 days of repository
  inactivity.** Include a keep-alive step.
- **Actions cron is UTC only**, and a single expression cannot express an
  adaptive cadence. Use two schedule entries: every 20 minutes for
  `00:00–15:00 UTC` (08:00–23:00 SGT) and hourly for the rest. Make the cadence
  configurable.
- **Cache `node_modules`** and shallow-checkout, to keep job time down.
- **Actions schedules on a best-effort basis** and routinely delays or drops
  cron runs. Every run therefore records `scheduled_for` (passed in by the
  workflow), `started_at`, and the resulting `drift_seconds` in the `runs`
  table, from Phase 0 onward. The Phase 2 review decides on numbers, not
  impressions.
- `timeout-minutes: 10` and **no `concurrency:` group** — see §7 and D-46.
- **A gap in scheduled runs is reported once, when runs resume**, as an event:
  how long, how many scheduled runs never happened, and that the resuming run
  has already re-read every course. It is not a raise/resolve alert. That form
  turned a 24-hour outage into "Resolved" ten minutes later. Three missed slots
  (one hour in the daytime) is the reporting threshold.
- **Drift is measured from the cron expression that fired.** GitHub exposes
  which schedule fired, never when it was meant to run, so the run reconstructs
  its slot as the latest matching minute before it started. Once drift exceeds
  the cadence that reconstruction picks a *later* slot, so recorded drift is a
  **lower bound**; skipped runs are measured separately, as gaps between
  consecutive runs (DECISIONS.md D-43), and reported as described below.
- **Actions are pinned to commit SHAs**, not tags. The job holds the Turso
  credentials, and a public repository is where a retagged upstream action
  would bite.
- **Dead-man's switch (optional, recommended).** Every alert is sent by a run, so
  if runs stop entirely nothing is left to notice — the one case §2.1 cannot
  otherwise cover. Setting `healthcheck_url` (e.g. healthchecks.io) pings start,
  success and failure each run, and the external service alerts when pings stop
  (DECISIONS.md D-44).
- **Exit codes:** a run where some courses failed but others committed is
  `partial` and exits 0 — per-course staleness alerts cover it, and a red cross
  every 20 minutes would train me to ignore red crosses. A run that could not
  deliver notifications at all exits 1, so GitHub's own failure email is the
  escape hatch when Telegram itself is the thing that broke.

### Revisit at the Phase 2 review

If p95 drift is unacceptable after two weeks, moving to a small always-on
instance (Fly.io/Railway, a few dollars a month — roughly the OneDrive tier
already being paid for) is **not merely a latency fix**. Three separate
complications in this spec exist only because there is no long-lived process:

1. the quiet-hours notification queue (§12) needs `release_after` persistence
   because there is no process to hold a message in;
2. the lock staleness window (§7) exists because a hung Actions job cannot be
   asked whether it is alive;
3. the scheduling latency itself.

An always-on instance deletes all three. Frame the decision that way, not as
latency alone.

Cloudflare Workers cron triggers remain a possibility, but check Workers' CPU
limits against PDF parsing before committing, and be prepared to move parsing to
a separate stage. Vercel is ruled out: Hobby cron triggers run once per day.

---

## 12. Notifications

Telegram bot, batched **per context per run**. Never one message per file.

```
BT2102 — 3 new files
• Tutorial 6.pdf → Tutorials/  ⚠ answers pending
• Week 6 Slides.pdf → Lectures/  (v2, +4 pages)
• Reading 6.pdf → _unsorted  ⚠ needs routing rule
```

- Attach OneDrive `webUrl` links as inline buttons — tappable on mobile.
- **Notify only after the download and upload complete and the file is verified
  present.** Never announce a file that isn't there.
- Telegram caps a message at 4096 characters. A busy course exceeds it; split on
  item boundaries rather than truncating.
- The bot cannot open a conversation — I must `/start` it once.
- **First sync is silent (`silent_sync`, DECISIONS.md D-41).** A context's first
  sync records every existing item as seen and sends one "now watching" summary
  instead of a notification per item. Operational alerts are never silenced by
  it.
- **Quiet hours 22:00–07:00 SGT,** held in the `notifications` table with
  `state='queued'` and a `release_after`, and released as a morning digest.
  There is no long-lived process to hold a message in memory. Override for
  genuinely urgent items only (a deadline inside 12 hours). If the first week of
  use wakes me twice, I will mute this and the project dies.
- **Operational alerts are never held, but are silent at night** (DECISIONS.md
  D-42). During quiet hours they are delivered with `disable_notification`: on
  the phone when I wake, never waking me. Content is held; ops is not, because an
  outage message that arrives at 07:00 is five hours stale.
- **An alert pages once, not every run.** Alerts are reconciled as desired
  state: raised when a condition becomes true, reminded on a slow cadence (6h
  critical, 24h warn) while it stays true, and announced as resolved when it
  clears. Token expiry is a ladder — crossing from T−14 to T−7 is a climb, not a
  recovery, and sends no "resolved".
- Operational failures go to a **second Telegram chat ID**, not a forum topic —
  simpler, and failures never get lost in file noise. Distinct alerts for: 401
  from Canvas, Graph auth failure, storage above 80%, a context stale for more
  than 24 hours, token expiring within 14 days, and scheduler drift beyond
  threshold.

### Idempotency

Delivery is **at-least-once**. Telegram can accept a message and the process can
die before the database records it; nothing can close that window entirely. What
must be bounded is its width:

- `batch_key = hash(sorted (item_id, content_hash) pairs)` — deterministic, so a
  retried run collides with the batch it already sent, **and** content-versioned,
  so the same item changing twice is two notifications. An id-only key would
  silently swallow the second due-date change (DECISIONS.md D-04, amended).
- The `notifications` row is inserted as `queued` **before** the send and marked
  `sent` after.
- `items.notified_at` / `files.notified_at` are written in the same transaction
  as the batch row.

Per-item marks make the duplicate window one message wide rather than one batch
wide.

### Token expiry

NUS caps Canvas tokens at 90 days maximum, with no non-expiring option.
**Verified 2026-08-27** against the Canvas "New Access Token" dialog, which
states "Maximum expiration is 90 days" directly beneath the expiry field. This
is an observed constraint, not an inherited assumption.

Record the exact expiry Canvas shows in `canvas_token_expires_at`, rather than
computing today-plus-90 — the two differ whenever the dialog is not submitted on
the day it is opened, and the alerts below are only as good as that value.

Store the token and its expiry in the `config` table, **not** in environment
variables — I want to rotate it by pasting, not by redeploying.

Until the Phase 8 dashboard exists there is no form to paste into, so rotation
is `npm run set-config canvas_token`, which reads the value from **stdin, never
argv** (an argument lands in shell history and in `ps` output).

Alert at T−14, T−7, T−3, T−1.

---

## 13. Explicit non-goals and prohibitions

- Do not attempt to scrape Canvas HTML or automate login. NUS uses Entra ID SSO
  with MFA; bearer tokens are the supported path.
- Do not call Canvas from any client-side code. Canvas sends no permissive CORS
  headers and the token must never reach a browser.
- Do not store file bytes in Turso. Hash and stream; OneDrive is the store.
- Do not build a UI before Phase 8.
- Do not add multi-user support, auth, or accounts. This is single-user, my data
  only.
- Do not build any sharing or export feature, and do not create
  anonymous-scope OneDrive share links. Lecture slides and publisher PDFs are
  someone else's IP; this archive stays private.
- Do not render instructor-authored HTML unsanitised. Run it through DOMPurify
  with an allowlist and strip inline styles.
- Do not commit raw Canvas captures or a database file. Both are blocked by a
  pre-commit hook (§15).
- Do not add an environment variable that lifts log redaction, and do not print
  identifying data to stdout from any command that runs in CI. The repository is
  public and Actions captures both streams into the same public log.

---

## 14. Build order

Ship and use each phase before starting the next. **Do not build ahead.**

| Phase | Deliverable | Done when |
|---|---|---|
| 0 | Repo, config table, contexts schema, Canvas client with pagination + rate limiting + three-state errors, `--dry-run`, raw capture, run instrumentation | `npm run probe` lists my courses |
| 1 | `npm run discover` (§16), mapping table, coverage detection, section resolution, `enrollment_state=completed` probe | `courses.seed.json` reviewed and loaded; coverage correct for every module |
| 2 | Announcements + assignments + submissions/feedback ingest. **Notification only, no downloading.** Section-override fixture captured first. | Runs a week; alerts feel correct and timely |
| 3 | Files + modules fallback + **group files** (group announcements cut, D-36/D-47). Coverage transitions visible. Still no downloading. | New files detected reliably, zero false positives |
| 4 | OneDrive upload, atomicity, size gate, resumable upload, **seed routing defaults** (D-40), one-off **prior-term backfill** command (D-36), **confinement guard** (D-50) | Files land correctly and are verified; nothing outside the root is touched |
| 5 | Routing rules, `_unsorted` flow, `--replay` | Most files route correctly; misroutes are visible |
| 6 | `npm run tune-patterns`, then answer follow-ups | Patterns confirmed against real history; tracking works end to end |
| 7 | Versioning Tiers 1–3, reconciliation command, FTS5 search | No duplicate confusion |
| 8 | Optional read-only dashboard (separate Next.js app) | — |

Phase 2 is the real milestone for **notification**: if the alerts are timely
and trustworthy, my original problem is solved.

Phase 4 is the real milestone for the **archive**, and it has a deadline
(DECISIONS.md D-36). Current-term courses conclude at 23:59 SGT on 9 January
2027 per Canvas's own `term.end_at`, and concluded content is unrecoverable.
Phases 2 and 3 are time-boxed so that Phase 4 is live by early November; if
either overruns, cut scope from it, never from Phase 4's date.

Before Phase 4 starts, resolve D-40: route-once plus Phase 4-before-5 would
otherwise file every early download under `_unsorted` permanently.

---

## 15. Testing and observability requirements

- **A `--dry-run` flag on every command** that performs all reads, logs every
  intended write, and mutates nothing. Implemented as a type-level seam: all
  mutations pass through one writer interface, and dry-run swaps in an
  implementation that logs and executes nothing. Reads always hit the real
  database, so a dry run makes realistic decisions.
- **Structured logging with a run ID**, on stderr, one JSON object per line, so
  stdout stays machine-readable. Log every skipped item and the reason.
- **Redaction is on by default, in three tiers**, at every log level:
  personal data → `[redacted]`, identity (course names, module codes, file and
  folder names, titles) → `[name]`, free-text bodies → `[body:Nc]`.
  **Numeric identifiers are kept** — a redacted line must still be actionable.
  The only way off is `--unsafe-log`, which the CLI refuses under CI. There is
  deliberately no environment variable that lifts it, because a workflow file
  can set an environment variable.
- **Identifying stdout is suppressed under CI** as well. Actions captures stdout
  into the same public log, so printing a course name publishes it just as
  surely as logging one. **Locally it is never suppressed**: reading the course
  list is the purpose of `probe`, and reviewing `courses.seed.json` by hand is
  the purpose of `discover`. Both go through one gate in
  `src/core/presentation.ts`, so a new command cannot quietly omit it.
- **A single redaction hook** (`src/core/redact.ts`) shared by the logger and the
  raw capture store. Two copies would mean two places to forget. The two callers
  choose different tiers — captures keep identity because `--replay` tunes
  routing rules that match on file and folder names, and captures are local,
  gitignored, and expiring — but third-party personal data is dropped at both.
- **Raw response capture** to `var/raw/<day>/<run-id>/`, from Phase 0, because
  capture cannot be done retroactively. It is what `--replay` (Phase 5) reads.
  Its privacy policy is non-optional:
  - every payload passes through the shared redaction hook **before** it is
    written;
  - the output root is gitignored **and** blocked by `.githooks/pre-commit`;
  - captures expire — default 60 days, enforced by `npm run prune-raw`;
  - endpoints with no replay value (`/users/self`) are not captured at all.
    Capture what replay needs, rather than capturing everything and redacting.
- **Fixtures** captured from real Canvas responses and promoted from `var/raw`
  by hand, with a documented redaction step written **before** the first capture
  (`test/fixtures/README.md`). Needed for: a course with Files disabled, an
  assignment with section overrides, a delayed-post announcement, a
  same-name-different-folder file pair, a genuine v2 re-upload, a malformed PDF.
- **A `--replay` mode** (Phase 5) that re-runs classification against stored raw
  responses without hitting Canvas, so I can tune routing rules and notification
  wording without waiting for real uploads.
- **Unit tests specifically for:** watermark boundary behaviour, filename
  sanitising against both rule sets, answer-pattern word-boundary matching,
  section-override resolution, version grouping, SGT day bucketing, Link-header
  parsing, three-state error classification, and the cross-origin
  `Authorization`-stripping guarantee.
- **Credential scanning.** A pre-commit hook blocks `var/`, `.db` files, and
  credential-shaped content; it uses gitleaks when installed and always runs a
  built-in scan so it cannot silently degrade to a no-op. GitHub secret scanning
  with push protection is the backstop for a bypassed hook. A test fails the
  build if any tracked file contains a real email address, matriculation number,
  or credential-shaped string.
- **Clock discipline.** Only `src/core/clock.ts` may read the wall clock; a test
  fails the build on any `Date.now()` or zero-argument `new Date()` elsewhere.
  Watermark correctness depends on injectable time.

---

## 16. Decisions — already made, do not re-ask

| Question | Decision |
|---|---|
| Folder tree | `<root>/<term>/<module_code>/<category>/`, where `<root>` is `Apps/<app registration name>/` (AppFolder) or `onedrive_root_folder` (full scope), D-51. Categories: `Lectures`, `Tutorials`, `Labs`, `Readings`, `Assignments`, `Group`, `_unsorted`. |
| Notification channel | Telegram bot. One chat for content, a second chat ID for operational alerts. |
| Hosting | GitHub Actions on a **public** repo, adaptive cadence: every 20 min 08:00–23:00 SGT, hourly overnight, expressed as two UTC cron entries. Keep-alive step mandatory. Drift instrumented from Phase 0; revisit at the Phase 2 review. |
| Dashboard | Not in v1. Phase 8 only, and only if notification alone proves insufficient. Build nothing that assumes a UI exists. |
| Semester-end archive | Keep permanently. NUS revokes access to concluded courses, so this becomes the only copy. |
| Storage | **Microsoft 365 Family, 1TB, funded, shared with personal files** (D-12 amended). Permanent retention is paid for, not assumed. Read the quota from Graph and alert at 80%; hardcode no quota; build no pruning logic. |
| Size gate | 50MB. Above that, record metadata and send the Canvas link without downloading. Skip video MIME types entirely regardless of size — lecture recordings live in Panopto and are not worth the quota. |
| Multi-user | Never. Single user, my data, no auth layer. |

### Course discovery — replaces asking me for course IDs

Do not ask me for my module list. Build `npm run discover` as part of Phase 1:

1. Fetch `/courses?enrollment_state=active&include[]=term` and print every
   course with its ID, raw name, course code, term, and my section from
   `/courses/:id/enrollments?user_id=self`.

   **`enrollment_state=active` is not a proxy for "modules I am taking now."**
   Observed 2026-09-10: of 8 active courses, 3 were current modules, 1 was a
   prior semester still un-concluded, and 4 were mandatory non-academic admin
   sites that persist indefinitely. `discover` must propose `enabled` per
   context from the term code and a non-academic heuristic. A proposal, for
   review — never a final answer.
2. Probe each course for coverage: try `/files`, fall back to `/modules`, and
   record which succeeded.
3. Also probe `/courses?enrollment_state=completed` and record what is
   reachable — Phase 6's pattern tuning depends on it.
4. Propose a `module_code` per course by extracting the NUS module pattern
   **`\b[A-Z]{2,4}\d{4}[A-Z]?\b`** from the course code or name — but treat
   this as a suggestion only.

   **The originally specified `[A-Z]{2,3}\d{4}[A-Z]?` is wrong** (DECISIONS.md
   D-35). NUS uses four-letter prefixes (the GESS and GEXS families), and against
   such a code the three-letter form does not fail — it silently matches one
   character in, `ABCD1234` becoming `BCD1234`. The `\b` anchors matter as much as
   the `{2,4}`. A wrong module code becomes a wrong OneDrive folder, fixed at
   first sight by route-once.
5. Detect likely lecture/tutorial/common site groupings by matching on the
   extracted module code, and flag suspected pairs.

   **Unexercised as of 2026-09-10.** Every module is a single Canvas site; no
   lecture/tutorial split exists in the current semester. The logic stays built
   for a future semester that splits, but it has never fired against real data
   and must not be presumed correct.

   Note also that terms arrive as prefixed codes — `[2610] 2026/2027 Semester 1`
   — and the bracketed code, not the full string, is what
   `Canvas/<term>/<module_code>/` should use: the full string contains slashes
   that §5's path sanitising would strip anyway.

   Course names prefix the module code, including combined offerings such as
   `ABC1001/ABD1002`. A single-code extractor matches only the
   first code of such a pair, and which one I enrolled under is not inferable
   from the course object. Surface both and let me choose.
6. Seed group contexts from `/users/self/groups`. Canvas names each group's
   parent as `course_id`, so groups **inherit** module code and term from the
   parent course, and follow its enabled state. A group with `concluded: true`
   is proposed disabled — its content is unreadable (D-37).
7. Write the result to a `courses.seed.json` file that I review and edit once,
   then load into the `contexts`, `courses` and `groups` tables. Discover
   **refuses to overwrite** an existing seed file without `--overwrite`, since
   that file holds my review; `--out` writes elsewhere to compare.

   The loader validates the whole file before writing and rejects an enabled
   context with no module code — it would become a folder name, fixed at first
   sight — and an enabled group whose code differs from its parent's.

   **`courses.seed.json` is gitignored.** It contains real module codes and
   Canvas course ids, and this repository is public (§11). The same applies to
   any saved `probe-*` or `discover-*` output.

**Do not regex your way to a final answer here.** NUS course naming is
inconsistent enough that inference will always have edge cases. The goal is to
get me 90% of the way to a mapping I approve by hand in ten minutes, twice a
year — not to be clever. The seed file is the human checkpoint, and it is
intentional.

### Answer patterns — replaces asking me about naming conventions

Handled by `npm run tune-patterns` in §10, subject to the historical-access
caveat recorded there.

---

## 17. What to do when this spec is wrong

This spec was written without access to a live NUS Canvas instance. Some of it
will be wrong. When reality contradicts it:

- **Trust the API response over the spec.** If an endpoint behaves differently
  than described, follow the actual behaviour and tell me what changed.
- **Never work around a permission error by scraping.** If an endpoint is
  unavailable, record reduced coverage and surface it. Reduced coverage that I
  know about is fine; silently substituted data is not.
- **Escalate ambiguity rather than resolving it.** Anywhere the correct
  behaviour is genuinely unclear — especially section-override resolution and
  version grouping — prefer showing me both possibilities with a warning over
  picking one confidently.
- **Keep `DECISIONS.md`** recording every deviation from this spec, with the
  reason. I want to be able to reconstruct why the code differs from the plan
  six months from now.
- **Fold accepted corrections back into this file.** This document stays
  canonical; corrections must not live only in a chat message.
