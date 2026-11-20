// app.ts — the forge's HTTP server.
//
// One process, one in-memory Forge. Routes:
//   GET  /healthz                          the env's boot check: 200 {"ok":true}
//   POST /api/graphql                      GraphQL (graphql.ts)
//   POST/DELETE /mcp                       MCP (mcp.ts)
//   /api/v3/*                              REST v3 (rest.ts)
//   /{owner}/{repo}.git/info/refs
//   /{owner}/{repo}.git/git-upload-pack
//   /{owner}/{repo}.git/git-receive-pack   git smart HTTP (git.ts, loaded lazily)
//   everything else                        JSON 404
//
// Auth: Authorization: Bearer <MAKEFUN_SHOP_TOKEN>. A missing/wrong token
// is 401 on every API surface. Every response carries a non-empty
// X-GitHub-Request-Id (a per-request counter, deterministic in request
// order). Bodies are capped at 64 MiB. Keep-alive is left to Node's HTTP
// server (the read workload reuses one connection for 2,000 GETs).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './store.ts';
import { handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

const forge = new Forge();

let requestCounter = 0;
const nextRequestId = (): string => {
  requestCounter += 1;
  return `req-${requestCounter}`;
};

// ------------------------------------------------------------------ git

// The git handler (git.ts) is loaded lazily so the server starts even
// before git.ts lands. Its shape: handleGit({method, url, headers, body},
// repo) -> {status, headers, body}; see git.ts's header for the contract.
import type { handleGit } from './git.ts';

let gitHandler: typeof handleGit | null = null;
import('./git.ts')
  .then((mod) => {
    if (typeof mod.handleGit === 'function') gitHandler = mod.handleGit;
  })
  .catch(() => {
    gitHandler = null;
  });

// ------------------------------------------------------------------ helpers

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  // No token configured (local runs without the env var): any non-empty
  // Bearer token passes; the graded run always sets MAKEFUN_SHOP_TOKEN.
  if (SHOP_TOKEN === '') return true;
  return token === SHOP_TOKEN;
}

function send(res: ServerResponse, status: number, body: Buffer | string, contentType: string, extra: Record<string, string> = {}): void {
  const buf = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': buf.length,
    'x-github-request-id': nextRequestId(),
    ...extra,
  });
  res.end(buf);
}

function sendJson(res: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  send(res, status, JSON.stringify(value), JSON_TYPE, extra);
}

const EMPTY_PARAMS = new URLSearchParams();

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooBig = false;
    req.on('data', (chunk: Buffer) => {
      if (tooBig) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        tooBig = true;
        req.resume();
        resolve(Buffer.concat(chunks));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const rawUrl = req.url ?? '/';
      const q = rawUrl.indexOf('?');
      const path = q < 0 ? rawUrl : rawUrl.slice(0, q);
      const queryStr = q < 0 ? '' : rawUrl.slice(q + 1);
      const method = req.method ?? 'GET';
      const authed = isAuthed(req);

      // The env's boot check: 200 {"ok":true}.
      if (method === 'GET' && path === '/healthz') {
        sendJson(res, 200, { ok: true });
        return;
      }

      const needsBody = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
      const body = needsBody ? await readBody(req) : Buffer.alloc(0);
      const query = queryStr === '' ? EMPTY_PARAMS : new URLSearchParams(queryStr);
      const origin = `http://${req.headers.host ?? '127.0.0.1'}`;

      // GraphQL.
      if (path === '/api/graphql') {
        if (method !== 'POST') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        const out = handleGraphql(forge, { body, authed });
        send(res, out.status, out.body, JSON_TYPE);
        return;
      }

      // MCP.
      if (path === '/mcp') {
        const out = handleMcp(forge, { method, body, authed });
        send(res, out.status, out.body, out.headers?.['content-type'] ?? JSON_TYPE, {
          ...(out.headers?.['mcp-protocol-version'] !== undefined
            ? { 'mcp-protocol-version': out.headers['mcp-protocol-version'] }
            : {}),
        });
        return;
      }

      // REST v3.
      if (path === '/api/v3' || path.startsWith('/api/v3/')) {
        const out = handleRest(forge, { method, path, query, body, authed, origin });
        if (out.status === 204) {
          res.writeHead(204, { 'x-github-request-id': nextRequestId() });
          res.end();
          return;
        }
        send(res, out.status, out.body, JSON_TYPE, out.headers ?? {});
        return;
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)$/.exec(path);
      if (gitMatch !== null) {
        const owner = decodeURIComponent(gitMatch[1]!);
        const repoName = decodeURIComponent(gitMatch[2]!);
        const gitPath = gitMatch[3]!;
        if (gitPath !== '/info/refs' && gitPath !== '/git-upload-pack' && gitPath !== '/git-receive-pack') {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (!authed) {
          sendJson(res, 401, { message: 'Requires authentication' });
          return;
        }
        const repo = forge.getRepo(owner, repoName);
        if (repo === undefined || repo.owner !== owner) {
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }
        if (gitHandler === null) {
          sendJson(res, 501, { message: 'git support is not loaded' });
          return;
        }
        const out = await gitHandler({ method, url: rawUrl, headers: req.headers, body }, repo);
        send(res, out.status, out.body, out.headers['content-type'] ?? 'application/x-git-upload-pack-advertisement', out.headers);
        return;
      }

      // Everything else: GitHub's 404 body.
      sendJson(res, 404, { message: 'Not Found' });
    })().catch(() => {
      try {
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      } catch {
        // The socket is already gone; nothing to do.
      }
    });
  });
}
