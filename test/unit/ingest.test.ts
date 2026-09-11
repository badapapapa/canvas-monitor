import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { htmlToText, preview } from '../../src/core/html.ts';
import { classify } from '../../src/ingest/classify.ts';
import {
  hashOf,
  normaliseAnnouncement,
  normaliseAssignment,
  normaliseComments,
  normaliseGrade,
} from '../../src/ingest/normalise.ts';
import type { CanvasAssignment, CanvasSubmission } from '../../src/canvas/types.ts';

const NOW = new Date('2026-09-11T04:00:00Z');

describe('htmlToText', () => {
  it('drops scripts and styles entirely, not just their tags', () => {
    const out = htmlToText('<p>Hello</p><script>alert(1)</script><style>p{}</style><p>World</p>');
    assert.equal(out, 'Hello\nWorld');
  });

  it('keeps structure: paragraphs, line breaks and list items', () => {
    assert.equal(htmlToText('<p>A</p><p>B<br>C</p><ul><li>one</li><li>two</li></ul>'), 'A\nB\nC\n\n• one\n• two');
  });

  it('decodes entities AFTER stripping, so encoded markup stays text', () => {
    // "&lt;b&gt;" must come out as the literal characters "<b>", which the
    // renderer escapes again. It must never become a real tag.
    assert.equal(htmlToText('5 &lt; 6 &amp; &lt;b&gt;bold&lt;/b&gt;'), '5 < 6 & <b>bold</b>');
    assert.equal(htmlToText('caf&#233; &#x2014; ok&nbsp;now'), 'café — ok now');
  });

  it('handles null, empty and plain text', () => {
    assert.equal(htmlToText(null), '');
    assert.equal(htmlToText(''), '');
    assert.equal(htmlToText('no markup'), 'no markup');
  });

  it('previews on a word boundary with an ellipsis', () => {
    const text = 'Tutorial six has moved to Friday afternoon because of the public holiday';
    const p = preview(text, 40);
    assert.ok(p.endsWith('…'));
    assert.ok(p.length <= 41);
    assert.ok(!p.slice(0, -1).endsWith(' '));
    assert.equal(preview('short', 40), 'short');
  });
});

describe('normalise', () => {
  it('hashes independently of key order', () => {
    assert.equal(hashOf({ a: 1, b: 2 }), hashOf({ b: 2, a: 1 }));
    assert.notEqual(hashOf({ a: 1 }), hashOf({ a: 2 }));
  });

  it('detects an announcement edit from content alone, since there is no updated_at', () => {
    const a = normaliseAnnouncement({ id: 1, title: 'Week 3', message: '<p>Room A</p>' }, NOW);
    const b = normaliseAnnouncement({ id: 1, title: 'Week 3', message: '<p>Room B</p>' }, NOW);
    assert.ok(a !== null && b !== null);
    assert.notEqual(a.contentHash, b.contentHash);
  });

  it('skips a delayed announcement that is not live yet', () => {
    const future = normaliseAnnouncement({ id: 2, title: 't', delayed_post_at: '2026-09-12T00:00:00Z' }, NOW);
    const past = normaliseAnnouncement({ id: 3, title: 't', delayed_post_at: '2026-09-10T00:00:00Z' }, NOW);
    assert.equal(future, null);
    assert.ok(past !== null);
  });

  it('flags all_dates that disagree with due_at instead of picking one (D-13)', () => {
    const a = normaliseAssignment({
      id: 5,
      name: 'A1',
      due_at: '2026-09-19T15:59:00Z',
      all_dates: [{ due_at: '2026-09-19T15:59:00Z' }, { due_at: '2026-09-20T15:59:00Z' }],
    });
    assert.deepEqual(a.meta['other_due_dates'], ['2026-09-20T15:59:00Z']);
  });

  it('records no disagreement when all_dates agrees, as observed live', () => {
    const a = normaliseAssignment({ id: 6, name: 'A', due_at: '2026-09-19T15:59:00Z', all_dates: [{ due_at: '2026-09-19T15:59:00Z' }] });
    assert.equal(a.meta['other_due_dates'], undefined);
  });

  it('treats a held grade as not news, and keeps any score out of the hash', () => {
    // Observed live: workflow_state graded, posted_at null, score null.
    const held: CanvasSubmission = { id: 9, assignment_id: 5, workflow_state: 'graded', posted_at: null, score: 7 };
    const g = normaliseGrade(held, undefined);
    assert.equal(g.notifiable, false);
    assert.equal(g.contentHash, normaliseGrade({ ...held, score: 3 }, undefined).contentHash);
  });

  it('treats a posted grade as news', () => {
    const g = normaliseGrade({ id: 9, assignment_id: 5, posted_at: '2026-09-11T00:00:00Z', score: 8 }, { id: 5, name: 'Quiz', points_possible: 10 });
    assert.equal(g.notifiable, true);
    assert.equal(g.title, 'Quiz');
  });

  it('ignores my own submission comments', () => {
    const items = normaliseComments(
      {
        id: 1,
        assignment_id: 5,
        submission_comments: [
          { id: 100, author_id: 42, comment: 'my question' },
          { id: 101, author_id: 7, comment: 'tutor reply' },
        ],
      },
      undefined,
      42,
    );
    assert.deepEqual(items.map((i) => i.externalId), ['101']);
  });
});

function assignment(over: Partial<CanvasAssignment> = {}) {
  return normaliseAssignment({ id: 5, name: 'A1', due_at: '2026-09-19T15:59:00Z', published: true, ...over });
}

describe('classify', () => {
  it('records everything as seen on a baseline (silent_sync, D-41)', () => {
    const c = classify(assignment(), undefined, { baseline: true });
    assert.equal(c.kind, 'new');
    assert.equal(c.notify, false);
  });

  it('notifies a genuinely new item after the baseline', () => {
    const c = classify(assignment(), undefined, { baseline: false });
    assert.equal(c.notify, true);
  });

  it('says nothing about an unchanged item', () => {
    const r = assignment();
    const c = classify(r, { contentHash: r.contentHash, meta: r.meta }, { baseline: false });
    assert.equal(c.kind, 'unchanged');
    assert.equal(c.notify, false);
  });

  it('names a moved due date, first, with before and after', () => {
    const before = assignment();
    const after = assignment({ due_at: '2026-09-22T15:59:00Z' });
    const c = classify(after, { contentHash: before.contentHash, meta: before.meta }, { baseline: false });
    assert.equal(c.kind, 'revised');
    assert.equal(c.notify, true);
    assert.equal(c.change?.kind, 'assignment');
    const first = c.change?.kind === 'assignment' ? c.change.changes[0] : undefined;
    assert.deepEqual(first, { field: 'due_at', from: '2026-09-19T15:59:00Z', to: '2026-09-22T15:59:00Z' });
  });

  it('still notifies a description-only edit: changed requirements matter', () => {
    const before = assignment({ description: '<p>Two pages</p>' });
    const after = assignment({ description: '<p>Three pages</p>' });
    const c = classify(after, { contentHash: before.contentHash, meta: before.meta }, { baseline: false });
    assert.equal(c.notify, true);
    assert.deepEqual(c.change?.kind === 'assignment' ? c.change.changes.map((x) => x.field) : [], ['description_hash']);
  });

  it('announces a grade when it is posted, not when it is graded', () => {
    const held = normaliseGrade({ id: 9, assignment_id: 5, workflow_state: 'graded', posted_at: null }, undefined);
    const posted = normaliseGrade({ id: 9, assignment_id: 5, posted_at: '2026-09-11T00:00:00Z', score: 8 }, undefined);

    const whileHeld = classify(held, undefined, { baseline: false });
    assert.equal(whileHeld.notify, false, 'a held grade must not notify');

    const onPost = classify(posted, { contentHash: held.contentHash, meta: held.meta }, { baseline: false });
    assert.equal(onPost.notify, true);
    assert.deepEqual(onPost.change, { kind: 'grade', transition: 'posted' });
  });

  it('says nothing when a posted grade is hidden again', () => {
    const posted = normaliseGrade({ id: 9, assignment_id: 5, posted_at: '2026-09-11T00:00:00Z', score: 8 }, undefined);
    const hidden = normaliseGrade({ id: 9, assignment_id: 5, posted_at: null }, undefined);
    const c = classify(hidden, { contentHash: posted.contentHash, meta: posted.meta }, { baseline: false });
    assert.equal(c.notify, false);
  });

  it('never notifies during a baseline, even for a revision', () => {
    const before = assignment();
    const after = assignment({ due_at: '2026-09-22T15:59:00Z' });
    const c = classify(after, { contentHash: before.contentHash, meta: before.meta }, { baseline: true });
    assert.equal(c.notify, false);
  });

  it('does not notify an unpublished assignment', () => {
    const c = classify(assignment({ published: false }), undefined, { baseline: false });
    assert.equal(c.notify, false);
  });
});
