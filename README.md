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

**Current phase: 0.** Repo, config table, contexts schema, Canvas client
(pagination, rate limiting, three-state errors), raw capture, run
instrumentation, `--dry-run`. Done when `npm run probe` lists my courses.

---

## The single writer rule

**Only the poller writes to the OneDrive synced folder.**

Editing, renaming, or moving a file inside `Canvas/` on a machine where OneDrive
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
