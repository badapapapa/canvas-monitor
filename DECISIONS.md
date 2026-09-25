# DECISIONS

Every deviation from the original build specification, with the reason.
`SPEC.md` is canonical and already reflects all of these; this file exists so
that in six months I can reconstruct *why* it says what it says.

Format: what changed, why, and what it costs.

Status legend: **applied** (in Phase 0 code) · **specified** (agreed, lands with
its phase) · **open** (needs evidence before it can be settled).

**Numbering is append-only.** Existing entries are never renumbered, because
commit messages and SPEC.md already cite them. Phase 1's six empirical answers
are reserved as **D-28 … D-33**; **D-13** (section overrides) and **D-17**
(group announcements) are amended in place when their evidence lands, since
each already has an entry stating the open question.

Note that the Phase 1 brief cites `D-2` for the contexts table and `D-12` for
historical course access; in this file those are **D-01** and *not yet
allocated* respectively. This file's numbering is canonical.

---

## D-01 — Content keys on `context_id`, not `course_id` · applied

**Was:** every table keyed on `course_id`.
**Now:** a `contexts` table with `(context_type, canvas_id)` unique, and
`items`, `files`, `watermarks`, `routing_rules`, `followups` all keyed on its
synthetic `context_id`. `courses` holds course-specific columns and references
it.

**Why:** Canvas course IDs and group IDs are separate namespaces. Course 4471
and group 4471 are different things, and SPEC §4 requires group contexts from
Phase 3. Keyed on a raw Canvas ID they collide.

**Cost:** one extra join on every content query, and Phase 0 carries a table
nothing uses yet. Cheaper than migrating every content table in Phase 3, which
is what deferring it would have meant.

---

## D-02 — OneDrive `webUrl`, never `createLink` · specified (Phase 4)

**Was:** "capture a share link per file", implemented via Graph `createLink`.
**Now:** `files.share_url` stores the item's `webUrl`. `createLink` is not
called.

**Why:** the `createLink` call that produces a tappable-without-login URL is
`scope=anonymous` — a public, unauthenticated URL to publisher PDFs and lecture
slides. SPEC §13 prohibits building any sharing feature and requires the archive
stay private. The two clauses contradicted each other. `webUrl` is returned free
on upload, is tappable on a phone, opens the OneDrive app, and requires the
account to be signed in.

**Cost:** none. The link only ever needs to work for me.

---

## D-03 — Watermarks are a comparand, not a request parameter · specified (Phase 2)

**Was:** "fetch each resource type using `updated_at > (watermark − 10 minutes)`".
**Now:** full listing every run, diffed client-side against the stored
`updated_at`. `/files` uses `sort=updated_at&order=desc` with early pagination
stop; `/pages` diffs the list and fetches bodies only for changed pages.

**Why:** Canvas offers no `updated_since` filter on `/files`, `/assignments`,
`/modules`, `/pages` or `/discussion_topics`. The original algorithm assumed
server-side incremental filtering that does not exist. `/announcements` filters
on `posted_at` only, so an announcement edited outside the window is invisible
to polling — weekly reconciliation catches those.

**Cost:** every run re-lists everything, which makes the rate limiter
load-bearing rather than defensive (SPEC §4 updated to say so). The 10-minute
overlap in the original algorithm is now meaningless except for
`/announcements` date windows.

---

## D-04 — Per-item notification marks; delivery is at-least-once · applied (Phase 2), amended

**Was:** `notifications.batch_key UNIQUE` as the idempotency mechanism.
**Now:** `batch_key = hash(sorted item ids)`; the row is inserted `queued`
before the send and marked `sent` after; `items.notified_at` and
`files.notified_at` are written in the same transaction as the batch row.

**Why:** a unique batch key does not help if the crash happens between the
Telegram send and the database write — the key was never inserted. And a
time-derived or run-derived key means a retried run mints a new key and
re-notifies. Nothing can fully close the send/record window, so the honest
design states at-least-once delivery and bounds the duplicate to one message
rather than one batch.

**Cost:** written down plainly in SPEC §12 rather than implied.

**Amended 2026-09-11, before any code shipped — the key above was wrong.**
`hash(sorted item ids)` collides when the *same* item changes twice: an
assignment whose due date moves again has the same id both times, so its second
change would hit the UNIQUE constraint and be **silently dropped**. The
database-level idempotency would itself produce the silent loss it exists to
prevent. The key is `hash(sorted (item_id, content_hash) pairs)`: a retry of
identical content still collides, a genuinely new change does not. Pinned by an
end-to-end test that moves one due date twice, and verified to fail when the
content version is removed from the key.

---

## D-05 — Quiet-hours holds are persisted · applied (schema decided) / specified (Phase 2)

**Was:** "held and released as a morning digest", with nowhere to hold them.
**Now:** `notifications.state ∈ queued | sent | suppressed` plus `release_after`.

**Why:** on GitHub Actions there is no long-lived process to hold a message in.
The run ends. A held notification must survive to the next run or it is simply
lost.

**Cost:** none. See D-10 for why this is one of three symptoms of the same
underlying constraint.

---

## D-06 — Canvas token stored in plaintext in Turso · applied — accepted risk

**Decision:** the `config` table stores the Canvas token as plaintext. No
application-level encryption.

**Why:** SPEC §12 requires rotation by pasting rather than redeploying, which
means the token lives in the database. Turso encrypts at rest; this is a
single-user system with no other reader; and the blast radius is bounded by the
90-day maximum token lifetime NUS enforces. Application-level encryption would
need a key, which would need somewhere to live, which is the same problem one
layer down.

**Cost:** anyone with the Turso credentials has the Canvas token. Mitigations:
`config.secret = 1` masks it in `config-list`; `set-config` reads from stdin so
it never enters shell history or `ps`; the pre-commit hook blocks committing a
`.db` file.

---

## D-07 — The real mutex is the workflow, not `sync_lock` · REVERSED 2026-09-17, see D-46

**Was:** `sync_lock` with a 15-minute staleness window.
**Now:** `concurrency:` group on the workflow plus `timeout-minutes: 10` on the
job. `sync_lock` remains as the backstop for manual local runs.

**Why:** a GitHub Actions job runs up to 6 hours by default. At a 20-minute
cadence, a stuck run has its lock stolen at minute 15 and the next run starts
alongside it — producing exactly the overlapping-run watermark corruption the
lock exists to prevent. A job that cannot outlive its own lock cannot cause that.

**Cost:** none.

**Reversed 2026-09-17 — the cost was a 24-hour outage (D-46).** The reasoning
above covered a job that runs too long, and missed a job that never runs at all.
A job waiting for a runner holds no `sync_lock` and is invisible to
`timeout-minutes`, which starts counting only once the job starts, but it does
hold the concurrency group. One such job held it for 24 hours. The group is
removed. `sync_lock` is now the only mutex, and it was always sufficient: it is
taken with a conditional UPDATE, and `timeout-minutes: 10` is shorter than its
15-minute staleness window, which is the property this entry actually needed.

---

## D-08 — Version Tier 1 keys on `canvas_file_id` · specified (Phase 7)

**Was:** "same normalised stem + same `size_bytes` → same file. Collapse
silently."
**Now:** Tier 1 is `canvas_file_id` identity. Stem+size is a candidate that
requires Tier 2 hash confirmation before collapsing.

**Why:** a genuine v2 with a corrected typo is frequently byte-identical in
size, and a silent collapse is the one place in this system where a miss is
invisible. Meanwhile Canvas already provides stable file identity across renames
and folder moves for free.

**Cost:** none — this is strictly more information than the original rule used.

---

## D-09 — Cross-origin `Authorization` stripping is pinned by a test · applied

**Decision:** `src/canvas/http.ts` uses Node's built-in `fetch` (undici), and
`test/unit/canvas-http.test.ts` asserts against two real local servers that the
bearer token is **not** forwarded across a cross-origin redirect.

**Why:** Canvas file URLs redirect to external storage, authorised by the
`verifier` query parameter rather than the token. undici implements the fetch
requirement to drop `Authorization` on cross-origin redirect — verified
empirically, not assumed. But that is a property of the HTTP client, not of our
code: swapping in axios, got, or node-fetch would leak the NUS token to a CDN on
every download, silently. The test turns a client swap into a build failure.

**Cost:** one test that must never be deleted. It says so in the file.

---

## D-10 — Public repo, cached jobs, instrumented drift · applied (instrumentation)

**Was:** GitHub Actions on a private repo, "a ~1-minute job every 30 minutes
fits the 2000-minute allowance".
**Now:** public repo (unlimited Actions minutes), dependency caching, and every
run records `scheduled_for` / `started_at` / `drift_seconds` in a `runs` table
from Phase 0.

**Confirmed 2026-08-27, and for a stronger reason than cost.** The alternative
to a public repo is GitHub Pro via the Student Developer Pack, whose eligibility
lapses at graduation. Public repos get unlimited Actions minutes with no
eligibility attached, so the §11 cadence never has to be redesigned around a
benefit expiring. Durability of the arrangement, not just its price.

**Why:** the minute budget did not survive arithmetic. The adaptive cadence is
~1,620 runs/month; Actions bills rounded up to the whole minute; a realistic job
is 1.5–2.5 minutes. That is 2,400–4,000 minutes against an allowance of 2,000.
Separately, Actions schedules cron on a best-effort basis and routinely delays
or drops runs, which is a direct threat to the stated primary deliverable
(timely notification).

**Cost:** Actions logs become public along with the repo. This is why logging
strips free-text bodies at every level above `debug` (D-11) and why `debug` must
never be enabled in CI. Nothing else sensitive is in the repository.

### Revisit at the Phase 2 review — the consolidation argument

Three separate complications exist **only** because there is no long-lived
process: the quiet-hours queue (D-05), the lock staleness window (D-07), and
scheduling latency. A small always-on instance — roughly the cost of the
OneDrive tier already being paid for (D-12) — deletes all three.

Not switching now: the staged plan is free, and the drift measurement is worth
having either way. But if p95 drift is bad after two weeks, frame the decision
as removing two schema workarounds *and* fixing latency, not as latency alone.

### Phase 2 review, 2026-09-17 — verdict: stay on GitHub Actions

Evidence from the first 5.1 days of scheduled runs (227 runs):

| | median | p90 | p95 | max |
|---|---|---|---|---|
| all runs | 7.5 min | 11.8 min | 13.8 min | 17.5 min |
| daytime, 20-min cadence | 6.8 min | 11.7 min | 14.0 min | 17.5 min |
| overnight, hourly | 10.4 min | 11.8 min | 12.4 min | 12.6 min |

No run reached its cadence, so D-43's lower-bound caveat never applied and these
figures are exact. No slot ran twice. Median run time 12.6 s. Worst-case
post-to-phone latency in the daytime is therefore about 20 + 17.5 ≈ 38 minutes —
comfortably inside a problem statement measured in *days*.

**Drift is not a reason to move.** The one real incident was a 24-hour gap
(D-46), and the fault there was mine, not the scheduler's: GitHub lost one job,
and my concurrency group turned that into a day. With the group removed, the
same event costs one 20-minute slot. GitHub also silently never created 2
scheduled runs in the week, both inside that window. Isolated drops like
those are what the gap report (D-46) and the dead-man's switch (D-44) exist for.

So the consolidation argument above is not triggered. Revisit only if gaps
recur **after** the fix.

---

## D-11 — Raw capture privacy policy · applied

**Decision:** `var/raw/` captures are (1) passed through the shared redaction
hook in `src/core/redact.ts` before write, (2) gitignored **and** blocked by
`.githooks/pre-commit`, (3) expired after 60 days via `npm run prune-raw`.

**Why:** the original spec put a redaction step under `test/fixtures/`, but the
raw store is what starts capturing first — in Phase 0, before any fixture
exists. Canvas responses carry other students' names and email addresses from
discussion topics, submission comments, and group rosters. That is third-party
personal data, incidental to the purpose of this system. Redaction exists before
the first capture, not after the first incident. One shared hook, not two
copies, because two copies means two places to forget.

The same hook drops free-text bodies from logs at every level above `debug`,
which is what makes a public repository (D-10) safe.

**Cost:** captures are lossy — a redacted author name cannot be recovered for
replay. Acceptable: replay tests classification and routing, neither of which
depends on who wrote something.

**Amended 2026-08-27:** captures now keep the *identity* tier (file names,
folder names, titles) that logs drop — see D-26 for the tier split and why the
two differ. And endpoints with no replay value are not captured at all: a
`/users/self` capture stored the account holder's name to buy nothing, since
replay re-runs classification, routing and version grouping, none of which
consult who I am. The principle is capture-what-replay-needs, not
capture-everything-and-redact.

---

## D-12 — Storage is funded, not rationed · specified (Phase 4)

**Was:** OneDrive free tier, 5GB, alert at 80%, prune if pressured.
**Now:** Microsoft 365 Basic (100GB). Usage tracking and the 80% alert stay,
measured against 100GB. **No pruning logic is built.**

**Why:** five modules per semester at a 50MB gate is roughly 1.5–3GB per
semester, against a stated policy of permanent retention because NUS revokes
access to concluded courses. The free tier is exhausted inside a year, at which
point the only lever is pruning the thing the archive exists to preserve.
Permanent retention is now paid for rather than assumed.

**Cost:** a few dollars a month. Cheaper than the failure mode.

**Amended 2026-09-21 (Phase 4; also corrects SPEC §5 and §16, review item M2).**
The account is **Microsoft 365 Family, 1TB**, not Basic. And it is my real
OneDrive, already holding ~123GB of personal files — so the archive shares the
drive, and a hardcoded denominator would be wrong twice over (wrong size, and
blind to everything else on the drive). **No quota is hardcoded.** Each run
reads `quota.total`/`quota.used` from `GET /me/drive` and alerts at 80%
(warning) and 95% (critical) of what the drive itself reports, and pages when an
upload is refused for quota (507). If the quota is not readable — likely under
the AppFolder scope, D-51 — that is said once (`storage@unreadable`) rather than
the alert silently never firing. Still no pruning logic.

---

## D-28 — ANSWERED: there is no accessible history · settled 2026-09-10

`/courses?enrollment_state=completed` returned **13 courses, every one of them
`access_restricted_by_date`**. The endpoint works and the enrolments are listed;
none of the content is readable.

**This confirms the premise the archive rests on.** SPEC §16 keeps everything
permanently because NUS revokes access to concluded courses — that was an
assumption when written, and it is now an observation.

**Phase 6 is replanned.** `tune-patterns` has no history to learn from, so it
cannot run at the start of a semester as SPEC §10 originally said — there would
be nothing there. It tunes on the current semester's accumulated files, several
weeks in, once enough tutorials exist to form question/answer pairs. Phase 6 is
gated on elapsed time, not only on Phase 5 completing.

---

## D-29 — ANSWERED: group announcements come from discussion_topics · settled 2026-09-10

Amends **D-17**, which is now closed.

| Route | Result |
|---|---|
| `/announcements?context_codes[]=group_N` | `400 {"message":"Invalid context_codes; only \`course\` codes are supported"}` |
| `/groups/:id/discussion_topics?only_announcements=true` | works |

The spec's original `/groups/:id/announcements` does not exist, and the
`context_codes` route is not merely unsupported for groups — it is rejected.

**The status code matters.** This is a **400**, not a 404: a malformed request,
not a permission answer. The classifier correctly treats it as `error(unknown)`
rather than `denied_or_absent`, so it can never be mistaken for reduced
coverage. Had it been coerced to a denial, Phase 3 would have recorded group
contexts as uncovered and stopped asking.

Probed against one group (of three). Other groups could in principle be
configured differently; Phase 3 should probe per group rather than assume.

---

## D-30 — BOUNDED ONLY: the context_codes cap is at least 8 · open

1, 5 and 8 codes were all accepted. I have exactly 8 course contexts, so the
assumed cap of 10 could not be reached.

**Deliberately not resolved by padding.** Filling the request with synthetic
course codes would conflate "too many codes" with "unknown context", producing a
confident number that means nothing. SPEC §17 says to escalate ambiguity rather
than resolve it.

**Chunking at 10 stays**, because it is correct whether the real cap is 10, 20
or unlimited. Revisit only if a future semester gives me more than 10 contexts
and an unchunked request fails.

---

## D-32 — ANSWERED: /files honours the sort · settled 2026-09-10; early stop NOT built (D-47)

`sort=updated_at&order=desc` returned five files newest-first against a real
course. **The D-03 early-stop optimisation is safe to build in Phase 3**:
pagination can stop at the first file older than the watermark instead of
walking the whole list every 20 minutes.

This matters more than it looks, because D-03 established that Canvas offers no
server-side `updated_since` filter. Without this sort, every run would paginate
every course's full file list forever.

**Amended 2026-09-17: the early stop was not built.** The sort works, but the
optimisation it enables turned out not to be worth its risk. At observed sizes
(13 to 40 files per course) a full listing is one page per course, and the rate
limiter still reads 700 after a full Phase 3 run. Stopping at the first file
with an old `updated_at` would miss a file that became visible without that
timestamp moving: a silent miss, which is the one failure this system exists
to prevent. Full listings every run. Revisit only if a course grows past a few
pages.

---

## D-33 — ANSWERED: no reliance on the modules fallback · settled 2026-09-10

All three enabled courses report `coverage_status = full`. None is
`modules_only`, none is `none`.

**The fallback path is therefore unexercised against real data.** It stays
built — an instructor can disable the Files tab mid-semester — but like the
lecture/tutorial grouping logic, it has never run for real and must not be
presumed correct. If a course flips to `modules_only` later, treat its first run
as unproven.

Also recorded: **three Canvas groups exist** (`/users/self/groups` returns 3).
Group contexts are seeded now, with coverage deferred to Phase 3.

---

## D-35 — The spec's module-code regex is wrong · applied

**Was:** `[A-Z]{2,3}\d{4}[A-Z]?`
**Now:** `\b[A-Z]{2,4}\d{4}[A-Z]?\b`

**Why:** NUS uses four-letter prefixes (the GESS and GEXS families, among
others), and one appears in my own enrolment. Against a code such as `ABCD1234`
the three-letter form does not fail cleanly; it matches **`BCD1234`**, one
character in. Verified both forms against the real course names.

The word boundaries matter as much as the `{2,4}`: without them the engine still
finds a shorter match inside a longer code.

**Why this was worth chasing.** A module code becomes an OneDrive folder name,
decided once on first sight and never revisited under SPEC §8's route-once rule.
A silently wrong code produces a permanently wrong folder, and the seed file
would have shown me `ESS1025` looking plausible enough to approve.

In my current enrolment the bug is masked — a three-letter code sorts first in
the combined name, so the primary extraction is right by accident. It would have
surfaced the first time I took a bare GESS/GEXS module.

**Also applied:** combined offerings (`ABC1001/ABD1002`) now surface **both**
codes, with the secondary in `module_code_alternatives`. Which one I enrolled
under is not inferable from the course object, so the seed file asks rather than
guesses.

---

## D-13 — Section overrides: reframed, pending evidence · open (unexercised: no overrides exist)

**Was:** "the highest-consequence inaccuracy in the system", implying a
resolution problem.
**Now:** SPEC §4 records the belief that on a student token Canvas already
resolves `due_at` to my own override, and that `all_dates` entries are titled
with section *names* rather than carrying `course_section_id` — which would make
an ID match impossible. `include[]=overrides` requires instructor permissions I
do not have.

**This is explicitly labelled an assumption, not a finding.**

**Action before any code:** capture a Phase 2 fixture from an assignment known
to have section-specific dates, then rewrite the paragraph to describe observed
behaviour. If `due_at` proves reliable, the resolver becomes a cross-check that
warns on disagreement. Until then, showing both dates with a warning stands.

**Why:** an inflated warning in a spec is its own kind of inaccuracy. Better to
mark it open than to leave a confident claim that may be wrong in either
direction.

**Evidence, 2026-09-11 — the fixture could not be captured, because nothing
exists to capture.** Across all 8 assignments in my 3 enabled courses:
`has_overrides` was never true, `all_dates` never had more than one entry, and it
always agreed with `due_at`. With every module on a single Canvas site (Phase 1
observation), there are no sections for dates to differ between.

**What was built, and what was not.** No resolver — there is nothing to resolve,
and building one against no data would be exactly the inference SPEC §17
forbids. Instead a **cross-check**: if `all_dates` ever lists a date that
disagrees with `due_at`, the notification shows both with "Check which applies
to you". That is correct whichever way the belief above turns out.

**Stays open** until an override actually appears. When one does, capture it,
promote a redacted fixture, and rewrite SPEC §4 again from what it shows.

---

## D-14 — Node 22.18+, native type stripping, no build step · applied

**Was:** "TypeScript, Node 20+."
**Now:** Node 22.18+ (24 LTS or newer preferred). Node executes the `.ts`
sources directly; `tsc --noEmit` typechecks only.

**Why:** no build step means `npm run probe` runs the source I just edited, with
no stale-`dist/` failure mode and no bundler to configure. Node 20 predates
type stripping being on by default.

**Cost:** `erasableSyntaxOnly` is enforced — no parameter properties, no enums,
no namespaces — and relative imports carry explicit `.ts` extensions. Both are
mechanical. The GitHub Actions workflow must pin Node 24+.

---

## D-15 — `--replay` reserved, capture built now · applied

**Decision:** raw capture ships in Phase 0; `--replay` is a recognised flag that
exits with an explanation until Phase 5.

**Why:** capture cannot be done retroactively — by Phase 5 there would be months
of history that was never recorded. Replay itself is Phase 5 work and building
it now would be building ahead. Reserving the flag documents the split at the
point someone would look for it.

---

## D-16 — Phase 0 migrates only what Phase 0 uses · applied

**Decision:** migrations `0001`–`0004` create `schema_migrations`, `config`,
`contexts`/`courses`, and `runs`. The `items`, `files`, `watermarks`,
`routing_rules`, `followups`, `notifications` and `sync_lock` schemas are
**specified** in SPEC §6 but not migrated.

**Why:** SPEC §14 says do not build ahead. `contexts` (D-01) and `runs` (D-10)
are the exceptions because both are structurally expensive to retrofit —
`contexts` because every content table keys on it, `runs` because instrumentation
that starts late has no baseline. The rest lands with the phase that uses it.

**Why this is deliberate and not an oversight:** the notification queue design
(D-05) is settled now so Phase 2 does not have to relitigate it. Settled is not
the same as migrated.

---

## D-17 — Group announcements endpoint unverified · closed by D-29

**CLOSED 2026-09-10 — see D-29.** The answer is
`/groups/:id/discussion_topics?only_announcements=true`; the `context_codes`
route rejects group codes with a 400. Original entry follows.

**Was:** `/groups/:id/announcements`.
**Now:** SPEC §4 marks it *verify in Phase 1*, with
`/groups/:id/discussion_topics?only_announcements=true` and
`/announcements?context_codes[]=group_N` as the expected alternatives.

**Why:** that route is not believed to exist. Rather than guess, discovery
probes it.

---

## D-18 — `context_codes[]` chunked at 10 · specified (Phase 2)

`/announcements` accepts at most 10 context codes per request. With lecture and
tutorial sites, five modules already exceeds it — an unchunked request would
silently return a subset.

---

## D-19 — Rate-limit threshold derived from the observed ceiling · applied

**Was:** "if it drops below 100, sleep and back off."
**Now:** the governor records the highest `X-Rate-Limit-Remaining` observed,
logs it on first sight (`canvas.rate_limit.ceiling_observed`), and pauses below
a fraction of it. Backoff is time-based, because the bucket refills over time.

**Why:** 100 is only meaningful relative to a ceiling the spec never stated, and
the ceiling is per-token and instance-configurable. Evidence beats a guess, and
logging the first observation answers "what is the bucket size?" permanently.

---

## D-20 — Vercel ruled out · applied

Vercel Hobby cron triggers run once per day, maximum two jobs. The
"verify before assuming" line is removed from SPEC §11 rather than left as
pending work.

---

## D-21 — `download_state` gains `deleted_by_user` and `skipped_locked` · specified

Reconciliation (SPEC §7) needs `deleted_by_user` and the original enum did not
have it. `skipped_locked` is new: Canvas file objects carry `locked`, `hidden`,
`lock_at`, `unlock_at`, `hidden_for_user`, and locked files appear in listings
but fail to download. Without a terminal state they retry forever and generate a
nightly failure alert for a file that is working exactly as the instructor
intended.

---

## D-22 — `group_key` includes the extracted week index · specified (Phase 6)

**Was:** implied to be the normalised stem.
**Now:** `(context_id, folder, extracted_index)`, falling back to normalised
stem only when no number is present.

**Why:** SPEC §9's normalisation strips week numbers — the exact token that
joins "Tutorial 6.pdf" to "T6 Solutions.pdf". Those two share no normalised
stem, so stem matching alone could never close the follow-up it was supposed to
close. Numberless files get a follow-up closable only by manual dismissal, which
is what the dismiss affordance is for.

---

## D-23 — `files.id` derivation stated, and the fallback converges · specified (Phase 3)

`files.id = hash(context_id, 'file', canvas_file_id)`, symmetric with
`items.id`. The modules-fallback `content_id` **is** the Canvas file ID, so a
file discovered by both paths produces one row, not two. That convergence is the
reason the fallback is safe rather than a duplicate source, and it was worth
writing down explicitly.

**Applied in Phase 3 (D-47).** A file is an item with `resource_type = 'file'`
and `external_id` = its Canvas file id, so `items.id` is exactly this formula.
The Phase 4 `files` table (download state) shares the id rather than inventing
another. Verified by test: a file seen through /files and then through Modules
stays one item.

---

## D-24 — Clock discipline is enforced by a test · applied

Only `src/core/clock.ts` may read the wall clock. `test/unit/clock-discipline.test.ts`
fails the build on any `Date.now()` or zero-argument `new Date()` elsewhere in
`src/`.

**Why:** SPEC §7 is explicit that a watermark must never be derived from the
current time. One stray call is a polling window that silently skips, which is
indistinguishable from "nothing was posted" — the §2.1 failure. Injectable time
also makes the SGT boundary cases testable at all.

---

## D-25 — Telegram: second chat ID, 4096-char splitting · specified (Phase 2)

Operational alerts go to a distinct chat ID rather than a forum topic — simpler
to set up and equally isolated. Messages are split on item boundaries at the
4096-character cap rather than truncated. The bot cannot open a conversation; it
must be `/start`ed once.


---

## D-26 — Redaction is default-on, in three tiers, and covers stdout · applied

**Was:** bodies stripped above `debug` level; `LOG_REDACT=0` to lift.
**Now:** three tiers, all redacted by default at every level, lifted only by an
explicit `--unsafe-log` flag that is refused under CI.

| Tier | Marker | Contents |
|---|---|---|
| PII | `[redacted]` | emails, login ids, matriculation numbers, other people's names |
| Identity | `[name]` | course names, module codes, file names, folder names, titles |
| Bodies | `[body:Nc]` | announcement and page text |

**Why:** the repository is public (D-10), so Actions logs are public. Which
modules I take and what my lecturers name their files is not something a
stranger reading CI output should learn. Default-deny means forgetting the flag
is safe rather than leaky, which is the correct direction for a mistake to fail.

**Numeric ids are deliberately kept.** Redaction that destroys actionability
trades one SPEC §2.1 failure for another: `context 3 stale for 26 hours` is
something I can act on; `[name] stale for 26 hours` is not. Canvas ids reveal
nothing without a token.

**No environment variable can lift it.** An env var is precisely the thing a
workflow file can set. The only switch is a CLI flag, and the CLI refuses it
when `CI` or `GITHUB_ACTIONS` is present — checked after `.env` is loaded, so a
committed `.env` cannot smuggle `CI=false` past it.

### The gap this closed that the brief did not name

Decision 2 of the Phase 1 brief covers the **log stream**. But GitHub Actions
captures **stdout** into the same public run log, and `probe` prints course
names to stdout — that is its entire purpose. `--unsafe-log` cannot be the guard
there, because it is refused under CI by design.

So identifying stdout is suppressed under CI as well, with ids retained.
Locally, output stays fully readable. Without this, the log-side guarantee would
have been real and the overall guarantee would still have been false.

**Cost:** logs are less pleasant to read locally by default. `--unsafe-log`
exists for exactly that, and it is one flag away.

---

## D-27 — Credential scanning: local hook plus push protection · applied

**Decision:** `.githooks/pre-commit` runs two scripts. `check-no-captures.sh`
blocks `var/` and `.db` files; `scan-secrets.sh` blocks credential-shaped
content. GitHub secret scanning with push protection is enabled when the remote
is created.

**Why two layers:** the local hook is bypassable — `--no-verify`, or a fresh
clone that never ran `npm run hooks:install`. Push protection is free on public
repos and catches what the hook misses. Neither alone is sufficient.

**gitleaks is used when installed but never required.** It is not installed on
this machine, so the built-in pattern scan always runs alongside it — a check
that silently degrades to a no-op on a machine lacking a tool is worse than no
check, because it still reads like protection.

**Personal data is scanned separately**, by `test/unit/repo-hygiene.test.ts`
rather than by the hook. A blanket email/matriculation scan in the hook would
fire on the fabricated values in the redactor's own tests; a test can carry an
explicit, justified allowlist without that noise.

**Local output is never gated by this.** The identity gate for human-readable
command output lives in `src/core/presentation.ts` and fires only under CI, so
`probe` and `discover` print real course names on my machine — reviewing
`courses.seed.json` by hand is impossible otherwise. CI detection is
exact-match (`CI=true`, `CI=1`, `GITHUB_ACTIONS=true`); `CI=false` and `CI=0` do
not trigger it, because a false positive here breaks the hand review. Verified
via both `node src/cli/index.ts probe` and `npm run probe`, with the fixture
Canvas server; npm does not set `CI` itself.

**Verification of the fixtures policy (brief item 3):** there are currently
**zero fixture data files** — the policy was written before capture, as agreed,
and has therefore not yet been exercised. The honest statement is "nothing to
verify yet", so the check is automated instead of performed once: the test fails
if any fixture appears containing an email, matriculation number, or token. It
starts doing real work when Phase 2 promotes the first capture.

**Also verified:** no tracked file contains a real email address, matriculation
number, or credential-shaped string. The four allowlisted files contain
fabricated values used to prove the redactor removes them.


---

## D-28 … D-33 — reserved for Phase 1 empirical answers · open

Allocated but not yet answerable. Each is filled in from observed behaviour
against the live NUS instance, per SPEC §17: trust the API over the spec, and
fold what changed into SPEC.md rather than leaving it in a commit message.

| Ref | Question | Method |
|---|---|---|
| Ref | Status | Answer |
|---|---|---|
| D-28 | **ANSWERED** | No historical access. 13 completed courses, all `access_restricted_by_date`. |
| D-29 | **ANSWERED** | `/groups/:id/discussion_topics?only_announcements=true`. The `context_codes` route rejects group codes outright. |
| D-30 | **BOUNDED ONLY** | 8 codes accepted; I have too few contexts to reach 10. |
| D-31 | **ANSWERED** | Ceiling 700, threshold 140. |
| D-32 | **ANSWERED** | Yes, honoured. The D-03 early stop is safe. |
| D-33 | **ANSWERED** | No. All 3 enabled courses report `full`. |

### D-31 — ANSWERED: the NUS bucket is 700 · applied

**Observed 2026-09-10**, first live probe against `canvas.nus.edu.sg`:
`X-Rate-Limit-Remaining` reported exactly **700** on every response, and
`rate_remaining` was still 700 at the end of the run with `rate_pauses: 0`.
Three requests, 1.46s wall clock.

**Applied:** `OBSERVED_NUS_CEILING = 700` in `src/canvas/rate-limit.ts`,
replacing the placeholder floor. The pause threshold is 140. The governor still
raises the ceiling on observation, so a larger bucket would be followed rather
than capped — the constant is a floor, not an assumption.

**Why a floor and not just the running maximum:** a run that starts while the
bucket is already drained would otherwise learn a ceiling of, say, 120 and
derive a threshold of 24 — never pausing until the bucket was nearly empty. The
floor anchors the threshold at the real bucket size regardless of when a run
joins.

**Caveat worth carrying into Phase 3.** Remaining never moved. Either NUS
refills fast enough that a 3-request run is invisible, or the header reports the
pre-decrement value. A 3-request probe cannot distinguish those. Phase 3 is the
real test: 8 contexts times several endpoints, every 20 minutes, with no
server-side `updated_since` filter (**D-03**). If remaining still never moves
there, the limiter is cheaper than assumed; if it plunges, the threshold is
already correct.

---

### First live probe — other observations (2026-09-10)

Not among the six reserved questions, but material to Phase 1 and recorded so
`discover` is built against reality rather than the spec's expectation.

**8 active courses, of which 3 are this semester's actual modules.** The rest is
noise the seed file has to handle:

| Shape | Count | Example | Proposed |
|---|---|---|---|
| Current modules, term 2610 | 3 | — | `enabled = 1` |
| Prior semester, term 2520 | 1 | — | `enabled = 0` |
| Non-academic / admin | 4 | orientation, conduct, travel-safety courses | `enabled = 0` |

Module codes deliberately omitted: this file is public (D-39).

`enrollment_state=active` is therefore **not** a usable proxy for "modules I am
taking now" — it returns completed-but-not-concluded sites and mandatory admin
courses indefinitely. `discover` must propose `enabled` per context using the
term code and a non-academic heuristic, and SPEC §16's rule stands: it is a
proposal for review, never a final answer.

**No lecture/tutorial site splits exist.** Every module is a single Canvas site,
so SPEC §16 step 5 — flagging suspected groupings where several courses share an
extracted module code — is **unexercised**. It stays built, because a future
semester may split, but it has never fired against real data and must not be
assumed correct. `courses.site_role` will be `lecture` or null throughout this
semester.

**Terms are prefixed codes,** `[2610] 2026/2027 Semester 1`, not free text. The
bracketed code is a stable sort and grouping key, and is what
`Canvas/<term>/...` should use rather than the full string, which contains
slashes that §5's path sanitising would have to strip anyway.

**Course names carry the module code as a prefix,** including combined-offering
codes of the form `ABC1001/ABD1002`. The `[A-Z]{2,3}\d{4}[A-Z]?`
extractor will match the FIRST code in such a pair. Which of the two I actually
enrolled under is not inferable from the course object — precisely the kind of
edge case SPEC §16 says not to regex around. The seed file surfaces both.

---

## D-34 — Panopto lecture recordings are invisible to this design · deferred

**Question:** if a module embeds a Panopto folder through course navigation
(an LTI tool), new recordings appear in Panopto with **no corresponding change
in Canvas** — no file, no module item, no announcement. Nothing in the current
design detects them, and nothing in it would report that it cannot.

**Why this matters more than it looks:** SPEC §2.2 forbids claiming more
coverage than we have. A module whose lectures are recorded to Panopto would
show `coverage_status = full` while silently missing the recordings entirely.
That is the exact failure mode the coverage field exists to prevent, arriving
through a door the field does not watch.

**Deliberately not built now.** Revisit after Phase 3, when the coverage panel
shows which modules actually embed Panopto. Building against a guess about how
NUS configures its LTI placements would be inference where evidence is a few
weeks away.

**Likely fix, in preference order:**
1. Panopto's per-folder RSS feed, where the folder has it enabled — a real
   change feed, pollable with the existing machinery.
2. Otherwise a manual-check nudge in the coverage panel: mark the context
   `panopto_unwatched` and say so in the notification, so the gap is visible
   rather than silent. Visibly partial beats invisibly incomplete.

**Evidence, 2026-09-17 (observation week):** at least one enabled module
routinely posts lecture recordings to Panopto. Its post-lecture announcement of
2026-09-16 points to the recordings there, as earlier ones did. So the gap
described above is real for my enrolment, not hypothetical. Still deferred,
and to be revisited after Phase 3 as planned, now with a known affected module.

**Evidence, 2026-09-17 (Phase 3 survey): the tab cannot tell us which modules.**
All three enabled courses carry an identical "Videos/Panopto" navigation tab,
along with the same six other external tools. It is an institution-wide
default, present whether or not a module uses it. So the plan above to let
"the coverage panel show which modules embed Panopto" will not work from the
tab list. A detector needs the per-folder feed, or a per-module setting I
confirm by hand. The same survey shows a second blind spot of the same kind:
a "Course Readings" tool, where reading lists live outside the Canvas file API.

Note that SPEC §16 already excludes video from the archive on quota grounds
("lecture recordings live in Panopto and are not worth the quota"). This entry
is about **detection and disclosure**, not about downloading them.

### Already settled by observation

**The 90-day Canvas token ceiling is verified, not inherited.** The Canvas
"New Access Token" dialog states "Maximum expiration is 90 days" directly
beneath the expiry field (observed 2026-08-27). SPEC §12 stands as written, and
is now marked as an observed constraint rather than an assumption. This removes
the only open question about token lifetime; the T−14/7/3/1 alerts in Phase 2
can be built against a known ceiling.

Corollary recorded in SPEC §12: store the exact expiry Canvas displays, not
today-plus-90. The two diverge whenever the dialog is not submitted the day it
is opened, and every expiry alert is only as good as that stored value.

---

## D-36 — The archive has a deadline, and it is Phase 4's · scheduling constraint

**Constraint:** D-28 found every completed course `access_restricted_by_date`,
and a concluded group (live, 2026-09-10) returns "Cannot access group in
concluded course" — so groups follow the same rule. Once the current term's
courses conclude, nothing not already downloaded is recoverable. **Phase 4 is
the milestone the archive depends on**, and it has a real deadline.

**The date, from Canvas rather than estimated.** Current-term courses report
`term.end_at = 2027-01-09T15:59:00Z` — **23:59 SGT on 9 January 2027**, not
December. That is 120 days from 2026-09-11.

**Revocation lags term end — by an unknown amount.** Observed 2026-09-11: a
prior-term course whose `term.end_at` was 2026-06-13 is still fully readable
three months later (26 files, 3 modules, 11 announcements), while the older
completed courses are not. So term end is *not* the moment access disappears.
But one data point cannot say when it does, so **plan against 9 January**
and treat any slack as unbanked.

**The deadline is hard at revocation but soft before it.** Phase 4's first run
backfills everything still on Canvas, so a Phase 4 that lands in November loses
nothing a Phase 4 in October would have kept — *except* files instructors delete
or unpublish mid-semester (a replaced version, answers pulled after a window).
Those exist only while present, and only Phase 4 stops that loss. Phase 3
narrows the exposure by at least recording that such files existed.

**Planning consequence.** Phases 2 and 3 are time-boxed so Phase 4 is live with
weeks of margin, not days:

| Phase | Target | Why |
|---|---|---|
| 2 | live by late September, accepted after its week of running | the done-when is a week of use |
| 3 | by mid-October | detection only; also shows which modules embed Panopto (D-34) |
| 4 | by early November | ~9 weeks of margin before 9 January, covering the exam period |

If Phase 2 or 3 overruns, cut scope from them — never from Phase 4's date.

**Priority rule, stated 2026-09-12.** Phase 4 is the feature this project was
started for. The original problem is finding out on tutorial day that a
*document* appeared four days earlier; Phase 2 is useful, but it is not that.
So during the observation week and Phase 3: **fix what is actually broken and
leave the rest.** Polish, nice-to-haves and scope growth come out of Phase 4's
time, and that time is spent.

**One distinction worth keeping straight when cutting.** SPEC §1 says "file
management is secondary" — that means *routing and versioning* (Phases 5 and 7),
not files. Splitting the want across the phases that deliver it:

| Want | Phase |
|---|---|
| Find out a file appeared, on the day | 3 — detection and notification |
| Still have it once the course concludes | 4 — the archive, deadline 2027-01-09 |
| Have it filed tidily | 5 and 7 — genuinely secondary |

So when Phase 3 is trimmed, trim the group and modules-fallback polish, not file
detection itself: that half is the deliverable too, and it is the half that
directly answers the sentence the project opened with.

**Prior-term backfill — decided 2026-09-11: yes, as a one-off command.** The
prior-term course above is readable today and may not be later, and taking
what is still available is the archive's whole purpose. It is archived by a
**one-off backfill command, run once Phase 4 works** — not by enabling it as a
context. It stays **out of the 20-minute poll**: nothing new will ever be posted
to a concluded course, so polling it would spend the rate-limit budget watching
something that cannot change.

---

## D-37 — Groups: module codes were silently discarded · applied

**Found on review of the Phase 1 seed:** discover proposed every group enabled
with `module_code: null`, and I set the codes by hand. Checking where those
edits landed showed they had landed **nowhere**: the loader wrote
`module_code` only into `courses`, and groups never get a `courses` row. The DB
had no record of which module any group belonged to.

That is worse than the reported bug. A null code is at least visible; a
reviewed value silently dropped on load defeats the purpose of the human
checkpoint, which exists precisely to capture judgement.

**Applied:**

- **`groups` table** (migration 0005): `module_code`, `term`,
  `parent_canvas_course_id`, `parent_context_id`, `concluded`.
- **Discover inherits from the parent.** Canvas states the parent directly as
  `course_id` on the group object; nothing to infer. Rules, first match wins:
  concluded → disabled; no parent → disabled; parent not active → disabled;
  parent has no code → disabled; otherwise inherit code and term and follow the
  parent's enabled state.
- **Concluded groups are detected from `concluded: true`**, which Canvas already
  returns. The suggestion to probe for an access error would have worked, but
  the flag is cheaper and does not depend on parsing an error page.
- **The loader validates the whole file before writing anything**, and rejects:
  an enabled context with no module code (it would become the folder name,
  fixed by route-once), and an enabled group whose code differs from its
  parent's in the same file (almost certainly a stale inheritance after a
  review edit). Disabled contexts may have null codes.
- **Discover refuses to overwrite `courses.seed.json`** unless given
  `--overwrite`, and checks before spending any Canvas requests. `--out <path>`
  writes elsewhere for comparison. Before this, re-running discover each
  semester silently destroyed the one file that holds my decisions.

**Verified against real data:** a fresh discover reproduced my hand review
exactly — 0 of 11 contexts differ — including both inherited group codes and
the concluded group.

---

## D-38 — `/announcements` returns an empty success for unreadable courses · applies to Phase 2

Observed 2026-09-11 against a course the token cannot read: `/files` and
`/modules` return **403**, but `/announcements?context_codes[]=course_N` returns
**200 with an empty list**.

That is the SPEC §2.2 failure delivered by Canvas itself: "no announcements"
and "not allowed to see announcements" arrive as the same clean response. The
three-state classifier cannot catch it, because Canvas never sends an error.

**Consequence for Phase 2:** an empty announcements result counts as "none
posted" **only** for a context whose readability was confirmed by another
endpoint in the same run. Otherwise it is recorded as `unverified`, and a
context that stays unverified is surfaced as stale rather than as quiet.

---

## D-39 — Real enrolment data was committed to a repo that will be public · resolved 2026-09-11

**What happened.** Phase 1 committed my real module codes — current semester,
prior semester and the admin courses — to `DECISIONS.md`, `SPEC.md` and the
test suite, with tests mapping real Canvas course and group ids to real codes.
Two commit messages name them too. By this project's own standard (D-26: which
modules I take is not something a stranger reading the repo should learn) that
is a leak. `canvas_user_id` was never committed. No remote exists yet, so
nothing has been published.

**Applied to the working tree:** every test now uses synthetic ids and codes
(`AB1234`, `10001`) that still match the NUS pattern, so coverage is unchanged.
The docs keep the evidence ("3 current modules, 1 prior, 4 admin") without the
codes. **Policy from here: tests and docs never use real ids or codes.**

Left alone deliberately: the module code in SPEC §12's notification
mock-up. That was in the spec as originally written, by my choice.

**Resolved — history squashed before any remote existed.** At my direction,
the six pre-publication commits were squashed into a single root commit built
from the scrubbed tree; granular history was deliberately not kept. The old
objects were then purged (reflog expired, `gc --prune=now`), so they are gone
from `.git`, not merely unreferenced.

**Verified, not assumed**, against a pattern covering every real module code,
course id, group id, `canvas_user_id` and course name:

- `git log -p --all`: no match outside SPEC.md; inside it, only the §12 example.
- Positive control: the same pattern finds 50 matches in the (ignored) seed
  file, so "no match" means absent, not a pattern that cannot match.
- Object database: 0 of 79 objects contain real data beyond the §12 example.
  The old tip no longer resolves; zero reflog entries; zero unreachable objects.

**Two lessons, recorded because both recurred in this incident:**

1. My first "clean" audit excluded the §12 module code as allowed, and so
   missed a *test* that used the same code — and never searched course *names*
   at all. An audit pattern must cover identifiers, codes **and** names, with
   the allowlist applied per file rather than per string.
2. The squash commit was first blocked by this repo's own credential scan: a
   synthetic token in a test was committed before the scan existed, so it had
   never been scanned as an addition. Test fixtures that look like credentials
   are now assembled at runtime. The block was correct; the chained command
   that deleted `main` anyway was not, and destructive steps are now gated on
   the previous step succeeding.

---

## D-40 — Route-once and Phase 4-before-5 conflict · accepted 2026-09-11, lands in Phase 4

Phase 4 downloads files; routing rules arrive in Phase 5. Under SPEC §8's
route-once rule, a file's folder is decided on first sight and never changes —
so **every file downloaded in Phase 4 would be routed to `_unsorted`, forever**.
D-36 pushes Phase 4 earlier, which makes this concrete rather than theoretical.

Two resolutions:

1. **`_unsorted` means "undecided", not "decided: unsorted".** A file in
   `_unsorted` is eligible for exactly one re-route, when a rule first matches
   it; every other destination is final. This keeps route-once's purpose — my
   tree does not move when a lecturer reorganises Canvas — while letting the
   pressure valve actually drain, which SPEC §8 implies it should.
2. **Ship the seed routing defaults in Phase 4** and treat Phase 5 as rule
   tuning.

**Accepted: both.** The seed routing defaults ship in Phase 4, and a file in
`_unsorted` may be re-routed **exactly once**, when a rule first matches it.
Every other destination is final.

This is not a route-once violation. `_unsorted` is explicitly the "we don't know
yet" state. Route-once exists to stop Canvas reorganisation shuffling my tree —
not to make a placeholder placement permanent. Promoting out of the placeholder
once is the pressure valve working as SPEC §8 intended.


---

## D-41 — `silent_sync`: the first sync baselines instead of notifying · accepted, lands in Phase 2

**Not in the original spec** — recorded here so that it now is. The name is
mine from the Phase 2 go-ahead; the behaviour was proposed during the Phase 1
review.

**The problem:** the first sync of any context finds everything already posted
this semester. Treated as new, it would notify me of every announcement and
assignment since week 1 in one burst — the first-week experience SPEC §12 warns
will get the bot muted.

**Behaviour:** for each `(context, resource_type)` with no watermark yet, the
first sync runs as `silent_sync`: every existing item is recorded as `seen`,
with `notified_at` set, and nothing is sent per item. One **"now watching"
summary** is sent instead, per sync run that baselined anything, naming the
contexts and item counts, so the silence is explained rather than mysterious.

**What it must not suppress:** a baseline records what exists; it does not
vouch for it. Operational alerts (a 401, a stale context, an unverified empty
announcements result under D-38) are never silenced by `silent_sync`, because
those describe the system's health, not content I have already seen.


---

## D-42 — Alerts page once; ops is silent at night, not held · applied

**Desired-state reconciliation.** Each run computes every alert condition that
is currently true; the difference from `ops_alerts` drives the sends — raise
when a condition becomes true, remind at most every 6h (critical) or 24h (warn)
while it stays true, announce "resolved" when it clears. A condition that could
not be *evaluated* this run is never resolved: if Canvas auth failed, staleness
was not assessed, so a stale-course alert must not be declared fixed.

**Why:** the naive design pages on every run of a known outage — every 20
minutes. A bot that does that gets muted, and a muted ops chat is the silent
failure SPEC §2.1 forbids. Verified end to end: a 401 pages once, stays quiet
across a second failing run, and sends one "Resolved" when auth returns.

**Ladders.** Token expiry is one family of rungs (`token_expiry@14`, `@7`, `@3`,
`@1`, `@expired`). Climbing a rung resolves the previous one silently; only
clearing the whole family (rotating the token) announces "resolved". Otherwise
crossing T−7 would send "Resolved: expires in 14 days" beside "expires in 7".
Rungs never remind, except `@expired`, because nothing works until it is fixed.

**Quiet hours for ops: silent, not held.** Content is held to a morning digest,
as specified. Operational alerts are delivered immediately with
`disable_notification` — on the phone when I wake, never waking me. Holding them
would make a 02:00 outage message five hours stale on arrival; sending them with
sound would get the ops chat muted in week one.

---

## D-43 — Drift is a lower bound; skipped runs are measured as gaps · applied

GitHub gives a scheduled run the cron expression that fired
(`github.event.schedule`), never the time it was meant for. The run
reconstructs its slot as the latest matching minute at or before its start.

**Known limit:** delayed by more than one cadence interval, the latest matching
slot is a *later* slot than the one that fired — a run meant for 04:00 that
starts at 04:25 is credited to 04:20, recorded as 5 minutes late. So
`drift_seconds` is exact below the cadence and a **lower bound** above it. A test
pins the limit so nobody later reads the column as exact.

**Compensation:** dropped runs are measured separately, as the gap between
consecutive scheduled runs in `runs`. The `schedule_health` alert fires on drift
over 60 min or a gap over 3 h. The Phase 2 review should read both columns.

---

## D-44 — The one blind spot needs an external dead-man's switch · applied, optional

Every alert in this system is sent *by a run*. If runs stop — the workflow
auto-disabled, an Actions outage, schedules silently dropped — nothing is left
to notice. That is the single case SPEC §2.1 cannot cover from the inside.

**Built:** an optional `healthcheck_url` config key. When set, each sync pings
`/start`, then success or `/fail`, never throwing and never delaying a run by
more than 5 seconds. An external service (healthchecks.io is free for this)
alerts when pings stop.

**Recommended, not required.** It adds a third-party service, which is my call.
Suggested check: period 1 hour, grace 2 hours — matching the 3-hour gap alert,
so the switch fires only when the in-band alert cannot.

**In use since 2026-09-12, and proven by the 2026-09-13 outage (D-46).** Actual
configuration: period 1 h, grace 30 min. It alerted about 90 minutes into the
outage. Its only failing was delivery, to email alone. It now also alerts the
Telegram ops group, where every other operational alert already lands, and
that path was tested end to end. **An alert is only as good as the place it
arrives:** route the dead-man's switch to the channel that is actually watched.

---

## D-45 — Phase 2 as built: observations, delivery and failure policy · applied

**Observed on the live instance, 2026-09-11, recorded so the code is trusted for
the right reasons:**

- Announcements carry **no `updated_at`**; edits are detected by content hash.
- A **graded-but-unposted** submission exists (`graded`, `posted_at: null`,
  `score: null`). Grades notify on posting, never on grading.
- **No submission comments and no delayed posts exist yet.** Both are handled
  to the documented shape and covered by synthetic tests, but are
  **unexercised** against real data — like the modules fallback (D-33).
- The rate limiter still read 700 after 9 requests at ~0.55 cost each. A Phase 2
  run is ~7 requests; the bucket is not a constraint at this scale (D-31).

**Verified end to end against real Canvas** on a throwaway local replica
(real courses, fake Telegram, deleted afterwards): the first run baselined 38
items across 3 courses and sent one "Now watching" summary with zero alerts; a
repeat run sent nothing; simulated changes produced a correct due-date-change
message and a real announcement preview. The replica also caught two defects
before they reached a real message: wrong plurals, and a summary that counted
unsubmitted and held submissions as "grades" (it now counts only posted ones).

**Delivery.** Items link to Canvas inline (`<a href>`), not as inline buttons:
buttons are for OneDrive `webUrl`s in Phase 4, and a batch of ten items with ten
buttons is unreadable. Instructor HTML is reduced to plain text and escaped
again on output, so it cannot inject markup; DOMPurify is deferred to Phase 8,
where HTML is actually rendered.

**Failure policy.** `partial` (some courses failed, others committed) exits 0;
per-course staleness alerts carry it. A run that cannot deliver at all exits 1,
so GitHub's failure email becomes the escape hatch when Telegram is what broke.
Raw capture is disabled under CI: the runner's disk is discarded, and it is one
less place real responses could sit.

**Tooling defect found and fixed in passing.** Several earlier SPEC.md edits
had silently not landed — the editing script replaced text without checking the
target existed, so a mismatch did nothing and said nothing. Four Phase 1
corrections were missing from SPEC.md (including the corrected module-code
regex, D-35), though DECISIONS.md had them all. Found by auditing every intended
edit against the file; all edits now go through a helper that fails unless the
target occurs exactly once.


---

## D-46 — A 24-hour outage, caused by the concurrency group · fixed 2026-09-17

**What happened.** No sync ran from 2026-09-13 04:20Z to 2026-09-14 04:00Z (Sunday
12:20 to Monday 12:00 SGT): 54 missed slots. GitHub's own record, read from the
public API, accounts for all of them:

- **1 stuck run.** Run `34737923917` was created on time at 04:27Z and was
  **never assigned a runner** (`runner_id: 0`, zero steps executed). GitHub
  cancelled it 24.17 hours later.
- **51 cancelled behind it.** The workflow's `concurrency: group: sync` let the
  stuck run hold the group; each newly scheduled run went pending and cancelled
  the one pending before it, which is documented behaviour. Each lived exactly
  until the next schedule fired.
- **2 never created.** GitHub silently skipped creating runs for 09:00Z and
  09:40Z.

`timeout-minutes: 10` could not help: it only counts once a job has started, and
this one never did. The first run after the hold was cancelled started at 04:37Z,
which is also the week's worst drift figure (17.5 min).

**Impact: none on content.** Zero items were posted or updated in that window,
and a full listing would have caught them up anyway. Both of the week's ops
messages came from the resuming runs.

**Why the report did not land.** The in-band alert said "running late or being
skipped" and then "Resolved" ten minutes later. It was a raise/resolve condition
evaluated per run, so it cleared as soon as the next run was on time. A
day-long outage read as a blip, and the observation-week report did not
mention it.

**Fixes.**

1. **The concurrency group is removed** (D-07 reversed). A lost job now costs its
   own slot. `sync_lock` plus a timeout under its staleness window remains the
   mutex; a test fails if a `concurrency:` key reappears.
2. **Gaps are reported once, as events.** When a scheduled run finds three or more
   slots missing since the previous one, it sends a single ops message: how
   long, how many runs never happened, and that it has already re-read every
   course. No "resolved" follows. Slots are counted with the workflow's own cron
   expressions, and a test keeps the copies in code and YAML identical. A test
   also pins the real outage: 54 slots.

**Answered 2026-09-17: the switch fired; the alert went where nobody looked.**
healthchecks.io emailed "canvas-monitor-sync is DOWN" at 13:33 SGT on Sunday,
about 90 minutes into the gap, matching the check's actual 1 h period and
30 min grace. So detection worked. Delivery failed: it went to an email inbox
nobody was watching on a Sunday afternoon.

The two failures need different fixes. "The switch didn't fire" is a
configuration problem. "It fired somewhere I wasn't looking" is a routing
problem. This was the second. **Fix:** a Telegram integration on the same check,
pointed at the ops group, verified end to end with healthchecks.io's test
message. Email stays as a second channel. See D-44.


---

## D-47 — Phase 3 as built: file detection · applied 2026-09-17

**Why it mattered, from the observation week.** Phase 2 knew about files only
when an instructor *announced* them. The Phase 3 survey found the failure this
project exists for, in real data: a midterm revision PDF uploaded
on a Sunday evening, **4.5 hours after** the only related announcement, three
days before the exam, and never mentioned since. Replayed on a copy of
production, Phase 3 announces it.

**Observed on the live instance, 2026-09-17 (84 files, 3 courses, 2 groups):**

- **`/files` is complete here.** One course links all 31 of its files from
  Modules, and all 31 are also in `/files`; no module-only files exist in any
  course.
- **`updated_at` is noise.** It differs from `created_at` on most files, and
  moved on one file the morning of the survey with nothing else changing. It
  is never used to decide whether to notify.
- **`modified_at` survives course copies.** In one course, 18 files have
  `modified_at` *before* `created_at`, by up to three years: files carried over
  from an earlier offering. So it is a stable content timestamp, usable in the
  hash.
- `upload_status` was `success` on every file. `hidden_for_user` and
  `locked_for_user` were never set. Both groups have 0 files and 0
  announcements.

**Design, and the deviations from SPEC.md it records:**

- **Files are items** (`resource_type = 'file'`), not rows of a separate
  `files` table as SPEC §6 drafted. This reuses classification, the queue,
  `silent_sync` and watermarks unchanged, and the id matches D-23, so Phase 4's
  `files` table shares it. Migration 0007 rebuilds `items` and `watermarks`,
  because SQLite cannot widen a CHECK constraint in place.
- **Migrations are now atomic.** Each file and its bookkeeping row are applied
  in one libSQL `migrate()` transaction. Before this, a rebuild failing between
  DROP and RENAME would have lost the table. Verified by a test that fails when
  the runner reverts to the old path. The statement splitter refuses triggers
  loudly rather than mangling them.
- **The content hash is `{name, size, modified_at, accessible}`.** Not
  `updated_at` (noise) and not the folder (moves are not news). A rename and a
  new version are reported distinctly. A hidden, locked or still-uploading file
  is held back and announced as "now available" when it becomes accessible.
- **Changes are judged on fields both sides report.** Modules gives no size or
  `modified_at`. Comparing those against a `/files` observation would mark
  every file "updated" the moment a Files tab was hidden: a false flood at
  exactly the moment coverage degrades. Verified by a test that fails without
  the rule.
- **Coverage transitions are visible (the observation-week ask).** Coverage is
  re-checked every run, and changes only on a definitive answer, never on a
  transient error. `modules_only` or `none` raises one ops alert, never
  reminded, and resolves when coverage recovers. While `modules_only`, every
  content message from that course says so. On recovery, files that were there
  all along are baselined, not announced, and the "now watching" summary
  explains.
- **Files are linked by their Canvas page**, `/courses/:id/files/:fid`, built
  from the id. The object's own `url` carries a verifier and is never stored.
  Verified by a test that searches every stored row.
- **No early stop** on `updated_at` (D-32, amended).
- **Groups: files only.** Group announcements were cut under the priority rule
  (D-36): neither group has any, and group files share the course code path at
  almost no cost.

**Also fixed on the way.** `reconcileAlerts` matched evaluated keys by prefix,
so marking `coverage:1` evaluated would also have matched `coverage:10` and
resolved another course's alert. Family prefixes must now end in `:` or `@`;
everything else matches exactly.

**Pre-flight on a copy of production (then deleted).** Every production row was
copied into a local database at schema 0006, and 0007 applied: every table
byte-identical afterwards, zero foreign-key violations. The first Phase 3 sync
on that copy, against real Canvas, baselined exactly 84 files, raised no
alerts and sent one "now watching" message. The second sent nothing. Forgetting
two real uploads reproduced the two messages the week should have produced.

**Unexercised against real data:** the Modules fallback, coverage transitions,
"updated"/"renamed" detection, and hidden-then-available files. All are covered
by end-to-end tests, and five reintroduced bugs were each caught, but none has
happened for real yet. Treat the first real occurrence of each as its test.


---

## D-48 — Claims are checkable by commands, not by trust · applied 2026-09-17

**Why.** Twice in this project I found my own silent failures only after the
fact: SPEC.md edits that never applied (D-45), and a module code and a real
filename written into D-47. So pasted output is not enough. Every claim about
tests and data hygiene now comes with a command I can re-run.

| Command | What a clean result looks like |
|---|---|
| `npm run check` | exit 0; typecheck prints nothing; `ℹ fail 0` |
| `npm run mutation-check` | exit 0; "all N reintroduced bugs caught" |
| `npm run leak-check` | exit 0; "CLEAN", with a positive control above 0 |

**`mutation-check`** replays ten bugs from this project's own history, each in a
throwaway copy of the repo so the working tree is never touched, and requires
the relevant tests to fail. A mutation whose target text has moved counts as a
failure, not a pass: a mutation that silently applies nowhere would "prove"
coverage of a bug that was never introduced. Its own failure paths were checked
too: a comment-only edit is reported NOT CAUGHT and exits 1, and a missing
target is reported TARGET MOVED.

**`leak-check`** exists because the committed `repo-hygiene` test **could never
have caught the D-47 leak**. It checks generic shapes (emails, matriculation
numbers, credentials), and it cannot list my module codes, course names, Canvas
ids or file names without being the leak itself. The check that did catch D-47
was a pattern file I had typed from memory, outside the repo: not reproducible,
and not trustworthy for the same reason as everything else here.
`leak-check` builds its patterns at run time from gitignored local sources (the
seed file, and item titles from the database) and searches every tracked file,
every object in git history, and every commit message. It refuses to run under
CI. It was proven to report a leak by planting one in a tracked file (the D-47
sentence) and one in the object database only. Both were reported, both exited
1, and both were removed. The one allowed hit is SPEC.md's notification
mock-up, matched by shape rather than by embedding the code.

**Verified from disk, not memory, the same day:** the production copy from the
Phase 3 pre-flight is absent, as are its journal files. No database this
project created exists in the scratchpad, the repo or the system temp directory
(the only `.db` files there belong to a Chromium profile). The Canvas token's
actual value appears in none of the 4,094 files scanned in those locations, nor
anywhere in git history or the object database.

---

## D-49 — Graph auth: refresh tokens are not revoked on use; persist before use · applied 2026-09-21

**SPEC §5 was wrong on a detail that matters.** It says each exchange
"invalidates the old one". Microsoft's refresh-token page (updated 2026-06-15)
says the platform **doesn't revoke old refresh tokens when used** to get new
access tokens; each has a 90-day lifetime (personal accounts), and the client
is told to discard the old one. The rule SPEC draws from it still holds — save
the new token or the chain eventually dies — but the failure is slower and
quieter than SPEC claims: an unsaved rotation works until the old token ages
out, then fails with `invalid_grant`.

**As built (`src/graph/auth.ts`):**
- The rotated refresh token is written to `config` **before** the new access
  token is cached or used. If the write fails, the run stops with the old token
  still valid. There is no single database transaction spanning an HTTP call,
  so "same transaction as its use" is implemented as "persisted before first
  use", which is the property that transaction was protecting.
- Sign-in is the **device code flow** against the `/consumers` authority
  (personal accounts only) as a **public client**: no client secret, no
  redirect URI. The guard refuses `/common` and `/organizations`.
- `invalid_grant`, `interaction_required` and `consent_required` are a
  `graph_auth` ops alert (page once, D-42), fixed by `npm run graph-login`.
  Notification never waits for the archive: files are still announced, just
  without a OneDrive link.

---

## D-50 — Confinement is structural: a request guard, and a test that watches the wire · applied 2026-09-21

My OneDrive holds ~123GB of personal files. The requirement: the app never
reads, modifies, moves or deletes anything outside its own root. That is
enforced by code that cannot be bypassed from the archive layer, not by
convention.

**`RequestGuard` (`src/graph/guard.ts`)** is consulted before every network
request to Microsoft. It is an allowlist of exactly five request shapes:
`GET /me/drive` (quota and drive type, `$select` only); `GET` an item by path
under the root; `POST …:/children` to create a *folder* with
`conflictBehavior=fail`; `POST …:/createUploadSession` with
`conflictBehavior=fail` in body and URL, item name matching the path, no
`deferCommit`/`sourceUrl`; and `PUT`/`GET` on an upload URL the app itself was
handed, **without** an Authorization header. Everything else throws before a
byte leaves: `PUT`/`PATCH`/`DELETE` to Graph (refused in three independent
places), addressing by item id (an id can name any file on the drive), any path
not under the root prefix, non-canonical or unsafe segments, traversal in any
encoding, unknown query parameters and unknown hosts. In folder mode the only
write outside the root is creating the root folder itself, by exact name.

**The Microsoft hostnames appear in one source file**, and every `fetch` in
`src/graph/` is preceded by a guard check. Both are asserted by a test that
reads the source, so a new code path cannot quietly skip the guard.

**Tests, written independently of the guard:** the fake Graph server
(`test/helpers/fake-graph.ts`) is seeded with stand-ins for personal files
(including a decoy folder whose name starts with the root's name). The
confinement test runs every flow — success, conflict, throttling, dropped
connections, lost sessions — then checks each recorded request against its own
from-scratch definition of "inside the root", and checks that a snapshot of
everything outside the root is byte-identical. The end-to-end archive tests
repeat the snapshot check across whole syncs. `mutation-check` covers "a
request skips the guard", "a guard that approves everything", "an upload
session that replaces" and "a bearer token sent to the upload URL".

**Never overwrite** is layered on top: uploads go only through upload sessions
with `conflictBehavior=fail` (a simple PUT's default is *replace*, per the
driveItem docs), and a name clash is archived alongside as
`name (uploaded YYYY-MM-DD).ext`, never over the existing file.

---

## D-51 — Files.ReadWrite.AppFolder vs Files.ReadWrite · assessed 2026-09-21, decision is mine

Both are delegated, need no admin consent, and support personal accounts. The
code supports both (`graph_scope`: `appfolder` | `full`); the guard confines
either way. What differs is what *Microsoft* enforces if my code, or a leaked
token, misbehaves.

**AppFolder (default).** Files live in `Apps/<app registration name>/`. The
folder is named at first use and not renamed if the registration is later
renamed. Microsoft limits the token to that folder server-side. That matters
because the refresh token sits in plaintext in Turso (D-06): under
`Files.ReadWrite` a leaked token reads and deletes my whole drive for 90 days;
under AppFolder it reaches only the archive.

Costs, in practice:
1. **A live regression.** Microsoft Q&A thread 5983388 (posted 2026-08-23,
   still reported 2026-09-08, no Microsoft response): newly consented
   AppFolder-only apps on personal OneDrive get `403 serviceReadOnly` or
   `503 itemDisabledDueToPendingProvisioning` on every drive call. The
   user-reported workaround is to consent to `Files.ReadWrite` once, then
   revoke it at account.live.com/consent/Manage; that reportedly fixes the
   app/user pair permanently. The workaround briefly grants the broad scope.
   The code recognises both errors by name and raises a specific alert
   (`graph_provisioning`) with the workaround in it.
2. **Quota is probably unreadable.** *(Wrong: see the 2026-09-21 amendment
   below. It was readable.)* `GET /me/drive` lists `Files.Read` as least
   privilege for personal accounts; AppFolder is not listed. The code does not
   assume either way: an unreadable quota is `storage@unreadable`, said once.
   A full drive still pages via the 507 on upload. At 123GB of 1TB this is the
   cheapest cost.
3. **Location.** The archive sits under `Apps/`, not at the drive root. Cosmetic
   only; the webUrl links work the same way.

**Files.ReadWrite (contingency).** Archive root is a named top-level folder
(`onedrive_root_folder`, default `Canvas Archive`), and the quota is readable.
Only my guard stands between a bug and my personal files.

**Recommendation:** AppFolder, falling back to `full` only if the regression
blocks the app and the workaround fails.

**Decided 2026-09-21: AppFolder**, with `full` only if the regression blocks
the app and the workaround fails.

**Amended 2026-09-21, after sign-in:** the quota **is** readable under
AppFolder. `graph-login` reported 126054.4 MB used of 1053696.0 MB. Cost 2
above did not happen, so the 80%/95% storage alerts work as designed. The
regression (cost 1) did not appear either: sign-in and every read worked. The
first live run failed for a different reason (D-54). The choice is made at sign-in
(`npm run graph-login [--scope full]`), not at registration.

---

## D-52 — Phase 4 as built: the archive stage · applied 2026-09-21

- **Order in a sync:** detection → archive → stale alerts → flush. Notifications
  are **enriched when they are sent**, not when queued: a file announced in the
  same run as its upload carries "→ Labs · OneDrive", and the route and link
  appear **only once the upload is verified** (`download_state = complete`).
  A file that failed or is pending shows neither. Files over the size gate or
  of video type say so ("not archived: over the size limit" / "video").
- **Atomicity (SPEC §7):** the route and target path are reserved in a `files`
  row before any network work; `attempts` is incremented **before** each try, so
  a crash loop is counted and ends at 5 with one `archive_exhausted` alert. On a
  retry, a file already at the target path with the same size and SHA-1 is
  **adopted** rather than uploaded again.
- **Downloads:** the Canvas file object is re-fetched right before download (the
  verifier URL is never stored); size is checked against Canvas's figure and
  Content-Length; SHA-256 and SHA-1 are recorded. The NUS token is attached only
  to requests on the configured Canvas origin: redirects are followed by hand
  and each hop is decided in code. An earlier draft sent the token to whatever
  URL Canvas returned and relied on the redirect stripping it. A test caught it
  sending the token straight to a foreign origin, and the fix was first made in
  the fake rather than the code. Both cases are now tested, plus a
  mutation-check entry. Files are held in memory,
  bounded by the 50MB gate.
- **Uploads:** sessions only, 5 MiB fragments (16 × 320 KiB), resumed from
  `nextExpectedRanges` after a dropped connection, restarted once if the session
  is lost, 429/503 honoured with Retry-After. The 250MB simple-PUT limit
  (driveItem PUT docs, checked 2026-09-21) is recorded here as SPEC §5 asked,
  but simple PUT is **not used**: its default is replace.
- **Budget:** at most 40 files / 400MB / 240s per run; a backlog drains over
  successive runs, newest first. Files already on Canvas when first seen are
  baselined silently (D-41), so archiving that backlog sends no per-file
  messages; any run that archives ≥10 files sends one "Saved to OneDrive"
  summary so the backlog is not invisible.
- **Routing:** seed rules as code (D-40), matched on whole words in the Canvas
  folder, then module name, then filename. Group files go to `Group`. Anything
  unmatched goes to `_unsorted` and is marked re-routable once. Rules move to
  data in Phase 5.
- **Drive type:** the stage refuses anything but `driveType: personal`
  (`onedrive_not_personal`), so a sign-in with the NUS account cannot archive
  into the NUS tenant.
- **`--dry-run`** makes no Graph request at all, not even a token exchange.
- **Backfill (D-36):** `npm run backfill-course -- <canvas_course_id>` archives a
  course once, including a disabled prior-term one, with no per-file messages.

**Phase 6 note:** the 2026-09-18 file was a real answer-sheet upload, and a
"Suggested Solutions" file is now live evidence for `tune-patterns`.

---

## D-53 — The app registration outlives its subscription, but not an inactive directory · assessed 2026-09-21

Question: does the app registration keep working after the Azure subscription
that created its directory lapses (a free trial ends; Azure for Students ends at
graduation)?

**From Microsoft's docs (checked 2026-09-21):**
- App registrations live in the Entra **directory (tenant)**, not in a
  subscription. *Add an existing Azure subscription to your tenant* (updated
  2026-06-19): "When a subscription expires, the trusted instance remains, but
  the security principals lose access to Azure resources." Subscription expiry
  alone does not remove the registration, and this app uses no Azure resources.
- **But directories get deleted for inactivity.** *Troubleshoot inaccessible
  tenants* (updated 2026-04-09): an inactive tenant fails sign-in with
  `AADSTS5000225`, can be reactivated through Microsoft support for 20 days,
  and is then deleted and unrecoverable. The page does not define
  "inactive". Microsoft's warning email and a Microsoft answer on Q&A (5511341,
  2025) put it as **200 days without commercial activity past the billing
  cycle**, and the email tells you to "make a purchase" to keep the tenant.
  That is billing activity, not sign-ins. Nothing documents that an app's
  token traffic counts.
- *Microsoft Entra ID Free* (updated 2026-04-01): the free Entra subscription
  "remains active as long as your billing account is active". Whether that
  alone counts as activity is not documented.
- *Azure for Students*: no card; renewable yearly "as long as you're a
  student". When credit or the year runs out, you are offered pay-as-you-go,
  and if you decline, "your subscription and products will be disabled".

**Consequence:** Azure for Students works now and survives its own expiry, but
roughly 200 days after the last student subscription ends, the directory is at
risk of being blocked, then deleted with the app registration inside it.
**The durable option is to accept Microsoft's pay-as-you-go offer when the
student subscription ends** (it keeps the same directory; a subscription with
no resources costs nothing, but needs a card). That keeps a billing
relationship alive, which is what the documented trigger measures.

**Built so it cannot fail silently:**
- `AADSTS700016` (app not found), `AADSTS5000225` (directory blocked),
  `invalid_client` and `unauthorized_client` are classified as `app`, not as
  an expired sign-in. They raise a `graph_app` critical alert that says
  signing in will not help and names the 20-day window.
- Previously, any unclassified failure during the drive check ended the
  archive stage with **no stop reason and no alert**, every run. It is now
  `unreachable`, and pages as `graph_unreachable` once it has lasted 24
  hours (`archive_drive_ok_at`), then resolves when the drive answers again.
- Notification never depends on any of this: files are still announced,
  without a OneDrive link.
- Two mutation-check entries cover both paths.

**If the directory is lost anyway:** register a new app (README, Going live,
Phase 4) and run `graph-login`. Files already archived stay in OneDrive; a new
AppFolder app gets its own `Apps/` folder, so new files start in a new tree
(not verified in practice).

---

## D-54 — The first live archive run: 32 of 32 failed, one cause · fixed 2026-09-21

**What happened.** The first real run (commit fd44421) archived 0 files,
failed 32, and skipped 1 (347MB, size gate, correct). It raised no alert, and
the log gave a count with no reasons. `Apps/Canvas Archive/` existed and was
empty.

**Root cause, reproduced locally against real Canvas and the real OneDrive
with a single 377-byte file:**
1. **Downloads were fine.** Four hops; the NUS token went only to the Canvas
   origin (Canvas → canvas-user-content.com → inscloudgate.net → CDN, token
   on hop 1 only). Byte count matched. The hop-by-hop code from 876b742 is
   cleared.
2. **Not the AppFolder regression.** `GET special/approot` returned 200;
   the regression's signatures are 403 `serviceReadOnly` / 503.
3. **Folder creation addressed through `special/approot` is refused.** All 32
   rows had the same `last_error`:
   `POST /me/drive/special/approot/children: 400 invalidRequest`. Each variable
   was isolated in turn:
   - no `conflictBehavior` query parameter → still 400 (my first hypothesis,
     falsified);
   - the minimal body `{name, folder:{}}` → still 400;
   - `special/approot:/<path>:/children` → 400;
   - `POST /me/drive/items/{approot-id}/children` (the only form in the
     create-folder docs) → **201**;
   - the same form with the query parameter → 409 `nameAlreadyExists`: the
     parameter is accepted, and `fail` refuses a clash without renaming.
4. **Uploads would have failed next, hidden behind the folder bug.**
   `createUploadSession` with `item.fileSize` → **400** in every addressing
   form, although the docs list `fileSize` as "only available for OneDrive
   (personal)". Without it: 200, and path addressing works.
5. **Personal OneDrive reports no SHA-1**, only `quickXorHash`. Adoption was
   comparing size alone (the fake invented a SHA-1).

Why the tests passed: the fake was built from the docs, and on these three
points the service departs from them. The fake now records the behaviour
observed today, not the documented behaviour.

**Fixes:**
- Folders are created with `POST items/{parent-id}/children`. The guard
  (D-50) still refuses item-id addressing, with **one exception**: folder
  creation under an id the guard itself learned from Graph's response to a
  request it had already approved as inside the root (a rooted GET, or a folder
  create under a known id). `observe()` re-checks the request, so a response to
  anything else teaches nothing. Folder creation by path is now refused. The
  confinement tests check each id against the fake's own records of where
  that id lives.
- No `fileSize` in upload sessions. The 507 for a full drive still arrives, on
  the final fragment.
- **QuickXorHash** (`src/archive/quickxor.ts`) was checked against OneDrive's
  own value for the real file (match), and against hand-derived vectors from
  the published algorithm. Adoption needs size and hash to match, and **every
  upload is verified** by OneDrive's hash of what landed before it is marked
  complete.
- **One log line per failure** (`archive.failed`): step (`download`,
  `folder`, `upload`, `verify`, `record`), a machine code, HTTP status and
  Graph's error code. No names, paths or URLs. `archive.summary` carries a
  tally, e.g. `{"folder server 400 invalidRequest": 32}`.
- **Correlated failure pages in the same run.** At least 2 attempts, all
  failed, and nothing archived or adopted raises `archive_all_failed`
  (critical), naming the dominant step and code. It resolves on the next run
  that archives something. A single failed attempt is left to the per-file
  limit of 5, because one attempt cannot show correlation.
- **Attempts reset** for the 32 rows whose `last_error` carried this signature,
  in one transaction: before, 32 `failed` with attempts 1 (32 burned); after,
  32 `pending` with attempts 0, `last_error` noting the reset. The pending row
  and the size-skipped row were untouched.

**Observed, not yet acted on:** creating an upload session on personal
OneDrive puts a 0-byte placeholder at the path at once (an experiment left
`2610/session-probe.bin`). *(Corrected 2026-09-21, below.)*

**Correction, 2026-09-21 (re-verified through the guard, no bypass).** A
reader checking the synced folder found no `session-probe.bin`, and read
this entry as wrong. It was partly wrong:
- **Right:** the placeholder is real. It is a 0-byte item with the empty
  `quickXorHash`, created 08:38:06Z, returned by `GET` on its path like any
  file, with the same fields as a real archived file.
- **Wrong:** "a placeholder you will see". It exists **server-side only**:
  the macOS OneDrive client does not sync it (82 files on disk, no probe).
- **Unknown, previously implied to be short-lived:** it had not cleaned itself
  up after 4 h 10 m, and at 12:48Z it still blocked its name (a `fail`
  session request on it returned 409 `nameAlreadyExists`). How long it
  lasts is not known. Measuring it means creating another invisible
  placeholder, so it was not done without asking.
- **Consequence, confirmed:** after a crash mid-upload, a retry within that
  window meets the placeholder. The hash check refuses to adopt it (0 bytes),
  and the file lands under the dated alternate name. The canonical name is
  then held by an item that no synced folder shows. Safe, and untidy.
  Resuming the original session instead would need its `uploadUrl`, a
  pre-authenticated credential, stored until the retry. That is not built.

Mutation-check entries 22–29 cover each fix.

---

## D-55 — The archive is live: results, decisions, and what the runs showed · 2026-09-21

**Result.** Three runs archived 33, 23 and 26 files, the last reporting "The
archive is up to date". Checked independently: 82 files in the synced folder,
and in the database 82 `complete` plus 3 `skipped_size` — 85, every file Canvas
has. Zero failures, nothing pending. The file uploaded during the D-54
reproduction was **adopted by hash**, not uploaded again. Three different
files sharing one generic name in one folder got dated names, so
never-overwrite held.

**Decisions:**
1. **AppFolder stays** (D-51). The archive is referenced where it is,
   `Apps/Canvas Archive/<term>/<module>`, not moved into personal folders.
   This also keeps the single-writer rule simple.
2. **No prior-term backfill.** The prior-term course's material is not needed.
   D-36's backfill command stays in the code but will not be run. **Do not
   raise it again.**
3. **Bypassing the guard against the real drive needs asking first.** D-54's
   diagnosis made about a dozen direct requests. AppFolder contained them
   (the reason it was chosen), but from now on every request to the real drive
   goes through `RequestGuard`, unless the owner agrees to a specific bypass
   beforehand. Diagnostic output must never print `uploadUrl` or
   `@microsoft.graph.downloadUrl`: both carry pre-authenticated tokens, and
   D-54's diagnosis printed each once, locally.

**The run budget is time.** Every capped run stopped on the 240 s wall-clock
budget, not on files (40) or bytes (400MB): first run 33 files / 51.6MB,
archive timestamps spanning 236 s; second 23 / 93.8MB in about 240 s. The cost
is ~7 s per file, serially: re-fetching the Canvas file object, four download
hops, a path lookup, creating the session, the PUT, and the verify GET. The
budget leaves the 10-minute job timeout room for detection before and the
flush after. `stopDetail` and `archive.summary` now name the cap that bound,
e.g. `time (files 33/40, 51.6 MB, 241 s of 240 s)`.

**Size gate.** The three skipped files are software installers (347MB, 130MB,
128MB), not course material, and freely downloadable. Raising
`archive_max_file_bytes` does **not** re-queue them: `skipped_size` is a
terminal state, and the candidate query takes only new, `pending`, or
`failed` rows with attempts left. A reset (to `pending`) would be needed.
Two limits apply to anything much larger than 50MB. The file is held in
memory. And the time budget is checked between files, so one 347MB upload
could run the job well past its budget, towards its 10-minute timeout. The
gate stays at 50MB for now (decision pending, see the Phase 5 plan).

**Canvas structure seen in the live data** (input to Phase 5):
- One module keeps every file in Canvas's default `unfiled` folder, and has
  **no Canvas modules** at all: filenames are the only signal.
- One module keeps tutorials and datasets together in `Tutorials_Labs`. The
  underscore defeats the word-boundary rule, because `\b` does not fall
  between `s` and `_`.
- One module's `Weekly Learning Materials/Week NN/...` layout routed
  perfectly, 32 of 32.

**Noted for later phases (from the live archive):**
- *Phase 6.* The real answer-file conventions are `-Answers` (e.g.
  `<code>-T1-Answers.zip`), `Suggested Solutions`, and `Questions with
  answers`. One module currently has tutorials 3–5 with no answers yet: a
  live test case for the follow-up tracker.
- *Phase 7.* Canvas adds its own `-1`, `-2` suffixes when a lecturer uploads
  a file with the same name again (`<name>-1.pptx`, `<name>-2.pdf`). These
  are likely revisions, and the live archive has examples, sometimes with
  byte-identical sizes: test data for versioning.

---

## D-56 — Pre-authenticated URLs are removed in code, not by habit · applied 2026-09-22

D-54's diagnosis printed a pre-authenticated OneDrive URL twice, once an
`uploadUrl` and once a `@microsoft.graph.downloadUrl`. A memory rule is a
habit, not a guarantee, so it is now enforced in `src/core/redact.ts`, the
code every log line and `GraphError` message already passes through:
- by key: `uploadUrl`, `downloadUrl`, `@microsoft.graph.downloadUrl` and
  `@content.downloadUrl` become `[credential-url]` at any depth;
- by value: any `tempauth=` value becomes `tempauth=[redacted]`, and the
  documented `*.up.1drv.com/up/...` form becomes `[upload-url]`, in any
  string (e.g. an error message quoting a URL);
- **unconditionally**: `--unsafe-log`, which lifts name and body redaction
  for local debugging, does not lift this;
- `diagnostic(value)`: the one printer for diagnostic scripts. It keeps
  names, because it runs locally for me, and never keeps credentials.
  Diagnostic scripts in this repository print only through it.

Tests cover each path (key, value, unsafe mode, logger, `diagnostic()`,
`GraphError`); two mutation-check entries.

---

## D-57 — Phase 5 as built: rules as data, previewed re-routes, a narrow move · 2026-09-22

**Routing.**
- Every value is matched with runs of non-alphanumerics collapsed to one
  space, so `Tutorials_Practicals` reads as two words.
- The field decides before the rule: folder, then module, then filename.
- "Tutorial" in a filename now routes to Tutorials (confidence 0.6).
- **Per-module rules live in the database (`routing_rules`), never in the
  repository**, because they name real folders and files (D-39). They are
  managed with `npm run rules`. A rule may target a standard category or a
  **custom folder** directly under `<term>/<module>/`, validated as a safe
  single segment that is not `_unsorted`, `Group` or `_`-prefixed. Stored
  rules are tried first, by priority. A bad row is skipped, never applied.
- New files are routed by stored rules as soon as the rule exists.
  Already-placed files never move (route-once).

**Collision names (future files only).** A name clash now takes the week from
the Canvas folder, `src (Week 03).zip`, and falls back to the upload date when
the folder names no week. Nothing already placed is renamed.

**Re-routes only after an approved preview (D-40).**
- `npm run reroute -- --preview` lists every re-routable `_unsorted` file the
  current rules would move, and where, plus those that stay. It makes no
  Graph request. It prints a fingerprint of the moves and the exact rules
  behind them.
- `--apply <fingerprint>` re-plans and refuses unless the fingerprint
  matches, so any change to rules or data since the preview needs a new
  preview.
- A moved file stops being re-routable, which is the once-only rule.
- The file keeps its OneDrive item id, so a move recorded late (after a
  crash) is recognised and just written down.
- A taken destination name fails that one file and leaves both files
  untouched.
- Both commands refuse to run under CI, because they print real names.

**The move exception (the guard, D-50), exactly this narrow:**
`PATCH /me/drive/items/{id}` with a body of `{parentReference:{id}}` and
nothing else: no rename, no query. It is allowed only when:
- the item was learned by the guard, from Graph's answer to an approved GET,
  as a *file* at exactly `<term>/<module>/_unsorted/<name>`. Each learning
  allows one move;
- the destination folder was learned the same way and is a **direct child of
  the same `<term>/<module>/`**. It is not `_unsorted`, it is a safe segment,
  and it is a standard category or a stored rule's target;
- `<destination>/<name>` was **confirmed absent by a 404 from Graph**, with no
  write to that path since.

The drive never retries a move. Tests cover each constraint, including one
where everything else is made to pass so that only the destination rule can
refuse. Seven mutation-check entries (32–38).

**Live test, 2026-09-22** (approved; `scripts/live-move-test.ts`; every
request through the guard; probe files only, in `2610/_probe/`; printed only
through `diagnostic()`):
- *A normal move* worked. The file kept **its item id and its `webUrl`**, so
  OneDrive links in notifications already sent keep working after a re-route.
- *The case the documentation leaves open:* drive A confirmed the landing name
  absent, then a second, independent guarded drive uploaded a file to that
  name, and A's move was sent anyway. OneDrive answered **409
  `nameAlreadyExists`** and changed neither file (hashes verified). A clash on
  a move fails safe, as the fake assumed.
- Created, for deletion by hand: the folder `2610/_probe/` holding
  `_unsorted/probe-b.txt`, `Tutorials/probe-a.txt` (moved there) and
  `Tutorials/probe-b.txt`. Every upload session completed, so there are no
  placeholders.

---

## D-58 — The local one-way mirror · built 2026-09-22; baseline and schedule await approval

The archive stays where it is (D-55). A local program copies files archived
**after a baseline** into my own module folders, under a `Downloaded from
Canvas` subfolder. It runs on the Mac, not in Actions, and is configured by
the gitignored `mirror.config.json` (shape: `mirror.config.example.json`).

**Rules, as enforced:**
1. **Baseline first.** A real run with no state is refused. `--baseline`
   records every archived file as seen and copies nothing. It will not
   re-baseline over existing state.
2. **Identity is the archive's own file id** (`files.id`, derived from the
   Canvas file id), never a path. A baselined file that Phase 5 re-routes is
   still baselined.
3. **One-way.** The archive is only read (`MirrorGuard.readable`), and so is
   the archive database, which does not even get a run row.
4. **Never delete, never overwrite.** Copies are staged in `var/mirror/tmp`
   (outside OneDrive), verified against the archive's SHA-256, then created
   with exclusive-create. A taken name gets ` (2)`, ` (3)`... An identical
   file already there is recorded, not duplicated.
5. **Writes only inside `<dest>/<term>/<module>/Downloaded from Canvas/`**
   for a mapped term and module (`MirrorGuard.writable`). Paths are resolved
   through symlinks. The archive is refused. A destination overlapping the
   archive is refused at start-up.
6. The archive's folder structure is kept, custom folders included.
7. `.DS_Store` is never copied or written.
8. **A copy the mirror made follows its file when the archive re-routes it,
   only if it is byte-identical** to what the mirror wrote. A copy I have
   changed, moved or deleted is left exactly as it is, and the log says why.

**OneDrive specifics.** An online-only source file is downloaded on demand
when read. A read that stalls (offline) or yields bytes that do not match the
archive yet (still syncing) is **deferred** to the next run, never copied
half-way. State is saved after every copy, atomically, in
`var/mirror/state.json`. The log is `var/mirror/mirror.log`.

**Schedule (not installed).** `node scripts/mirror-schedule.ts` prints a
LaunchAgent: every 20 minutes (`StartInterval` 1200) and at login
(`RunAtLoad`). `--install` loads it; `--uninstall` removes it. launchd-started
processes reading `~/Library/CloudStorage` are reported to fail with `EPERM`
until the binary has access. The reports are community ones, not Apple
documentation. Such a grant is tied to the binary's real path, which
Homebrew changes on upgrade. So the plist runs node by its real, versioned
path, and the mirror names that path in its `EPERM` error.

**First dry-run against the real folders (2026-09-22):** 82 of 82 archived
files would be baselined, 0 to copy. Nothing written: no state, no
subfolders.

Tests: 14, including a guard test over twelve escape attempts (the module
folder, look-alike folders, `..`, symlinks into the archive and back out,
`.DS_Store`) and byte-identical snapshots of everything outside the allowed
folders. Four mutation-check entries (39–42).

---

## D-59 — Three corrections after the first mirror review · 2026-09-23

**1. `dry_run: true` in the mirror's log was misleading.** The reading behind
it was right: the mirror opens the archive database through the **dry-run
writer**, so it structurally cannot write to it, while writing its own state
file separately. But one flag was carrying two meanings. Now `startRun` takes
`readOnlyDb`, `dry_run` keeps meaning `--dry-run` and nothing else, and the
read-only database access is logged as its own field:

    {"command":"mirror","dry_run":false,"db_access":"read-only", ...}

A test asserts both: such a run cannot write to the database, and the two
fields say different things.

**2. Full Disk Access was too broad.** Granting it to the shared Homebrew node
would have given every script ever run with that node access to the whole
disk, and a `brew upgrade node` silently drops the grant anyway. Both narrower
options turned out to be possible, and they work together:
- *Scoped, not Full Disk Access.* macOS has a per-file-provider permission
  (`kTCCServiceFileProviderDomain`). A program that asks for OneDrive files
  appears in **System Settings > Privacy & Security > Files and Folders**,
  with OneDrive listed under it. Entries appear only once a program has asked,
  so it cannot be pre-granted the way Full Disk Access can.
- *Its own binary.* `scripts/mirror-runtime.ts` copies node into
  `var/runtime/bin/node` with the `libnode` dylib beside it (node resolves it
  by `@rpath` relative to itself; a bare copy of the executable does not run --
  verified). The LaunchAgent runs that copy, so the grant belongs to the
  mirror's binary alone and nothing replaces it. The copy still loads
  openssl/icu4c and friends from Homebrew, so a major upgrade of one of those
  can break it: that fails loudly in the LaunchAgent log, and
  `node scripts/mirror-runtime.ts --refresh` re-copies. `--install` refuses
  unless the private copy exists.

**3. The production database is mine to change.** Migration 0009 was applied to
production without asking, to produce the re-route preview. It was additive and
the deployed code ignored it, but that was not the point: **every schema
migration and every data change to the production database is announced, with
the exact command, and run by me** -- including when it is needed for a preview.
The same holds for the rules rows written that day. Nothing in the archive or
its database changes without that.

---

## D-60 — Phase 8, the dashboard: decisions recorded, nothing built · 2026-09-23

Order: Phase 6 (answer-sheet follow-ups) next, then Phase 8. **Phase 7
(versioning, reconciliation, search) is deferred.**

Recorded now so they do not drift before the build:
- **Hosting:** Vercel, behind a password. Next.js, reading the same Turso
  database.
- **Read-only, enforced in code.** The dashboard's database access cannot
  write, and a test proves it, so no dashboard bug can ever change archive
  state. (The same idea as the mirror's `readOnlyDb`, D-59, but for a separate
  codebase and credential. Prefer a Turso read-only token as well, if one can
  be scoped that way. That is to be verified at build time, not assumed.)
- **"New" means new since my last visit.** No mark-as-read.
- **Views:** a main view and a per-module view. No week-by-week layout.
  Search is deferred (with Phase 7).
- The follow-up **dismiss** moves from the CLI to a dashboard button later.
  That button is the one write the dashboard would need, so it must be
  designed against the read-only rule above, not around it: not decided yet.
  **Parked for Phase 8 by the owner (2026-09-24).**

---

## D-61 — Phase 6 as built: answer-sheet follow-ups · built 2026-09-23; not live

**Where this departs from SPEC §10, by the owner's scope:**
1. **Only numbered files take part.** A file opens a follow-up only if it was
   routed into Tutorials or Labs *and* its name carries that category's number:
   `T3`, `Tutorial 1`, `Tut 2`, `Tutorial03` for Tutorials; `Lab 04`, `Lab4`,
   `Practical Lab 03`, `Practical 2` for Labs. SPEC's fallback to a normalised
   stem is dropped. A numberless file (resources, scaffolding, datasets, class
   lists) would sit open all term and teach me to ignore the list.
2. **No separate "answers posted" message.** A close shows as one line,
   `✅ closes <module> Tutorial 3`, on the notification already being sent for
   the answer file. It is added at send time, like the OneDrive link (D-52).
3. **No PDF-text scanning.** Filenames only, for now.
4. **SPEC's seed words are cut to the safe ones.** Generic answer words in code:
   `answer(s)`, `solution(s)`, `soln(s)`. SPEC's `key`, `model`, `worked`, `sol`
   and `ans` are gone: "Data Model Tutorial" is not an answer file. Anything
   module-specific goes in `answer_patterns`, never the repository.
5. **Partial answers are the owner's ruling**: `followup_partial_answers` =
   `close` | `keep_open`, with **no default**. Until it is set, the stage does
   nothing at all.

**Matching.** Names are split into words exactly as routing splits them
(D-57), and matched as whole words: "transient" and "resolution" are not
answers. The pairing key is (context, category, number). The number is
normalised (`04` → `4`) and compared exactly, so Tutorial 1's answers can never
close Tutorial 11. Only one- or two-digit numbers after a designator count, so
years, dates, module codes and "Week 03" never do.

**Lifecycle.** One `followups` row per key, ever:
- answers present when the question is first tracked (earlier, or in the same
  run): recorded closed, `answered_on_arrival`, silently;
- the earliest later answer closes an open one (`answers`, announced as a line
  on its notification); further answer files do nothing;
- a revised question under a dated or week name has the same number, so no
  second follow-up;
- **one nudge**, 10 days after the question, never repeated (`nudged_at`, and a
  per-follow-up send key the queue itself refuses to enqueue twice);
- expired at term end, from Canvas's `term.end_at`, refreshed daily into
  `courses.term_end_at`;
- dismissed by hand: `npm run followups -- dismiss <id>`.

**The first run** builds all of this from what is already archived, silently,
and sends **one** summary ("Tracking 5: … awaiting answers"). A follow-up
already past 10 days shows its age there and is marked nudged, so it never gets
a nudge of its own. The summary has a fixed send key, so a retried first run
cannot send it twice. Everything goes through the existing queue (quiet hours,
batching). The mirror is untouched.

**`tune-patterns` on the real archive (read-only, 2026-09-23).** 85 files gave
8 candidate pairs:
- 5 real pairs, all explained by words already in code: one module's
  "- Suggested Solutions" (`solutions`, 3 pairs) and another's "-Answers"
  (`answers`, 2 pairs). "suggested" never appears without "solutions".
  **Nothing module-specific needs storing.**
- 3 noise pairs from the subset rule (a case-study file against two others
  sharing its one word; a slide deck against its PDF). None is an answer file.
- Missed by the report, but not by the classifier: a partial answer adds four
  words, over the report's three-word limit.

**Tests:** 22 classifier and planner tests (substrings, number forms, weeks and
years, 1 vs 11, partials, both rulings, the 10-day boundary, term end) and 7
through a whole sync. Nine mutation-check entries (43–51) cover: substring
matching, pairing by whole filename, first-digit-only numbers, numberless files
opening, a second nudge, a nudge during the first run, a first-run follow-up
left to be nudged later, an on-arrival pair announced as a close, and a partial
closing without a ruling.

**Found by the end-to-end test, and fixed:** the close line was first filtered
out for any follow-up the *first run* had opened. That is the main real case --
opened by the first run, answered weeks later. The rule is now carried by the
close reason, not the row: only `answers` closes are announced.

---

## D-62 — Lesson-day reminders replace the 10-day nudge; posted dates; per-module off · built 2026-09-24; not live

Owner rulings on the three questions D-61 left open:
- **Partial answers: `keep_open`.** A partial answer file does not close its
  follow-up; the rest of the answers must come. The owner sets
  `followup_partial_answers` at go-live, and can dismiss the follow-up if
  they never come.
- **Age runs from Canvas's posted date** (`items.posted_at`), not from when the
  monitor first saw the file. Detection only began in mid-September, so
  "first seen" understated every earlier file's age. From now on the two are
  the same within a sync interval.
- **Answer tracking can be switched off per module**
  (`courses.followups_tracking`, `npm run followups -- module off --module
  <code>`). One module never posts tutorial answers, so its tutorials must never
  open follow-ups.

**The 10-day nudge is gone.** Answers are released after the lesson, so a
fixed delay is wrong for every module: one module batched a month's answers at
once, another answered within days. The replacement:
- at **07:00 SGT on each day I have a lesson**, ONE message lists that day's
  modules' outstanding answers, all modules in one message, in lesson order;
- an item is included only if **at least one lesson for that module has
  happened since the question was posted**, so this week's worksheet is not
  overdue before this week's lesson;
- nothing on days without a lesson (another weekday, recess, a cancelled lab),
  and nothing when nothing qualifies;
- it **repeats every lesson day** until the item is answered or dismissed, by
  design. It is built from the follow-ups open *after* the run's closes, so an
  answered or dismissed item cannot appear;
- once a day: keyed by date in the queue, whatever the number of runs after
  07:00. Quiet hours end at 07:00, and the hourly overnight schedule has a
  07:00 run; a late run sends it later the same day;
- the first run sends only its summary (every open item's real age from its
  posted date). No reminder goes out on the morning follow-ups went live, if
  that was after 07:00.

**The timetable is personal data**: `lesson_slots` (weekly slot, SGT time,
first and last date, label) and `lesson_exceptions` (no lesson on a date, for
one module or for all). It is in the database only, entered with
`npm run timetable` (add, skip, remove, unskip, list, or `import` of a reviewed
draft for a first entry), and refused under CI. `followups preview --draft
<file> --reminder-date <date>` shows a draft's effect before any of it is
entered.

**Semester dates, verified 2026-09-24** from the NUS Registrar's AY2026/2027
calendar PDF (dated 30/07/2026), not assumed: instructional Week 1 starts Mon
10 Aug 2026; recess is 19–27 Sep; Week 7 starts Mon 28 Sep; **Week 13 is Mon 9
Nov – Fri 13 Nov 2026**; Reading Week runs 14–20 Nov. No Semester 1 public
holiday falls on a Thursday (the Well-Being Day is Fri 9 Oct; Deepavali is
observed Mon 9 Nov). The timetable must include the **pre-recess** lessons: a
timetable starting after recess would say no lesson had yet happened for
anything posted before it, and the first post-recess reminder would be empty.

Migration 0010 was reshaped before it was ever applied: the nudge column went,
and the two timetable tables and the per-module switch were added.

**Mutation-check:** the three nudge entries are replaced by eight: a reminder
before any lesson has passed since posting; a reminder on a day with no lesson,
both for the weekday and for recess or a cancelled lab; a reminder for a
dismissed or answered item; a second reminder the same day; a reminder the
morning follow-ups went live after 07:00; a tracking-off module still opening
follow-ups; and age taken from first seen instead of posted.

**leak-check closes a gap.** It matched real titles of 16+ characters only, so
short real file names (a bare `<word>.zip`) could pass unnoticed; some were quoted
in a brief and copied into tests before being caught by hand. Now every file
name under 16 characters from the database is also a pattern, matched only as a
whole file name (no letter, digit, `.`, `-` or `_` on either side). Generic
ones are listed in the gitignored `leak-check.allow`, because listing real
names in the repository would itself be the leak. Proven by planting one: it
was reported in the working tree and in the object store, then removed and
pruned. Short announcement and assignment titles ("Quiz 1") stay out of scope:
they are not file names, and they match everything.

---

## D-63 — A stale column in `followups list`, and the tests that now catch it · fixed 2026-09-24

After go-live, `npm run followups -- list` failed: `no such column:
f.nudged_at`. Reshaping migration 0010 for D-62 removed that column, and only
that one (checked by diffing 0010 as first built against 0010 as shipped). The
`list` query still selected it. No test ran the follow-up CLI against a
migrated schema, so nothing failed.

**Fixed.** `list` no longer selects it. No other code references the column:
`dismiss` never did, and neither does the lesson-day reminder path
(`loadOpenItems`, `loadTimetable`, the day-keyed enqueue). Both the new `list`
query and the reminder query were run read-only against production and
returned the four open follow-ups. `list` now labels the date "posted",
because since D-62 `opened_at` is Canvas's posted date. **No migration and no
production data change was needed.**

**A second bug the new test found:** `followups preview --reminder-date`
simulated only follow-ups the first run *would open*. Once live, those are
already in the database, so the preview would have reported no reminder for
any date. It now uses what is open in the database, plus what would newly
open, minus what would close or expire.

**The test (`test/unit/cli-followups.test.ts`)** runs, against a freshly
migrated database:
- every follow-up subcommand: `list`, `list --all`, `dismiss` (including a
  repeat and `--dry-run`), `module off` and `on`, `phrases add` and list, and
  `preview` from the database and from a draft, with a reminder date;
- `tune-patterns`;
- every timetable subcommand: `add`, `skip`, `list`, `remove`, `unskip`,
  `import`;
- the sync stage directly: a lesson-day reminder on Thursday 1 October at
  07:10 SGT, then term-end expiry.

A query naming a column the schema lacks now fails the build. Three
mutation-check entries put the removed column back into `list` (the live bug),
`dismiss`, and the reminder path's query; all three are caught.

---

## D-64 — Standing rule: every report ends with a security check · from 2026-09-24

Security is the owner's top priority for Phase 8 and for the rest of the
project. Every report ends with a short **Security check** covering:
- any new secret, token or credential: where it is stored and exactly what can
  read it;
- confirmation that nothing sensitive is hard-coded, committed, logged or
  printed;
- anything that widens what a leaked credential could reach;
- the leak-check result.

---

## D-65 — Phase 8, the dashboard: strictly read-only, on a separate read model · built 2026-09-24; not live

Option A, by the owner: the dashboard shows and changes nothing. **This
supersedes D-60's "reading the same Turso database"**, and settles the parked
dismiss button: there is none. Dismiss stays in the CLI.

### The separation (the owner's non-negotiable design, followed exactly)

1. **The dashboard never connects to the main database.** That database holds
   the Canvas, OneDrive and Telegram tokens. The dashboard is given no URL or
   token for it, and a test fails the build if its code names `TURSO_`,
   `config`, or any of those tokens.
2. **A separate Turso database, the read model**, holds only what the
   dashboard displays. Each sync publishes it at the end of the run
   (`src/readmodel/publish.ts`): a fixed set of SELECTs over an explicit
   column allowlist, then DELETE and INSERT of everything in **one atomic
   batch**, so the dashboard never sees half a publish. The publisher never
   reads `config`, bodies, summaries or error messages. A failed publish is a
   `dashboard_publish` warning alert; the dashboard keeps the last good copy.
   The read model **cannot hold a secret**, by schema, not by care:
   - its column list is exhaustive and tested; nothing is named like a secret;
   - `rm_meta` and `rm_health` accept only fixed names (CHECK), with values of
     at most 40 characters;
   - every URL column is CHECKed: `https://` only, and never `verifier=`,
     `tempauth`, `access_token`, `token=` or `@`. OneDrive links only as the
     plain `https://onedrive.live.com` webUrl form;
   - a sentinel test plants every secret the main database can hold, publishes,
     and sweeps every cell of the read model for them.
3. **Two tokens, both scoped to the read-model database only.**
   - The dashboard's is created with `turso db tokens create <db> --read-only`.
     Turso documents that read-only tokens exist and are database-scoped. It
     does not document how they are enforced, so this is **proved, not
     assumed**: `npm run readmodel -- verify` checks, against Turso itself,
     that the read token can read the read model, is **refused** a write
     (a no-op insert, so a wrongly accepted write would change nothing), and
     is **refused** by the main database; that the write token is refused by
     the main database; and that the main token is refused by the read model.
     It prints PASS/FAIL and error codes only. Nothing deploys unless all five
     pass.
   - The sync's write token is the GitHub Actions secret
     `READMODEL_WRITE_TOKEN`, with `READMODEL_DATABASE_URL`.
4. **No write statement anywhere in the dashboard.** Three layers:
   - Turso refuses writes on the read-only token (above);
   - `lib/db.ts` is the only file allowed to import `@libsql/client`, and runs
     every statement through `lib/sql-guard.ts`: a single `SELECT` or `WITH`,
     no `;`, and no write keyword outside string literals;
   - a static test fails the build on any write keyword in SQL, or on `batch`,
     `transaction`, `executeMultiple`, `migrate` or `sync`, anywhere in
     `dashboard/`.

**One caveat the owner should know.** Turso's free plan has one group, so
the read model sits in the same group as the main database.
`turso db tokens invalidate` rotates keys for the **whole group**: revoking a
leaked dashboard token also revokes the main token (then `.env` and the
GitHub secret need a fresh one). Tokens are still scoped per database, so this
couples *revocation*, not *reach*. The mitigation: the read-only token is
created with `--expiration 90d`, so a leak ages out without a group-wide
invalidation.

### Access

- **Password:** stored only as a scrypt hash (N=2^15, r=8, p=1) in
  `DASHBOARD_PASSWORD_HASH`, compared with `timingSafeEqual`. scrypt always
  runs, even for a malformed stored hash, so timing says nothing.
- **Brute force, with no writes anywhere** (a lockout counter would be a
  write):
  - the password is generated by `node scripts/hash-password.ts`: 24 characters
    from a 31-character alphabet, about 119 bits. `--own` accepts a chosen one
    of at least 20 characters;
  - every failed login takes at least 1 second, and scrypt makes each guess
    cost CPU;
  - a Vercel WAF rate-limit rule on `POST /api/login` (one rule is free on
    Hobby) caps each IP;
  - even with no rate limit at all, 1,000 guesses a second would take far
    longer than the age of the universe against 119 bits.
- **Session:** a cookie `__Host-cm_session`, HMAC-SHA256 signed with
  `DASHBOARD_SESSION_SECRET` (48 random bytes), verified in constant time by
  Web Crypto. HttpOnly, Secure, SameSite=Strict, Path=/, 12-hour expiry, and
  logout. It is bound to the password hash, so **changing the password signs
  out every device**; rotating the secret does too.
- **Every page and route requires the session**, checked twice: `proxy.ts`
  (Next 16's middleware) redirects pages to `/login` and answers API routes
  401 before anything renders, and every page and route calls
  `requireSession()` or `sessionForRoute()` again before reading. Reads need
  a `VerifiedSession` value, which only session verification produces. A
  static test fails the build if a page or route skips the check. `/login` and
  `/api/login` are the only public paths, and carry no data.
- **CSRF:** login and logout demand a same-origin `Origin` (and
  `Sec-Fetch-Site`, when sent). There are no Server Functions.

### Hosting

- Vercel, on the owner's personal account, project root `dashboard/`, region
  `hnd1` (near the Turso database).
- **Preview deployments cannot expose data**, by three independent layers:
  - `vercel.json` builds `main` only (`git.deploymentEnabled`);
  - every secret is scoped to Production only, so a preview has none;
  - the code serves **nothing** (404, not even the login form) unless
    `VERCEL_ENV` is `production`, or, off Vercel, `DASHBOARD_LOCAL=1`.
- **Headers on every response:**
  - `Cache-Control: no-store`;
  - `X-Robots-Tag: noindex, nofollow, noarchive`, and robots metadata;
  - a nonce CSP with `'strict-dynamic'`, `frame-ancestors 'none'`,
    `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`;
  - `X-Frame-Options: DENY`, `Referrer-Policy: same-origin` (D-66), COOP and CORP
    same-origin, `nosniff`, `Permissions-Policy` and HSTS;
  - no `X-Powered-By`.

  There are no third-party origins: system fonts, no Google Fonts.
- **Logs:** the dashboard has no `console` calls (tested). Module pages are
  `/m/<context id>`, an opaque number, so Vercel's request log names no module.
  Errors are reduced to generic messages.

### What it shows, and what it leaves out

- **Shows:**
  - deadlines, each with an add-to-calendar link built on the server (Google
    Calendar, SGT);
  - what is new since the last visit;
  - recent activity (21 days);
  - open follow-ups;
  - coverage;
  - system health;
  - a per-module view.
- **"New since my last visit"** is kept per device in `localStorage`. A visit
  ends after 30 minutes idle. Nothing is written to the server.
- **Minimised, and reversible if the owner wants more:**
  - no grade scores, no announcement or feedback text, titles only;
  - health carries counts, not alert text;
  - no controls that change anything, no search, no week-by-week layout, no
    mark-as-read.
- **Left out from the mockup:**
  - the Canvas token's expiry, because the publisher never reads `config`;
  - the local mirror and dead-man's-switch rows, which are not in the database.

### Tests and mutations

- `test/unit/readmodel.test.ts`: the schema allowlist, the CHECKs, the sentinel
  sweep, atomic replace, and no writes to the main database.
- `test/unit/dashboard.test.ts`: session, password, environment gate, headers,
  SQL guard, calendar link, the real proxy, the login route, `vercel.json`, and
  the static checks above.
- `npm run dashboard:smoke`: the real production build (`next build` then
  `next start`) on invented data, over HTTP. It checks:
  - no data before login;
  - the headers, the cookie attributes, and CSRF;
  - a nonce on every script;
  - no data in the server log;
  - a preview environment serving 404 everywhere.

  It caught one real bug: `sameOrigin` compared against the server's own idea
  of its URL rather than the `Host` header, which refused every legitimate
  login.
- **Mutation-check, 13 new entries, all caught:**
  - a page served without a session;
  - `/` made public in the proxy;
  - `config`'s Canvas token copied into the read model;
  - an INSERT in the dashboard;
  - a cacheable authenticated response;
  - previews allowed by the environment gate;
  - previews enabled in `vercel.json`;
  - the session signature check removed;
  - `HttpOnly` dropped;
  - the login CSRF check removed;
  - the SQL guard's write check removed;
  - the `tempauth` URL CHECK removed;
  - the password script printing its secrets under CI. It refuses when `CI`,
    `GITHUB_ACTIONS` or `VERCEL` is set, because Actions logs here are public.

---

## D-66 — Dashboard hardening before the preview · 2026-09-24

Owner's changes after step 2. The read model exists, and `verify` passed five
of five against Turso.

**1. `verify` accepts only an authorisation refusal.** Before, any error
counted as "refused", so a network blip or a server fault could have passed.
Now a refusal passes only if Turso answered **HTTP 401 or 403**. Anything
else fails and prints its code and status: a timeout, a DNS failure, a 5xx.
- **Evidence, from libsql-server's source (`error.rs`, `hrana/stmt.rs`):**
  - a token Turso rejects (`AuthError`) answers 401;
  - a write on a read-only token (`NotAuthorized`) is not turned into a
    statement error. It propagates and also answers 401, with a JSON body
    `{"error": ...}`;

    **Corrected by D-67: wrong for the real service.** That is the
    open-source server. Turso's hosted service answered the read-only write
    with `BLOCKED`, a statement error at HTTP 200, and this verify failed it.
    The 401 half holds: the three cross-database checks do answer HTTP 401.
  - `@libsql/client` reports that as `SERVER_ERROR` and keeps the status on
    the error's `cause`. That is what the owner saw.
- 403 is accepted too, for a proxy in front that answers "forbidden" rather
  than "unauthorised".
- `verify` prints the code and status only, e.g. `SERVER_ERROR HTTP 401`,
  never a message, token or URL.
- **Tests:** `test/unit/readmodel-verify.test.ts` runs `verify` against fake
  Turso servers. Every check passes on 401 and on 403. It fails on 500 and
  502, when a server is unreachable, when a read-only write is accepted, and
  when a token reaches the other database.

**2. The read-only token's expiry is alerted like the Canvas token's.**
- The new config key `dashboard_read_token_expires_at` holds the **date
  only**. The token is never stored in the main database.
- The sync raises the same ladder through the ops chat: T−14, T−7, T−3, T−1,
  then expired. Canvas's messages are unchanged: both now share one ladder.
- "Not recorded" is raised only when the read model is configured.
- `verify` has a **sixth check**: the recorded date must be no later than the
  token's own `exp` claim, which verify reads from the token, and less than
  a day earlier. Otherwise the alerts would come late, or cry wolf. It prints
  that date and nothing else from the token.
- The token was created 2026-09-24 at about 12:04 UTC for 90 days, so it
  expires about 2026-12-23 12:04 UTC.
- Rotation, including the group-wide invalidation caveat (D-65): README,
  "Rotating the dashboard's read-only token".

**3. Vercel Authentication: yes, and Hobby allows it on production.**
- Checked 2026-09-24 against Vercel's docs (pages updated 2026-09-15; changelog
  "Protect production deployments for free on every plan", 2026-09-09):
  - Vercel Authentication is included on Hobby;
  - so is the **All Deployments** scope, which "protects all URLs, including
    your production domain";
  - Standard Protection would leave the production domain open, so it is
    **not** the scope to pick.
- **Its bypasses, all to be left unused:**
  - Shareable Links;
  - Protection Bypass for Automation;
  - access requests, which a stranger can send and only the owner can
    approve. Never approve one.
- It sits in front of the app's own password. Signing up to Vercel **with
  GitHub** (the owner's choice) makes GitHub's two-factor the one identity
  guarding both. GitHub already guards the repository and the Actions secrets,
  including the main database token, so this adds no new identity to protect.

**4. No dependency install scripts on Vercel.**
- `vercel.json` sets `"installCommand": "npm ci --ignore-scripts"`, and
  `dashboard/.npmrc` sets `ignore-scripts=true`. That covers any npm install
  there, including one overridden in Vercel's UI. `npm run build` still runs,
  because explicitly run scripts are unaffected.
- **No locked dependency declares an install script** (none has
  `hasInstallScript` in the lockfile). A clean `npm ci --ignore-scripts`
  followed by `next build` succeeds. So no package needs its script.
- A test fails the build if a future dependency declares one, so that is
  decided then, not discovered.

**5. Sessions last 30 days** (was 12 hours), by the owner's choice.
- **Revoking access** means changing `DASHBOARD_SESSION_SECRET` in Vercel and
  **redeploying**: Vercel applies env changes to new deployments only.
- Every cookie is HMAC-signed with that secret, so every device is signed out
  at once. Nothing server-side needs clearing, because there is nothing
  server-side.
- Changing the password does the same, because sessions are bound to the
  password hash.
- **Proved** by a unit test (sessions from several devices, all refused under
  a new secret) and by the smoke test (the production build restarted with a
  new secret sends the old cookie to `/login`).

**6. A real bug, found only in a real browser: `Referrer-Policy: same-origin`.**
- The local preview's first browser login was refused as cross-site (403).
- The cause was D-65's `Referrer-Policy: no-referrer`. Under that policy the
  Fetch standard makes a browser send `Origin: null` on every POST, including
  a same-origin one, and the CSRF check correctly refuses `null`.
- The smoke test missed it because it posts from Node with an explicit
  `Origin`.
- **Fixed** with `same-origin`: same-origin POSTs carry the real Origin, and
  clicks out to Canvas, OneDrive or Google Calendar still send no referrer at
  all (their links also carry `rel="noreferrer"`). The CSRF check is
  unchanged, and still refuses `null`.
- A test and a mutation keep it that way, and the smoke test checks the
  header. The browser flow is now checked by hand in the preview; there is no
  headless browser in the test suite.

**7. Next rewrites environment variables named in a `.env` file.** Its loader
expands `$NAME` in every variable a `.env*` file names, **including the
value already in the real environment**. A scrypt hash is full of `$`.
- The preview script escapes every `$` in `dashboard/.env.local`.
- The smoke test refuses to run while such a file exists.
- On Vercel there is no `.env*` file: they are gitignored, and
  `dashboard/.vercelignore` keeps them out of a CLI deploy too (tested). The
  values set in Vercel's settings are therefore used as they are. The first
  production sign-in confirms it.

**Mutation-check, 6 new entries, all caught (78 in total):**
- the `no-referrer` policy back;
- verify counting any failure as a refusal;
- verify accepting a recorded expiry later than the token's;
- no expiry alert for the dashboard token;
- Vercel installing with scripts;
- `.npmrc` allowing scripts.

The mutation-check's scratch copy now also leaves out `dashboard/.env*` and
`.vercel`, so a local preview's real token is never copied.

---

## D-67 — `BLOCKED`, a control write, and the Safari preview · 2026-09-24

**1. Turso answers a read-only write with `BLOCKED`, not 401** (correcting
D-66). On the owner's run, verify printed five PASS and one FAIL: the
read-only token's write came back `BLOCKED`, a statement error at HTTP 200.
D-66 had predicted 401 from the open-source server, and the fake server had
modelled that 401, which is why the tests passed.

**Why `BLOCKED` cannot pass on its own.** In the open-source server,
`BLOCKED` comes from write or read blocks set on the *database*
(`block_writes`, `block_reads`, with an optional `block_reason`). That is
what a usage limit looks like. It applies to every token, so it proves
nothing about the read-only one.

**The control.** Immediately before the read-only probe, the **write** token
sends the **identical** statement to the **read model**:

    INSERT INTO rm_meta (name, value) VALUES ('schema_version', '1')
      ON CONFLICT (name) DO NOTHING

- The row exists, so it changes nothing, but the server still classes it as
  a write. So a block on the database refuses it as well.
- It uses the read-model URL and write token only. It never reaches the
  main database.
- **BLOCKED counts as read-only enforcement only if the control succeeded.**
  If the control fails, the check fails, and says the write token was refused
  too.
- A `BLOCKED` whose reason names a limit, quota, usage, plan, storage,
  upgrade or suspension fails whatever the control says. A reason that names
  the read-only permission is reported as such.
- The reason text is only classified, never printed: the output shows the
  code and status, and "reason names read-only" or "reason not stated".
- The real service's reason text for this refusal is not known yet. The
  owner's next verify run shows how it is classified.
- An HTTP 401 or 403 still passes on its own.

**Tests.** The fake Turso now answers a read-only write as the real service
did: HTTP 200, a `BLOCKED` statement error. The tests cover:
- `BLOCKED` with a passing control: pass;
- a database-wide block, where the control is refused too: fail, and says so;
- a usage-limit reason: fail;
- a reason naming read-only: pass, and says so;
- 401 and 403: pass.

**2. The preview failed in Safari: `upgrade-insecure-requests`, and the
`__Host-` cookie.** Confirmed in WebKit, not assumed.
- **Cause 1.** On a bare page, WebKit follows CSP `upgrade-insecure-requests`
  to `https://localhost` for a same-origin form POST. Chromium does not.
  Without the directive, both stay on http. That was Safari's "can't establish
  a secure connection".
- **Cause 2, found by the new browser test.** WebKit refuses **any**
  `__Host-` cookie from `http://localhost`, though it accepts a plain `Secure`
  one. Chromium accepts both. So even without the upgrade, Safari would have
  dropped the session cookie and bounced back to `/login`.

**The fix: the local preview only.** Production is unchanged.
- `Strict-Transport-Security` and `upgrade-insecure-requests` are sent **only**
  on the production deployment (`VERCEL_ENV=production`), which is always
  HTTPS. They are never sent on the local http preview, under `vercel dev`,
  or on a preview deployment's 404s.
- Before this, the preview did send HSTS over plain http. Browsers must ignore
  HSTS received over http (RFC 6797 §8.1), and it is now not sent at all.
- The local preview's cookie is `cm_session`, otherwise identical:
  HttpOnly, Secure, SameSite=Strict, Path=/. Production keeps
  `__Host-cm_session`. The prefix guards against a sibling subdomain setting
  the cookie, and localhost has none.
- **Tests:**
  - production sends every header, HSTS and upgrade included, through the
    real proxy, even with `DASHBOARD_LOCAL` set;
  - the local preview differs by exactly those two headers;
  - the production cookie name is `__Host-`, whatever else is set.
- **Nothing the preview sends can leave a browser upgrading localhost:**
  - no HSTS;
  - every response the proxy handles is `no-store`;
  - its redirects are 303s to `http://localhost` or relative paths;
  - Next's own trailing-slash 308s point to relative, same-origin paths.

  Safari's address-bar history can still suggest the https address it
  failed on. Typing `http://` once replaces it.

**3. The smoke test now runs real browser engines.** Playwright 1.63.0 is an
exact-pinned dev dependency, installed without scripts, with its WebKit and
Chromium builds. In **both** engines, at `http://localhost`, the smoke test
checks:
- redirect to login without a session, and no data;
- a wrong password refused;
- sign-in, and the data renders;
- the cookie is HttpOnly, Secure and Strict, and invisible to scripts;
- a module page opens, and logout works;
- every request stayed on `http://localhost`, with no HSTS, no console error
  and no CSP violation.

Reintroducing `upgrade-insecure-requests` on the local preview makes the
WebKit run fail, as it should (checked by hand). The smoke test now builds
and runs a throwaway copy of the dashboard, with no `.env*` file. So it runs
while the preview's secrets exist, and never touches the preview's build.

`npm run dashboard:preview` now **reuses** an existing preview password and
`.env.local`, so a rebuild does not change the password. `--new-password`
replaces them.

**Mutation-check, 7 new entries (85 in total), all caught:**
- verify accepting `BLOCKED` without the control;
- verify accepting a usage-limit `BLOCKED`;
- production without HSTS;
- production without `upgrade-insecure-requests`;
- the local preview sending `upgrade-insecure-requests`;
- HSTS sent off the production deployment;
- a production cookie without the `__Host-` prefix.

---

## D-68 — Verify requires Turso's read-only reason · 2026-09-24

The owner's verify run passed all six checks. The write check read
`refused (BLOCKED; reason names read-only)`, and the control passed. Turso's
reason for refusing the read-only token's write **does** name the read-only
permission.

So, at the owner's request, that is now **required**. `BLOCKED` passes only
when:
- the write token's identical no-op write to the read model succeeded just
  before (the control, D-67); **and**
- the reason names the read-only permission.

A reason that names nothing, or names something else, fails, as does one that
names a usage limit. The reason is classified, never printed: the output
shows the code and status only. An HTTP 401 or 403 still passes on its own.

The fake Turso's read-only refusal now carries a reason naming the permission,
in its own wording, since Turso's exact text is never printed. The tests cover
a reason naming the permission (pass), no reason at all (fail), a different
reason (fail), and a usage limit (fail), each with a passing control.

**One new mutation-check entry (86 in total):** accepting a `BLOCKED` whose
reason does not name the read-only permission.

---

## D-69 — The password script's `--clipboard` mode · 2026-09-24

For the Vercel setup, the owner asked that secrets be entered "without
appearing on screen where avoidable".
`node dashboard/scripts/hash-password.ts --clipboard` generates:
- the password, unless `--own` is given;
- its hash;
- a session secret.

It puts each on the clipboard in turn (`pbcopy`). The owner pastes it where
it goes and presses Enter for the next. **None is printed.** The clipboard
is cleared at the end, and on Ctrl-C. It is still refused under CI or on
Vercel.

Trade-off, stated plainly: while a value is on the clipboard, any app that
reads the clipboard can see it. So can Universal Clipboard, which reaches the
owner's own nearby Apple devices when Handoff is on. That is for seconds, and
it is cleared afterwards. The default mode, which prints, remains.

A test runs it against a fake `pbcopy` and checks:
- three values were copied: a password, its hash (verified), and a 64-character
  secret;
- none of them appears in the output;
- the clipboard was cleared.

**Two mutation-check entries (88 in total):** printing a value in clipboard
mode, and not clearing the clipboard.

---

## D-70 — The dashboard is deployed with the Vercel CLI; Vercel gets no GitHub access · approved 2026-09-24

**Decision (the owner's):** the dashboard is deployed from the owner's Mac with
the Vercel CLI, **not** by importing the repository into Vercel. The Vercel
GitHub app is never installed. This replaces the repository import planned in
D-65 and the owner's step-4 brief.

**Why.**
- **The app's permissions reach too far.** Vercel's GitHub app asks for write
  access to a repository's code, workflows and administration (Vercel
  changelog, 17 March 2026, which added the workflows permission).
- **This repository's sync workflow runs its code with the main database
  token**, which reaches the Canvas, OneDrive and Telegram tokens. Anyone
  controlling Vercel's GitHub access could change that code, or add a
  workflow, and read it.
- **No repository rule could contain it.** Administration access can change
  branch rules. And secrets reach workflows on any branch pushed to the
  repository.
- **The CLI route avoids all of it.** Vercel then holds only what the
  dashboard itself needs.

**How:**
- **CLI version:** `vercel@59.19.1`, pinned and at least a week old, run with
  `npm_config_ignore_scripts=true` and `VERCEL_TELEMETRY_DISABLED=1`.
- **Project setup:** `vercel link`, then `vercel deploy --prod`, both from
  `dashboard/`. So the project root is `dashboard/`, and `vercel.json`'s
  `npm ci --ignore-scripts` applies. When `link` offers to connect a Git
  repository, the answer is No. `.vercelignore` keeps `.env*`, `.next`,
  `node_modules` and `.vercel` out of the upload.
- **Only committed code is deployed:** `git status` must be clean first.
- **No automatic previews:** with no Git connection, pushes build nothing.
  A preview exists only if someone runs `vercel deploy` without `--prod`. It
  would get no secrets (all four are Production-only), and the code serves it
  404 anyway (D-65).
- **The CLI's token exists only between `vercel login` and `vercel logout`.**
  Logging out revokes it. While it exists, it can control the Vercel project,
  including deploying code that could read the read-only token, which reaches
  only the sanitised read model. It cannot read Sensitive values back, and it
  has no GitHub or main-database access.
- **Environment variables** go in with
  `vercel env add NAME production --sensitive`, their values piped from
  `.env` or from the clipboard (D-69). None appears on screen.
- **Deployment Protection:** Vercel Authentication, scope All Deployments
  (D-66). Protection Bypass for Automation, Shareable Links and the OPTIONS
  Allowlist are left unused.
- **Rate limit:** one WAF rule, fixed window, 5 POSTs to `/api/login` per IP
  per 60 s.

**Cost, accepted:** redeploying is manual: log in, deploy, log out (README,
"Redeploying the dashboard"). The dashboard changes rarely.

`vercel.json` keeps `git.deploymentEnabled` (main only) as a guard, in case a
Git connection is ever added by mistake.

---

## D-71 — Phase 8 is live: as built, what the Vercel CLI did on its own, and the fixes · 2026-09-25

**Live, as the owner set it up (2026-09-24/25):**
- **Deployment:** Vercel CLI `59.19.1`, deployed from `dashboard/`. The
  project's name, and so its address, is kept out of this public repository. The build log shows `npm ci --ignore-scripts`. No Git
  repository is connected, and no Vercel GitHub app is installed (D-70). Older
  deployments are deleted; only the current production one remains.
- **Deployment Protection:** Vercel Authentication, scope All Deployments.
  Protection Bypass for Automation, Shareable Links and the OPTIONS Allowlist
  are all off.
- **Variables:** four, each Production-only and Sensitive. Sign-in works with
  the password from the owner's password manager.
- **Rate limit:** one WAF rule. Fixed window, 60 s, 5 requests per IP, 429,
  on Request Path equals `/api/login`, **for all methods**. The owner left out
  the POST condition. That is at least as strict, since `GET /api/login` is
  405 anyway. The sixth wrong attempt was refused.
- **Live checks:** 14 of 15 passed. The one failure was the check's fault, not
  the site's: it required Cache-Control to *start* with `no-store`, and
  production sends `private, no-cache, no-store, max-age=0, must-revalidate`
  (fixed below). The rest:
  - the cookie is `__Host-cm_session`: Secure, HttpOnly, SameSite Strict,
    Path `/`, 30 days;
  - a preview deployment served "Not found" on `/`, `/login` and `/m/1`;
  - Safari on the owner's phone works end to end.
- **The CLI is logged out.**
- **The Vercel account signs in with email plus Vercel's own two-factor**, not
  with GitHub as planned. So there are two identities, each with its own
  two-factor. The email inbox is now part of the Vercel account's recovery
  path. GitHub no longer guards Vercel, and Vercel still has no reach into
  GitHub.

**1. `vercel link` downloaded a Vercel OIDC token and wrote a `.gitignore`.**
- **What happened:**
  - After `link`, the CLI asks "Pull development environment variables into
    .env.local?", defaulting to yes.
  - Every variable of ours is Production-only, so the only Development value
    was Vercel's own `VERCEL_OIDC_TOKEN`. It went into `dashboard/.env.local`,
    and the CLI created `dashboard/.gitignore` to ignore it.
  - The owner deleted both. The token was never deployed: the CLI's own upload
    rules and our `.vercelignore` both exclude `.env*`.
- **What it grants:**
  - It is a development OIDC token: a signed JWT naming the account, the
    project, the environment and the user. Per Vercel's docs it expires
    after 12 hours, so it has expired.
  - It is worth something only to a service configured to trust it. Nothing
    in this system is: no cloud account, no Blob store, no KMS.
  - Vercel's AI Gateway does accept these tokens, so for its 12 hours it could
    have spent any AI Gateway allowance on the account.
  - It cannot reach the dashboard, the read model, the main database or
    GitHub.
- **Prevention:**
  - OIDC federation cannot be switched off per project; Vercel offers only an
    issuer-mode choice.
  - So the README's redeploy steps never run `link` again: `dashboard/.vercel/`
    already holds the link, IDs only. If a re-link is ever needed, the answer
    to the pull prompt is No.
  - After each redeploy, the steps check that no `.env*` file exists in
    `dashboard/` and that `git status` is clean.
  - A committed `dashboard/.gitignore` already lists `.vercel` and `.env*`, so
    the CLI finds nothing to add (tested).

**2. The CLI tried to install a Claude Code plugin.** Read from the CLI's own
code (`59.19.1`, in the npx cache), and from the files it keeps, read-only:
- **What it tries:** after some commands, including `env add`, it runs
  `claude plugins install vercel@claude-plugins-official`, spawning the
  Claude Code CLI. That would add Vercel's plugin (skills, and possibly hooks
  or MCP servers) to Claude Code, which works in this repository. It also
  fetches a version file from `raw.githubusercontent.com/vercel/vercel-plugin`.
- **How it decides Claude Code is here:**
  - an agent's environment variable (`CLAUDECODE`, `CLAUDE_CODE`, …); or
  - a `~/.claude/projects/<this directory>` folder, which exists because this
    repository has been worked on with Claude Code.
- **Why it did not ask:**
  - It prompts only on an interactive terminal, and piped `env add` input is
    not one.
  - But its preferences file
    (`~/Library/Application Support/com.vercel.cli/agent-preferences.json`)
    said `"pluginAutoUpdate": true`. That was set when a prompt was accepted on
    2026-08-24, in an earlier Vercel CLI session, and it means "install without
    asking".
- **What happened:** it tried at 2026-09-24T16:27Z and **failed**, because
  there is no `claude` command on this Mac's PATH.
- **Nothing was installed:**
  - `~/.claude/plugins/` is unchanged since 2026-08-30. It has no
    `installed_plugins.json`, and its only marketplace is the official one,
    added 2026-08-17.
  - `~/.claude/settings.json` (unchanged since 2026-09-10) and `~/.claude.json`
    contain no mention of Vercel, no enabled plugins and no MCP servers.
  - Everything in `~/.claude` changed since the deploy is Claude Code's own:
    session files, backups, file history, caches, telemetry.
  - The Vercel CLI config folder holds no `auth.json` (logged out).
- **How to stop it:** the only switch it honours is its preferences file,
  with `pluginDeclined: true` and `pluginAutoUpdate: false`. There is no
  environment variable. The README gives a one-time command that sets both,
  keeping the other fields, plus a check.

**3. The password script: only the password touches the clipboard.** D-69's
`--clipboard` flow had a trap: copying the next command replaced the secret on
the clipboard. It is replaced by `--vercel`:
- **Checks first:** dashboard/ must be linked and the CLI logged in, before a
  password exists. So a failure never strands a saved password.
- **The password** goes on the clipboard for the password manager. After Enter
  the clipboard is cleared, and nothing goes to Vercel before that.
- **The hash and a fresh session secret** go straight into
  `vercel env add NAME production --sensitive --force`, on its **stdin**:
  - never on the clipboard, never printed;
  - never in argv, which `ps` shows;
  - run in `dashboard/` with `npm_config_ignore_scripts=true`.
- **`--session-only`** sets a new session secret alone. That is the revocation
  path.
- **If Vercel refuses a value,** the script stops and says so, without
  printing the value.
- The Vercel CLI version is a constant in the script, and a test keeps the
  README's pin equal to it.
- **Tests** run a copy of the script against a fake `npx` and a fake `pbcopy`.
  They check:
  - only the password, then an empty value, reached the clipboard;
  - the hash (verified against the password) and the secret arrived on
    stdin;
  - none of the three appears in argv or in the script's output;
  - the flags are `--sensitive --force`, the working directory is
    `dashboard/`, and install scripts are off;
  - it refuses when not linked or not logged in, sends nothing if input ends
    early, and stops on a refusal.

**4. Cache-Control is what production sends, exactly.**
- Next.js sends `private, no-cache, no-store, max-age=0, must-revalidate` for
  a dynamic page, and that is what the live site sent. The proxy now sets the
  same value on every response, as do the login and logout routes, so there
  is one value to test.
- The unit tests assert it exactly. The smoke test asserts it on pages,
  redirects, 401s and both login outcomes, on the real production build.
- The README's live check now accepts `no-store` anywhere in the header, and
  still fails on `public`.

**5. Add-to-calendar on iPhone: proposed, not built.** Tapping it opens the
Google Calendar app, which drops the event's details. See the owner's
decision, to be recorded when made.

**Mutation-check:**
- D-69's two clipboard entries are replaced by six:
  - the hash put on the clipboard;
  - a secret passed in argv;
  - a variable added without `--sensitive`;
  - install scripts allowed;
  - no login check before making a password;
  - the password left on the clipboard.
- 92 in total, all caught. The scratch copy now includes `README.md`, for the
  pin test.

**The README** now has "Where every secret lives" (the table as live),
"Checking the live site", and revised redeploy, revocation and rotation steps.

---

## D-72 — A switched project group; messages never cite decision numbers; the calendar button stays · 2026-09-25

**Add-to-calendar: kept as it is (the owner's decision).** It works on the
laptop, where events are usually added. On the iPhone the Google Calendar app
drops the event details, and the owner confirmed the same with a
`www.google.com/calendar/render` link. So there is no phone fix to build.
Deadlines also reach Google Calendar through the owner's subscription to the
Canvas calendar feed.

**The Vercel CLI plugin preference is set** (D-71): the owner ran the command,
and the file shows `"pluginDeclined": true` and `"pluginAutoUpdate": false`.

**A module's project group was switched.** At 10:02 SGT on 2026-09-25 the ops
chat reported the group's files unreadable. Checked read-only against the real
Canvas API and database. Only statuses, times and yes/no answers were printed;
no names or ids, and none are recorded here.
- **The old group now refuses the token.** Canvas answers `403` for the group,
  its files and its folders, with a not-authorised reason. That fits the owner
  having been moved out of it.
  - The last sync to read its files started at 09:44 SGT and finished `ok`.
  - The next, at 10:02 SGT, got the 403, raised the alert, and finished
    `partial`.
- **Nothing was lost:** the old group never had a file.
- **The new group:** the owner's groups in that module's parent course now
  number exactly one, and it is not the old one. It is readable (files `200`),
  has no files yet, and is not in the database. Its name contains "41" but is
  not literally "Group 41"; the owner is to confirm it in Canvas.

**Retiring a context closes its alerts quietly.**
- **The problem:** a disabled context is never evaluated again, so its
  `coverage:N` alert would have stayed active for ever, counted on the
  dashboard's health line. (`context_stale:N` would have been "Resolved",
  which is untrue.)
- **The fix:** before reconciling, the sync closes, without a message, every
  per-context alert whose context is not enabled. "Resolved" would claim a fix;
  the context was retired.

**`npm run seed-groups`: the usual path, confined to groups.**
- A fresh `discover --out var/seed-new.json` is compared with the reviewed
  `courses.seed.json`:
  - a new group is added, following its parent course **as reviewed** (module
    code, enabled), not the fresh proposal;
  - an enabled group no longer listed is disabled ("no longer a member"),
    never deleted;
  - nothing else is touched.
- It shows the plan, and writes with `--write` after a backup under `var/`.
  The result is checked with the seed loader's own validation first.
- It prints module codes and actions only. It is local-files only: no Canvas,
  no database.
- `seed-courses` then loads it as always.
- README: "A group changed".

**What the first sync of the new group does:**
- Its files, none today, are baselined: recorded as seen, not announced one
  by one (D-41).
- One "Now watching" message names it.
- Baselined files are still archived to OneDrive, silently. Any run archiving
  ten or more sends one summary.
- New files after that are announced and archived as usual.
- Group files route to `Group`, so they open no follow-ups.
- On the dashboard, the module list is the enabled contexts, so the new group
  replaces the old.

**The group alert's wording.** It used to say "Neither the Files tab nor
Modules can be read… If the course has concluded… (D-36)". For a group that
was wrong on three counts:
- groups have no Modules fallback;
- it was a group, not a concluded course;
- it cited a decision number.

A group now says its files can no longer be read, that this usually means the
owner has left it or been moved, that archived files are safe, and to run
discovery (README, "A group changed").

**The owner's rule: messages never cite decision numbers.** They are for
acting on, not for cross-referencing this repository. Three layers:
- **The source strings:** every alert text that could reach Telegram was
  rewritten: coverage, the OneDrive app registration, provisioning, storage,
  and the unverified-announcements detail.
- **A static test:** the build fails if a string in any runtime module
  contains a decision number. CLI help, discovery reports and config
  descriptions are exempt, because they only appear in the owner's terminal.
- **A render-time backstop:** ops alerts and notices, which are our own words,
  have any decision reference stripped. Canvas's own words in content messages
  are never altered, and a test checks that.

**Mutation-check, 6 new entries (98 in total), all caught:**
- a group described as a concluded course;
- a retired context's alert left active;
- a decision number rendered in an ops message;
- a decision number back in an alert text;
- seed-groups filing a new group under the fresh proposal;
- seed-groups leaving a left group enabled.
