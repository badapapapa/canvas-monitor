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

## A group changed

When a project group is switched, the old group starts refusing the token.
The ops chat says its files can no longer be read. The fix is the usual
discovery and seed path, confined to groups (DECISIONS.md D-72). Run it from
the repository root, locally:

1. Write a fresh discovery **beside** the reviewed seed file, not over it:
   ```
   npm run discover -- --out var/seed-new.json
   ```
2. See which groups changed, then apply only that, with a backup under
   `var/`:
   ```
   npm run seed-groups
   npm run seed-groups -- --write
   ```
   - A new group follows its parent course as you reviewed it.
   - A group you left is disabled, not deleted.
   - Everything else in `courses.seed.json` is untouched.
3. Load it. This changes the production database:
   ```
   npm run seed-courses -- --dry-run
   npm run seed-courses
   ```
4. Optionally, preview the next run's messages without sending or writing
   anything:
   ```
   npm run sync -- --dry-run
   ```
5. Delete the discovery file, which names your real courses and groups
   (`var/` is gitignored and blocked by the commit hook anyway):
   ```
   rm var/seed-new.json
   ```

**What the next sync does:**
- The new group's existing files are recorded as seen, not announced one by
  one.
- One "Now watching" message names it.
- Its files are archived to OneDrive (under the module's `Group` folder)
  silently. A run that archives ten or more sends one "Saved to OneDrive"
  summary.
- From then on, its new files are announced and archived as usual.
- The old group's alert closes quietly: no "Resolved", because nothing was
  fixed.
- Files archived from the old group stay where they are.

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
| `node dashboard/scripts/hash-password.ts --vercel` | A new dashboard password on the clipboard (for your password manager), and its hash and a new session secret piped straight into Vercel. Nothing secret is printed. `--session-only`: a new session secret alone. |
| `npm run dashboard:smoke` | Build a copy of the dashboard and check it on invented data: over HTTP, and the whole login flow in WebKit (Safari) and Chromium. Needs `npx playwright install webkit chromium` once. |
| `npm run dashboard:preview` | The dashboard locally on the real read model (read-only token, throwaway password), self-checked. Serve it with `npm --prefix dashboard run start -- -p 3100 -H localhost`, open http://localhost:3100, and paste `pbcopy < var/dashboard-preview/password`. `-- --clean` removes its secrets. |

A preview deployment is never built automatically, is given no secrets, and
serves nothing (DECISIONS.md D-65, D-70).

### Where every secret lives

| Secret | Where | What can read it | What it reaches |
|---|---|---|---|
| Canvas token, OneDrive refresh token, Telegram bot token, health-check URL | Main database, `config` table | Anything holding the main database token | Canvas; the OneDrive app folder; the bot |
| Main database URL and token | `.env` on this Mac; GitHub Actions secrets | This Mac's CLI and mirror; the sync workflow | The main database, so everything above |
| Read-model URL and write token | `.env`; GitHub Actions secrets | This Mac; the sync workflow | The read model only, read and write |
| Read-model read-only token (expires; its date is in `dashboard_read_token_expires_at`) | `.env`, for `verify`; Vercel Production, Sensitive | This Mac; the production deployment's server code | The read model only, read-only |
| Dashboard password | Your password manager only | You | The dashboard, behind Vercel's login |
| Password hash and session secret | Vercel Production, Sensitive | The production deployment's server code | Signing in; signing sessions |
| Session cookie `__Host-cm_session` | Your browsers; HttpOnly; 30 days | Not the page's scripts | The dashboard, still behind Vercel's login |
| Vercel account | Email, plus Vercel's two-factor | You | The Vercel project: deploys and env vars (Sensitive values cannot be read back) |
| Vercel CLI token | `~/Library/Application Support/com.vercel.cli/auth.json`, only between `login` and `logout` | Anything running as you on this Mac | The Vercel account |
| Vercel Authentication cookie | Your browsers, one per address | Not the page's scripts | Past Vercel's login to the dashboard |
| GitHub account | Password, plus GitHub's two-factor | You | The repository and its Actions secrets |
| Turso CLI login | This Mac | Anything running as you on this Mac | Both databases; creating tokens |
| Canvas calendar feed URL (outside this system) | Google Calendar, as a subscription | Google; you | Your Canvas calendar, read-only |

**Temporary copies:**
- `npm run dashboard:preview` puts the read-only token and a throwaway password
  in `dashboard/.env.local` and `var/dashboard-preview/` while you preview.
  `--clean` removes them.
- A `vercel link` that pulls "development environment variables" writes a
  12-hour Vercel OIDC token to `dashboard/.env.local`. Nothing in this system
  trusts it, but delete it (D-71).

### Redeploying the dashboard

The dashboard is deployed from this Mac with the Vercel CLI. Vercel has no
access to GitHub (DECISIONS.md D-70).

**Once per Mac: stop the CLI installing a Claude Code plugin** (D-71). This
records "declined" in the CLI's own preferences, which is the only switch it
honours:

```
node -e 'const f=require("os").homedir()+"/Library/Application Support/com.vercel.cli/agent-preferences.json",fs=require("fs");let p={};try{p=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}p.pluginDeclined=true;p.pluginAutoUpdate=false;fs.mkdirSync(require("path").dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(p,null,2)+"\n")'
```

Check: `grep plugin ~/Library/Application\ Support/com.vercel.cli/agent-preferences.json`
shows `"pluginDeclined": true` and `"pluginAutoUpdate": false`.

**Each redeploy.** Commit first (`git status` clean), then, in one Terminal
window, from the repository root:

```
export npm_config_ignore_scripts=true VERCEL_TELEMETRY_DISABLED=1
npx --yes vercel@59.19.1 login
cd dashboard
npx --yes vercel@59.19.1 deploy --prod
npx --yes vercel@59.19.1 logout
cd ..
ls -a dashboard | grep -E '^\.env'
git status --short
```

The last two print nothing. If `ls` shows a `.env` file, delete it: it is a
Vercel token the CLI downloaded.
- **Always `--prod`.** A plain `deploy` makes a preview, which has no secrets
  and serves nothing.
- **Logging out revokes the CLI's token.**
- **Do not run `vercel link` again.** `dashboard/.vercel/` already holds the
  link (project and team IDs only, no secrets). If you ever must re-link:
  - answer **No** to "Pull development environment variables into
    .env.local?";
  - answer **No** to connecting a Git repository.

### Revoking access

A new session secret signs every device out at once. Sessions otherwise last
30 days. With the CLI logged in, from the repository root:

```
node dashboard/scripts/hash-password.ts --vercel --session-only
```

Then **redeploy** (above): Vercel applies env changes to new deployments only.

A new password does the same, and replaces the password too:
`node dashboard/scripts/hash-password.ts --vercel`. The new password goes on
the clipboard for your password manager, and nothing else ever does. The
hash and session secret go straight into Vercel. Nothing secret is printed.

### Checking the live site

Sign in, open the browser's JavaScript console:
- **Chrome:** View → Developer → JavaScript Console.
- **Safari:** Develop → Show JavaScript Console, after turning on "Show
  features for web developers".

Paste this. It should print `ALL PASS`:

```js
(async () => {
  const r = await fetch(location.pathname, { cache: 'no-store' });
  const h = (k) => r.headers.get(k) ?? '';
  const csp = h('content-security-policy');
  const cc = h('cache-control');
  const age = Number(/max-age=(\d+)/.exec(h('strict-transport-security'))?.[1] ?? 0);
  const checks = {
    'HSTS, a year or more': age >= 31536000,
    "CSP nonce + 'strict-dynamic'": /'nonce-[^']+' 'strict-dynamic'/.test(csp),
    "CSP frame-ancestors 'none'": csp.includes("frame-ancestors 'none'"),
    'CSP upgrade-insecure-requests': csp.includes('upgrade-insecure-requests'),
    'CSP no unsafe-inline/eval': !/unsafe-(inline|eval)/.test(csp),
    'Cache-Control no-store, not public': /(^|[\s,])no-store([\s,]|$)/.test(cc) && !/public/.test(cc),
    'X-Robots-Tag noindex, nofollow': /noindex/.test(h('x-robots-tag')) && /nofollow/.test(h('x-robots-tag')),
    'Referrer-Policy same-origin': h('referrer-policy') === 'same-origin',
    'X-Frame-Options DENY': /DENY/.test(h('x-frame-options')),
    'nosniff': /nosniff/.test(h('x-content-type-options')),
    'COOP same-origin': h('cross-origin-opener-policy') === 'same-origin',
    'CORP same-origin': h('cross-origin-resource-policy') === 'same-origin',
    'Permissions-Policy': h('permissions-policy').includes('camera=()'),
    'no X-Powered-By': r.headers.get('x-powered-by') === null,
    'session cookie invisible to scripts': !document.cookie.includes('cm_session'),
  };
  console.table(checks);
  return Object.values(checks).every(Boolean) ? 'ALL PASS' : 'SOMETHING FAILED: see the table';
})()
```

Production sends `Cache-Control: private, no-cache, no-store, max-age=0,
must-revalidate` (the tests assert exactly that).

**The cookie:** it is `__Host-cm_session`, with:
- HttpOnly ✓ and Secure ✓;
- SameSite Strict;
- path `/`;
- no Domain;
- about 30 days to expiry.

Chrome shows it in DevTools → Application → Cookies; Safari in Web Inspector →
Storage → Cookies.

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
3. Give Vercel the new token without printing it. With the CLI logged in, from
   `dashboard/`:
   ```
   grep '^READMODEL_READ_TOKEN=' ../.env | cut -d= -f2- | tr -d '\n' | npx --yes vercel@59.19.1 env add READMODEL_READ_TOKEN production --sensitive --force
   ```
   Then redeploy (see "Redeploying the dashboard", including its checks), and
   log out.

**If a token has leaked.** `turso db tokens invalidate canvas-readmodel`
revokes it. But on the free plan both databases share one group, and
invalidation is **group-wide**. It also revokes the main database token and
the read model's write token. Sync runs fail until all three are replaced:
1. main: `turso db tokens create <main database>` → `TURSO_AUTH_TOKEN` in
   `.env` and in the GitHub secret;
2. write: `turso db tokens create canvas-readmodel` → `READMODEL_WRITE_TOKEN`
   in `.env` and in the GitHub secret;
3. read: as in routine rotation above, including Vercel, the redeploy and
   the recorded expiry;
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
