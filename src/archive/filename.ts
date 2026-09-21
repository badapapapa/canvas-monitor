/**
 * Names that are safe in OneDrive AND on the Windows machine it syncs to
 * (SPEC.md section 5).
 *
 * Every path segment the archive writes -- term, module code, category, file
 * name -- passes through `safeSegment`. The Graph guard (graph/guard.ts)
 * independently rejects any segment that is not already safe, so a name that
 * skipped this function cannot reach OneDrive.
 */

/** Characters forbidden by Windows and OneDrive, plus the path separators. */
const FORBIDDEN = /["*:<>?/\\|]/g;
// Control characters, built from code points so the source holds no raw ones.
const CONTROL = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`, 'g');

/** Windows reserved device names, forbidden as a stem with any extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function splitExtension(name: string): { stem: string; ext: string } {
  const dot = name.lastIndexOf('.');
  // A leading dot (".env") or no dot at all means there is no extension.
  if (dot <= 0 || dot === name.length - 1) return { stem: name, ext: '' };
  const ext = name.slice(dot);
  // Treat only short, plain suffixes as extensions; "Report v1.2 final" is a stem.
  return /^\.[A-Za-z0-9]{1,8}$/.test(ext) ? { stem: name.slice(0, dot), ext } : { stem: name, ext: '' };
}

/**
 * One safe path segment. Never returns an empty string, "." or "..".
 *
 * `maxLength` truncates the STEM and always keeps the extension, so a long
 * lecture title stays openable as a PDF.
 */
export function safeSegment(raw: string, maxLength = 120): string {
  let name = raw.normalize('NFC').replace(CONTROL, '').replace(FORBIDDEN, '_');
  name = name.replace(/\s+/g, ' ').trim();
  // Trailing dots and spaces are silently dropped by Windows, which would make
  // two distinct names collide on disk.
  name = name.replace(/[. ]+$/, '');

  let { stem, ext } = splitExtension(name);
  // Windows strips trailing dots and spaces from the END of a name only.
  // "Slides ..pdf" is valid as it is; trimming its stem would make it collide
  // with a real "Slides.pdf".
  if (ext === '') stem = stem.replace(/[. ]+$/, '');
  if (RESERVED.test(stem)) stem = `${stem}_`;
  if (stem === '' || stem === '.' || stem === '..') stem = '_';

  const room = Math.max(1, maxLength - ext.length);
  if (stem.length > room) {
    stem = stem.slice(0, room);
    if (ext === '') stem = stem.replace(/[. ]+$/, '');
    if (stem === '') stem = '_';
  }
  return `${stem}${ext}`;
}

/** Collision key: OneDrive and Windows both compare names case-insensitively. */
export function collisionKey(name: string): string {
  return name.normalize('NFC').toLowerCase();
}

/**
 * The archive name used when the plain name is taken: the Canvas upload date,
 * then a counter (SPEC.md section 9). Never overwrite; add alongside.
 */
export function alternateName(name: string, uploadedSgtDate: string, attempt: number): string {
  const { stem, ext } = splitExtension(name);
  const tag = attempt <= 1 ? `uploaded ${uploadedSgtDate}` : `uploaded ${uploadedSgtDate} ${attempt}`;
  return `${stem} (${tag})${ext}`;
}

/**
 * Fit a relative path under a total length budget by shortening the file
 * name's stem. The budget leaves room for the local OneDrive prefix on
 * Windows (e.g. C:\Users\<name>\OneDrive\Apps\<app>\), under the 260-char limit.
 */
export function fitPath(dirs: string[], file: string, budget: number): string[] {
  const dirLength = dirs.reduce((n, d) => n + d.length + 1, 0);
  const room = budget - dirLength;
  if (room < 8) throw new Error(`path budget ${budget} leaves no room for a file name under ${dirs.join('/')}`);
  return [...dirs, file.length <= room ? file : safeSegment(file, room)];
}
