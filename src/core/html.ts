/**
 * Instructor HTML to plain text, for notification previews.
 *
 * SPEC.md section 13 forbids RENDERING instructor HTML unsanitised. Nothing in
 * Phase 2 renders it: announcement bodies are reduced to plain text here, and
 * every piece of text is HTML-escaped again before it enters a Telegram
 * message. Markup cannot survive the round trip -- `&lt;script&gt;` decodes to
 * the literal characters "<script>", which the renderer escapes back. DOMPurify
 * is for Phase 8, when a dashboard actually renders instructor HTML.
 */

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED[body.toLowerCase()] ?? match;
  });
}

export function htmlToText(html: string | null | undefined): string {
  if (html === null || html === undefined || html === '') return '';
  const text = html
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n• ')
    // Not </li>: each <li> already opens its own line, so closing one too
    // double-spaced every list.
    .replace(/<\/(p|div|h[1-6]|tr|blockquote|ul|ol|table)>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  return decodeEntities(text)
    .replace(/\u00a0/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** First `max` characters on a word boundary, with an ellipsis if cut. */
export function preview(text: string, max = 200): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
