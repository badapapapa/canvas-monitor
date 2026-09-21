/**
 * Fetch a file's bytes from Canvas (SPEC.md sections 4 and 7).
 *
 * The file object's `url` carries a time-limited verifier, so the object is
 * re-fetched immediately before every download and the URL is never stored.
 * The download redirects to Canvas's storage host on another origin. The NUS
 * token is attached ONLY to a request whose origin is the configured Canvas
 * origin, decided here on every hop: redirects are followed by hand, never by
 * fetch. This does not rely on Canvas always handing back its own origin, nor
 * on the HTTP client stripping the header (which test/unit/canvas-http.test.ts
 * still pins, as a second layer).
 *
 * Files are at most 50 MB (the size gate), so they are held in memory rather
 * than streamed to a `.part` file -- verified against Canvas's reported size
 * and the response's Content-Length before anything is uploaded.
 */

import { createHash } from 'node:crypto';
import type { CanvasClient, FileContextKind } from '../canvas/client.ts';
import { describe } from '../core/result.ts';

export type DownloadResult =
  | { kind: 'ok'; bytes: Uint8Array; sha256: string; sha1: string }
  | { kind: 'locked' | 'too_large' | 'gone' | 'error'; detail: string; reason: string };

export async function downloadCanvasFile(options: {
  canvas: CanvasClient;
  contextKind: FileContextKind;
  contextCanvasId: number;
  fileId: number;
  token: string;
  /** The configured Canvas origin; the only origin that ever sees the token. */
  canvasOrigin: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<DownloadResult> {
  const fresh = await options.canvas.getFile(options.contextKind, options.contextCanvasId, options.fileId);
  if (fresh.kind === 'denied_or_absent') return { kind: 'gone', detail: describe(fresh), reason: 'canvas_denied_or_absent' };
  if (fresh.kind !== 'ok') return { kind: 'error', detail: describe(fresh), reason: `canvas_${fresh.kind}` };

  const file = fresh.value;
  if (file.hidden_for_user === true || file.locked_for_user === true) return { kind: 'locked', detail: 'locked or hidden at download time', reason: 'locked' };
  const expected = file.size ?? -1;
  if (expected > options.maxBytes) return { kind: 'too_large', detail: `${expected} bytes`, reason: 'too_large' };

  // Deliberately untyped access: `url` is not on CanvasFile so nothing else can
  // reach for it. It lives only for the length of this function.
  const url = (file as unknown as { url?: unknown }).url;
  if (typeof url !== 'string' || url === '') return { kind: 'error', detail: 'file object has no download url', reason: 'no_url' };

  let response: Response;
  try {
    response = await fetchWithTokenOnlyForCanvas(url, options);
  } catch (error) {
    return { kind: 'error', detail: `download failed: ${error instanceof Error ? error.message : String(error)}`, reason: 'network' };
  }
  if (!response.ok) return { kind: 'error', detail: `download returned ${response.status}`, reason: `http_${response.status}` };

  const bytes = new Uint8Array(await response.arrayBuffer());
  const declared = response.headers.get('content-length');
  if (declared !== null && response.headers.get('content-encoding') === null && Number(declared) !== bytes.length) {
    return { kind: 'error', detail: `truncated: got ${bytes.length} of ${declared} bytes`, reason: 'truncated' };
  }
  if (expected >= 0 && bytes.length !== expected) {
    return { kind: 'error', detail: `size mismatch: Canvas says ${expected}, got ${bytes.length}`, reason: 'size_mismatch' };
  }
  return {
    kind: 'ok',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex').toUpperCase(),
  };
}

const MAX_REDIRECTS = 5;

/**
 * Follows redirects by hand so that each hop's credentials are decided by this
 * code: the bearer token for the Canvas origin, nothing for any other.
 */
async function fetchWithTokenOnlyForCanvas(
  start: string,
  options: { token: string; canvasOrigin: string; fetchImpl?: typeof fetch },
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch;
  const deadline = AbortSignal.timeout(120_000);
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const headers: Record<string, string> = {};
    if (url.origin === options.canvasOrigin) headers['authorization'] = `Bearer ${options.token}`;
    const response = await doFetch(url, { headers, redirect: 'manual', signal: deadline });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status > 399 || location === null) return response;
    await response.body?.cancel();
    url = new URL(location, url);
  }
  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}
