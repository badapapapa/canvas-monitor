import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { parseLinkHeader } from '../../src/canvas/paginate.ts';

describe('Link header parsing', () => {
  it('extracts every rel Canvas sends', () => {
    const header =
      '<https://canvas.nus.edu.sg/api/v1/courses?page=1&per_page=100>; rel="current",' +
      '<https://canvas.nus.edu.sg/api/v1/courses?page=2&per_page=100>; rel="next",' +
      '<https://canvas.nus.edu.sg/api/v1/courses?page=1&per_page=100>; rel="first",' +
      '<https://canvas.nus.edu.sg/api/v1/courses?page=4&per_page=100>; rel="last"';
    const links = parseLinkHeader(header);
    assert.equal(links.next, 'https://canvas.nus.edu.sg/api/v1/courses?page=2&per_page=100');
    assert.equal(links.last, 'https://canvas.nus.edu.sg/api/v1/courses?page=4&per_page=100');
  });

  it('does not split on commas inside the URL', () => {
    // Canvas embeds commas in include[] parameters. A naive split(',') here
    // drops the next link and silently truncates the collection at one page.
    const header =
      '<https://example.test/api/v1/courses?include[]=term,total_scores&page=2>; rel="next",' +
      '<https://example.test/api/v1/courses?include[]=term,total_scores&page=1>; rel="first"';
    const links = parseLinkHeader(header);
    assert.equal(links.next, 'https://example.test/api/v1/courses?include[]=term,total_scores&page=2');
    assert.equal(links.first, 'https://example.test/api/v1/courses?include[]=term,total_scores&page=1');
  });

  it('returns no next on the final page', () => {
    const links = parseLinkHeader('<https://example.test/x?page=3>; rel="current"');
    assert.equal(links.next, undefined);
  });

  it('tolerates absent, empty, and malformed headers', () => {
    assert.deepEqual(parseLinkHeader(null), {});
    assert.deepEqual(parseLinkHeader(''), {});
    assert.deepEqual(parseLinkHeader('garbage'), {});
  });

  it('accepts unquoted rel values', () => {
    assert.equal(parseLinkHeader('<https://example.test/x?page=2>; rel=next').next, 'https://example.test/x?page=2');
  });
});
