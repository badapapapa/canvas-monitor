/**
 * Canvas pagination (SPEC.md section 4).
 *
 * Canvas paginates via the RFC 5988 `Link` header. There is no total-count
 * field and no page-number arithmetic that is safe to do by hand: the only
 * correct way to know there is more is `rel="next"` being present. Never
 * assume a single page.
 */

export interface LinkRels {
  current?: string;
  next?: string;
  prev?: string;
  first?: string;
  last?: string;
}

const LINK_ENTRY = /<([^>]+)>\s*;\s*(.+)/;
const REL_VALUE = /rel\s*=\s*"?([^",;]+)"?/i;

export function parseLinkHeader(header: string | null): LinkRels {
  const out: LinkRels = {};
  if (header === null || header.trim() === '') return out;

  for (const chunk of splitLinkHeader(header)) {
    const match = LINK_ENTRY.exec(chunk.trim());
    if (match === null) continue;
    const url = match[1];
    const params = match[2];
    if (url === undefined || params === undefined) continue;
    const rel = REL_VALUE.exec(params)?.[1]?.trim().toLowerCase();
    if (rel === 'current' || rel === 'next' || rel === 'prev' || rel === 'first' || rel === 'last') {
      out[rel] = url;
    }
  }
  return out;
}

/**
 * Split on commas that separate entries, not on commas inside the `<...>` URL.
 * Canvas URLs contain encoded commas in `include[]` params often enough that
 * a naive `header.split(',')` drops pages.
 */
function splitLinkHeader(header: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < header.length; i += 1) {
    const ch = header[i];
    if (ch === '<') depth += 1;
    else if (ch === '>') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(header.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(header.slice(start));
  return parts.filter((p) => p.trim() !== '');
}
