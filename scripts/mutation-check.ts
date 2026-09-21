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
    from: "{ item: { '@microsoft.graph.conflictBehavior': 'fail', name, fileSize: bytes.length } },",
    to: "{ item: { '@microsoft.graph.conflictBehavior': 'replace', name, fileSize: bytes.length } },",
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
