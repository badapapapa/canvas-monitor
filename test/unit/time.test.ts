import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  SGT_OFFSET_MINUTES,
  isQuietHours,
  parseCanvasTs,
  quietHoursReleaseAt,
  sgtDayKey,
  sgtHour,
  sgtToUtc,
  toSgtParts,
} from '../../src/core/time.ts';

describe('SGT conversion', () => {
  it('buckets a 23:59 SGT deadline on the SGT day, not the UTC day', () => {
    // SPEC.md section 4: 23:59 SGT is 15:59Z. Bucketing this naively puts a
    // Thursday deadline on Wednesday, which is the entire point of the module.
    const deadline = new Date('2026-03-05T15:59:00Z');
    assert.equal(sgtDayKey(deadline), '2026-03-05');
    assert.equal(sgtHour(deadline), 23);
  });

  it('rolls to the next SGT day at 16:00Z exactly', () => {
    assert.equal(sgtDayKey(new Date('2026-03-05T15:59:59Z')), '2026-03-05');
    assert.equal(sgtDayKey(new Date('2026-03-05T16:00:00Z')), '2026-03-06');
  });

  it('renders SGT midnight as hour 0, not hour 24', () => {
    const midnight = new Date('2026-03-05T16:00:00Z');
    assert.equal(sgtHour(midnight), 0);
    assert.deepEqual(toSgtParts(midnight), {
      year: 2026, month: 3, day: 6, hour: 0, minute: 0, second: 0,
    });
  });

  it('round-trips sgtToUtc against the formatter', () => {
    const utc = sgtToUtc(2026, 8, 27, 21, 30, 0);
    assert.equal(utc.toISOString(), '2026-08-27T13:30:00.000Z');
    assert.equal(sgtDayKey(utc), '2026-08-27');
    assert.equal(sgtHour(utc), 21);
  });

  it('asserts the fixed +08:00 offset claim against Intl across the year', () => {
    // SGT_OFFSET_MINUTES is a claim about the world, not a fact about code.
    // If Singapore ever adopts DST, this fails before anything drifts silently.
    for (const iso of [
      '2026-01-15T00:00:00Z', '2026-04-15T00:00:00Z',
      '2026-07-15T00:00:00Z', '2026-10-15T00:00:00Z',
      '2027-12-31T23:00:00Z',
    ]) {
      const at = new Date(iso);
      const parts = toSgtParts(at);
      const reconstructed = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
      assert.equal(
        (reconstructed - at.getTime()) / 60_000,
        SGT_OFFSET_MINUTES,
        `offset drifted at ${iso}`,
      );
    }
  });
});

describe('quiet hours', () => {
  it('covers 22:00 to 06:59 SGT inclusive', () => {
    assert.equal(isQuietHours(sgtToUtc(2026, 8, 27, 21, 59)), false);
    assert.equal(isQuietHours(sgtToUtc(2026, 8, 27, 22, 0)), true);
    assert.equal(isQuietHours(sgtToUtc(2026, 8, 28, 3, 0)), true);
    assert.equal(isQuietHours(sgtToUtc(2026, 8, 28, 6, 59)), true);
    assert.equal(isQuietHours(sgtToUtc(2026, 8, 28, 7, 0)), false);
  });

  it('releases pre-dawn holds the same morning', () => {
    const held = sgtToUtc(2026, 8, 28, 3, 15);
    assert.equal(quietHoursReleaseAt(held).toISOString(), sgtToUtc(2026, 8, 28, 7, 0).toISOString());
  });

  it('releases late-night holds the next morning', () => {
    const held = sgtToUtc(2026, 8, 27, 23, 40);
    assert.equal(quietHoursReleaseAt(held).toISOString(), sgtToUtc(2026, 8, 28, 7, 0).toISOString());
  });

  it('crosses a month boundary when releasing', () => {
    const held = sgtToUtc(2026, 8, 31, 22, 30);
    assert.equal(quietHoursReleaseAt(held).toISOString(), sgtToUtc(2026, 9, 1, 7, 0).toISOString());
  });
});

describe('parseCanvasTs', () => {
  it('returns null rather than an Invalid Date', () => {
    // An Invalid Date propagates as NaN into watermark comparisons, where every
    // comparison is false and the polling window silently collapses.
    assert.equal(parseCanvasTs(null), null);
    assert.equal(parseCanvasTs(undefined), null);
    assert.equal(parseCanvasTs(''), null);
    assert.equal(parseCanvasTs('not-a-date'), null);
    assert.equal(parseCanvasTs('2026-08-27T05:00:00Z')?.toISOString(), '2026-08-27T05:00:00.000Z');
  });
});
