/**
 * A real HTTP server standing in for Canvas.
 *
 * Deliberately not a mocked `fetch`: the behaviours under test -- Link-header
 * pagination, rate-limit headers, and whether the bearer token survives a
 * cross-origin redirect -- are properties of the HTTP client and the wire, and
 * a stubbed fetch would assert nothing about either.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  url: string;
  authorization: string | undefined;
}

export interface FakeServer {
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export type Handler = (req: IncomingMessage, res: ServerResponse, hits: number) => void;

export async function startServer(handler: Handler): Promise<FakeServer> {
  const requests: RecordedRequest[] = [];
  const hitCounts = new Map<string, number>();

  const server: Server = createServer((req, res) => {
    const key = (req.url ?? '/').split('?')[0] ?? '/';
    const hits = (hitCounts.get(key) ?? 0) + 1;
    hitCounts.set(key, hits);
    requests.push({ url: req.url ?? '', authorization: req.headers.authorization });
    handler(req, res, hits);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined || error === null ? resolve() : reject(error)));
      }),
  };
}

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(payload);
}

export function sendText(
  res: ServerResponse,
  status: number,
  body: string,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'content-type': 'text/plain', ...headers });
  res.end(body);
}
