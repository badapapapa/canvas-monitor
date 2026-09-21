/**
 * Fetch a file's bytes from Canvas (SPEC.md sections 4 and 7).
 *
 * The file object's `url` carries a time-limited verifier, so the object is
 * re-fetched immediately before every download and the URL is never stored.
 * The download redirects to Canvas's storage host on another origin; Node's
 * fetch drops the Authorization header across origins, so the NUS token is
 * not sent there (pinned by test/unit/canvas-http.test.ts).
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
  | { kind: 'locked' | 'too_large' | 'gone' | 'error'; detail: string };

export async function downloadCanvasFile(options: {
  canvas: CanvasClient;
  contextKind: FileContextKind;
  contextCanvasId: number;
  fileId: number;
  token: string;
  maxBytes: number;
  fetchImpl?: typeof fetch;
}): Promise<DownloadResult> {
  const fresh = await options.canvas.getFile(options.contextKind, options.contextCanvasId, options.fileId);
  if (fresh.kind === 'denied_or_absent') return { kind: 'gone', detail: describe(fresh) };
  if (fresh.kind !== 'ok') return { kind: 'error', detail: describe(fresh) };

  const file = fresh.value;
  if (file.hidden_for_user === true || file.locked_for_user === true) return { kind: 'locked', detail: 'locked or hidden at download time' };
  const expected = file.size ?? -1;
  if (expected > options.maxBytes) return { kind: 'too_large', detail: `${expected} bytes` };

  // Deliberately untyped access: `url` is not on CanvasFile so nothing else can
  // reach for it. It lives only for the length of this function.
  const url = (file as unknown as { url?: unknown }).url;
  if (typeof url !== 'string' || url === '') return { kind: 'error', detail: 'file object has no download url' };

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(url, {
      headers: { authorization: `Bearer ${options.token}` },
      redirect: 'follow',
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return { kind: 'error', detail: `download failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!response.ok) return { kind: 'error', detail: `download returned ${response.status}` };

  const bytes = new Uint8Array(await response.arrayBuffer());
  const declared = response.headers.get('content-length');
  if (declared !== null && response.headers.get('content-encoding') === null && Number(declared) !== bytes.length) {
    return { kind: 'error', detail: `truncated: got ${bytes.length} of ${declared} bytes` };
  }
  if (expected >= 0 && bytes.length !== expected) {
    return { kind: 'error', detail: `size mismatch: Canvas says ${expected}, got ${bytes.length}` };
  }
  return {
    kind: 'ok',
    bytes,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sha1: createHash('sha1').update(bytes).digest('hex').toUpperCase(),
  };
}
