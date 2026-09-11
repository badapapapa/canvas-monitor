import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createClient, type Client } from '@libsql/client';
import { createDb } from '../../src/core/db/writer.ts';
import { migrate } from '../../src/core/db/migrate.ts';
import { runSeedCourses } from '../../src/cli/seed-courses.ts';
import { silentLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';
import { isAppError } from '../../src/core/errors.ts';
import type { RunContext } from '../../src/core/run-context.ts';
import type { SeedContext } from '../../src/discover/seed.ts';

const clock = fixedClock('2026-09-10T08:00:00Z');
const temps: string[] = [];
after(async () => {
  await Promise.all(temps.map((d) => rm(d, { recursive: true, force: true })));
});

function course(id: number, code: string, enabled: boolean): SeedContext {
  return {
    context_type: 'course',
    canvas_id: id,
    display_name: `${code} Something [2610]`,
    course_code: code,
    term_code: '2610',
    term_name: '[2610] 2026/2027 Semester 1',
    section_id: 900 + id,
    section_name: null,
    coverage_status: 'full',
    coverage_probed: true,
    coverage_detail: 'Files tab readable.',
    shares_module_code_with: [],
    proposed: {
      module_code: code,
      module_code_alternatives: [],
      site_role: 'lecture',
      enabled,
      reason: 'current_term',
      explanation: 'Term 2610 is the current term.',
    },
  };
}

function group(id: number, parent: number | null, code: string | null, enabled: boolean): SeedContext {
  return {
    context_type: 'group',
    canvas_id: id,
    display_name: 'Synthetic Project Group',
    course_code: null,
    term_code: parent === null ? null : '2610',
    term_name: null,
    section_id: null,
    section_name: null,
    coverage_status: 'unknown',
    coverage_probed: false,
    coverage_detail: 'Probed in Phase 3.',
    shares_module_code_with: [],
    parent_canvas_course_id: parent,
    concluded: false,
    proposed: {
      module_code: code,
      module_code_alternatives: [],
      site_role: 'group',
      enabled,
      reason: 'follows_parent',
      explanation: 'Synthetic.',
    },
  };
}

async function harness(contexts: SeedContext[]): Promise<{ ctx: RunContext; file: string; client: Client }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'canvas-seed-'));
  temps.push(dir);
  const client = createClient({ url: `file:${path.join(dir, 'test.db')}` });
  await client.execute('PRAGMA foreign_keys = ON');
  await migrate(client, silentLogger(), clock, { dryRun: false });

  const file = path.join(dir, 'courses.seed.json');
  await writeFile(file, JSON.stringify({ contexts }), 'utf8');

  const ctx = {
    runId: 'test', command: 'seed-courses', dryRun: false, unsafeLog: false, ci: false,
    startedAt: clock.now(), clock, log: silentLogger(),
    db: createDb(client, silentLogger(), false),
    bootstrap: {} as RunContext['bootstrap'],
  } satisfies RunContext;

  return { ctx, file, client };
}

describe('seed-courses', () => {
  it('loads courses and groups into contexts', async () => {
    const { ctx, file, client } = await harness([
      course(10001, 'AB1234', true),
      group(20001, 10001, 'AB1234', true),
    ]);

    const outcome = await runSeedCourses(ctx, { path: file });
    assert.equal(outcome.inserted, 2);

    const rows = await client.execute('SELECT context_type, canvas_id FROM contexts ORDER BY canvas_id');
    assert.equal(rows.rows.length, 2);
    const courses = await client.execute('SELECT canvas_course_id, module_code FROM courses');
    assert.equal(courses.rows.length, 1, 'only the course gets a courses row');
    assert.equal(courses.rows[0]?.['module_code'], 'AB1234');
    client.close();
  });

  it("persists a group's module code, parent and term (D-37)", async () => {
    // Before D-37 the loader wrote module_code only into `courses`, so a
    // group's reviewed module code was silently discarded on load.
    const { ctx, file, client } = await harness([
      course(10001, 'AB1234', true),
      group(20001, 10001, 'AB1234', true),
    ]);
    await runSeedCourses(ctx, { path: file });

    const row = await client.execute(
      `SELECT g.module_code, g.term, g.parent_canvas_course_id, g.parent_context_id, g.concluded,
              p.canvas_id AS parent_canvas_id
         FROM groups g LEFT JOIN contexts p ON p.context_id = g.parent_context_id
        WHERE g.canvas_group_id = 20001`,
    );
    assert.equal(row.rows.length, 1, 'the group must have a groups row');
    assert.equal(row.rows[0]?.['module_code'], 'AB1234');
    assert.equal(row.rows[0]?.['term'], '2610');
    assert.equal(Number(row.rows[0]?.['parent_canvas_id']), 10001, 'parent resolved to its context');
    assert.equal(Number(row.rows[0]?.['concluded']), 0);
    client.close();
  });

  it('keeps a concluded group whose parent course is not seeded', async () => {
    // A concluded group's parent is an older course that never appears in the
    // active list, so parent_context_id is legitimately null.
    const concluded = group(20003, 99999, null, false);
    concluded.concluded = true;
    const { ctx, file, client } = await harness([course(10001, 'AB1234', true), concluded]);
    await runSeedCourses(ctx, { path: file });

    const row = await client.execute('SELECT parent_context_id, concluded FROM groups WHERE canvas_group_id = 20003');
    assert.equal(row.rows[0]?.['parent_context_id'], null);
    assert.equal(Number(row.rows[0]?.['concluded']), 1);
    client.close();
  });

  it('rejects an enabled context with no module code, and loads nothing', async () => {
    // The case reported on review: an enabled group with module_code null
    // would become Canvas/<term>/null/..., fixed forever by route-once.
    const { ctx, file, client } = await harness([
      course(10001, 'AB1234', true),
      group(20001, 10001, null, true),
    ]);
    await assert.rejects(
      () => runSeedCourses(ctx, { path: file }),
      (e: unknown) =>
        isAppError(e) && e.code === 'config_invalid' && e.message.includes('group 20001 is enabled but has no module_code'),
    );
    const rows = await client.execute('SELECT count(*) AS n FROM contexts');
    assert.equal(Number(rows.rows[0]?.['n']), 0, 'validation must run before any write');
    client.close();
  });

  it('allows a DISABLED context with no module code', async () => {
    const { ctx, file, client } = await harness([course(10001, 'AB1234', true), group(20002, 10001, null, false)]);
    await assert.doesNotReject(() => runSeedCourses(ctx, { path: file }));
    client.close();
  });

  it("rejects a group filed under a different module from its parent", async () => {
    // Stale inheritance: the parent's code was edited on review, the group's
    // was not. Under route-once the split would be permanent.
    const { ctx, file, client } = await harness([
      course(10001, 'AB1234-EDITED', true),
      group(20001, 10001, 'AB1234', true),
    ]);
    await assert.rejects(
      () => runSeedCourses(ctx, { path: file }),
      (e: unknown) => isAppError(e) && e.message.includes('Make them match'),
    );
    client.close();
  });

  it('reports every problem at once rather than one per run', async () => {
    const { ctx, file, client } = await harness([
      course(10001, 'AB1234', true),
      group(20001, 10001, null, true),
      group(20002, 10001, null, true),
    ]);
    await assert.rejects(
      () => runSeedCourses(ctx, { path: file }),
      (e: unknown) => isAppError(e) && e.message.includes('2 problem(s)'),
    );
    client.close();
  });

  it('is idempotent: re-running updates rather than duplicating', async () => {
    // SPEC.md section 16 expects the file to be edited and re-loaded.
    const { ctx, file, client } = await harness([course(10001, 'AB1234', true)]);

    await runSeedCourses(ctx, { path: file });
    const second = await runSeedCourses(ctx, { path: file });

    assert.equal(second.inserted, 0);
    assert.equal(second.updated, 1);
    const rows = await client.execute('SELECT count(*) AS n FROM contexts');
    assert.equal(Number(rows.rows[0]?.['n']), 1);
    client.close();
  });

  it('applies my hand edits on re-load', async () => {
    const { ctx, file, client } = await harness([course(10001, 'AB1234', true)]);
    await runSeedCourses(ctx, { path: file });

    // Simulate the review step: disable it and rename the module code.
    const edited = course(10001, 'AB1234', false);
    edited.proposed.module_code = 'AB1234-RENAMED';
    await writeFile(file, JSON.stringify({ contexts: [edited] }), 'utf8');
    await runSeedCourses(ctx, { path: file });

    const ctxRow = await client.execute('SELECT enabled FROM contexts WHERE canvas_id = 10001');
    assert.equal(Number(ctxRow.rows[0]?.['enabled']), 0, 'my edit must win over the proposal');
    const courseRow = await client.execute('SELECT module_code FROM courses WHERE canvas_course_id = 10001');
    assert.equal(courseRow.rows[0]?.['module_code'], 'AB1234-RENAMED');
    client.close();
  });

  it('rejects a malformed seed file rather than half-loading it', async () => {
    const bad = course(1, 'XX1000', true);
    // @ts-expect-error deliberately invalid for the test
    bad.proposed.enabled = 'yes';
    const { ctx, file, client } = await harness([bad]);
    await assert.rejects(
      () => runSeedCourses(ctx, { path: file }),
      (e: unknown) => isAppError(e) && e.code === 'config_invalid',
    );
    const rows = await client.execute('SELECT count(*) AS n FROM contexts');
    assert.equal(Number(rows.rows[0]?.['n']), 0, 'a rejected load must leave nothing behind');
    client.close();
  });

  it('gives an actionable error when the file is missing', async () => {
    const { ctx, client } = await harness([course(1, 'XX1000', true)]);
    await assert.rejects(
      () => runSeedCourses(ctx, { path: '/nonexistent/courses.seed.json' }),
      (e: unknown) => isAppError(e) && e.hint?.includes('npm run discover') === true,
    );
    client.close();
  });
});
