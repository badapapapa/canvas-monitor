# canvas-monitor

Polls NUS Canvas, archives new files to personal OneDrive, and sends a single
batched Telegram notification about what appeared, where it went, and whether it
needs follow-up.

**This is a personal tool for one person, published publicly only so that
GitHub Actions minutes stay free.** It is not a product, not deployable as-is,
and there is no hosted instance. It is hardcoded to one Canvas instance
(`canvas.nus.edu.sg`), assumes a single user with no authentication layer, and
requires you to supply your own Canvas token, Turso database, Microsoft Graph
app registration and Telegram bot before it does anything at all. Nobody's
credentials or coursework are in this repository. You are welcome to read it or
fork it, but running it against your own institution means doing the whole setup
yourself, and I do not support that use.

Single user. No accounts, no sharing, no dashboard before Phase 8.

- [`SPEC.md`](SPEC.md) — canonical specification. If anything disagrees with it,
  it is wrong.
- [`DECISIONS.md`](DECISIONS.md) — every deviation from the original draft, with
  reasoning.

**Current phase: 4 — the OneDrive archive, built, not yet live.** Phases 2–3
(announcements, assignments, grades, feedback, file detection) are live. Phase 4
downloads each new file into my personal OneDrive, under
`<term>/<module>/<category>/`, and adds "→ Labs · OneDrive" to its
notification once the upload is verified. It never touches anything outside its
own root folder: every request goes through an allowlist guard, and a test
checks the wire (DECISIONS.md D-50). It is off until `archive_enabled` is set.

**Deploying a phase that adds a migration: run `npm run migrate` first, then
push.** `sync` refuses to run against a schema behind its code, so pushing first
fails every scheduled run until the migration is applied. Migrations are
atomic: all or nothing.

---

## The single writer rule

**Only the poller writes to the OneDrive synced folder.**

Editing, renaming, or moving a file inside the archive root (`Apps/Canvas Archive/`
by default) on a machine where OneDrive
is syncing produces conflict copies (`Week 6 Slides-DESKTOP-ABC.pdf`) and breaks
the assumption that a `files` row marked `complete` describes what is actually on
disk. Read from the folder freely. Write to it from nowhere but this program.

If a file needs to be deleted, delete it and let weekly reconciliation mark it
`deleted_by_user` — it will not be re-downloaded.

---

## Setup

Requires **Node 22.18+** (24 LTS or newer preferred). There is no build step;
Node runs the TypeScript sources directly.

```bash
npm install
cp .env.example .env      # then edit
npm run hooks:install     # blocks committing captures or a database file
```

`.env` holds bootstrap secrets only — the database URL and its auth token.
Everything else lives in the `config` table so it can be rotated without a
redeploy.

For local development, a file-backed database needs no token:

```bash
TURSO_DATABASE_URL=file:./data/canvas-monitor.db
```

Then create the schema and set the Canvas token:

```bash
npm run migrate
```

Generate a token at **Canvas → Account → Settings → New Access Token**. NUS caps
these at 90 days. Record the expiry it shows you — without it the expiry alerts
cannot fire.

```bash
npm run set-config canvas_token
```

The value is read from **stdin**, never from the command line: an argument would
land in shell history and in `ps` output. Paste it, then press Ctrl-D.

```bash
npm run set-config canvas_token_expires_at
npm run probe
```

`probe` validates the token and lists active courses. That is the Phase 0
deliverable.

---

## Commands

| Command | What it does |
|---|---|
| `npm run migrate` | Apply pending schema migrations. |
| `npm run probe` | Validate the Canvas token and list active courses. |
| `npm run set-config <key>` | Set a config value, read from stdin. |
| `npm run config-list` | Show config keys and whether they are set (secrets masked). |
| `npm run prune-raw` | Delete raw captures past their retention window. |
| `npm run discover` | Probe coverage and write `courses.seed.json` for review. Refuses to overwrite without `--overwrite`. |
| `npm run seed-courses` | Load the reviewed seed file. Idempotent; rejects an enabled course with no module code. |
| `npm run telegram-test` | Send one test message to each Telegram chat. |
| `npm run sync` | One polling run. `-- --dry-run` previews the messages it would send, and makes no OneDrive request. |
| `npm run graph-login` | Sign in to OneDrive (device code). `-- --scope full` for the contingency scope (D-51). |
| `npm run backfill-course -- <canvas_course_id>` | Archive one course's files once, including a disabled prior-term course (D-36). |
| `npm run check` | Typecheck and run the test suite. |

Every command accepts `--dry-run`: all reads happen, every intended write is
logged, nothing is mutated. This is a type-level seam, not a convention — all
mutations pass through a single writer interface, and dry-run swaps in one that
logs and executes nothing.

`--json` gives machine-readable output on stdout. Logs always go to stderr, one
JSON object per line, so the two never mix.

```bash
npm run probe -- --dry-run --json
```

---

## Verifying, rather than trusting

Three commands, each safe to run at any time. They are how to check a claim
instead of taking it on trust (DECISIONS.md D-48).

| Command | Clean result |
|---|---|
| `npm run check` | exit 0 · typecheck silent · `ℹ fail 0` |
| `npm run mutation-check` | exit 0 · "all N reintroduced bugs caught" |
| `npm run leak-check` | exit 0 · "CLEAN", with a positive control above 0 |

`mutation-check` works in a throwaway copy and never touches the working tree.
`leak-check` is local only: it derives its patterns from the gitignored seed
file and the database, so it cannot run in CI and must never be made to.

In zsh, `$?` after a pipe is the *last* command's status. Check an exit code
without piping, e.g. `npm run check > /dev/null; echo $?`.

## Going live (Phase 2)

In this order — each step is safe to stop after.

1. **Telegram config**, each read from stdin:
   `npm run set-config telegram_bot_token`, then `telegram_content_chat_id`,
   then `telegram_ops_chat_id` (the group; its id is negative).
2. **`npm run migrate`** — adds the Phase 2 tables. Additive only.
3. **`npm run telegram-test`** — one message lands in each chat.
4. **`npm run sync -- --dry-run`** — reads real Canvas, writes and sends nothing,
   prints what it would send. On the first run that is one "Now watching"
   summary: everything already posted is recorded as seen, not notified
   (`silent_sync`, DECISIONS.md D-41).
5. **`npm run sync`** — the real first run. Expect exactly one message.
6. **Publish and schedule.** Create the public GitHub repository, enable secret
   scanning with push protection, add `TURSO_DATABASE_URL` and
   `TURSO_AUTH_TOKEN` as Actions secrets, and push. The `sync` workflow then
   runs 54 times a day.
7. *(Recommended)* **Dead-man's switch.** Create a healthchecks.io check —
   period 1 hour, grace 2 hours — and `npm run set-config healthcheck_url`. It is
   the only thing that notices if runs stop altogether (DECISIONS.md D-44).

## Going live (Phase 4)

1. **Register the app** (once; DECISIONS.md D-51 for the scope choice). In the
   Microsoft Entra admin center, *App registrations → New registration*: name it
   **`Canvas Archive`** (this names the `Apps/` folder, and renaming later does
   not rename the folder), supported account types **Personal Microsoft
   accounts only**, no redirect URI. Then *Authentication → Advanced settings →
   Allow public client flows: Yes*. Copy the **Application (client) ID**.
2. `npm run set-config graph_client_id` — paste the ID.
3. **`npm run migrate`** — adds the `files` table. Then push.
4. **`npm run graph-login`** — sign in with the *personal* account. It checks the
   drive is personal and prints the quota, or says it is not readable.
   If it reports "read-only" or "pending provisioning", that is the 2026
   AppFolder regression; the workaround is printed (D-51).
5. **`npm run sync -- --dry-run`**, then
   `npm run set-config archive_enabled` → `true`. The next scheduled run archives
   what is already on Canvas, a batch at a time, and sends one "Saved to
   OneDrive" summary.
6. *(D-36)* `npm run backfill-course -- <canvas_course_id>` for the prior-term course.

Revoke the app at any time at account.live.com/consent/Manage.

**Keep the directory alive.** The app registration lives in the Entra directory
created with your Azure subscription. A directory with no billing activity for
about 200 days can be blocked and then deleted (DECISIONS.md D-53). When Azure
for Students ends, accept the pay-as-you-go offer rather than letting it lapse.
If it happens anyway, the `graph_app` alert says so.

## Answer-sheet follow-ups (Phase 6)

When a numbered tutorial or lab lands without its answers, it is tracked; when
the answers arrive, their notification says `✅ closes <module> Tutorial 3`.
On each lesson day at 07:00 SGT, one message lists what a lesson has already
passed without answers. Everything still open closes at term end
(DECISIONS.md D-61, D-62).

| Command | What it does |
|---|---|
| `npm run tune-patterns` | Read-only: the words that mark answer files, ranked, with their pairs. |
| `npm run followups -- preview` | Read-only: what would open, close, and be ignored. |
| `npm run followups -- list [--all]` | Open follow-ups. |
| `npm run followups -- dismiss <id>` | Close one by hand (answers only given in class). |
| `npm run followups -- module off --module <code>` | Never track answers for that module. |
| `npm run timetable -- list` | My lessons (personal: database only). `add`, `skip`, `remove`, `unskip`, `import`. |
| `npm run followups -- preview --draft <file> --reminder-date <date>` | Read-only: a draft timetable's effect, and one morning's reminder. |

## The local mirror (optional, Mac only)

Copies files archived **from now on** into your own module folders, under
`Downloaded from Canvas/` (DECISIONS.md D-58). One-way; never deletes or
overwrites; writes nowhere else.

1. `cp mirror.config.example.json mirror.config.json` and fill in the mapping
   (gitignored: it names real folders).
2. `npm run mirror -- --dry-run`: previews the baseline.
3. `npm run mirror -- --baseline`: records everything currently archived as
   seen. Copies nothing.
4. `npm run mirror -- --dry-run` again, any time, shows what the next run would do.
5. `node scripts/mirror-runtime.ts` makes the mirror its own copy of node in
   `var/runtime/bin/node`, so the macOS file grant belongs to that binary alone
   and survives `brew upgrade node` (D-59).
6. `node scripts/mirror-schedule.ts` prints the LaunchAgent; `--install` loads
   it (every 20 minutes, and at login).
7. **Permission:** the first scheduled run asks for OneDrive access. Allow it.
   If no prompt appears and the log shows `EPERM`, open System Settings →
   Privacy & Security → **Files and Folders**, find that node binary and tick
   **OneDrive**. Full Disk Access is not needed. After a brew upgrade breaks
   the copy, run `node scripts/mirror-runtime.ts --refresh`.

## The dashboard (Phase 8)

A strictly read-only web view, in `dashboard/` (Next.js, on Vercel). It shows:
- deadlines, with add-to-calendar links;
- what is new since your last visit on that device;
- recent activity and open follow-ups;
- coverage and system health, overall and per module.

It changes nothing (DECISIONS.md D-65).

**It never touches the main database.** Each sync publishes a sanitised copy
of what the dashboard shows into a **separate** Turso database, the read
model. The dashboard holds a read-only token for that database alone.
- The read model's schema cannot hold a token, a config value, a body or a
  credential-bearing URL (CHECK constraints, tested).
- Turso itself refuses the dashboard's token any write, and refuses it the
  main database. `npm run readmodel -- verify` proves both.

| Command | What it does |
|---|---|
| `npm run readmodel -- migrate` | Create the read model's tables (write token). |
| `npm run readmodel -- verify` | Prove the token separation against Turso, and the recorded expiry. All six checks must pass before deploying. |
| `npm run readmodel -- publish` | Publish once now (the sync does it every run). |
| `node dashboard/scripts/hash-password.ts` | Generate the dashboard password, its hash and the session secret. |
| `npm run dashboard:smoke` | Build the dashboard and check it over HTTP on invented data. |

Secrets live only in `.env` (gitignored, for local runs), GitHub Actions
secrets (the sync's write token) and Vercel's Production environment (the
dashboard's read token, password hash and session secret). A preview
deployment is never built, is given no secrets, and would serve nothing if it
were.

### Revoking access

Change `DASHBOARD_SESSION_SECRET` in Vercel (Production), then **redeploy**:
Vercel applies env changes to new deployments only. Every session on every
device ends at once. Sessions otherwise last 30 days. Changing the password
hash does the same.

### Rotating the dashboard's read-only token

It expires 90 days after creation. The ops chat warns at 14, 7, 3 and 1 days
(`dashboard_read_token_expires_at`: the date only, never the token).

**Routine rotation.** Creating a new token does not revoke the old one, which
simply expires. From the repo root:

1. Remove the old line, then add the new token, without printing it:
   ```
   sed -i '' '/^READMODEL_READ_TOKEN=/d' .env
   printf 'READMODEL_READ_TOKEN=%s\n' "$(turso db tokens create canvas-readmodel --read-only --expiration 90d)" >> .env
   ```
2. `npm run readmodel -- verify`. Check 6 fails and prints the new token's
   expiry. Record it: `npm run set-config dashboard_read_token_expires_at`
   (paste the date, then Ctrl-D). Run verify again: six PASS.
3. Vercel → Settings → Environment Variables: replace `READMODEL_READ_TOKEN`
   (Production only, Sensitive), then redeploy.

**If a token has leaked.** `turso db tokens invalidate canvas-readmodel`
revokes it. But on the free plan both databases share one group, and
invalidation is **group-wide**. It also revokes the main database token and
the read model's write token. Sync runs fail until all three are replaced:
1. main: `turso db tokens create <main database>` → `TURSO_AUTH_TOKEN` in
   `.env` and in the GitHub secret;
2. write: `turso db tokens create canvas-readmodel` → `READMODEL_WRITE_TOKEN`
   in `.env` and in the GitHub secret;
3. read: as in routine rotation above, including Vercel and the recorded
   expiry;
4. `npm run readmodel -- verify`: six PASS.

## Privacy posture

This repository is public, which makes its GitHub Actions logs public with it.
Everything below follows from that.

### Logs: redacted by default

`src/core/redact.ts` is a single hook shared by the logger and the capture
store. It removes three tiers, all on by default at every log level:

| Tier | Becomes | Examples |
|---|---|---|
| Personal data | `[redacted]` | emails, login ids, matriculation numbers, other people's names |
| Identity | `[name]` | course names, module codes, file names, folder names, titles |
| Bodies | `[body:Nc]` | announcement and page text |

**Numeric ids are deliberately kept.** `context_id`, `canvas_course_id` and
`canvas_file_id` mean nothing to a reader without a token, but they are what
makes a redacted line actionable — `context 3 stale for 26 hours` is something
I can act on, `[name] stale for 26 hours` is not.

The only way to switch redaction off is `--unsafe-log`, for local debugging.
**The CLI refuses it whenever `CI` or `GITHUB_ACTIONS` is set**, and there is
deliberately no environment variable that enables it, because an env var is
precisely the thing a workflow file can set.

Identifying **stdout** is suppressed under CI too, for the same reason: Actions
captures stdout into the same public log, so a command that prints course names
publishes them just as surely as one that logs them.

### Raw captures: local only, richer, expiring

Every Canvas response is written to `var/raw/<day>/<run-id>/` so Phase 5's
`--replay` has history. Capture cannot be done retroactively, which is why it
starts now.

Captures keep bodies and identity where logs drop both — `--replay` tunes
routing rules that match on exactly those file and folder names. The tiers
differ because the threat differs: captures are gitignored, pre-commit-blocked,
never leave the machine, and expire in 60 days. Third-party personal data is
dropped at both tiers, unconditionally. Endpoints with no replay value
(`/users/self`) are not captured at all.

- `var/` is gitignored **and** blocked by `.githooks/pre-commit`;
- captures expire after 60 days (`npm run prune-raw`).

### Secret scanning

`npm run hooks:install` (once per clone) installs a pre-commit hook that blocks:

- anything under `var/`, and any `.db` file — the database holds the Canvas token;
- credential-shaped strings — Canvas tokens, JWTs, private keys, Telegram bot
  tokens, populated `.env` assignments.

It runs [gitleaks](https://github.com/gitleaks/gitleaks) when installed
(`brew install gitleaks`) and always runs the built-in scan, so the check never
degrades to a no-op on a machine without it. GitHub secret scanning with push
protection is the backstop for a bypassed hook, and is enabled on the remote.

`npm run check` additionally fails the build if any tracked file contains a real
email address, matriculation number, or credential-shaped string.

---

## Layout

```
migrations/          Forward-only SQL. Immutable once applied.
src/core/            Config, database, logging, redaction, time, clock, run context.
src/canvas/          HTTP client: pagination, rate limiting, error classification, capture.
src/cli/             Thin argument-parsing wrapper. No logic.
src/index.ts         Library entry point — the poller is a library, not a script.
test/unit/           Unit tests.
test/fixtures/       Real Canvas responses, redacted and promoted by hand.
var/                 Raw captures. Never committed.
```

Two boundaries are load-bearing:

**`src/canvas` returns `Result<T>`, never throws for HTTP outcomes.** Canvas
returns 404 for permission denial, so `denied_or_absent` is a value the caller
must handle. There is no `unwrapOr` helper — coercing a denial into an empty
array is a compile error, not a code-review catch.

**Only `src/core/clock.ts` reads the wall clock.** A test fails the build on any
`Date.now()` or bare `new Date()` elsewhere. Watermark correctness depends on
injectable time, and SPEC §7 forbids deriving a watermark from the current time.

---

## Timezone

Everything is stored as UTC and converted to `Asia/Singapore` before any day
bucketing or display. A 23:59 SGT deadline is 15:59Z and lands on the previous
day if bucketed naively. `src/core/time.ts` is the only place that converts, and
its test asserts the fixed +08:00 offset against `Intl` at several dates — so if
Singapore ever adopts DST, the build fails before anything drifts silently.
