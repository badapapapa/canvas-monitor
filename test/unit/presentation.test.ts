import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { IDENTITY_MASK, maskIdentity, suppressionNotice } from '../../src/core/presentation.ts';
import { readBootstrap } from '../../src/core/env.ts';

const base = { TURSO_DATABASE_URL: 'file:./test.db' };

describe('identity gate for command output', () => {
  it('prints identity in the clear when not under CI', () => {
    // This is the guarantee that makes `probe` and `discover` usable: reviewing
    // courses.seed.json by hand is impossible if identity is suppressed
    // locally. Redaction applies to the LOG stream, not to command output.
    assert.equal(maskIdentity(false, 'AB1234'), 'AB1234');
    assert.equal(maskIdentity(false, 'AB1234 Synthetic Module'), 'AB1234 Synthetic Module');
    assert.equal(maskIdentity(false, null), null);
    assert.equal(suppressionNotice(false), null);
  });

  it('suppresses identity under CI, where stdout is published', () => {
    assert.equal(maskIdentity(true, 'AB1234'), IDENTITY_MASK);
    assert.equal(maskIdentity(true, null), null, 'absent stays absent, rather than becoming a mask');
    assert.ok(suppressionNotice(true)?.includes('suppressed'));
  });
});

describe('CI detection', () => {
  it('is false in an ordinary local shell', () => {
    assert.equal(readBootstrap(base).ci, false);
  });

  it('is false for CI=false, which some scripts set explicitly', () => {
    // A false positive here would break the hand review of courses.seed.json,
    // so the check is exact-match rather than presence-of-variable.
    assert.equal(readBootstrap({ ...base, CI: 'false' }).ci, false);
    assert.equal(readBootstrap({ ...base, CI: '0' }).ci, false);
    assert.equal(readBootstrap({ ...base, CI: '' }).ci, false);
  });

  it('is true for the values GitHub Actions and other CI systems set', () => {
    assert.equal(readBootstrap({ ...base, CI: 'true' }).ci, true);
    assert.equal(readBootstrap({ ...base, CI: '1' }).ci, true);
    assert.equal(readBootstrap({ ...base, GITHUB_ACTIONS: 'true' }).ci, true);
  });
});
