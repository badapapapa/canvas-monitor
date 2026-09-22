/**
 * A fake Microsoft Graph + login server with a REAL-SHAPED drive.
 *
 * The drive is seeded with stand-ins for my personal files, so tests can
 * prove the archive never touched -- or even addressed -- anything outside its
 * root. Every request is recorded for that purpose.
 *
 * Behaviour follows the Microsoft documentation checked on 2026-09-21:
 *   - refresh tokens rotate, and old ones stay valid;
 *   - upload fragments must be sequential and, when split, multiples of 320 KiB;
 *   - an Authorization header on an upload URL is answered with 401;
 *   - a name clash under conflictBehavior=fail is reported at the final fragment.
 */

import { quickXorHash } from '../../src/archive/quickxor.ts';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

interface FNode {
  id: string;
  name: string;
  kind: 'folder' | 'file';
  children: Map<string, FNode>;
  bytes: Buffer<ArrayBufferLike>;
  parent: FNode | null;
}

export interface Recorded {
  method: string;
  path: string;
  hasAuth: boolean;
  body: string;
}

interface Session {
  parent: FNode;
  name: string;
  total: number;
  received: Buffer[];
  next: number;
  gone: boolean;
}

export interface FakeGraphState {
  appName: string;
  quota: { total: number; used: number } | 'forbidden';
  /** Newly consented AppFolder-only apps, 2026: every drive call refused. */
  provisioningBroken: boolean;
  refreshRevoked: boolean;
  /** The token endpoint's answer once the app registration or its directory is gone. */
  appGone: 'deleted' | 'tenant_blocked' | null;
  /** Every drive call fails with an error the client has no category for. */
  driveBroken: boolean;
  /** Folder creation answers 400 invalidRequest, as the first live run saw (D-54). */
  folderCreateBroken: boolean;
  /** The next completed upload stores different bytes from those sent. */
  corruptNextUpload: boolean;
  throttleNext: number;
  failNextPuts: number;
  dropNextPut: boolean;
  loseSessionNextPut: boolean;
  quotaFullOnFinal: boolean;
  devicePendingPolls: number;
}

const FRAGMENT = 320 * 1024;

function node(name: string, kind: 'folder' | 'file', parent: FNode | null, bytes: Buffer<ArrayBufferLike> = Buffer.alloc(0)): FNode {
  const n: FNode = { id: randomUUID(), name, kind, children: new Map(), bytes, parent };
  if (parent !== null) parent.children.set(name.toLowerCase(), n);
  return n;
}

function pathOf(n: FNode): string {
  const parts: string[] = [];
  for (let cur: FNode | null = n; cur !== null && cur.parent !== null; cur = cur.parent) parts.unshift(cur.name);
  return `/${parts.join('/')}`;
}

export class FakeGraph {
  readonly requests: Recorded[] = [];
  readonly state: FakeGraphState;
  readonly driveRoot: FNode;
  private server!: Server;
  url = '';
  private readonly validRefresh = new Set<string>(['rt-initial']);
  private readonly validAccess = new Set<string>();
  private readonly sessions = new Map<string, Session>();
  private issued = 0;

  constructor(state: Partial<FakeGraphState> = {}) {
    this.state = {
      appName: 'Canvas Archive',
      quota: { total: 1024 ** 4, used: 123 * 1024 ** 3 },
      provisioningBroken: false,
      refreshRevoked: false,
      appGone: null,
      driveBroken: false,
      folderCreateBroken: false,
      corruptNextUpload: false,
      throttleNext: 0,
      failNextPuts: 0,
      dropNextPut: false,
      loseSessionNextPut: false,
      quotaFullOnFinal: false,
      devicePendingPolls: 1,
      ...state,
    };
    // Stand-ins for ~123 GB of personal files the app must never touch.
    this.driveRoot = node('', 'folder', null);
    const docs = node('Documents', 'folder', this.driveRoot);
    node('Taxes 2025.pdf', 'file', docs, Buffer.from('personal: taxes'));
    node('Thesis draft.docx', 'file', docs, Buffer.from('personal: thesis'));
    const photos = node('Photos', 'folder', this.driveRoot);
    node('beach.jpg', 'file', node('2025', 'folder', photos), Buffer.from('personal: photo'));
    const apps = node('Apps', 'folder', this.driveRoot);
    node('settings.json', 'file', node('Other App', 'folder', apps), Buffer.from('another app'));
    // A decoy with the root's name as a prefix, which folder mode must not match.
    node('Canvas Archive Backup', 'folder', this.driveRoot);
  }

  get graphBase(): string {
    return `${this.url}/v1.0`;
  }

  get loginBase(): string {
    return `${this.url}/login`;
  }

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      let chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        chunks = [];
        this.requests.push({ method: req.method ?? '', path: req.url ?? '', hasAuth: req.headers.authorization !== undefined, body: body.toString('utf8') });
        try {
          this.route(req, res, body);
        } catch (error) {
          this.json(res, 500, { error: { code: 'fakeFailure', message: String(error) } });
        }
      });
    });
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop(): Promise<void> {
    return new Promise((resolve) => this.server.close(() => resolve()));
  }

  // --- test helpers -----------------------------------------------------------

  /** Everything outside the app's root, serialised, for before/after comparison. */
  snapshotOutsideRoot(rootPath: string): string {
    const out: string[] = [];
    const walk = (n: FNode): void => {
      const p = pathOf(n);
      if (p === rootPath || p.startsWith(`${rootPath}/`)) return;
      out.push(`${n.kind} ${p} ${createHash('sha256').update(n.bytes).digest('hex').slice(0, 12)}`);
      for (const c of n.children.values()) walk(c);
    };
    walk(this.driveRoot);
    return out.sort().join('\n');
  }

  /** Files under a path, as "relative/path size". */
  filesUnder(rootPath: string): string[] {
    const base = this.resolveAbsolute(rootPath);
    if (base === null) return [];
    const out: string[] = [];
    const walk = (n: FNode, rel: string): void => {
      for (const c of n.children.values()) {
        const r = rel === '' ? c.name : `${rel}/${c.name}`;
        if (c.kind === 'file') out.push(`${r} ${c.bytes.length}`);
        else walk(c, r);
      }
    };
    walk(base, '');
    return out.sort();
  }

  fileBytes(absolute: string): Buffer | null {
    const n = this.resolveAbsolute(absolute);
    return n === null || n.kind !== 'file' ? null : n.bytes;
  }

  /** Put a file where the app will later want to write, to force a clash. */
  plant(absolute: string, bytes: Buffer): void {
    const parts = absolute.split('/').filter(Boolean);
    let cur = this.driveRoot;
    for (const p of parts.slice(0, -1)) cur = cur.children.get(p.toLowerCase()) ?? node(p, 'folder', cur);
    node(parts[parts.length - 1] ?? 'x', 'file', cur, bytes);
  }

  // --- routing ----------------------------------------------------------------

  private resolveAbsolute(absolute: string): FNode | null {
    let cur: FNode | undefined = this.driveRoot;
    for (const p of absolute.split('/').filter(Boolean)) {
      cur = cur?.children.get(p.toLowerCase());
      if (cur === undefined) return null;
    }
    return cur ?? null;
  }

  /** The node with this id, anywhere in the drive, or null. */
  nodeById(id: string, from: FNode = this.driveRoot): FNode | null {
    if (from.id === id) return from;
    for (const c of from.children.values()) {
      const hit = this.nodeById(id, c);
      if (hit !== null) return hit;
    }
    return null;
  }

  /** The drive path of an item id, for tests checking where a request pointed. */
  pathOfId(id: string): string | null {
    const n = this.nodeById(id);
    return n === null ? null : pathOf(n);
  }

  private approot(): FNode {
    const apps = this.driveRoot.children.get('apps') ?? node('Apps', 'folder', this.driveRoot);
    return apps.children.get(this.state.appName.toLowerCase()) ?? node(this.state.appName, 'folder', apps);
  }

  private json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  }

  private item(n: FNode): Record<string, unknown> {
    return {
      id: n.id,
      name: n.name,
      size: n.bytes.length,
      webUrl: `https://onedrive.live.com/?id=${n.id}`,
      parentReference: { driveType: 'personal', path: pathOf(n.parent ?? n) },
      ...(n.kind === 'folder'
        ? { folder: { childCount: n.children.size } }
        // As real personal OneDrive: quickXorHash only, no SHA-1 (observed 2026-09-21, D-54).
        : { file: { hashes: { quickXorHash: quickXorHash(n.bytes) } } }),
    };
  }

  private route(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';

    if (path.startsWith('/login/')) return this.login(path, res, new URLSearchParams(body.toString('utf8')));
    if (path.startsWith('/upload/')) return this.uploadRoute(method, path, req, res, body);
    if (!path.startsWith('/v1.0/')) return this.json(res, 404, { error: { code: 'itemNotFound' } });

    const auth = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (!this.validAccess.has(auth)) return this.json(res, 401, { error: { code: 'InvalidAuthenticationToken' } });
    if (this.state.throttleNext > 0) {
      this.state.throttleNext -= 1;
      return this.json(res, 429, { error: { code: 'activityLimitReached' } }, { 'retry-after': '0' });
    }
    if (this.state.driveBroken) return this.json(res, 400, { error: { code: 'invalidRequest', message: 'unexpected' } });
    if (this.state.provisioningBroken) {
      return this.json(res, 403, { error: { code: 'accessDenied', message: 'Database Is Read Only', innerError: { code: 'serviceReadOnly' } } });
    }

    const graphPath = req.url?.slice('/v1.0'.length).split('?')[0] ?? '';

    // Move (D-57): PATCH an item's parentReference. The item keeps its id.
    // ASSUMPTION until the live test: a name clash at the destination is a 409.
    const moveOf = /^\/me\/drive\/items\/([^/:]+)$/.exec(graphPath);
    if (moveOf !== null && method === 'PATCH') {
      const moved = this.nodeById(decodeURIComponent(moveOf[1]!));
      const b = JSON.parse(body.toString('utf8')) as { parentReference?: { id?: string }; name?: string };
      const dest = b.parentReference?.id === undefined ? null : this.nodeById(b.parentReference.id);
      if (moved === null || dest === null || dest.kind !== 'folder') return this.json(res, 404, { error: { code: 'itemNotFound' } });
      const name = b.name ?? moved.name;
      if (dest.children.has(name.toLowerCase())) return this.json(res, 409, { error: { code: 'nameAlreadyExists' } });
      moved.parent?.children.delete(moved.name.toLowerCase());
      moved.parent = dest;
      moved.name = name;
      dest.children.set(name.toLowerCase(), moved);
      return this.json(res, 200, this.item(moved));
    }

    // Folder create by parent id: the only form real Graph accepts under the
    // app folder (observed 2026-09-21, D-54).
    const byId = /^\/me\/drive\/items\/([^/:]+)\/children$/.exec(graphPath);
    if (byId !== null && method === 'POST') {
      if (this.state.folderCreateBroken) return this.json(res, 400, { error: { code: 'invalidRequest', message: 'Invalid request' } });
      const parent = this.nodeById(decodeURIComponent(byId[1]!));
      if (parent === null || parent.kind !== 'folder') return this.json(res, 404, { error: { code: 'itemNotFound' } });
      const b = JSON.parse(body.toString('utf8')) as { name: string };
      if (parent.children.has(b.name.toLowerCase())) return this.json(res, 409, { error: { code: 'nameAlreadyExists' } });
      return this.json(res, 201, this.item(node(b.name, 'folder', parent)));
    }
    if (graphPath === '/me/drive') {
      if (this.state.quota === 'forbidden') return this.json(res, 403, { error: { code: 'accessDenied' } });
      const q = this.state.quota;
      return this.json(res, 200, { driveType: 'personal', quota: { total: q.total, used: q.used, remaining: q.total - q.used, state: 'normal' } });
    }

    const parsed = this.parseGraphPath(graphPath);
    if (parsed === null) return this.json(res, 400, { error: { code: 'invalidRequest', message: `fake cannot route ${graphPath}` } });
    const { base, segments, action } = parsed;

    let target: FNode | null = base;
    for (const s of action === null ? segments : segments.slice(0, action === 'createUploadSession' ? -1 : undefined)) {
      target = target?.children.get(s.toLowerCase()) ?? null;
    }

    if (method === 'GET' && action === null) {
      return target === null ? this.json(res, 404, { error: { code: 'itemNotFound' } }) : this.json(res, 200, this.item(target));
    }
    if (method === 'POST' && action === 'children' && graphPath.startsWith('/me/drive/special/approot')) {
      // Real Graph, 2026-09-21: 400 for /special/approot/children and for
      // /special/approot:/<path>:/children alike (D-54).
      return this.json(res, 400, { error: { code: 'invalidRequest', message: 'Invalid request' } });
    }
    if (method === 'POST' && action === 'children') {
      if (target === null) return this.json(res, 404, { error: { code: 'itemNotFound' } });
      const b = JSON.parse(body.toString('utf8')) as { name: string };
      if (target.children.has(b.name.toLowerCase())) {
        return this.json(res, 409, { error: { code: 'nameAlreadyExists' } });
      }
      return this.json(res, 201, this.item(node(b.name, 'folder', target)));
    }
    if (method === 'POST' && action === 'createUploadSession') {
      if (target === null) return this.json(res, 404, { error: { code: 'itemNotFound', message: 'parent missing' } });
      const b = JSON.parse(body.toString('utf8')) as { item: { name: string; fileSize?: number; '@microsoft.graph.conflictBehavior'?: string } };
      // Real personal OneDrive, 2026-09-21: `fileSize` is a 400, whatever the docs say (D-54).
      if (b.item.fileSize !== undefined) return this.json(res, 400, { error: { code: 'invalidRequest', message: 'Invalid request' } });
      const id = randomUUID();
      this.sessions.set(id, { parent: target, name: b.item.name, total: b.item.fileSize ?? -1, received: [], next: 0, gone: false });
      return this.json(res, 200, { uploadUrl: `${this.url}/upload/${id}`, expirationDateTime: new Date(Date.now() + 3600_000).toISOString() });
    }
    return this.json(res, 405, { error: { code: 'notAllowed', message: `${method} ${graphPath}` } });
  }

  private parseGraphPath(p: string): { base: FNode; segments: string[]; action: 'children' | 'createUploadSession' | null } | null {
    const split = (rest: string): { segments: string[]; action: 'children' | 'createUploadSession' | null } => {
      const colon = rest.indexOf(':');
      const raw = colon === -1 ? rest : rest.slice(0, colon);
      const act = colon === -1 ? null : rest.slice(colon + 2);
      return {
        segments: raw.split('/').filter(Boolean).map((s) => decodeURIComponent(s)),
        action: act === 'children' ? 'children' : act === 'createUploadSession' ? 'createUploadSession' : null,
      };
    };
    if (p.startsWith('/me/drive/special/approot')) {
      const rest = p.slice('/me/drive/special/approot'.length);
      if (rest === '') return { base: this.approot(), segments: [], action: null };
      if (rest === '/children') return { base: this.approot(), segments: [], action: 'children' };
      if (rest.startsWith(':/')) return { base: this.approot(), ...split(rest.slice(2)) };
      return null;
    }
    if (p === '/me/drive/root/children') return { base: this.driveRoot, segments: [], action: 'children' };
    if (p.startsWith('/me/drive/root:/')) return { base: this.driveRoot, ...split(p.slice('/me/drive/root:/'.length)) };
    return null;
  }

  private login(path: string, res: ServerResponse, form: URLSearchParams): void {
    if (path === '/login/consumers/oauth2/v2.0/devicecode') {
      return this.json(res, 200, {
        device_code: 'dc-1', user_code: 'ABCD-EFGH', verification_uri: 'https://microsoft.com/devicelogin',
        message: 'To sign in, use a web browser to open the page https://microsoft.com/devicelogin and enter the code ABCD-EFGH to authenticate.',
        interval: 1, expires_in: 900,
      });
    }
    if (path !== '/login/consumers/oauth2/v2.0/token') return this.json(res, 404, { error: 'not_found' });

    const grant = form.get('grant_type');
    if (grant === 'urn:ietf:params:oauth:grant-type:device_code') {
      if (this.state.devicePendingPolls > 0) {
        this.state.devicePendingPolls -= 1;
        return this.json(res, 400, { error: 'authorization_pending' });
      }
      return this.json(res, 200, this.issue());
    }
    if (grant === 'refresh_token') {
      const presented = form.get('refresh_token') ?? '';
      if (this.state.appGone === 'deleted') {
        return this.json(res, 400, {
          error: 'unauthorized_client',
          error_description: "AADSTS700016: Application with identifier 'x' was not found in the directory 'Microsoft Accounts'.",
        });
      }
      if (this.state.appGone === 'tenant_blocked') {
        return this.json(res, 400, { error: 'invalid_request', error_description: 'AADSTS5000225: This tenant has been blocked due to inactivity.' });
      }
      if (this.state.refreshRevoked || !this.validRefresh.has(presented)) return this.json(res, 400, { error: 'invalid_grant' });
      // Documented: the new token replaces the old, but the old is NOT revoked.
      return this.json(res, 200, this.issue());
    }
    return this.json(res, 400, { error: 'unsupported_grant_type' });
  }

  private issue(): Record<string, unknown> {
    this.issued += 1;
    const access = `at-${this.issued}`;
    const refresh = `rt-${this.issued}`;
    this.validAccess.add(access);
    this.validRefresh.add(refresh);
    return { token_type: 'Bearer', access_token: access, refresh_token: refresh, expires_in: 3600 };
  }

  private uploadRoute(method: string, path: string, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
    const session = this.sessions.get(path.slice('/upload/'.length));
    if (session === undefined || session.gone) return this.json(res, 404, { error: { code: 'itemNotFound' } });
    if (method === 'GET') return this.json(res, 200, { nextExpectedRanges: [`${session.next}-`] });
    if (method !== 'PUT') return this.json(res, 405, {});
    if (req.headers.authorization !== undefined) return this.json(res, 401, { error: { code: 'unauthenticated' } });

    if (this.state.loseSessionNextPut) {
      this.state.loseSessionNextPut = false;
      session.gone = true;
      return this.json(res, 404, { error: { code: 'itemNotFound' } });
    }
    if (this.state.dropNextPut) {
      this.state.dropNextPut = false;
      req.socket.destroy();
      return;
    }
    if (this.state.failNextPuts > 0) {
      this.state.failNextPuts -= 1;
      return this.json(res, 503, { error: { code: 'serviceNotAvailable' } }, { 'retry-after': '0' });
    }

    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(req.headers['content-range'] ?? ''));
    if (range === null) return this.json(res, 400, { error: { code: 'invalidRange' } });
    const [start, end, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
    if (start !== session.next) return this.json(res, 416, { error: { code: 'invalidRange' } });
    const length = end - start + 1;
    if (length !== body.length) return this.json(res, 400, { error: { code: 'lengthMismatch' } });
    if (end + 1 < total && length % FRAGMENT !== 0) return this.json(res, 400, { error: { code: 'fragmentNotMultipleOf320KiB' } });
    if (length >= 60 * 1024 * 1024) return this.json(res, 400, { error: { code: 'fragmentTooLarge' } });

    session.received.push(body);
    session.next = end + 1;
    if (end + 1 < total) return this.json(res, 202, { nextExpectedRanges: [`${end + 1}-`] });

    if (this.state.quotaFullOnFinal) return this.json(res, 507, { error: { code: 'quotaLimitReached' } });
    if (session.parent.children.has(session.name.toLowerCase())) {
      return this.json(res, 409, { error: { code: 'nameAlreadyExists', message: 'Another file exists with the same name as the uploaded session.' } });
    }
    const bytes = Buffer.concat(session.received);
    if (this.state.corruptNextUpload) {
      this.state.corruptNextUpload = false;
      bytes[0] = bytes[0]! ^ 0xff;
    }
    const created = node(session.name, 'file', session.parent, bytes);
    this.sessions.delete(path.slice('/upload/'.length));
    return this.json(res, 201, this.item(created));
  }
}
