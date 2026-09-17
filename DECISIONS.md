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

**Open question.** Every in-band signal can fire only once a run happens again.
While runs are stopped, only the dead-man's switch (D-44) can speak. A healthy
check with period 1 h and grace 2 h should have alerted about three hours into
this gap, around 15:00 SGT on Sunday. Whether it did determines whether that
switch is configured correctly.


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
