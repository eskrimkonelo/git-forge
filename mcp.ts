// mcp.ts — the Model Context Protocol surface at POST /mcp.
//
// JSON-RPC 2.0 over Streamable HTTP (plain JSON responses; no SSE needed).
// Modern era 2026-07-28 via server/discover; the legacy initialize +
// notifications/initialized handshake is also answered. Tools share the
// REST store, so a repository or issue created over MCP is the same object
// over REST, with the same ids.
//
// Tools (all with a non-empty description and an inputSchema of type
// object; the suite matches them by suffix, case-insensitive):
//   create_repo, get_repo, create_issue, list_issues,
//   create_pull_request, merge_pull_request, get_issue, list_repos
//
// Errors: unknown tool -> -32601; unknown method -> -32601; missing
// required arguments -> isError:true; a body that is not JSON -> HTTP 400
// with -32700; no Authorization header -> HTTP 401.

import {
  Forge,
  VIEWER_LOGIN,
  type Repo,
} from './store.ts';
import {
  createPull,
  issueObject,
  mergePull,
  pullObject,
  repoJson,
  resolveRepo,
} from './forge-api.ts';

export interface McpCtx {
  method: string;
  body: Buffer;
  authed: boolean;
}

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner (the authenticated user).' }),
        name: Object.freeze({ type: 'string', description: 'The repository name.' }),
        description: Object.freeze({ type: 'string', description: 'A short description of the repository.' }),
        private: Object.freeze({ type: 'boolean', description: 'Whether the repository is private.' }),
      }),
      required: Object.freeze(['name']),
    }),
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The issue title.' }),
        body: Object.freeze({ type: 'string', description: 'The issue body.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title']),
    }),
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        state: Object.freeze({ type: 'string', description: 'open, closed or all.' }),
      }),
      required: Object.freeze(['owner', 'repo']),
    }),
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch onto a base branch.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        title: Object.freeze({ type: 'string', description: 'The pull request title.' }),
        body: Object.freeze({ type: 'string', description: 'The pull request body.' }),
        head: Object.freeze({ type: 'string', description: 'The head branch name.' }),
        base: Object.freeze({ type: 'string', description: 'The base branch name.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'title', 'head', 'base']),
    }),
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        pull_number: Object.freeze({ type: 'integer', description: 'The pull request number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'pull_number']),
    }),
  }),
  Object.freeze({
    name: 'get_issue',
    description: 'Read one issue by number.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
        repo: Object.freeze({ type: 'string', description: 'The repository name.' }),
        number: Object.freeze({ type: 'integer', description: 'The issue number.' }),
      }),
      required: Object.freeze(['owner', 'repo', 'number']),
    }),
  }),
  Object.freeze({
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: Object.freeze({
      type: 'object',
      properties: Object.freeze({
        owner: Object.freeze({ type: 'string', description: 'The repository owner.' }),
      }),
      required: Object.freeze([]),
    }),
  }),
]);

/** Byte-identical tools/list payload (the tools array never changes). */
const TOOLS_JSON = JSON.stringify(TOOLS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function rpcResult(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

function toolOk(payload: unknown): Record<string, unknown> {
  const text = JSON.stringify(payload);
  return { content: [{ type: 'text', text }], structuredContent: payload };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArg(name: string): Record<string, unknown> {
  return toolError(`missing required argument: ${name}`);
}

function reqString(args: Record<string, unknown>, name: string): string | null {
  const v = args[name];
  return typeof v === 'string' && v !== '' ? v : null;
}

function optString(args: Record<string, unknown>, name: string): string {
  const v = args[name];
  return typeof v === 'string' ? v : '';
}

function reqNumber(args: Record<string, unknown>, name: string): number | null {
  const v = args[name];
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/** Execute one tool; returns the tool result object. */
function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = reqString(args, 'name');
      if (repoName === null) return missingArg('name');
      const description = optString(args, 'description');
      const isPrivate = args.private === true;
      const repo = forge.createRepo(VIEWER_LOGIN, repoName, description, isPrivate);
      if (repo === null) return toolError('a repository with this name already exists');
      return toolOk(repoJson(repo));
    }
    case 'get_repo': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      const repo = resolveRepo(forge, owner, repoName);
      if (repo === null) return toolError(`repository not found: ${owner}/${repoName}`);
      return toolOk(repoJson(repo));
    }
    case 'create_issue': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const title = reqString(args, 'title');
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (title === null) return missingArg('title');
      const repo = resolveRepo(forge, owner, repoName);
      if (repo === null) return toolError(`repository not found: ${owner}/${repoName}`);
      const issue = repo.createIssue(title, optString(args, 'body'), []);
      return toolOk(issueObject(repo, issue));
    }
    case 'list_issues': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      const repo = resolveRepo(forge, owner, repoName);
      if (repo === null) return toolError(`repository not found: ${owner}/${repoName}`);
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return toolOk({ issues: list.map((i) => issueObject(repo, i)) });
    }
    case 'create_pull_request': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const title = reqString(args, 'title');
      const head = reqString(args, 'head');
      const base = reqString(args, 'base');
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (title === null) return missingArg('title');
      if (head === null) return missingArg('head');
      if (base === null) return missingArg('base');
      const repo = resolveRepo(forge, owner, repoName);
      if (repo === null) return toolError(`repository not found: ${owner}/${repoName}`);
      const result = createPull(repo, { title, body: optString(args, 'body'), head, base });
      if (!result.ok || result.pull === undefined) return toolError(result.error ?? 'could not create the pull request');
      return toolOk(pullObject(repo, result.pull));
    }
    case 'merge_pull_request': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const number = reqNumber(args, 'pull_number');
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (number === null) return missingArg('pull_number');
      const repo = resolveRepo(forge, owner, repoName);
      if (repo === null) return toolError(`repository not found: ${owner}/${repoName}`);
      const pull = repo.getPull(number);
      if (pull === undefined) return toolError(`pull request not found: #${number}`);
      const result = mergePull(repo, pull);
      if (!result.ok) return toolError(result.error ?? 'could not merge the pull request');
      return toolOk({ merged: true, sha: result.mergeSha, number, state: 'closed' });
    }
    case 'get_issue': {
      const owner = reqString(args, 'owner');
      const repoName = reqString(args, 'repo');
      const number = reqNumber(args, 'number');
      if (owner === null) return missingArg('owner');
      if (repoName === null) return missingArg('repo');
      if (number === null) return missingArg('number');
      const repo = resolveRepo(forge, owner, repoName);
      if (repo === null) return toolError(`repository not found: ${owner}/${repoName}`);
      const issue = repo.getIssue(number);
      if (issue === undefined) return toolError(`issue not found: #${number}`);
      return toolOk(issueObject(repo, issue));
    }
    case 'list_repos': {
      const repos = forge.listRepos(VIEWER_LOGIN);
      return toolOk({ repositories: repos.map((r) => repoJson(r)) });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

export function handleMcp(forge: Forge, ctx: McpCtx): { status: number; body: string; headers?: Record<string, string> } {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'mcp-protocol-version': '2026-07-28',
  };
  // A legacy session close (DELETE) needs no body.
  if (ctx.method === 'DELETE') return { status: 204, body: '', headers };
  if (ctx.method !== 'POST') {
    return { status: 405, body: JSON.stringify({ message: 'method not allowed' }), headers };
  }
  if (!ctx.authed) {
    return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }), headers };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: rpcError(null, -32700, 'Parse error'), headers };
  }
  if (!isRecord(parsed) || typeof parsed.method !== 'string') {
    return { status: 400, body: rpcError(null, -32600, 'Invalid Request'), headers };
  }
  const id = parsed.id ?? null;
  const method = parsed.method;
  const params = isRecord(parsed.params) ? parsed.params : {};

  // Notifications (no id) are acknowledged with 202 and no body.
  if (id === null || id === undefined) {
    return { status: 202, body: '', headers };
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    return {
      status: 200,
      body: rpcResult(id, {
        supportedVersions: SUPPORTED_VERSIONS,
        serverInfo,
        capabilities: { tools: {} },
        _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
      }),
      headers,
    };
  }

  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
    return {
      status: 200,
      body: rpcResult(id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      }),
      headers,
    };
  }

  if (method === 'tools/list') {
    // The tools array is a frozen constant: byte-identical on every call.
    return {
      status: 200,
      body: `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":{"tools":${TOOLS_JSON}}}`,
      headers,
    };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = TOOLS.some((t) => t.name === toolName);
    if (!known) {
      return { status: 200, body: rpcError(id, -32601, `Method not found: ${toolName}`), headers };
    }
    const result = callTool(forge, toolName, args);
    return { status: 200, body: rpcResult(id, result), headers };
  }

  if (method === 'ping') {
    return { status: 200, body: rpcResult(id, {}), headers };
  }

  return { status: 200, body: rpcError(id, -32601, `Method not found: ${method}`), headers };
}
