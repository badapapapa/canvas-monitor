/**
 * Mirror stalls (DECISIONS.md D-74): a Mac notification only after a file has
 * waited 24 hours, at most daily, and one more when it clears. Invented ids.
 */

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classify, evaluateStall, notifyMac, type StallState } from '../../src/mirror/stall.ts';

const T0 = new Date('2026-10-04T00:00:00Z');
const at = (hours: number) => new Date(T0.getTime() + hours * 3600_000);
const deferred = (...items: Array<[string, string]>) => ({ deferred: items.map(([id, reason]) => ({ id, from: 'x', reason })) });
const NOT_HERE = 'not on this Mac yet';
const MINUS_11 = 'could not read the source (online-only and offline, or syncing): Unknown system error -11';

describe('mirror stalls', () => {
  it('says nothing for the first 24 hours a file waits', () => {
    let s: StallState | null = null;
    for (const h of [0, 1, 12, 23.9]) {
      const r = evaluateStall(s, deferred(['a', NOT_HERE]), at(h));
      assert.equal(r.notice, null, `at ${h} h`);
      s = r.next;
    }
    assert.equal(s?.waiting['a']?.since, T0.toISOString(), 'the FIRST deferral is kept');
  });

  it('after 24 hours: one notice with how many and why; then at most daily', () => {
    let s = evaluateStall(null, deferred(['a', NOT_HERE], ['b', MINUS_11]), at(0)).next;
    const r = evaluateStall(s, deferred(['a', NOT_HERE], ['b', MINUS_11]), at(24));
    assert.deepEqual(r.notice, { title: 'Canvas mirror: files waiting', body: '2 files have been waiting more than 24 hours to be copied: 1 not on this Mac yet; 1 online-only; macOS refused the download.' });
    s = r.next;
    assert.equal(evaluateStall(s, deferred(['a', NOT_HERE], ['b', MINUS_11]), at(30)).notice, null, 'not every run');
    assert.notEqual(evaluateStall(s, deferred(['a', NOT_HERE], ['b', MINUS_11]), at(48)).notice, null, 'reminded a day later');
  });

  it('a file that stops being deferred is forgotten, and the clearing is announced once', () => {
    let s = evaluateStall(null, deferred(['a', NOT_HERE]), at(0)).next;
    s = evaluateStall(s, deferred(['a', NOT_HERE]), at(25)).next; // notified
    const cleared = evaluateStall(s, deferred(), at(26));
    assert.deepEqual(cleared.notice?.title, 'Canvas mirror: cleared');
    assert.deepEqual(cleared.next.waiting, {});
    assert.equal(evaluateStall(cleared.next, deferred(), at(27)).notice, null, 'only once');
  });

  it('a file deferred again later starts its 24 hours afresh', () => {
    let s = evaluateStall(null, deferred(['a', NOT_HERE]), at(0)).next;
    s = evaluateStall(s, deferred(), at(1)).next; // copied
    s = evaluateStall(s, deferred(['a', NOT_HERE]), at(20)).next;
    assert.equal(evaluateStall(s, deferred(['a', NOT_HERE]), at(30)).notice, null);
  });

  it('classifies the reasons the mirror gives', () => {
    assert.equal(classify(NOT_HERE), 'not_here');
    assert.equal(classify(MINUS_11), 'online_only');
    assert.equal(classify('could not read the source (online-only and offline, or syncing): read stalled'), 'unreadable');
    assert.equal(classify('source does not match the archive yet (still syncing?)'), 'syncing');
  });

  it('shows the notice with osascript and arguments only: nothing in the text can run', () => {
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const fake = ((cmd: string, args: readonly string[]) => { calls.push({ cmd, args }); return { status: 0 }; }) as unknown as typeof import('node:child_process').spawnSync;
    assert.equal(notifyMac({ title: 'T "x"', body: 'b\\\\ "; do shell script "rm -rf ~"' }, fake), true);
    assert.equal(calls[0]?.cmd, '/usr/bin/osascript');
    assert.equal(calls[0]?.args.length, 2);
    assert.equal(calls[0]?.args[1], 'display notification "b\\\\\\\\ \\"; do shell script \\"rm -rf ~\\"" with title "T \\"x\\""');
  });
});
