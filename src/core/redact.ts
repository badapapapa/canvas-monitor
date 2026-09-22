/**
 * The single redaction hook, shared by the logger and by the raw response
 * store (DECISIONS.md D-11, D-26). Two copies of this logic would mean two
 * places to forget, and the raw store is the one that starts capturing first.
 *
 * Three tiers, redacted by default, each with a distinct marker so a log line
 * says which class of thing was dropped:
 *
 *   PII_KEYS      -> "[redacted]"   emails, login ids, matriculation numbers
 *   IDENTITY_KEYS -> "[name]"       course names, module codes, file names,
 *                                   announcement titles, folder names
 *   BODY_KEYS     -> "[body:Nc]"    announcement and page bodies
 *
 * Numeric identifiers are deliberately KEPT. `canvas_course_id`, `context_id`
 * and `canvas_file_id` reveal nothing to a reader without a token, but they are
 * what makes a public log line actionable: "context 3 stale for 26 hours" is
 * something I can act on, "[name] stale for 26 hours" is not. Redaction that
 * destroys actionability would trade one SPEC.md section 2.1 failure for
 * another.
 *
 * What this is NOT: a security boundary. It is a data-minimisation pass over
 * structured JSON. `var/` is gitignored and pre-commit-blocked because
 * redaction is best-effort and a repo is forever.
 */

/** Keys whose value is replaced wholesale, wherever they appear. */
const PII_KEYS = new Set([
  'email',
  'primary_email',
  'login_id',
  'sis_user_id',
  'sis_login_id',
  'integration_id',
  'avatar_url',
  'avatar_image_url',
  'bio',
  'pronouns',
  'sortable_name',
  'short_name',
  'user_name',
  'author_name',
  'anonymous_id',
]);

/**
 * Keys holding a person object. The subtree is replaced with just `{ id }`,
 * which is enough to correlate repeat appearances without naming anyone.
 */
const PERSON_KEYS = new Set(['user', 'author', 'editor', 'enrollment_user', 'created_by']);

/**
 * Keys naming a course, a module, a file, or a posting. Not personal data in
 * the PII sense, but this repository is public and its Actions logs are public
 * with it (DECISIONS.md D-10). Which modules I take, and what my lecturers
 * name their files, is not something a stranger reading CI output should learn.
 */
const IDENTITY_KEYS = new Set([
  'name',
  'display_name',
  'course_name',
  'course_code',
  'module_code',
  'module_name',
  'title',
  'filename',
  'file_name',
  'folder_name',
  'canvas_folder_name',
  'normalised_stem',
  'stem',
  'onedrive_path',
  'path',
  'target_folder',
  'subject',
  'section_name',
]);

/** Keys holding free text that may quote or name people. Dropped unless debug. */
const BODY_KEYS = new Set([
  'body',
  'message',
  // Rendered Telegram payloads. The message text is the whole point of the
  // bot and must never reach a public Actions log.
  'text',
  'html',
  'caption',
  'description',
  'body_text',
  'syllabus_body',
  'extracted_text',
  'comment',
  'preview_url',
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** NUS matriculation numbers, e.g. A0123456X. */
const NUSID_RE = /\bA\d{7}[A-Z]\b/g;
/** Anything that looks like a bearer token or Canvas access token. */
const TOKEN_RE = /\b\d{3,6}~[A-Za-z0-9]{20,}\b/g;
/**
 * Telegram bot tokens. Deliberately NO leading word boundary: the token sits
 * inside the Bot API URL as `/bot<digits>:<secret>/`, where "bot" and the digits
 * are both word characters, so a boundary-anchored pattern never matches the
 * one place the token actually appears -- a fetch error quoting the URL.
 */
const TELEGRAM_TOKEN_RE = /\d{5,15}:[A-Za-z0-9_-]{30,}/g;
/**
 * Pre-authenticated OneDrive URLs (DECISIONS.md D-56). Whoever holds one can
 * read or write that item with no other credential. Personal OneDrive puts the
 * credential in a `tempauth` query value; the documented form puts it in the
 * path of an `*.up.1drv.com/up/...` upload URL. Both are removed ALWAYS,
 * including under --unsafe-log: there is no debugging reason to see them.
 */
const TEMPAUTH_RE = /(tempauth=)[^&\s"'<>]+/gi;
const UPLOAD_PATH_RE = /https:\/\/[^\s"'<>/]*\.up\.1drv\.com\/up\/[^\s"'<>]+/gi;
/** Keys whose value is a pre-authenticated URL, whatever it looks like. */
const CREDENTIAL_URL_KEYS = new Set(['uploadurl', 'downloadurl', '@microsoft.graph.downloadurl', '@content.downloadurl']);

export interface RedactOptions {
  /** Keep free-text bodies. Only ever true under --unsafe-log, never in CI. */
  keepBodies?: boolean;
  /** Keep course names, module codes, file names. Only under --unsafe-log. */
  keepIdentity?: boolean;
  /** Maximum recursion depth before a subtree is elided. */
  maxDepth?: number;
}

export function scrubString(input: string): string {
  return input
    .replace(TEMPAUTH_RE, '$1[redacted]')
    .replace(UPLOAD_PATH_RE, '[upload-url]')
    .replace(TOKEN_RE, '[token]')
    .replace(TELEGRAM_TOKEN_RE, '[token]')
    .replace(EMAIL_RE, '[email]')
    .replace(NUSID_RE, '[nusid]');
}

export function redact(value: unknown, options: RedactOptions = {}): unknown {
  return walk(value, options, options.maxDepth ?? 12);
}

function walk(value: unknown, options: RedactOptions, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth <= 0) return '[depth-elided]';

  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };

  if (Array.isArray(value)) {
    return value.map((entry) => walk(entry, options, depth - 1));
  }

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();

      // First, and not subject to any option: credential URLs never print.
      if (CREDENTIAL_URL_KEYS.has(lower)) {
        out[key] = entry === null || entry === undefined ? entry : '[credential-url]';
        continue;
      }
      if (PII_KEYS.has(lower)) {
        out[key] = '[redacted]';
        continue;
      }
      if (PERSON_KEYS.has(lower)) {
        out[key] = shrinkPerson(entry);
        continue;
      }
      if (BODY_KEYS.has(lower) && options.keepBodies !== true) {
        out[key] = typeof entry === 'string' ? `[body:${entry.length}c]` : '[body]';
        continue;
      }
      if (IDENTITY_KEYS.has(lower) && options.keepIdentity !== true) {
        out[key] = entry === null || entry === undefined ? entry : '[name]';
        continue;
      }
      out[key] = walk(entry, options, depth - 1);
    }
    return out;
  }

  return '[unserialisable]';
}

function shrinkPerson(entry: unknown): unknown {
  if (entry === null || entry === undefined) return entry;
  if (typeof entry !== 'object' || Array.isArray(entry)) return '[redacted]';
  const id = (entry as Record<string, unknown>)['id'];
  return id === undefined ? '[redacted]' : { id };
}

/**
 * The one way diagnostic scripts print Graph or Canvas data (D-56). Names are
 * kept -- diagnostics run locally, for me -- but credentials never are:
 * pre-authenticated URLs, tempauth values and tokens are always removed.
 */
export function diagnostic(value: unknown): string {
  return JSON.stringify(redact(value, { keepBodies: true, keepIdentity: true }), null, 1);
}
