import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { RateLimitGovernor } from '../../src/canvas/rate-limit.ts';
import { silentLogger } from '../../src/core/log.ts';

const headers = (entries: Record<string, string>): Headers => new Headers(entries);

describe('rate limit governor', () => {
  it('has no threshold before it has seen a bucket', () => {
    // The spec's original "sleep below 100" presumes a ceiling it never states.
    // Until Canvas tells us the ceiling, there is nothing to be a fraction of.
    const governor = new RateLimitGovernor(silentLogger());
    assert.equal(governor.threshold, null);
    assert.equal(governor.shouldPause(), false);
  });

  it('derives the threshold from the observed ceiling, not a constant', () => {
    // 700 is the real NUS bucket, observed on the first live probe (D-31).
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({ 'x-rate-limit-remaining': '700', 'x-request-cost': '0.15' }));
    assert.equal(governor.threshold, 140);
    assert.equal(governor.snapshot().ceiling, 700);
    assert.equal(governor.snapshot().lastCost, 0.15);
  });

  it('anchors the threshold at the known NUS ceiling when readings arrive drained', () => {
    // Joining mid-drain must not teach the governor that the bucket is tiny.
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({ 'x-rate-limit-remaining': '120' }));
    assert.equal(governor.threshold, 140, 'threshold must not collapse to 24');
    assert.equal(governor.shouldPause(), true, 'a drained bucket should pause immediately');
  });

  it('still follows the evidence if the real bucket is larger', () => {
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({ 'x-rate-limit-remaining': '1500' }));
    assert.equal(governor.threshold, 300);
  });

  it('raises the ceiling when a higher reading arrives', () => {
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({ 'x-rate-limit-remaining': '300' }));
    governor.observe(headers({ 'x-rate-limit-remaining': '690' }));
    assert.equal(governor.snapshot().ceiling, 690);
  });

  it('pauses below the threshold and not above it', () => {
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({ 'x-rate-limit-remaining': '700' }));

    governor.observe(headers({ 'x-rate-limit-remaining': '200' }));
    assert.equal(governor.shouldPause(), false);


    governor.observe(headers({ 'x-rate-limit-remaining': '120' }));
    assert.equal(governor.shouldPause(), true);
  });

  it('waits longer the deeper into the bucket it gets', () => {
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({ 'x-rate-limit-remaining': '700' }));

    governor.observe(headers({ 'x-rate-limit-remaining': '139' }));
    const shallow = governor.pauseMs();

    governor.observe(headers({ 'x-rate-limit-remaining': '5' }));
    const deep = governor.pauseMs();

    assert.ok(shallow > 0, 'expected a pause just under the threshold');
    assert.ok(deep > shallow, `expected deeper deficit to wait longer (${deep} vs ${shallow})`);
    assert.ok(deep <= 30_000, 'pause must stay bounded');
  });

  it('ignores responses that carry no rate-limit headers', () => {
    const governor = new RateLimitGovernor(silentLogger());
    governor.observe(headers({}));
    assert.equal(governor.snapshot().ceiling, null);
    assert.equal(governor.shouldPause(), false);
  });
});
