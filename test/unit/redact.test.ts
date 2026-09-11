import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { redact, scrubString } from '../../src/core/redact.ts';
import { createLogger } from '../../src/core/log.ts';
import { fixedClock } from '../../src/core/clock.ts';

describe('redaction', () => {
  it('scrubs emails, matriculation numbers, and Canvas tokens from free text', () => {
    assert.equal(scrubString('contact e0123456@u.nus.edu today'), 'contact [email] today');
    assert.equal(scrubString('student A0234567X submitted'), 'student [nusid] submitted');
    // Assembled at runtime so the literal never appears in source. A
    // token-shaped string in a committed file trips the pre-commit credential
    // scan, and would trip gitleaks and GitHub push protection the same way.
    const fakeToken = ['10521', 'AbCdEfGhIjKlMnOpQrStUvWxYz012345'].join('~');
    assert.equal(scrubString(`token ${fakeToken} leaked`), 'token [token] leaked');
  });

  it('replaces person subtrees with just an id', () => {
    // Other students appear in discussion topics and submission comments.
    // Their identity is incidental to this system; their id is enough to
    // correlate repeat appearances.
    const out = redact({
      id: 12,
      author: { id: 99, display_name: 'Someone Else', avatar_url: 'https://x/y.png' },
    }) as Record<string, unknown>;
    assert.deepEqual(out['author'], { id: 99 });
  });

  it('blanks known PII keys wherever they appear', () => {
    const out = redact({ user_profile: { login_id: 'e0123456', sortable_name: 'Tan, Ben' } }) as {
      user_profile: Record<string, unknown>;
    };
    assert.equal(out.user_profile['login_id'], '[redacted]');
    assert.equal(out.user_profile['sortable_name'], '[redacted]');
  });

  it('drops free-text bodies by default and keeps them only when asked', () => {
    const announcement = { id: 1, title: 'Week 6', message: '<p>See you Thursday</p>' };
    const stripped = redact(announcement) as Record<string, unknown>;
    assert.equal(stripped['message'], '[body:23c]');

    const kept = redact(announcement, { keepBodies: true }) as Record<string, unknown>;
    assert.equal(kept['message'], '<p>See you Thursday</p>');
  });

  it('drops identifying names by default, keeping numeric ids', () => {
    // DECISIONS.md D-26. The repository is public and Actions logs are public
    // with it: which modules I take, and what my lecturers name their files, is
    // not something a stranger reading CI output should learn.
    const file = {
      canvas_file_id: 991,
      context_id: 3,
      display_name: 'Tutorial 6 Solutions.pdf',
      canvas_folder_name: 'Tutorials',
      module_code: 'AB1234',
      title: 'Week 6 announcement',
    };
    const stripped = redact(file) as Record<string, unknown>;

    assert.equal(stripped['display_name'], '[name]');
    assert.equal(stripped['canvas_folder_name'], '[name]');
    assert.equal(stripped['module_code'], '[name]');
    assert.equal(stripped['title'], '[name]');

    // Ids survive: they are meaningless without a token, and they are what
    // makes a redacted log line actionable at all.
    assert.equal(stripped['canvas_file_id'], 991);
    assert.equal(stripped['context_id'], 3);
  });

  it('lifts both tiers together under the unsafe flag', () => {
    const entry = { display_name: 'Week 6 Slides.pdf', message: 'body text' };
    const unsafe = redact(entry, { keepBodies: true, keepIdentity: true }) as Record<string, unknown>;
    assert.equal(unsafe['display_name'], 'Week 6 Slides.pdf');
    assert.equal(unsafe['message'], 'body text');
  });

  it('still removes third-party PII even when identity is kept', () => {
    // Raw captures keep identity so that --replay can tune routing rules on
    // real file names. Other people's data is dropped at every tier.
    const entry = {
      display_name: 'Tutorial 6.pdf',
      author: { id: 4, display_name: 'Someone Else' },
      login_id: 'e0123456',
      note: 'ask A0234567X',
    };
    const kept = redact(entry, { keepBodies: true, keepIdentity: true }) as Record<string, unknown>;
    assert.equal(kept['display_name'], 'Tutorial 6.pdf');
    assert.deepEqual(kept['author'], { id: 4 });
    assert.equal(kept['login_id'], '[redacted]');
    assert.equal(kept['note'], 'ask [nusid]');
  });

  it('elides rather than recursing forever on a deep structure', () => {
    let nested: Record<string, unknown> = { end: true };
    for (let i = 0; i < 40; i += 1) nested = { nested };
    assert.doesNotThrow(() => redact(nested));
  });
});

describe('logger', () => {
  it('emits one JSON line per event, carrying the run id', () => {
    const lines: string[] = [];
    const log = createLogger({
      runId: 'run-1',
      level: 'info',
      clock: fixedClock('2026-08-27T05:00:00Z'),
      sink: (line) => lines.push(line),
    });

    log.info('probe.start', { courses: 3 });

    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(entry['run_id'], 'run-1');
    assert.equal(entry['event'], 'probe.start');
    assert.equal(entry['courses'], 3);
    assert.equal(entry['ts'], '2026-08-27T05:00:00.000Z');
  });

  it('redacts by default, without needing to be asked', () => {
    // GitHub Actions logs are public because the repo is public
    // (DECISIONS.md D-10, D-26). This must hold regardless of call-site
    // discipline, and regardless of level -- note this logger has no `unsafe`
    // option set at all, which is the point: forgetting is safe.
    const lines: string[] = [];
    const log = createLogger({
      runId: 'run-2',
      level: 'debug',
      clock: fixedClock('2026-08-27T05:00:00Z'),
      sink: (line) => lines.push(line),
    });

    log.info('item.new', {
      context_id: 3,
      title: 'Tutorial 6',
      body: 'Full announcement text here',
    });

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(entry['title'], '[name]');
    assert.ok(String(entry['body']).startsWith('[body:'), 'body must not survive');
    assert.equal(entry['context_id'], 3, 'the id must survive, or the line is unactionable');
  });

  it('emits in the clear only when explicitly made unsafe', () => {
    const lines: string[] = [];
    const log = createLogger({
      runId: 'run-4',
      level: 'info',
      clock: fixedClock('2026-08-27T05:00:00Z'),
      unsafe: true,
      sink: (line) => lines.push(line),
    });

    log.info('item.new', { title: 'Tutorial 6', body: 'Full text' });

    const entry = JSON.parse(lines[0] ?? '{}') as Record<string, unknown>;
    assert.equal(entry['title'], 'Tutorial 6');
    assert.equal(entry['body'], 'Full text');
  });

  it('suppresses entries below the configured level', () => {
    const lines: string[] = [];
    const log = createLogger({
      runId: 'run-3',
      level: 'warn',
      clock: fixedClock('2026-08-27T05:00:00Z'),
      sink: (line) => lines.push(line),
    });
    log.info('ignored', {});
    log.warn('kept', {});
    assert.equal(lines.length, 1);
  });
});
