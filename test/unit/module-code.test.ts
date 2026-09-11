import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import {
  currentTermCode,
  extractModuleCodes,
  findSharedCodeGroups,
  isNonAcademic,
  parseTerm,
  proposeEnabled,
} from '../../src/discover/module-code.ts';

describe('module code extraction', () => {
  it('matches four-letter prefixes, which the spec regex silently mangles', () => {
    // SPEC.md originally said [A-Z]{2,3}. Against a four-letter prefix that does not fail --
    // it matches ESS1025, one character in. A wrong module code becomes a wrong
    // OneDrive folder, decided once and never revisited.
    assert.equal(extractModuleCodes('ABCD1234 Synthetic Course').primary, 'ABCD1234');
    assert.equal(/[A-Z]{2,3}\d{4}[A-Z]?/.exec('ABCD1234')?.[0], 'BCD1234');
  });

  it('extracts both codes from a combined offering', () => {
    const codes = extractModuleCodes(null, 'XYZ1001/XYW1002 Synthetic Combined Offering [2610]');
    assert.deepEqual(codes.all, ['XYZ1001', 'XYW1002']);
    assert.equal(codes.primary, 'XYZ1001');
  });

  it('handles the trailing-letter form', () => {
    assert.equal(extractModuleCodes('CS2030S Programming Methodology II').primary, 'CS2030S');
    assert.equal(extractModuleCodes('DAO1704X Statistics').primary, 'DAO1704X');
  });

  it('deduplicates across course_code and name', () => {
    assert.deepEqual(extractModuleCodes('AB1234', 'AB1234 Synthetic Module [2610]').all, ['AB1234']);
  });

  it('returns null rather than guessing when nothing matches', () => {
    assert.equal(extractModuleCodes('Synthetic Admin Course').primary, null);
    assert.equal(extractModuleCodes(null, undefined).primary, null);
  });
});

describe('term parsing', () => {
  it('extracts the bracketed code, which is the grouping key', () => {
    // The full string contains slashes that path sanitising would strip anyway.
    const term = parseTerm('[2610] 2026/2027 Semester 1');
    assert.equal(term.code, '2610');
    assert.equal(term.name, '[2610] 2026/2027 Semester 1');
  });

  it('treats a site with no term code as non-academic', () => {
    const term = parseTerm('Non-Academic');
    assert.equal(term.code, null);
    assert.equal(isNonAcademic(term), true);
  });

  it('picks the highest code as the current term', () => {
    const terms = ['[2520] 2025/2026 Semester 2', '[2610] 2026/2027 Semester 1', 'Non-Academic'].map(parseTerm);
    assert.equal(currentTermCode(terms), '2610');
  });

  it('returns null when no term carries a code', () => {
    assert.equal(currentTermCode([parseTerm('Non-Academic')]), null);
  });
});

describe('enablement proposal', () => {
  it('enables the current term only', () => {
    assert.equal(proposeEnabled(parseTerm('[2610] 2026/2027 Semester 1'), '2610').enabled, true);
    assert.equal(proposeEnabled(parseTerm('[2520] 2025/2026 Semester 2'), '2610').enabled, false);
  });

  it('disables administrative sites', () => {
    const proposal = proposeEnabled(parseTerm('Non-Academic'), '2610');
    assert.equal(proposal.enabled, false);
    assert.equal(proposal.reason, 'non_academic');
  });

  it('defaults to disabled when no current term can be determined', () => {
    // Failing closed keeps a misread from silently polling everything.
    assert.equal(proposeEnabled(parseTerm('[2610] x'), null).enabled, false);
  });
});

describe('shared module code grouping', () => {
  it('flags courses sharing a code', () => {
    const groups = findSharedCodeGroups([
      { canvasId: 1, codes: ['AB1234'] },
      { canvasId: 2, codes: ['AB1234'] },
      { canvasId: 3, codes: ['CD3456'] },
    ]);
    assert.deepEqual(groups.get('AB1234'), [1, 2]);
    assert.equal(groups.has('CD3456'), false);
  });

  it('finds nothing when every module is a single site', () => {
    // The observed shape as of 2026-09-10; this branch is unexercised in reality.
    const groups = findSharedCodeGroups([
      { canvasId: 1, codes: ['AB1234'] },
      { canvasId: 2, codes: ['XYZ1001', 'XYW1002'] },
      { canvasId: 3, codes: ['CD3456'] },
    ]);
    assert.equal(groups.size, 0);
  });
});
