/**
 * `npm run mutation-check` -- prove the tests catch the bugs they claim to.
 *
 * Each entry reintroduces one real or near-real bug from this project's
 * history, runs the tests that are supposed to catch it, and expects them to
 * FAIL. A passing suite under a mutation means the test proves nothing.
 *
 * Runs entirely in a throwaway copy of the repository: the working tree is
 * never modified, so an interrupted run cannot leave a bug behind.
 *
 * A mutation whose target text no longer exists is itself a failure. A
 * mutation that silently applies nowhere would report "caught" for a bug that
 * was never introduced -- the same silent no-op that once left SPEC.md edits
 * unapplied (DECISIONS.md D-45).
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

interface Mutation {
  name: string;
  file: string;
  from: string;
  to: string;
  tests: string[];
}

const SYNC = 'test/unit/sync.test.ts';
const PURE = 'test/unit/archive-pure.test.ts';
const GRAPH = 'test/unit/graph.test.ts';
const ARCHIVE = 'test/unit/archive.test.ts';
const MIRROR = 'test/unit/mirror.test.ts';
const FOLLOWUPS = 'test/unit/followups.test.ts';
const CLI_FOLLOWUPS = 'test/unit/cli-followups.test.ts';
const DASHBOARD = 'test/unit/dashboard.test.ts';
const READMODEL = 'test/unit/readmodel.test.ts';
const VERIFY = 'test/unit/readmodel-verify.test.ts';

const MUTATIONS: Mutation[] = [
  {
    name: 'batch key ignores content version (D-04: a second due-date change is dropped)',
    file: 'src/notify/queue.ts',
    from: 'const parts = refs.map((r) => `${r.id}:${r.contentHash}`).sort();',
    to: 'const parts = refs.map((r) => `${r.id}`).sort();',
    tests: [SYNC],
  },
  {
    name: 'trust an empty announcements list from an unreadable course (D-38)',
    file: 'src/sync/run.ts',
    from: ': announcements.value.length === 0 && !readable',
    to: ': false',
    tests: [SYNC],
  },
  {
    name: 'ignore quiet hours',
    file: 'src/notify/queue.ts',
    from: 'if (urgent || !isQuietHours(now)) return null;',
    to: 'return null;',
    tests: [SYNC],
  },
  {
    name: 'non-atomic migrations (a failed rebuild loses the table)',
    file: 'src/core/db/migrate.ts',
    from: 'await client.migrate([...splitStatements(migration.sql), bookkeeping]);',
    to: 'await client.executeMultiple(migration.sql); await client.execute(bookkeeping);',
    tests: ['test/unit/migrate.test.ts'],
  },
  {
    name: 'reintroduce the workflow concurrency group (D-46: 24-hour outage)',
    file: '.github/workflows/sync.yml',
    from: 'permissions:\n  contents: read',
    to: 'concurrency:\n  group: sync\n  cancel-in-progress: false\n\npermissions:\n  contents: read',
    tests: ['test/unit/schedule.test.ts'],
  },
  {
    name: 'compare file fields Modules does not report (false "updated" flood)',
    file: 'src/ingest/classify.ts',
    from: 'if (a !== null && b !== null && a !== b) changes.push',
    to: 'if (a !== b) changes.push',
    tests: [SYNC],
  },
  {
    name: 'hash file updated_at, which moves with no content change',
    file: 'src/ingest/normalise.ts',
    from: '      modified_at: f.modified_at ?? null,\n      accessible:',
    to: '      modified_at: f.updated_at ?? null,\n      accessible:',
    tests: [SYNC],
  },
  {
    name: 'flip file coverage on a transient error',
    file: 'src/sync/run.ts',
    from: "return { fetch: { status: 'error', records: [], detail: describe(files) }, coverage: null, linked: null };",
    to: "return { fetch: { status: 'error', records: [], detail: describe(files) }, coverage: 'none', linked: null };",
    tests: [SYNC],
  },
  {
    name: 'announce every file when coverage recovers',
    file: 'src/sync/run.ts',
    from: " || (type === 'file' && upgraded)",
    to: '',
    tests: [SYNC],
  },
  {
    name: 'link and store the verifier-bearing download URL',
    file: 'src/sync/run.ts',
    from: '`${webBase}/${kind}/${context.canvasId}/files/${f.id}`,',
    to: 'String((f as unknown as { url: string }).url),',
    tests: [SYNC],
  },
  // Write verbs and item-id addressing are each refused in more than one
  // independent place in the guard (by name, by the GET/POST allowlist, by
  // the per-action verb check, by the root-prefix rule), so no single-line
  // edit disables them. The bugs that could are these two: a request that
  // skips the guard, and a guard that approves everything.
  {
    name: 'send a Graph request without the guard checking it (D-50)',
    file: 'src/graph/drive.ts',
    from: 'this.o.guard.check({ method, url, headers, ...(payload === undefined ? {} : { body: payload }) });',
    to: '',
    tests: [PURE],
  },
  {
    name: 'a guard that approves everything (D-50: the confinement guarantee)',
    file: 'src/graph/guard.ts',
    from: '  check(req: GuardedRequest): void {\n',
    to: '  check(req: GuardedRequest): void {\n    if (req.url !== "") return;\n',
    tests: [PURE, GRAPH],
  },
  {
    name: 'let the guard accept an upload session that replaces',
    file: 'src/graph/guard.ts',
    from: "if (props[CONFLICT_PARAM] !== 'fail') throw new GuardError('an upload session without conflictBehavior=fail');",
    to: '',
    tests: [PURE],
  },
  {
    name: 'upload with conflictBehavior=replace (never overwrite, SPEC.md section 5)',
    file: 'src/graph/drive.ts',
    from: "{ item: { '@microsoft.graph.conflictBehavior': 'fail', name } },",
    to: "{ item: { '@microsoft.graph.conflictBehavior': 'replace', name } },",
    tests: [GRAPH, ARCHIVE],
  },
  {
    name: 'send the bearer token to the pre-authenticated upload URL',
    file: 'src/graph/drive.ts',
    from: "this.o.guard.check({ method: 'PUT', url: uploadUrl, headers });",
    to: "headers['authorization'] = `Bearer ${await this.o.tokens.get()}`; this.o.guard.check({ method: 'PUT', url: uploadUrl, headers });",
    tests: [GRAPH],
  },
  {
    name: 'show the route and link before the archive has verified the file',
    file: 'src/notify/render.ts',
    from: "if (f.archiveState !== 'complete' || f.route === null || f.route === undefined) return '';",
    to: "if (f.route === null || f.route === undefined) return '';",
    tests: [ARCHIVE],
  },
  {
    name: 'count the archive attempt only after it succeeds (a crash loop retries forever)',
    file: 'src/archive/stage.ts',
    from: 'sql: `UPDATE files SET attempts = attempts + 1, download_state = \'pending\' WHERE id = ?`,',
    to: 'sql: `UPDATE files SET download_state = \'pending\' WHERE id = ?`,',
    tests: [ARCHIVE],
  },
  {
    name: 'use the rotated refresh token without saving it (D-49)',
    file: 'src/graph/auth.ts',
    from: 'await this.options.saveRefreshToken(json.refresh_token);',
    to: '',
    tests: [GRAPH, ARCHIVE],
  },
  {
    name: 'attach the NUS token to any download URL, whatever its origin (Phase 0 worst case)',
    file: 'src/archive/download.ts',
    from: "if (url.origin === options.canvasOrigin) headers['authorization'] = `Bearer ${options.token}`;",
    to: "headers['authorization'] = `Bearer ${options.token}`;",
    tests: [ARCHIVE],
  },
  {
    name: 'report a deleted app or blocked directory as a generic server error (D-53: silent)',
    file: 'src/graph/auth.ts',
    from: "if (aadsts === 'AADSTS700016' || aadsts === 'AADSTS5000225') return 'app';\n  if (code === 'invalid_client' || code === 'unauthorized_client') return 'app';",
    to: '',
    tests: [ARCHIVE],
  },
  {
    name: 'stop the archive silently when the drive check fails for an unclassified reason',
    file: 'src/archive/stage.ts',
    from: "return stop.stopped === null ? { ...out, stopped: 'unreachable', stopDetail: messageOf(error) } : { ...out, ...stop };",
    to: 'return { ...out, ...stop };',
    tests: [ARCHIVE],
  },
  // --- D-54: the first live run ---------------------------------------------
  {
    name: 'create folders by path under the app folder again (real Graph: 400, D-54)',
    file: 'src/graph/drive.ts',
    from: '`/me/drive/items/${encodeURIComponent(parentId)}/children`,',
    to: "rootedPath(this.o.root, path.slice(0, -1), 'children'),",
    tests: [GRAPH, ARCHIVE],
  },
  {
    name: 'send fileSize in the upload session (real personal OneDrive: 400, D-54)',
    file: 'src/graph/drive.ts',
    from: "{ item: { '@microsoft.graph.conflictBehavior': 'fail', name } },",
    to: "{ item: { '@microsoft.graph.conflictBehavior': 'fail', name, fileSize: bytes.length } },",
    tests: [GRAPH, ARCHIVE],
  },
  {
    name: 'let the guard learn a folder id from any response (an id can name anything)',
    file: 'src/graph/guard.ts',
    from: "if (method === 'POST' && this.root.mode === 'folder' && path === '/me/drive/root/children') this.rootedFolderIds.set(item.id, []);",
    to: 'this.rootedFolderIds.set(item.id, []);',
    tests: [PURE],
  },
  {
    name: 'adopt an existing file on size alone (no SHA-1 on personal OneDrive, D-54)',
    file: 'src/archive/stage.ts',
    from: 'item !== null && item.size === download.bytes.length && item.file?.hashes?.quickXorHash === localXor;',
    to: 'item !== null && item.size === download.bytes.length;',
    tests: [ARCHIVE],
  },
  {
    name: 'mark an upload archived without verifying what landed',
    file: 'src/archive/stage.ts',
    from: 'if (!isThisFile(landed)) {',
    to: 'if (false) {',
    tests: [ARCHIVE],
  },
  {
    name: 'count failures without logging why (SPEC 2.1: 32 silent failures)',
    file: 'src/archive/stage.ts',
    from: "log.warn('archive.failed', { item: c.itemId, attempt: priorAttempts + 1, ...failure });",
    to: '',
    tests: [ARCHIVE],
  },
  {
    name: 'wait for per-file limits when every attempt in a run fails',
    file: 'src/sync/run.ts',
    from: 'const CORRELATED_FAILURE_MIN = 2;',
    to: 'const CORRELATED_FAILURE_MIN = 1_000_000;',
    tests: [ARCHIVE],
  },
  {
    name: 'QuickXorHash without the length folded in',
    file: 'src/archive/quickxor.ts',
    from: 'out[WIDTH / 8 - 8 + b]! ^= Number(length & 0xffn);',
    to: 'void out;',
    tests: ['test/unit/quickxor.test.ts'],
  },
  // --- D-56: pre-authenticated URLs never print ----------------------------
  {
    name: 'print a pre-authenticated URL held under uploadUrl / downloadUrl',
    file: 'src/core/redact.ts',
    from: 'if (CREDENTIAL_URL_KEYS.has(lower)) {',
    to: 'if (false) {',
    tests: ['test/unit/redact.test.ts'],
  },
  {
    name: 'print a tempauth credential quoted in free text (an error message)',
    file: 'src/core/redact.ts',
    from: ".replace(TEMPAUTH_RE, '$1[redacted]')",
    to: '',
    tests: ['test/unit/redact.test.ts'],
  },
  // --- D-57: the re-route move, and nothing wider --------------------------
  {
    name: 'move into another module (destination not in the same <term>/<module>/)',
    file: 'src/graph/guard.ts',
    from: 'if (dest.length !== 3 || dest[0] !== source[0] || dest[1] !== source[1]) {',
    to: 'if (dest.length !== 3) {',
    tests: [PURE],
  },
  {
    name: 'move deeper or shallower than a direct child of <term>/<module>/',
    file: 'src/graph/guard.ts',
    from: 'if (dest.length !== 3 || dest[0] !== source[0] || dest[1] !== source[1]) {',
    to: 'if (dest[0] !== source[0] || dest[1] !== source[1]) {',
    tests: [PURE],
  },
  {
    name: "move into a custom folder no stored rule named",
    file: 'src/graph/guard.ts',
    from: "if (!this.moveDestinations.has(folder)) throw new GuardError(`move destination \"${folder}\" is not a standard category or a stored rule's target`);",
    to: '',
    tests: [PURE],
  },
  {
    name: 'move without Graph having confirmed the landing name absent',
    file: 'src/graph/guard.ts',
    from: "if (!this.confirmedAbsent.has(landing)) throw new GuardError('a move whose destination name was not confirmed absent');",
    to: '',
    tests: [PURE],
  },
  {
    name: 'allow a learned file to be moved more than once',
    file: 'src/graph/guard.ts',
    from: '    this.movableFiles.delete(id);\n',
    to: '',
    tests: [PURE],
  },
  {
    name: 'apply a re-route plan other than the one approved in the preview',
    file: 'src/archive/reroute.ts',
    from: 'if (plan.fingerprint !== approvedFingerprint) {',
    to: 'if (false) {',
    tests: [ARCHIVE],
  },
  {
    name: 'match rules on raw names, so Tutorials_Labs routes nowhere',
    file: 'src/archive/route.ts',
    from: "return value.normalize('NFC').replace(/[^\\p{L}\\p{N}]+/gu, ' ').trim();",
    to: "return value.normalize('NFC');",
    tests: [PURE],
  },
  // --- D-58: the local mirror ----------------------------------------------
  {
    name: 'mirror guard approves any path (writes outside "Downloaded from Canvas")',
    file: 'src/mirror/guard.ts',
    from: '      if (inside(real, subtree)) return lexical;',
    to: '      return lexical;',
    tests: [MIRROR],
  },
  {
    name: 'mirror identifies files by path, so a re-routed baselined file looks new',
    file: 'src/mirror/mirror.ts',
    from: '    if (state.entries[f.id] !== undefined) continue;',
    to: '    if (Object.values(state.entries).some((e) => e.archivePath === f.targetPath)) continue;',
    tests: [MIRROR],
  },
  {
    name: 'mirror overwrites a file already at the destination name',
    file: 'src/mirror/mirror.ts',
    from: 'await copyFile(staged, dest, fsConstants.COPYFILE_EXCL); // fails rather than overwrite',
    to: 'await copyFile(staged, path.join(subtree, ...segs.slice(2)));',
    tests: [MIRROR],
  },
  {
    name: 'mirror moves a copy I have changed when the archive re-routes it',
    file: 'src/mirror/mirror.ts',
    from: '    if (sha256Of(from) !== entry.copiedSha256) {',
    to: '    if (false) {',
    tests: [MIRROR],
  },
  // --- D-61: answer-sheet follow-ups ----------------------------------------
  {
    name: 'match answer words as substrings ("transient", "resolution" become answers)',
    file: 'src/followups/classify.ts',
    from: 'return tokens.some((t) => GENERIC_ANSWER_TOKENS.has(t)) ||',
    to: "return [...GENERIC_ANSWER_TOKENS].some((w) => tokens.join(' ').includes(w)) ||",
    tests: [FOLLOWUPS],
  },
  {
    name: 'pair by whole filename, losing the number',
    file: 'src/followups/plan.ts',
    from: 'const id = `${file.contextId}|${category}|${c.number}`;',
    to: 'const id = `${file.contextId}|${category}|${file.title}`;',
    tests: [FOLLOWUPS, ARCHIVE],
  },
  {
    name: "read only the first digit, so Tutorial 1's answers close Tutorial 11",
    file: 'src/followups/classify.ts',
    from: 'Tutorials: { words: new Set([\'tutorial\', \'tut\']), joined: /^(?:t|tut|tutorial)(\\d{1,2})$/ },',
    to: 'Tutorials: { words: new Set([\'tutorial\', \'tut\']), joined: /^(?:t|tut|tutorial)(\\d)/ },',
    tests: [FOLLOWUPS],
  },
  {
    name: 'let a file with no number open a follow-up',
    file: 'src/followups/classify.ts',
    from: '  const number = extractNumber(tokens, category);\n',
    to: "  const number = extractNumber(tokens, category) ?? '0';\n",
    tests: [FOLLOWUPS, ARCHIVE],
  },
  {
    name: 'announce a pair that was answered on arrival as a "close"',
    file: 'src/followups/stage.ts',
    from: "VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'answered_on_arrival')",
    to: "VALUES (?, ?, ?, ?, 'closed', ?, ?, ?, ?, ?, 'answers')",
    tests: [ARCHIVE],
  },
  {
    name: 'a partial answer closes its follow-up without a ruling',
    file: 'src/followups/plan.ts',
    from: "      if (input.partialPolicy !== 'close') continue;\n",
    to: '',
    tests: [FOLLOWUPS],
  },
  // --- D-62: lesson-day reminders --------------------------------------------
  {
    name: 'a reminder sent before any lesson has passed since posting',
    file: 'src/followups/timetable.ts',
    from: 'o.contextId === contextId && last !== null && last.getTime() > new Date(o.openedAt).getTime()',
    to: 'o.contextId === contextId && last !== null',
    tests: [FOLLOWUPS, ARCHIVE],
  },
  {
    name: 'a reminder on a day with no lesson (the weekday not checked)',
    file: 'src/followups/timetable.ts',
    from: 's.contextId === contextId && s.weekday === weekday && s.firstDate <= date',
    to: 's.contextId === contextId && s.firstDate <= date',
    tests: [FOLLOWUPS, ARCHIVE],
  },
  {
    name: 'a reminder on a day with no lesson (recess or a cancelled lab ignored)',
    file: 'src/followups/timetable.ts',
    from: '  if (tt.exceptions.some((e) => e.date === date && (e.contextId === null || e.contextId === contextId))) return [];\n',
    to: '',
    tests: [FOLLOWUPS],
  },
  {
    name: 'a reminder for a dismissed or answered item',
    file: 'src/followups/stage.ts',
    from: "      WHERE f.state = 'open' AND c.followups_tracking = 1`,",
    to: '      WHERE c.followups_tracking = 1`,',
    tests: [ARCHIVE],
  },
  {
    name: 'a second reminder on the same lesson day',
    file: 'src/followups/stage.ts',
    from: 'sendKey: `lesson-reminder ${decision.plan.date}`',
    to: 'sendKey: `lesson-reminder ${now.toISOString()}`',
    tests: [ARCHIVE],
  },
  {
    name: 'a reminder the morning follow-ups went live after 07:00',
    file: 'src/followups/timetable.ts',
    from: "  if (input.liveSince === null || new Date(input.liveSince).getTime() >= sendAt.getTime()) {",
    to: '  if (input.liveSince === null) {',
    tests: [FOLLOWUPS, ARCHIVE],
  },
  {
    name: 'a module with tracking switched off still opens follow-ups',
    file: 'src/followups/plan.ts',
    from: '    if (input.trackingOff?.has(file.contextId) === true) {',
    to: '    if (false) {',
    tests: [FOLLOWUPS, ARCHIVE],
  },
  {
    name: 'age and "overdue" from when the monitor saw the file, not when Canvas posted it',
    file: 'src/followups/plan.ts',
    from: 'export const postedOf = (f: TrackedFile): string => f.postedAt ?? f.firstSeenAt;',
    to: 'export const postedOf = (f: TrackedFile): string => f.firstSeenAt;',
    tests: [FOLLOWUPS],
  },
  // --- the column the reshaped 0010 removed, reintroduced --------------------
  {
    name: 'followups list selects nudged_at, a column migration 0010 no longer has (the live bug)',
    file: 'src/cli/followups.ts',
    from: 'SELECT f.id, f.category, f.number, f.state, f.opened_at, f.close_reason, c.module_code, i.title',
    to: 'SELECT f.id, f.category, f.number, f.state, f.opened_at, f.nudged_at, f.close_reason, c.module_code, i.title',
    tests: [CLI_FOLLOWUPS],
  },
  {
    name: 'followups dismiss writes nudged_at, a column migration 0010 no longer has',
    file: 'src/cli/followups.ts',
    from: "SET state = 'dismissed', closed_at = ?, close_reason = 'dismissed'",
    to: "SET state = 'dismissed', nudged_at = NULL, closed_at = ?, close_reason = 'dismissed'",
    tests: [CLI_FOLLOWUPS],
  },
  {
    name: 'the lesson-day reminder reads nudged_at, a column migration 0010 no longer has',
    file: 'src/followups/stage.ts',
    from: '    `SELECT f.id, f.context_id, f.category, f.number, f.opened_at, c.module_code',
    to: '    `SELECT f.id, f.context_id, f.category, f.number, f.opened_at, f.nudged_at, c.module_code',
    tests: [CLI_FOLLOWUPS],
  },
  // --- D-65: the dashboard and its read model --------------------------------
  {
    name: 'a page served without a session (the main view skips its own check)',
    file: 'dashboard/app/page.tsx',
    from: '  const { session, secrets } = await requireSession();',
    to: "  const { session, secrets } = { session: { kind: 'verified-session' as const, expiresAt: 0 }, secrets: (await import('../lib/env.ts')).secrets()! };",
    tests: [DASHBOARD],
  },
  {
    name: 'a page served without a session (the proxy lets the main view through)',
    file: 'dashboard/proxy.ts',
    from: "const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/login', '/api/login']);",
    to: "const PUBLIC_PATHS: ReadonlySet<string> = new Set(['/login', '/api/login', '/']);",
    tests: [DASHBOARD],
  },
  {
    name: 'a secret-bearing table copied into the read model (config, as a module code)',
    file: 'src/readmodel/publish.ts',
    from: 'COALESCE(c.module_code, g.module_code) AS code, COALESCE(c.followups_tracking, 0) AS tracked',
    to: "(SELECT value FROM config WHERE key = 'canvas_token') AS code, COALESCE(c.followups_tracking, 0) AS tracked",
    tests: [READMODEL],
  },
  {
    name: 'a write statement in the dashboard',
    file: 'dashboard/lib/readmodel.ts',
    from: `readRows(session, secrets, "SELECT value FROM rm_meta WHERE name = 'published_at'"),`,
    to: `readRows(session, secrets, "INSERT INTO rm_meta (name, value) VALUES ('seen', '1') RETURNING value"),`,
    tests: [DASHBOARD],
  },
  {
    name: 'a cacheable authenticated response',
    file: 'dashboard/lib/headers.ts',
    from: "'Cache-Control': 'no-store, max-age=0',",
    to: "'Cache-Control': 'public, max-age=3600',",
    tests: [DASHBOARD],
  },
  {
    name: 'preview deployments exposing data',
    file: 'dashboard/lib/env.ts',
    from: "return env.VERCEL_ENV === 'production';",
    to: "return env.VERCEL_ENV === 'production' || env.VERCEL_ENV === 'preview';",
    tests: [DASHBOARD],
  },
  {
    name: 'preview deployments enabled for every branch in vercel.json',
    file: 'dashboard/vercel.json',
    from: '"**": false,',
    to: '"**": true,',
    tests: [DASHBOARD],
  },
  {
    name: 'a session accepted without checking its signature',
    file: 'dashboard/lib/session.ts',
    from: '  if (!ok) return null;\n',
    to: '',
    tests: [DASHBOARD],
  },
  {
    name: 'a session cookie readable by page scripts (no HttpOnly)',
    file: 'dashboard/lib/session.ts',
    from: "const attrs = 'Path=/; HttpOnly; Secure; SameSite=Strict';",
    to: "const attrs = 'Path=/; Secure; SameSite=Strict';",
    tests: [DASHBOARD],
  },
  {
    name: 'verify counting ANY failure as a refusal (a network blip or a server fault would pass)',
    file: 'src/readmodel/cli.ts',
    from: 'return { ok: false, authRefusal: status === 401 || status === 403, detail: describe(error) };',
    to: 'return { ok: false, authRefusal: true, detail: describe(error) };',
    tests: [VERIFY],
  },
  {
    name: 'verify accepting a recorded token expiry LATER than the real one (alerts too late)',
    file: 'src/readmodel/cli.ts',
    from: 'if (at > tokenExp.getTime()) return',
    to: 'if (false) return',
    tests: [VERIFY],
  },
  {
    name: "no expiry alert for the dashboard's read-only token",
    file: 'src/sync/run.ts',
    from: '    if (dashboardToken !== null) alerts.push(dashboardToken);\n',
    to: '',
    tests: [SYNC],
  },
  {
    name: 'Vercel running dependency install scripts',
    file: 'dashboard/vercel.json',
    from: '"installCommand": "npm ci --ignore-scripts",',
    to: '"installCommand": "npm ci",',
    tests: [DASHBOARD],
  },
  {
    name: 'npm install scripts allowed in the dashboard (.npmrc)',
    file: 'dashboard/.npmrc',
    from: 'ignore-scripts=true',
    to: 'ignore-scripts=false',
    tests: [DASHBOARD],
  },
  {
    name: "Referrer-Policy no-referrer (browsers then send Origin: null on the login POST, refusing every login)",
    file: 'dashboard/lib/headers.ts',
    from: "'Referrer-Policy': 'same-origin',",
    to: "'Referrer-Policy': 'no-referrer',",
    tests: [DASHBOARD],
  },
  {
    name: 'the password script printing secrets under CI',
    file: 'dashboard/scripts/hash-password.ts',
    from: "if (process.env['CI'] !== undefined || process.env['GITHUB_ACTIONS'] !== undefined || process.env['VERCEL'] !== undefined) {",
    to: 'if (false) {',
    tests: [DASHBOARD],
  },
  {
    name: 'a login accepted from another site (no CSRF check)',
    file: 'dashboard/app/api/login/route.ts',
    from: "  if (!sameOrigin(request)) return new Response('Forbidden', { status: 403 });\n",
    to: '',
    tests: [DASHBOARD],
  },
  {
    name: 'the dashboard SQL guard waves writes through',
    file: 'dashboard/lib/sql-guard.ts',
    from: "  if (WRITE_WORDS.test(text.replace(/'(?:[^']|'')*'/g, \"''\"))) throw new WriteRefused('a write keyword');\n",
    to: '',
    tests: [DASHBOARD],
  },
  {
    name: 'a credential-bearing OneDrive link let into the read model schema',
    file: 'src/readmodel/schema.ts',
    from: "AND instr(lower(${col}), 'tempauth') = 0 ",
    to: '',
    tests: [READMODEL],
  },
];

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const COPY = ['src', 'test', 'migrations', '.github', 'package.json', 'tsconfig.json'];

function failures(dir: string, tests: string[]): { failed: number; output: string } {
  const run = spawnSync(process.execPath, ['--test', ...tests], { cwd: dir, encoding: 'utf8', timeout: 180_000 });
  const output = `${run.stdout}${run.stderr}`;
  const match = /^ℹ fail (\d+)$/m.exec(output);
  // No summary line at all means the run itself broke -- count it as failing,
  // but say so, so a crash is never mistaken for a caught mutation.
  return { failed: match === null ? -1 : Number(match[1]), output };
}

const work = mkdtempSync(path.join(tmpdir(), 'canvas-mutation-'));
let problems = 0;
try {
  for (const entry of COPY) cpSync(path.join(ROOT, entry), path.join(work, entry), { recursive: true });
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(work, 'node_modules'));
  // The dashboard's source, without its build output or any local secrets file
  // (.env.local holds a real read-only token during a preview); packages by symlink.
  cpSync(path.join(ROOT, 'dashboard'), path.join(work, 'dashboard'), {
    recursive: true,
    filter: (src) => !/[\\/](node_modules|\.next|\.vercel|\.env[^\\/]*)([\\/]|$)/.test(path.relative(ROOT, src)),
  });
  symlinkSync(path.join(ROOT, 'dashboard', 'node_modules'), path.join(work, 'dashboard', 'node_modules'));

  const allTests = [...new Set(MUTATIONS.flatMap((m) => m.tests))];
  const baseline = failures(work, allTests);
  if (baseline.failed !== 0) {
    console.error('Baseline is not green, so no mutation result would mean anything:\n');
    console.error(baseline.output.slice(-3000));
    process.exit(1);
  }
  console.log(`baseline: ${allTests.length} test files green in a scratch copy (${work})\n`);

  for (const [i, m] of MUTATIONS.entries()) {
    const target = path.join(work, m.file);
    const original = readFileSync(target, 'utf8');
    const occurrences = original.split(m.from).length - 1;
    const label = `${String(i + 1).padStart(2)}. ${m.name}`;
    if (occurrences !== 1) {
      problems += 1;
      console.log(`${label}\n    TARGET MOVED: found ${occurrences} times in ${m.file}; update this mutation\n`);
      continue;
    }
    writeFileSync(target, original.replace(m.from, m.to));
    const result = failures(work, m.tests);
    writeFileSync(target, original);
    if (result.failed > 0) {
      console.log(`${label}\n    CAUGHT (${result.failed} failing test${result.failed === 1 ? '' : 's'})\n`);
    } else if (result.failed === -1) {
      console.log(`${label}\n    CAUGHT, but the run crashed rather than failing an assertion; inspect by hand\n`);
    } else {
      problems += 1;
      console.log(`${label}\n    NOT CAUGHT: the tests still pass with this bug in place\n`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

console.log(
  problems === 0
    ? `mutation-check: all ${MUTATIONS.length} reintroduced bugs caught. Scratch copy removed.`
    : `mutation-check: ${problems} problem(s). Scratch copy removed.`,
);
process.exit(problems === 0 ? 0 : 1);
