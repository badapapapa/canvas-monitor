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

  it('counts nothing between consecutive slots, by day, by night and across the switch', () => {
    assert.equal(slotsBetween(new Date('2026-09-17T04:07:00Z'), new Date('2026-09-17T04:17:00Z')), 0);
    assert.equal(slotsBetween(new Date('2026-09-17T16:13:00Z'), new Date('2026-09-17T16:43:00Z')), 0);
    assert.equal(slotsBetween(new Date('2026-09-17T14:57:00Z'), new Date('2026-09-17T15:13:00Z')), 0, 'day to night');
    assert.equal(slotsBetween(new Date('2026-09-17T23:43:00Z'), new Date('2026-09-18T00:07:00Z')), 0, 'night to day');
  });

  it('has 108 slots a day: every 10 minutes for 15 hours, every 30 for 9 (D-75)', () => {
    assert.equal(slotsBetween(new Date('2026-09-13T04:07:00Z'), new Date('2026-09-14T04:17:00Z')), 108);
  });

  it('counts overnight gaps in half-hour slots', () => {
    // 16:13Z to 20:13Z skips 16:43, 17:13, 17:43, 18:13, 18:43, 19:13 and 19:43.
    assert.equal(slotsBetween(new Date('2026-09-17T16:13:00Z'), new Date('2026-09-17T20:13:00Z')), 7);
  });

  it("keeps every slot off GitHub's busiest minutes: :00, :15, :20, :30, :40, :45 (D-75)", () => {
    const busy = new Set([0, 15, 20, 30, 40, 45]);
    const minutes = SYNC_SCHEDULES.flatMap((c) => c.split(' ')[0]!.split(',').map(Number));
    assert.ok(minutes.every((m) => Number.isInteger(m) && !busy.has(m)), `slot minutes ${minutes.join(',')}`);
  });

  it('reports from three missed slots: 30 minutes by day, 90 at night', () => {
    assert.equal(MISSED_SLOTS_REPORT_THRESHOLD, 3);
  });
});
