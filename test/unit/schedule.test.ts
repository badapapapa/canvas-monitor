import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { MISSED_SLOTS_REPORT_THRESHOLD, SYNC_SCHEDULES, slotsBetween } from '../../src/sync/schedule.ts';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/sync.yml', import.meta.url));

describe('sync schedule', () => {
  it('matches the cron expressions in the workflow exactly', async () => {
    const yaml = await readFile(WORKFLOW, 'utf8');
    const inYaml = [...yaml.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => m[1]);
    assert.deepEqual(inYaml, [...SYNC_SCHEDULES], 'code and workflow disagree about when syncs run');
  });

  it('has no concurrency group (D-46)', async () => {
    // One job never assigned a runner held the group for 24 hours and the
    // group cancelled the 51 runs queued behind it. Do not reintroduce it.
    const yaml = await readFile(WORKFLOW, 'utf8');
    assert.equal(/^concurrency:/m.test(yaml), false);
  });

  it('keeps the job timeout under the 15-minute lock staleness window', async () => {
    const yaml = await readFile(WORKFLOW, 'utf8');
    const minutes = Number(/timeout-minutes:\s*(\d+)/.exec(yaml)?.[1]);
    assert.ok(minutes > 0 && minutes < 15, `timeout-minutes is ${minutes}`);
  });

  it('counts nothing between consecutive daytime slots', () => {
    assert.equal(slotsBetween(new Date('2026-09-17T04:00:00Z'), new Date('2026-09-17T04:20:00Z')), 0);
  });

  it('counts the slots a gap skipped, across both cadences', () => {
    // The real outage: last run for 04:00Z on the 13th, next for 04:20Z on the
    // 14th. 54 slots in between: 1 stuck run, 51 cancelled behind it, and 2
    // that GitHub never created at all.
    assert.equal(slotsBetween(new Date('2026-09-13T04:00:00Z'), new Date('2026-09-14T04:20:00Z')), 54);
  });

  it('counts overnight gaps in hourly slots', () => {
    // 16:00Z to 20:00Z skips 17:00, 18:00 and 19:00.
    assert.equal(slotsBetween(new Date('2026-09-17T16:00:00Z'), new Date('2026-09-17T20:00:00Z')), 3);
  });

  it('reports from one hour of missed daytime runs', () => {
    assert.equal(MISSED_SLOTS_REPORT_THRESHOLD, 3);
  });
});
