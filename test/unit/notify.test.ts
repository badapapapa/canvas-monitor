import { strict as assert } from 'node:assert';
import { after, describe, it } from 'node:test';
import { escapeHtml, formatSgt, pack, relativeTo, render, renderDigest, type ContentPayload } from '../../src/notify/render.ts';
import { batchKey } from '../../src/notify/queue.ts';
import { tokenExpiryCondition } from '../../src/notify/ops.ts';
import { MESSAGE_LIMIT, TelegramClient } from '../../src/notify/telegram.ts';
import { scrubString } from '../../src/core/redact.ts';
import { latestSlotAtOrBefore, parseCron } from '../../src/core/cron.ts';
import { silentLogger } from '../../src/core/log.ts';
import { startServer, sendJson, type FakeServer } from '../helpers/fake-canvas.ts';

const NOW = new Date('2026-09-11T04:00:00Z'); // 12:00 SGT

function payload(items: ContentPayload['items'], label = 'AB1234'): ContentPayload {
  return { kind: 'content', contextLabel: label, items };
}

describe('render', () => {
  it('escapes instructor text so it can never become markup', () => {
    const [msg] = render(
      payload([
        {
          resourceType: 'announcement',
          kind: 'new',
          title: '<b>Urgent</b> & <script>',
          url: 'https://canvas.example/courses/1/discussion_topics/2?a=1&b="x"',
          change: null,
          postedAt: null,
          dueAt: null,
          preview: 'Use <i>this</i> & not </a><a href="evil">',
        },
      ]),
      NOW,
    );
    assert.ok(msg !== undefined);
    assert.ok(msg.includes('&lt;b&gt;Urgent&lt;/b&gt; &amp; &lt;script&gt;'));
    assert.ok(msg.includes('&lt;/a&gt;&lt;a href="evil"&gt;') || msg.includes('&lt;/a&gt;&lt;a href=&quot;evil&quot;&gt;') || msg.includes('&lt;/a&gt;&lt;a href="evil"&gt;'));
    assert.ok(!msg.includes('<script>'), 'raw script tag leaked');
    assert.ok(msg.includes('href="https://canvas.example/courses/1/discussion_topics/2?a=1&amp;b=&quot;x&quot;"'));
  });

  it('formats times in SGT, so a 23:59 deadline shows as 23:59', () => {
    // 2026-09-19T15:59Z is Saturday 23:59 in Singapore.
    assert.equal(formatSgt('2026-09-19T15:59:00Z'), 'Sat 19 Sep, 23:59');
    assert.equal(formatSgt('2026-09-19T16:00:00Z'), 'Sun 20 Sep, 00:00');
  });

  it('renders relative time for the reader, not for the queue', () => {
    assert.equal(relativeTo('2026-09-11T09:00:00Z', NOW), 'in 5h');
    assert.equal(relativeTo('2026-09-19T04:00:00Z', NOW), 'in 8d');
    assert.equal(relativeTo('2026-09-11T03:00:00Z', NOW), 'overdue');
  });

  it('leads with a moved due date and shows before and after', () => {
    const [msg] = render(
      payload([
        {
          resourceType: 'assignment',
          kind: 'revised',
          title: 'Assignment 1',
          url: null,
          change: {
            kind: 'assignment',
            changes: [{ field: 'due_at', from: '2026-09-19T15:59:00Z', to: '2026-09-22T15:59:00Z' }],
          },
          postedAt: null,
          dueAt: '2026-09-22T15:59:00Z',
        },
      ]),
      NOW,
    );
    assert.match(msg ?? '', /Due date changed/);
    assert.match(msg ?? '', /Sat 19 Sep, 23:59 → <b>Tue 22 Sep, 23:59<\/b>/);
  });

  it('shows both dates when Canvas disagrees with itself (D-13)', () => {
    const [msg] = render(
      payload([
        {
          resourceType: 'assignment',
          kind: 'new',
          title: 'A2',
          url: null,
          change: null,
          postedAt: null,
          dueAt: '2026-09-19T15:59:00Z',
          otherDueDates: ['2026-09-20T15:59:00Z'],
        },
      ]),
      NOW,
    );
    assert.match(msg ?? '', /Canvas also lists Sun 20 Sep, 23:59/);
  });

  it('shows a posted grade with its points', () => {
    const [msg] = render(
      payload([
        {
          resourceType: 'grade',
          kind: 'revised',
          title: 'Quiz 1',
          url: null,
          change: { kind: 'grade', transition: 'posted' },
          postedAt: null,
          dueAt: null,
          grade: { score: 8, grade: '8', pointsPossible: 10, excused: false },
        },
      ]),
      NOW,
    );
    assert.match(msg ?? '', /Grade posted: <b>Quiz 1<\/b> — <b>8 \/ 10<\/b>/);
  });

  it('splits long batches on item boundaries, every message under the limit', () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      resourceType: 'announcement' as const,
      kind: 'new' as const,
      title: `Announcement ${i}`,
      url: null,
      change: null,
      postedAt: null,
      dueAt: null,
      preview: 'x'.repeat(190),
    }));
    const msgs = render(payload(items), NOW);
    assert.ok(msgs.length > 1, 'expected a split');
    for (const m of msgs) assert.ok(m.length <= MESSAGE_LIMIT, `message of ${m.length} chars`);
    const all = msgs.join('\n');
    for (let i = 0; i < 60; i += 1) assert.ok(all.includes(`Announcement ${i}<`), `item ${i} lost in the split`);
    assert.match(msgs[1] ?? '', /continued/);
  });

  it('truncates a single oversized block rather than dropping it', () => {
    const msgs = pack('H', 'C', ['y'.repeat(MESSAGE_LIMIT * 2)]);
    assert.equal(msgs.length, 1);
    assert.ok((msgs[0] ?? '').length <= MESSAGE_LIMIT);
    assert.ok((msgs[0] ?? '').endsWith('…'));
  });

  it('merges held notifications into one overnight digest, grouped by course', () => {
    const item = (title: string) => ({
      resourceType: 'announcement' as const, kind: 'new' as const, title, url: null, change: null, postedAt: null, dueAt: null,
    });
    const msgs = renderDigest(
      [payload([item('a1')], 'AB1234'), payload([item('b1')], 'CD3456'), payload([item('a2')], 'AB1234')],
      NOW,
    );
    assert.equal(msgs.length, 1);
    const msg = msgs[0] ?? '';
    assert.match(msg, /Overnight<\/b> · 3 updates/);
    assert.equal(msg.split('<b>AB1234</b>').length - 1, 1, 'one section per course');
  });

  it('escapes text helpers consistently', () => {
    assert.equal(escapeHtml('a<b>&c'), 'a&lt;b&gt;&amp;c');
  });
});

describe('now watching summary', () => {
  it('pluralises correctly and names posted grades as such', () => {
    const [msg] = render(
      { kind: 'watching', contexts: [{ label: 'AB1234', counts: { announcement: 1, assignment: 3, grade: 1 } }, { label: 'CD3456', counts: {} }] },
      NOW,
    );
    assert.match(msg ?? '', /AB1234<\/b> — 1 announcement, 3 assignments, 1 posted grade/);
    assert.match(msg ?? '', /CD3456<\/b> — nothing posted yet/);
  });
});

describe('batch keys', () => {
  it('differ when the same item changes again', () => {
    // The bug this prevents: an id-only key would collide on the second due
    // date change and the UNIQUE constraint would silently drop it.
    const first = batchKey('content', [{ id: 'item-1', contentHash: 'v1' }]);
    const second = batchKey('content', [{ id: 'item-1', contentHash: 'v2' }]);
    assert.notEqual(first, second);
  });

  it('are identical for identical content, so a retry collides with itself', () => {
    const a = batchKey('content', [{ id: 'x', contentHash: '1' }, { id: 'y', contentHash: '2' }]);
    const b = batchKey('content', [{ id: 'y', contentHash: '2' }, { id: 'x', contentHash: '1' }]);
    assert.equal(a, b, 'order must not matter');
  });
});

describe('token expiry ladder', () => {
  it('climbs T-14, T-7, T-3, T-1 as distinct rungs of one family', () => {
    assert.equal(tokenExpiryCondition(30), null);
    assert.equal(tokenExpiryCondition(14)?.key, 'token_expiry@14');
    assert.equal(tokenExpiryCondition(10)?.key, 'token_expiry@14');
    assert.equal(tokenExpiryCondition(7)?.key, 'token_expiry@7');
    assert.equal(tokenExpiryCondition(3)?.key, 'token_expiry@3');
    assert.equal(tokenExpiryCondition(1)?.key, 'token_expiry@1');
    assert.equal(tokenExpiryCondition(0)?.key, 'token_expiry@expired');
    assert.equal(tokenExpiryCondition(null)?.key, 'token_expiry@unknown');
  });

  it('never reminds within a rung, except once expired', () => {
    assert.equal(tokenExpiryCondition(7)?.remindEveryMs, null);
    assert.equal(tokenExpiryCondition(0)?.remindEveryMs, undefined, 'expired uses the critical cadence');
    assert.equal(tokenExpiryCondition(3)?.severity, 'critical');
  });
});

describe('cron slot reconstruction', () => {
  it('matches the two production schedules and nothing else', () => {
    const day = parseCron('*/20 0-14 * * *');
    const night = parseCron('0 15-23 * * *');
    assert.equal(day.matches(new Date('2026-09-11T00:00:00Z')), true);
    assert.equal(day.matches(new Date('2026-09-11T14:40:00Z')), true);
    assert.equal(day.matches(new Date('2026-09-11T15:00:00Z')), false);
    assert.equal(night.matches(new Date('2026-09-11T15:00:00Z')), true);
    assert.equal(night.matches(new Date('2026-09-11T15:20:00Z')), false);
  });

  it('finds the slot a late run was meant for', () => {
    const slot = latestSlotAtOrBefore('*/20 0-14 * * *', new Date('2026-09-11T04:07:31Z'));
    assert.equal(slot?.toISOString(), '2026-09-11T04:00:00.000Z');
  });

  it('under-reports drift once it exceeds the cadence -- a documented lower bound (D-43)', () => {
    // Fired for 04:00, started 04:25: the latest matching slot is 04:20.
    const slot = latestSlotAtOrBefore('*/20 0-14 * * *', new Date('2026-09-11T04:25:00Z'));
    assert.equal(slot?.toISOString(), '2026-09-11T04:20:00.000Z');
  });

  it('rejects malformed expressions', () => {
    assert.throws(() => parseCron('* * *'));
    assert.throws(() => parseCron('61 * * * *'));
    assert.throws(() => parseCron('*/0 * * * *'));
  });
});

describe('telegram client', () => {
  const servers: FakeServer[] = [];
  after(async () => {
    await Promise.all(servers.map((s) => s.close()));
  });
  const token = ['123456789', 'A'.repeat(35)].join(':');

  it('scrubs the bot token even inside the Bot API URL', () => {
    // A boundary-anchored pattern would miss this: "bot" and the digits are
    // both word characters.
    const leaked = `request to https://api.telegram.org/bot${token}/sendMessage failed`;
    const scrubbed = scrubString(leaked);
    assert.ok(!scrubbed.includes('A'.repeat(35)), scrubbed);
    assert.match(scrubbed, /bot\[token\]\/sendMessage/);
  });

  it('sends HTML with previews disabled and reports the message id', async () => {
    let body: Record<string, unknown> = {};
    const server = await startServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        body = JSON.parse(raw) as Record<string, unknown>;
        sendJson(res, 200, { ok: true, result: { message_id: 77 } });
      });
    });
    servers.push(server);
    const client = new TelegramClient({ token, log: silentLogger(), apiBase: server.url });
    const result = await client.send('-100', '<b>hi</b>', { silent: true });
    assert.deepEqual(result, { ok: true, messageId: 77 });
    assert.equal(body['parse_mode'], 'HTML');
    assert.equal(body['disable_notification'], true);
    assert.deepEqual(body['link_preview_options'], { is_disabled: true });
    assert.match(server.requests[0]?.url ?? '', /^\/bot\d+:A+\/sendMessage$/);
  });

  it('honours retry_after on 429, then succeeds', async () => {
    const server = await startServer((req, res, hits) => {
      req.resume();
      req.on('end', () => {
        if (hits === 1) sendJson(res, 429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } });
        else sendJson(res, 200, { ok: true, result: { message_id: 1 } });
      });
    });
    servers.push(server);
    const client = new TelegramClient({ token, log: silentLogger(), apiBase: server.url });
    const result = await client.send('1', 'x');
    assert.equal(result.ok, true);
    assert.equal(server.requests.length, 2);
  });

  it('marks a 403 (bot blocked, never /started) as permanent', async () => {
    const server = await startServer((req, res) => {
      req.resume();
      req.on('end', () => sendJson(res, 403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
    });
    servers.push(server);
    const client = new TelegramClient({ token, log: silentLogger(), apiBase: server.url });
    const result = await client.send('1', 'x');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.retryable, false);
  });

  it('marks a network failure retryable and leaks no token in the description', async () => {
    const client = new TelegramClient({ token, log: silentLogger(), apiBase: 'http://127.0.0.1:1', timeoutMs: 2000 });
    const result = await client.send('1', 'x');
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.retryable, true);
    assert.ok(!result.ok && !result.description.includes('A'.repeat(35)));
  });
});
