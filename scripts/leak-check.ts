/**
 * `npm run leak-check` -- is any of MY real data in this public repository?
 *
 * DECISIONS.md D-39 and D-48. The committed repo-hygiene test covers generic
 * shapes (emails, matriculation numbers, credentials). It cannot cover module
 * codes, course names, Canvas ids or file names, because listing mine in a
 * public test would be the leak.
 *
 * So the patterns are built HERE, at run time, from local sources that are
 * never committed:
 *
 *   courses.seed.json   module codes, Canvas course and group ids, course and
 *                       group names, my canvas_user_id    (gitignored)
 *   the database        titles of every stored announcement, assignment and
 *                       file, when .env is present          (never committed);
 *                       plus every SHORT file name (under 16 characters),
 *                       matched only as a whole file name -- "src.zip" in a
 *                       path or quotes, never inside "mysrc.zip" -- minus the
 *                       generic ones listed in leak-check.allow (gitignored:
 *                       one name per line, since listing real names in the
 *                       repo would itself be the leak)
 *
 * and searched for in every tracked file, every object in git history, and
 * every commit message. Nothing identifying is printed except the hits
 * themselves, which you need to see to fix.
 *
 * Local only: it refuses to run under CI, where its output would be public.
 */

import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const SEED = path.join(ROOT, 'courses.seed.json');

if (process.env['CI'] === 'true' || process.env['GITHUB_ACTIONS'] === 'true') {
  console.error('leak-check is local only: its output names the data it looks for.');
  process.exit(2);
}
if (!existsSync(SEED)) {
  console.error('courses.seed.json not found. Run `npm run discover` first; the check derives its patterns from it.');
  process.exit(2);
}

interface Needle {
  kind: string;
  text: string;
  /** Match on word boundaries (ids and codes), not as a raw substring. */
  word: boolean;
  /** Match only as a whole file name: no letter, digit, '.', '-' or '_' either side. */
  filename?: boolean;
}

const needles = new Map<string, Needle>();
const add = (kind: string, text: string | null | undefined, word: boolean, min: number): void => {
  const t = (text ?? '').trim();
  if (t.length >= min && !needles.has(t)) needles.set(t, { kind, text: t, word });
};

// --- from the seed file ------------------------------------------------------
interface SeedContext {
  context_type: string;
  canvas_id: number;
  display_name: string | null;
  course_code: string | null;
  parent_canvas_course_id?: number | null;
  proposed: { module_code: string | null; module_code_alternatives: string[] };
}
const seed = JSON.parse(readFileSync(SEED, 'utf8')) as { canvas_user_id?: number; contexts: SeedContext[] };
add('canvas user id', String(seed.canvas_user_id ?? ''), true, 4);
for (const c of seed.contexts) {
  add(`canvas ${c.context_type} id`, String(c.canvas_id), true, 4);
  if (c.parent_canvas_course_id) add('canvas course id', String(c.parent_canvas_course_id), true, 4);
  add('module code', c.proposed.module_code, true, 4);
  for (const alt of c.proposed.module_code_alternatives ?? []) add('module code', alt, true, 4);
  for (const code of (c.course_code ?? '').split(/[/\s]+/)) add('module code', code, true, 4);
  // Names: the whole name, and the descriptive part without codes or term tag.
  add(`${c.context_type} name`, c.display_name, false, 5);
  const descriptive = (c.display_name ?? '')
    .replace(/\[\d+\]/g, '')
    .replace(/\b[A-Z]{2,4}\d{4}[A-Z]?\b(\/\b[A-Z]{2,4}\d{4}[A-Z]?\b)*/g, '')
    .replace(/^[\s\-–:]+|[\s\-–:]+$/g, '');
  add(`${c.context_type} name`, descriptive, false, 12);
}

// --- from the database, when available ---------------------------------------
let titles = 0;
let shortNames = 0;
let allowedNames = 0;
let dbNote = 'database not checked (no .env)';
const ALLOW_FILE = path.join(ROOT, 'leak-check.allow');
const allowList = new Set(
  existsSync(ALLOW_FILE) ? readFileSync(ALLOW_FILE, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l !== '' && !l.startsWith('#')) : [],
);
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  /* optional */
}
if (process.env['TURSO_DATABASE_URL'] !== undefined) {
  const { createClient } = await import('@libsql/client');
  const authToken = process.env['TURSO_AUTH_TOKEN'];
  const db = createClient(
    authToken === undefined ? { url: process.env['TURSO_DATABASE_URL'] } : { url: process.env['TURSO_DATABASE_URL'], authToken },
  );
  try {
    const rows = await db.execute('SELECT DISTINCT title FROM items WHERE title IS NOT NULL');
    for (const r of rows.rows) {
      const before = needles.size;
      // Short titles ("Quiz 1", "src.zip") are too generic to be evidence.
      add('item title', String(r['title']), false, 16);
      if (needles.size > before) titles += 1;
    }
    // Short FILE names: generic ones are allowed by name; the rest must never appear as a file name.
    const short = await db.execute("SELECT DISTINCT title FROM items WHERE resource_type = 'file' AND title IS NOT NULL AND length(title) < 16");
    for (const r of short.rows) {
      const t = String(r['title']).trim();
      if (t.length < 3 || !/\.[A-Za-z0-9]{1,8}$/.test(t) || needles.has(t)) continue;
      if (allowList.has(t)) {
        allowedNames += 1;
        continue;
      }
      needles.set(t, { kind: 'short file name', text: t, word: false, filename: true });
      shortNames += 1;
    }
    dbNote = `${titles} distinct titles of 16+ characters, and ${shortNames} short file names (${allowedNames} allowed as generic by leak-check.allow), from the database`;
  } catch (error) {
    dbNote = `database not checked: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    db.close();
  }
}

// Term codes and years are shared by every NUS student; they identify no one.
for (const t of ['2610', '2520', '2026', '2025', '2027']) needles.delete(t);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patterns = [...needles.values()].map((n) => ({
  ...n,
  re: new RegExp(
    n.filename === true ? `(?<![A-Za-z0-9._-])${escape(n.text)}(?![A-Za-z0-9._-])`
      : n.word ? `(?<![A-Za-z0-9])${escape(n.text)}(?![A-Za-z0-9])` : escape(n.text),
  ),
}));

// The one deliberate exception: SPEC.md's notification mock-up, as I wrote it.
const allowed = (file: string, line: string): boolean => file === 'SPEC.md' && /^\S+ — 3 new files$/.test(line.trim());

// --- positive control ----------------------------------------------------------
const seedText = readFileSync(SEED, 'utf8');
const control = patterns.filter((p) => p.re.test(seedText)).length;

interface Hit {
  where: string;
  kind: string;
  text: string;
}
const hits: Hit[] = [];
const scanText = (where: string, file: string, text: string): void => {
  const lines = text.split('\n');
  for (const p of patterns) {
    if (!p.re.test(text)) continue;
    lines.forEach((line, i) => {
      if (p.re.test(line) && !allowed(file, line)) hits.push({ where: `${where}:${i + 1}`, kind: p.kind, text: p.text });
    });
  }
};

// 1. Every tracked file, as it is on disk now.
const git = (...args: string[]): Buffer => execFileSync('git', ['-C', ROOT, ...args], { maxBuffer: 1 << 30 });
const tracked = git('ls-files', '-z').toString().split('\0').filter(Boolean);
for (const f of tracked) {
  const full = path.join(ROOT, f);
  if (existsSync(full)) scanText(f, f, readFileSync(full, 'utf8'));
}

// 2. Every object in history (blobs, trees, commits), decompressed.
const objects = git('cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)')
  .toString()
  .trim()
  .split('\n')
  .filter(Boolean);
let historyHits = 0;
for (const line of objects) {
  const [oid, type] = line.split(' ') as [string, string];
  if (type !== 'blob' && type !== 'commit') continue;
  const body = git('cat-file', '-p', oid).toString();
  for (const p of patterns) {
    if (!p.re.test(body)) continue;
    const offending = body.split('\n').filter((l) => p.re.test(l) && !/^\S+ — 3 new files$/.test(l.trim()));
    if (offending.length > 0) {
      historyHits += 1;
      hits.push({ where: `history ${type} ${oid.slice(0, 10)}`, kind: p.kind, text: p.text });
    }
  }
}

// 3. Anything ignored that is nevertheless tracked.
const ignoredButTracked = git('ls-files', '-ci', '--exclude-standard', '-z').toString().split('\0').filter(Boolean);

console.log('leak-check');
console.log(`  patterns   ${patterns.length} identifiers derived from courses.seed.json and ${dbNote}`);
console.log(`  control    ${control} of them found in courses.seed.json itself (must be > 0, or the patterns are broken)`);
console.log(`  scanned    ${tracked.length} tracked files, ${objects.length} git objects`);
console.log(`  allowed    SPEC.md's "<code> — 3 new files" mock-up, by design`);
console.log(`  ignored-but-tracked files: ${ignoredButTracked.length}${ignoredButTracked.length ? ` (${ignoredButTracked.join(', ')})` : ''}`);
console.log('');
for (const h of hits) console.log(`  HIT  ${h.where}  [${h.kind}]  ${h.text}`);

const ok = control > 0 && hits.length === 0 && ignoredButTracked.length === 0;
console.log(
  ok
    ? `  CLEAN: none of your identifiers appear in the working tree, history (${objects.length} objects) or commit messages.`
    : control === 0
      ? '  FAILED: the positive control found nothing, so a clean result would mean nothing.'
      : `  FAILED: ${hits.length} hit(s)${historyHits > 0 ? `, ${historyHits} of them in history` : ''}.`,
);
process.exit(ok ? 0 : 1);
