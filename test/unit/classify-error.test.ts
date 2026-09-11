import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { classifyResponse } from '../../src/canvas/classify-error.ts';

const h = (entries: Record<string, string> = {}): Headers => new Headers(entries);

describe('Canvas error classification', () => {
  it('treats 404 as denied_or_absent, never as an empty collection', () => {
    // SPEC.md section 2.2 / 4: Canvas returns 404 for permission denial. A
    // course whose Files tab is off is indistinguishable by status code from a
    // course with no files, so neither may become [].
    const result = classifyResponse(404, h(), '{"errors":[{"message":"The specified resource does not exist."}]}');
    assert.equal(result.kind, 'denied_or_absent');
  });

  it('separates 403-as-rate-limit from 403-as-permission-denied', () => {
    const rateLimited = classifyResponse(403, h(), '403 Forbidden (Rate Limit Exceeded)');
    assert.equal(rateLimited.kind, 'retryable');
    assert.equal(rateLimited.kind === 'retryable' && rateLimited.code, 'rate_limited');

    const denied = classifyResponse(403, h(), '{"status":"unauthorized"}');
    assert.equal(denied.kind, 'denied_or_absent');
  });

  it('detects rate limiting from an exhausted bucket header even without body text', () => {
    const result = classifyResponse(403, h({ 'x-rate-limit-remaining': '0' }), 'Forbidden');
    assert.equal(result.kind, 'retryable');
  });

  it('never retries a 401 -- a dead token does not recover by waiting', () => {
    const result = classifyResponse(401, h(), 'Invalid access token.');
    assert.equal(result.kind, 'fatal');
    assert.equal(result.kind === 'fatal' && result.code, 'auth');
  });

  it('retries 5xx and 429, and honours Retry-After', () => {
    assert.equal(classifyResponse(500, h(), 'boom').kind, 'retryable');
    assert.equal(classifyResponse(503, h(), 'maintenance').kind, 'retryable');

    const throttled = classifyResponse(429, h({ 'retry-after': '3' }), 'slow down');
    assert.equal(throttled.kind, 'retryable');
    assert.equal(throttled.kind === 'retryable' && throttled.retryAfterMs, 3000);
  });

  it('passes 2xx through', () => {
    assert.equal(classifyResponse(200, h(), '[]').kind, 'ok');
    assert.equal(classifyResponse(204, h(), '').kind, 'ok');
  });

  it('treats an unrecognised 4xx as fatal rather than guessing', () => {
    const result = classifyResponse(422, h(), 'unprocessable');
    assert.equal(result.kind, 'fatal');
  });
});
