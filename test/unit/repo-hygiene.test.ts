import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const FIXTURES = path.join(REPO, 'test', 'fixtures');

const SKIP_DIRS = new Set(['node_modules', '.git', 'var', 'data', 'dist', '.next']);
const SKIP_FILES = new Set(['package-lock.json']);

/**
 * Files that legitimately contain PII-SHAPED strings: fabricated inputs used to
 * prove the redactor removes them. Every value in these files is invented.
 *
 * Adding a path here requires justifying it. Anything not listed is flagged.
 */
const ALLOWLIST = new Set([
  path.join(REPO, 'src', 'core', 'redact.ts'),
  path.join(REPO, 'test', 'unit', 'redact.test.ts'),
  path.join(REPO, 'test', 'unit', 'raw-store.test.ts'),
  path.join(REPO, 'test', 'unit', 'repo-hygiene.test.ts'),
  path.join(REPO, 'scripts', 'scan-secrets.sh'),
]);

/** Placeholder domains a fixture is allowed to use. */
const PLACEHOLDER_DOMAINS = /@(example\.(test|com|org)|u\.example\.edu)\b/;

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const NUS_ID = /\bA\d{7}[A-Z]\b/g;
const CANVAS_TOKEN = /\b\d{3,6}~[A-Za-z0-9]{20,}\b/g;
const JWT = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.githooks' && entry.name !== '.gitignore') continue;
    if (SKIP_DIRS.has(entry.name) || SKIP_FILES.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

function findAll(text: string, pattern: RegExp): string[] {
  return [...text.matchAll(pattern)].map((m) => m[0]);
}

describe('repository hygiene', () => {
  it('contains no real email addresses or matriculation numbers', async () => {
    // Phase 1 brief, Decision 2, item 3. The repository goes public; this is
    // the check that the fixtures policy actually held, run continuously
    // rather than once.
    const offenders: string[] = [];

    for (const file of await walk(REPO)) {
      if (ALLOWLIST.has(file)) continue;
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue; // binary or unreadable
      }

      for (const hit of findAll(text, EMAIL)) {
        if (PLACEHOLDER_DOMAINS.test(hit)) continue;
        if (hit === 'noreply@anthropic.com') continue; // commit trailer only
        offenders.push(`${path.relative(REPO, file)}: ${hit}`);
      }
      for (const hit of findAll(text, NUS_ID)) {
        offenders.push(`${path.relative(REPO, file)}: ${hit}`);
      }
    }

    assert.deepEqual(offenders, [], `Personal data found in tracked files:\n${offenders.join('\n')}`);
  });

  it('contains no credential-shaped strings', async () => {
    const offenders: string[] = [];

    for (const file of await walk(REPO)) {
      if (ALLOWLIST.has(file)) continue;
      let text: string;
      try {
        text = await readFile(file, 'utf8');
      } catch {
        continue;
      }
      for (const hit of [...findAll(text, CANVAS_TOKEN), ...findAll(text, JWT)]) {
        offenders.push(`${path.relative(REPO, file)}: ${hit.slice(0, 24)}...`);
      }
    }

    assert.deepEqual(offenders, [], `Credential-shaped strings found:\n${offenders.join('\n')}`);
  });

  it('holds no fixture data files yet, and flags any that appear with real data', async () => {
    // Today this asserts the empty case honestly: the fixtures policy was
    // written before capture, as agreed, and has not yet been exercised because
    // no fixture exists. When Phase 2 promotes the first one, this test starts
    // doing real work rather than having to be remembered.
    const files = await walk(FIXTURES);
    const dataFiles = files.filter((f) => !f.endsWith('README.md'));

    for (const file of dataFiles) {
      const text = await readFile(file, 'utf8');
      const hits = [
        ...findAll(text, EMAIL).filter((h) => !PLACEHOLDER_DOMAINS.test(h)),
        ...findAll(text, NUS_ID),
        ...findAll(text, CANVAS_TOKEN),
      ];
      assert.deepEqual(
        hits,
        [],
        `Fixture ${path.relative(REPO, file)} contains real data: ${hits.join(', ')}\n` +
          'Promote fixtures by hand from var/raw and replace identifying values with placeholders.',
      );
    }
  });

  it('keeps .env.example free of populated secrets', async () => {
    const text = await readFile(path.join(REPO, '.env.example'), 'utf8');
    for (const line of text.split('\n')) {
      const match = /^\s*(TURSO_AUTH_TOKEN|CANVAS_TOKEN)\s*=\s*(.+)$/.exec(line);
      assert.equal(match, null, `.env.example has a populated secret: ${line}`);
    }
  });
});
