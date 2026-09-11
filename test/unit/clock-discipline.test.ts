import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(fileURLToPath(new URL('../../src', import.meta.url)));
const ALLOWED = new Set([path.join(SRC, 'core', 'clock.ts')]);

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

describe('clock discipline', () => {
  it('reads the wall clock only in core/clock.ts', async () => {
    // Watermark correctness depends on timestamps being injectable. SPEC.md
    // section 7 is explicit that a watermark must never be derived from
    // Date.now(); one stray call is a poll window that silently skips.
    const offenders: string[] = [];

    for (const file of await walk(SRC)) {
      if (ALLOWED.has(file)) continue;
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');

      lines.forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        if (/\bDate\.now\s*\(/.test(code) || /\bnew\s+Date\s*\(\s*\)/.test(code)) {
          offenders.push(`${path.relative(SRC, file)}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    assert.deepEqual(
      offenders,
      [],
      `Wall-clock reads outside core/clock.ts:\n${offenders.join('\n')}\n\nInject a Clock instead.`,
    );
  });
});
