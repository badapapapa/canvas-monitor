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
 *          POST /me/drive/items/{id}/children    create a FOLDER, conflictBehavior=fail, and
 *                                                ONLY under an id this guard has seen Graph
 *                                                return for a folder inside the root (D-54)
 *          POST <root>:/<safe path>:/createUploadSession   conflictBehavior=fail
 *          PATCH /me/drive/items/{id}  {parentReference:{id}} ONLY: the re-route move
 *                                      (D-57), and only as narrow as described at
 *                                      `checkMove()` below
 *          POST /me/drive/root/children          folder mode only: create the root folder itself
 *   Upload PUT|GET <an uploadUrl Graph returned in this process>, WITHOUT Authorization
 *   Login  POST /consumers/oauth2/v2.0/{token,devicecode}
 *
 * Refused outright, whatever the path:
 *   - PUT, PATCH, DELETE to Graph: no overwrite (PUT's default is *replace*),
 *     no move, no delete, no simple upload.
 *   - Addressing by item id (`/items/{id}`): an id can name ANY item in the
 *     drive, which is exactly how code escapes a folder it thinks it is in.
 *     The one exception is folder creation, which real Graph refuses (400)
 *     when addressed through special/approot (observed 2026-09-21, D-54). It
 *     is allowed only under ids the guard itself learned, via `observe()`,
 *     from Graph's responses to requests it had already approved as inside
 *     the root. Code outside the guard cannot add an id.
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
/** The only id-addressed shape allowed: creating a child folder (D-54). */
const ID_CHILDREN = /^\/me\/drive\/items\/([^/:]+)\/children$/;
/** The re-route move (D-57): an item by id, PATCHed with a new parent only. */
const ID_ITEM = /^\/me\/drive\/items\/([^/:]+)$/;

function pathKey(segments: readonly string[]): string {
  return segments.map((s) => s.normalize('NFC').toLowerCase()).join('/');
}

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
  /** Folder id -> its path under the root, learned only from approved requests' responses. */
  private readonly rootedFolderIds = new Map<string, string[]>();
  /** File id -> path, for files learned at exactly <term>/<module>/_unsorted/<name>. */
  private readonly movableFiles = new Map<string, string[]>();
  /** Paths (lower-cased) Graph answered 404 for, since nothing here wrote to them. */
  private readonly confirmedAbsent = new Set<string>();
  /** Folder names a re-route may move into: standard categories plus stored-rule targets. */
  private readonly moveDestinations = new Set<string>();

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

  /**
   * Which folder names a re-route may move files into (D-57). Each must be a
   * safe single segment and not `_unsorted`. Nothing is allowed until set.
   */
  allowMoveDestinations(names: Iterable<string>): void {
    for (const name of names) {
      if (name === '_unsorted' || safeSegment(name) !== name) throw new GuardError(`"${name}" cannot be a move destination`);
      this.moveDestinations.add(name);
    }
  }

  /**
   * Learn from a response. The request is re-checked here, so only a response
   * to an approved, root-confined request can teach the guard anything:
   *   - a rooted GET that found a folder: its id and path;
   *   - a rooted GET that found a file at <term>/<module>/_unsorted/<name>:
   *     its id, as movable once;
   *   - a rooted GET answered 404: that path is confirmed absent;
   *   - a folder create under a known folder id: the new folder's id and path.
   */
  observe(req: GuardedRequest, status: number, response: unknown): void {
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'POST') return;
    const path = req.url.slice(this.graphBase.length).split('?')[0] ?? '';
    const prefix = rootPrefix(this.root);
    const rootedGet = method === 'GET' && (path === prefix || path.startsWith(`${prefix}:`) || path.startsWith(`${prefix}/`));

    if (status === 404 && rootedGet) {
      this.check(req);
      const { segments, action } = this.parseRooted(path.slice(prefix.length));
      if (action === null && segments.length > 0) this.confirmedAbsent.add(pathKey(segments));
      return;
    }
    if (status < 200 || status > 299 || response === null || typeof response !== 'object') return;
    const item = response as { id?: unknown; folder?: unknown; file?: unknown };
    if (typeof item.id !== 'string' || item.id === '') return;
    const isFolder = item.folder !== undefined && item.folder !== null;
    this.check(req);

    if (rootedGet) {
      const { segments, action } = this.parseRooted(path.slice(prefix.length));
      if (action !== null) return;
      if (isFolder) this.rootedFolderIds.set(item.id, segments);
      else if (item.file !== undefined && segments.length === 4 && segments[2] === '_unsorted') this.movableFiles.set(item.id, segments);
      return;
    }
    if (!isFolder) return;
    const child = ID_CHILDREN.exec(path);
    if (method === 'POST' && child !== null) {
      const parent = this.rootedFolderIds.get(decodeURIComponent(child[1]!));
      const name = parseJson(req.body)['name'];
      if (parent !== undefined && typeof name === 'string') this.rootedFolderIds.set(item.id, [...parent, name]);
      return;
    }
    if (method === 'POST' && this.root.mode === 'folder' && path === '/me/drive/root/children') this.rootedFolderIds.set(item.id, []);
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

    const moving = ID_ITEM.exec(path);
    if (method === 'PATCH' && moving !== null) {
      this.checkMove(moving[1]!, req, query);
      return;
    }
    if (method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
      throw new GuardError(`${method} to Graph (this app never overwrites, moves or deletes)`);
    }
    if (method !== 'GET' && method !== 'POST') throw new GuardError(`${method} to Graph`);
    const byId = ID_CHILDREN.exec(path);
    if (byId !== null) {
      let id: string;
      try {
        id = decodeURIComponent(byId[1]!);
      } catch {
        throw new GuardError('a malformed item id');
      }
      if (encodeURIComponent(id) !== byId[1]) throw new GuardError('a non-canonical item id');
      if (!this.rootedFolderIds.has(id)) throw new GuardError('addressing by an item id not known to be a folder inside the root');
      if (method !== 'POST') throw new GuardError(`${method} on an item id`);
      if (query.length > 0) throw new GuardError('query parameters on a folder create');
      const body = parseJson(req.body);
      this.requireFolderCreate(body);
      // Writing here un-confirms any absence recorded for that path.
      this.confirmedAbsent.delete(pathKey([...this.rootedFolderIds.get(id)!, String(body['name'])]));
      return;
    }
    if (/\/items\//.test(path) || /\/items$/.test(path)) throw new GuardError('addressing by item id');

    for (const [key, value] of query) {
      if (key === '$select' && method === 'GET') continue;
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
      this.requireFolderCreate(body);
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
      // Real Graph answers 400 to every path-addressed folder create under the
      // app folder (D-54). One route for folders: by a known parent id.
      throw new GuardError('a folder create addressed by path; use the parent folder id');
    }
    // createUploadSession: the upload MUST fail on a name clash, never replace.
    if (segments.length === 0) throw new GuardError('an upload session for the root itself');
    const item = body['item'];
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new GuardError('an upload session with no item');
    const props = item as Record<string, unknown>;
    if (props[CONFLICT_PARAM] !== 'fail') throw new GuardError('an upload session without conflictBehavior=fail');
    if (props['name'] !== segments[segments.length - 1]) throw new GuardError('an upload session whose item name disagrees with its path');
    if ('deferCommit' in body || '@microsoft.graph.sourceUrl' in props) throw new GuardError('an upload session with deferCommit or sourceUrl');
    this.confirmedAbsent.delete(pathKey(segments));
  }

  /**
   * The re-route move (D-57), exactly this narrow:
   *   - PATCH /me/drive/items/{id} with a body of `{parentReference:{id}}` and
   *     nothing else: no rename, no other property, no query;
   *   - the item was learned by this guard as a file at exactly
   *     <term>/<module>/_unsorted/<name>, and each learning allows one move;
   *   - the destination folder was learned by this guard, is a direct child of
   *     the SAME <term>/<module>/, is not `_unsorted`, is a safe segment, and
   *     is an allowed destination (a standard category or a stored rule's
   *     target);
   *   - <destination>/<name> was confirmed absent by a 404 from Graph, with no
   *     write to it since.
   * The move keeps the file's name, so the checked path is the one it lands at.
   */
  private checkMove(rawId: string, req: GuardedRequest, query: Array<[string, string]>): void {
    let id: string;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      throw new GuardError('a malformed item id');
    }
    if (encodeURIComponent(id) !== rawId) throw new GuardError('a non-canonical item id');
    if (query.length > 0) throw new GuardError('query parameters on a move');
    const body = parseJson(req.body);
    const ref = body['parentReference'];
    if (Object.keys(body).join() !== 'parentReference' || ref === null || typeof ref !== 'object' || Array.isArray(ref)) {
      throw new GuardError('a PATCH that does anything but set parentReference (no rename, no other property)');
    }
    const refKeys = Object.keys(ref as Record<string, unknown>);
    const parentId = (ref as Record<string, unknown>)['id'];
    if (refKeys.join() !== 'id' || typeof parentId !== 'string') throw new GuardError('a parentReference other than {id}');

    const source = this.movableFiles.get(id);
    if (source === undefined) throw new GuardError('moving an item not learned as a file in <term>/<module>/_unsorted/');
    const dest = this.rootedFolderIds.get(parentId);
    if (dest === undefined) throw new GuardError('moving into a folder not learned inside the root');
    if (dest.length !== 3 || dest[0] !== source[0] || dest[1] !== source[1]) {
      throw new GuardError('a move destination that is not a direct child of the same <term>/<module>/');
    }
    const folder = dest[2]!;
    if (folder === '_unsorted' || safeSegment(folder) !== folder) throw new GuardError(`move destination "${folder}"`);
    if (!this.moveDestinations.has(folder)) throw new GuardError(`move destination "${folder}" is not a standard category or a stored rule's target`);
    const landing = pathKey([...dest, source[3]!]);
    if (!this.confirmedAbsent.has(landing)) throw new GuardError('a move whose destination name was not confirmed absent');

    // One move per learning; the landing path is no longer known to be absent.
    this.movableFiles.delete(id);
    this.confirmedAbsent.delete(landing);
  }

  private requireFolderCreate(body: Record<string, unknown>): void {
    const name = body['name'];
    if (typeof name !== 'string' || safeSegment(name) !== name) throw new GuardError('a folder name that is not a safe segment');
    if (body['folder'] === undefined || 'file' in body || '@microsoft.graph.sourceUrl' in body) {
      throw new GuardError('a children POST that creates anything but an empty folder');
    }
    if (body[CONFLICT_PARAM] !== 'fail') throw new GuardError('a folder create without conflictBehavior=fail');
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
