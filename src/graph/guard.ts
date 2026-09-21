/**
 * The OneDrive confinement guard (DECISIONS.md D-50).
 *
 * My OneDrive holds ~123 GB of personal files. This app may touch ONLY its own
 * root folder, and within it may only create -- never overwrite, move or
 * delete. That is a structural guarantee, not a convention: every request to
 * Microsoft passes `check()` BEFORE any network I/O, and anything that is not
 * one of the few shapes below is refused.
 *
 *   Graph  GET  /me/drive                        quota only ($select)
 *          GET  <root>                           the root folder itself
 *          GET  <root>:/<safe path>              one item, by path
 *          POST <root>[:/<safe path>]:/children  create a FOLDER, conflictBehavior=fail
 *          POST <root>:/<safe path>:/createUploadSession   conflictBehavior=fail
 *          POST /me/drive/root/children          folder mode only: create the root folder itself
 *   Upload PUT|GET <an uploadUrl Graph returned in this process>, WITHOUT Authorization
 *   Login  POST /consumers/oauth2/v2.0/{token,devicecode}
 *
 * Refused outright, whatever the path:
 *   - PUT, PATCH, DELETE to Graph: no overwrite (PUT's default is *replace*),
 *     no move, no delete, no simple upload.
 *   - Addressing by item id (`/items/{id}`): an id can name ANY item in the
 *     drive, which is exactly how code escapes a folder it thinks it is in.
 *   - Any path segment that is not canonical and already safe: no `..`, no
 *     alternative percent-encoding, no separators smuggled inside a segment.
 *   - Any sign-in authority other than /consumers, which admits personal
 *     Microsoft accounts only -- never an NUS work account.
 *
 * With Files.ReadWrite.AppFolder the service enforces confinement too; this
 * guard is then defence in depth. With Files.ReadWrite it is the ONLY thing
 * standing between a bug and my files, which is why it has no escape hatch.
 */

import { safeSegment } from '../archive/filename.ts';

export type RootSpec = { mode: 'appfolder' } | { mode: 'folder'; name: string };

export const GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
export const LOGIN_BASE = 'https://login.microsoftonline.com';

export const SCOPES: Record<RootSpec['mode'], string> = {
  appfolder: 'Files.ReadWrite.AppFolder offline_access',
  folder: 'Files.ReadWrite offline_access',
};

export class GuardError extends Error {
  constructor(message: string) {
    super(`OneDrive guard refused a request: ${message}`);
    this.name = 'GuardError';
  }
}

export interface GuardedRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** JSON body as sent, or a form body for the login endpoints. */
  body?: string;
}

export interface GuardOptions {
  root: RootSpec;
  graphBase?: string;
  loginBase?: string;
}

const CONFLICT_PARAM = '@microsoft.graph.conflictBehavior';

export function rootPrefix(root: RootSpec): string {
  return root.mode === 'appfolder' ? '/me/drive/special/approot' : `/me/drive/root:/${encodeURIComponent(root.name)}`;
}

/** The canonical request path for a path of safe segments under the root. */
export function rootedPath(root: RootSpec, segments: readonly string[], action?: 'children' | 'createUploadSession'): string {
  const prefix = rootPrefix(root);
  if (segments.length === 0) {
    if (action === undefined) return prefix;
    return root.mode === 'appfolder' ? `${prefix}/${action}` : `${prefix}:/${action}`;
  }
  const joiner = root.mode === 'appfolder' ? ':/' : '/';
  const encoded = segments.map((s) => encodeURIComponent(s)).join('/');
  return `${prefix}${joiner}${encoded}${action === undefined ? '' : `:/${action}`}`;
}

function hasAuthorization(headers: Record<string, string>): boolean {
  return Object.keys(headers).some((k) => k.toLowerCase() === 'authorization');
}

function parseJson(body: string | undefined): Record<string, unknown> {
  if (body === undefined) throw new GuardError('a POST with no body');
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as Record<string, unknown>;
  } catch {
    throw new GuardError('a POST body that is not a JSON object');
  }
}

export class RequestGuard {
  private readonly root: RootSpec;
  private readonly graphBase: string;
  private readonly loginBase: string;
  private readonly uploadUrls = new Set<string>();

  constructor(options: GuardOptions) {
    this.root = options.root;
    this.graphBase = (options.graphBase ?? GRAPH_BASE).replace(/\/+$/, '');
    this.loginBase = (options.loginBase ?? LOGIN_BASE).replace(/\/+$/, '');
    if (this.root.mode === 'folder' && safeSegment(this.root.name) !== this.root.name) {
      throw new GuardError(`root folder name "${this.root.name}" is not a safe single segment`);
    }
  }

  /** Only upload URLs Graph itself handed back may ever be written to. */
  registerUploadUrl(url: string): void {
    this.uploadUrls.add(url);
  }

  check(req: GuardedRequest): void {
    const method = req.method.toUpperCase();

    if (this.uploadUrls.has(req.url)) {
      if (method !== 'PUT' && method !== 'GET') throw new GuardError(`${method} to an upload session`);
      // Documented: an Authorization header on the upload URL may 401. It is
      // also a bearer token sent to a different host, so it never goes there.
      if (hasAuthorization(req.headers)) throw new GuardError('an Authorization header sent to an upload URL');
      return;
    }

    if (req.url.startsWith(`${this.loginBase}/`)) return this.checkLogin(method, req);
    if (req.url.startsWith(`${this.graphBase}/`)) return this.checkGraph(method, req);
    throw new GuardError(`a host that is not Graph, the /consumers login, or a known upload URL (${new URL(req.url).host})`);
  }

  private checkLogin(method: string, req: GuardedRequest): void {
    const path = req.url.slice(this.loginBase.length).split('?')[0] ?? '';
    if (method !== 'POST') throw new GuardError(`${method} to the login endpoint`);
    if (path !== '/consumers/oauth2/v2.0/token' && path !== '/consumers/oauth2/v2.0/devicecode') {
      throw new GuardError(`login path ${path}: only the /consumers authority (personal accounts) is allowed`);
    }
    const form = new URLSearchParams(req.body ?? '');
    const scope = form.get('scope');
    if (scope !== null && scope !== SCOPES[this.root.mode]) {
      throw new GuardError(`scope "${scope}" does not match the configured root mode (${this.root.mode})`);
    }
  }

  private checkGraph(method: string, req: GuardedRequest): void {
    const url = new URL(req.url);
    const path = req.url.slice(this.graphBase.length).split('?')[0] ?? '';
    const query = [...url.searchParams.entries()];

    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      throw new GuardError(`${method} to Graph (this app never overwrites, moves or deletes)`);
    }
    if (method !== 'GET' && method !== 'POST') throw new GuardError(`${method} to Graph`);
    if (/\/items\//.test(path) || /\/items$/.test(path)) throw new GuardError('addressing by item id');

    for (const [key, value] of query) {
      if (key === '$select' && method === 'GET') continue;
      if (key === CONFLICT_PARAM && value === 'fail') continue;
      throw new GuardError(`query parameter ${key}=${value}`);
    }

    // The drive resource itself: quota and drive type, read-only.
    if (path === '/me/drive') {
      if (method !== 'GET') throw new GuardError(`${method} /me/drive`);
      return;
    }

    // Folder mode only: creating the root folder in the drive root, by name.
    if (this.root.mode === 'folder' && path === '/me/drive/root/children') {
      if (method !== 'POST') throw new GuardError(`${method} /me/drive/root/children`);
      const body = parseJson(req.body);
      if (body['name'] !== this.root.name) throw new GuardError('creating anything in the drive root except the app root folder');
      this.requireFolderCreate(body, query);
      return;
    }

    const prefix = rootPrefix(this.root);
    if (path !== prefix && !path.startsWith(`${prefix}/`) && !path.startsWith(`${prefix}:`)) {
      throw new GuardError(`a path outside the app root (${path})`);
    }

    const { segments, action } = this.parseRooted(path.slice(prefix.length));
    if (action === null) {
      if (method !== 'GET') throw new GuardError(`${method} on an item path`);
      return;
    }
    if (method !== 'POST') throw new GuardError(`${method} ${action}`);
    const body = parseJson(req.body);
    if (action === 'children') {
      this.requireFolderCreate(body, query);
      return;
    }
    // createUploadSession: the upload MUST fail on a name clash, never replace.
    if (segments.length === 0) throw new GuardError('an upload session for the root itself');
    const item = body['item'];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new GuardError('an upload session with no item');
    const props = item as Record<string, unknown>;
    if (props[CONFLICT_PARAM] !== 'fail') throw new GuardError('an upload session without conflictBehavior=fail');
    if (props['name'] !== segments[segments.length - 1]) throw new GuardError('an upload session whose item name disagrees with its path');
    if ('deferCommit' in body || '@microsoft.graph.sourceUrl' in props) throw new GuardError('an upload session with deferCommit or sourceUrl');
    if (!query.some(([k, v]) => k === CONFLICT_PARAM && v === 'fail')) throw new GuardError('an upload session without conflictBehavior=fail in the URL');
  }

  private requireFolderCreate(body: Record<string, unknown>, query: Array<[string, string]>): void {
    const name = body['name'];
    if (typeof name !== 'string' || safeSegment(name) !== name) throw new GuardError('a folder name that is not a safe segment');
    if (body['folder'] === undefined || 'file' in body || '@microsoft.graph.sourceUrl' in body) {
      throw new GuardError('a children POST that creates anything but an empty folder');
    }
    if (body[CONFLICT_PARAM] !== 'fail') throw new GuardError('a folder create without conflictBehavior=fail');
    if (!query.some(([k, v]) => k === CONFLICT_PARAM && v === 'fail')) throw new GuardError('a folder create without conflictBehavior=fail in the URL');
  }

  /** `rest` is what follows the root prefix. Returns decoded, verified segments. */
  private parseRooted(rest: string): { segments: string[]; action: 'children' | 'createUploadSession' | null } {
    if (rest === '') return { segments: [], action: null };
    const rootAction = this.root.mode === 'appfolder' ? rest.match(/^\/(children)$/) : rest.match(/^:\/(children)$/);
    if (rootAction !== null) return { segments: [], action: 'children' };

    const lead = this.root.mode === 'appfolder' ? ':/' : '/';
    if (!rest.startsWith(lead)) throw new GuardError(`an unrecognised root-relative form (${rest})`);
    const body = rest.slice(lead.length);
    const colon = body.indexOf(':');
    const rawPath = colon === -1 ? body : body.slice(0, colon);
    const actionPart = colon === -1 ? null : body.slice(colon);
    let action: 'children' | 'createUploadSession' | null = null;
    if (actionPart !== null) {
      if (actionPart === ':/children') action = 'children';
      else if (actionPart === ':/createUploadSession') action = 'createUploadSession';
      else throw new GuardError(`an unrecognised path action (${actionPart})`);
    }

    const segments = rawPath.split('/').map((raw) => {
      let decoded: string;
      try {
        decoded = decodeURIComponent(raw);
      } catch {
        throw new GuardError('a malformed percent-encoding in the path');
      }
      // Canonical only: the segment must round-trip exactly, so there is one
      // spelling of every path and no encoding trick can mean "..".
      if (encodeURIComponent(decoded) !== raw) throw new GuardError(`a non-canonical path segment (${raw})`);
      if (decoded === '' || decoded === '.' || decoded === '..') throw new GuardError(`the path segment "${decoded}"`);
      if (safeSegment(decoded, 255) !== decoded) throw new GuardError(`an unsafe path segment (${decoded})`);
      return decoded;
    });
    return { segments, action };
  }
}
