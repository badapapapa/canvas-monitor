/**
 * Keepalive (SPEC.md section 11; DECISIONS.md D-79): GitHub disables a quiet
 * repository's scheduled workflows after 60 days, and now drops most scheduled
 * runs. Between the age at which keepalive pushes and day 60 there must be
 * enough tries that losing every one of them is very unlikely.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import { parseCron } from '../../src/core/cron.ts';

const yaml = readFileSync('.github/workflows/keepalive.yml', 'utf8');
const DAY = 86_400_000;

describe('keepalive', () => {
  it('tries often enough that a 60% drop rate cannot run out the 60 days (all lost: under 1 in 100)', () => {
    const crons = [...yaml.matchAll(/^\s*-\s*cron:\s*'([^']+)'/gm)].map((m) => parseCron(m[1]!));
    assert.equal(crons.length, 1);
    const pushAfterDays = Number(/"\$age_days" -lt (\d+)/.exec(yaml)?.[1]);
    assert.ok(pushAfterDays > 0 && pushAfterDays < 60, 'the age at which it pushes');

    // Every try in 2027 and early 2028, at minute resolution.
    const tries: number[] = [];
    for (let t = Date.UTC(2027, 0, 1); t < Date.UTC(2028, 3, 1); t += 60_000) if (crons[0]!.matches(new Date(t))) tries.push(t);

    // For a last commit at any hour of 2027: how many tries fall between the push age and day 60?
    let fewest = Infinity;
    for (let last = Date.UTC(2027, 0, 1); last < Date.UTC(2028, 0, 1); last += 3_600_000) {
      const from = last + pushAfterDays * DAY;
      const to = last + 60 * DAY;
      fewest = Math.min(fewest, tries.filter((t) => t >= from && t < to).length);
    }
    const allLost = 0.6 ** fewest;
    assert.ok(allLost < 0.01, `only ${fewest} tries before day 60: all lost with probability ${allLost.toFixed(3)}`);
  });

  it('pushes only an empty commit, as the bot', () => {
    assert.match(yaml, /git commit --allow-empty -m "keepalive: prevent scheduled workflows being disabled"/);
    assert.match(yaml, /^permissions:\n  contents: write\n/m);
  });
});
