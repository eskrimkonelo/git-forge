// rest.ts — the GitHub REST v3 surface under /api/v3.
//
// Routes (exactly the wire contract in RULES.txt):
//   GET  /api/v3/                                  root (+ X-OAuth-Scopes)
//   GET  /api/v3/meta                              {installed_version}
//   GET  /api/v3/user                              the token owner
//   GET  /api/v3/user/repos                        list, Link pagination
//   POST /api/v3/user/repos                        create (duplicate name -> 422)
//   GET/PATCH/DELETE /api/v3/repos/{owner}/{repo}
//   GET  /api/v3/repos/{owner}/{repo}/branches
//   GET  /api/v3/repos/{owner}/{repo}/branches/{branch}
//   GET  /api/v3/repos/{owner}/{repo}/commits?sha=
//   POST /api/v3/repos/{owner}/{repo}/git/refs
//   GET  /api/v3/repos/{owner}/{repo}/git/refs/heads/{branch}
//   PUT/GET/DELETE /api/v3/repos/{owner}/{repo}/contents/{path}
//   POST/GET /api/v3/repos/{owner}/{repo}/labels
//   POST/GET /api/v3/repos/{owner}/{repo}/issues
//   GET/PATCH /api/v3/repos/{owner}/{repo}/issues/{n}
//   POST/GET /api/v3/repos/{owner}/{repo}/issues/{n}/comments
//   POST/GET /api/v3/repos/{owner}/{repo}/pulls
//   GET  /api/v3/repos/{owner}/{repo}/pulls/{n}
//   GET  /api/v3/repos/{owner}/{repo}/pulls/{n}/files
//   PUT  /api/v3/repos/{owner}/{repo}/pulls/{n}/merge
//
// Every reply is application/json with X-GitHub-Request-Id; errors are
// {"message": ...}. Missing/wrong Bearer token is 401; a repository under
// any owner but the token's login is 404, never 403.

import {
  Forge,
  VIEWER_LOGIN,
  VIEWER_ID,
  globalId,
  type Repo,
} from './store.ts';
import {
  branchObject,
  commitObject,
  createPull,
  deleteContents,
  getContents,
  issueJsonString,
  issueObject,
  labelObject,
  mergePull,
  prFiles,
  pullObject,
  putContents,
  repoJson,
  resolveRepo,
} from './forge-api.ts';

export interface RestCtx {
  method: string;
  /** Pathname, e.g. /api/v3/repos/adaiversen/foo/issues (no query). */
  path: string;
  query: URLSearchParams;
  /** Raw request body (may be empty). */
  body: Buffer;
  /** Whether the Bearer token matched MAKEFUN_SHOP_TOKEN. */
  authed: boolean;
  /** The entry's own origin, for absolute Link URLs. */
  origin: string;
}

export interface RestReply {
  status: number;
  /** Already-serialized JSON ('' for 204). */
  body: string;
  headers?: Record<string, string>;
}

const json = (status: number, value: unknown, headers?: Record<string, string>): RestReply => ({
  status,
  body: JSON.stringify(value),
  headers,
});

const err = (status: number, message: string): RestReply => json(status, { message });

const notFound = (what = 'Not Found'): RestReply => err(404, what);

function decode(seg: string): string {
  try {
    return decodeURIComponent(seg);
  } catch {
    return seg;
  }
}

/** Parse a JSON body; returns null when the body is absent/empty. */
function parseBody(ctx: RestCtx): { ok: true; value: unknown } | { ok: false; reply: RestReply } {
  if (ctx.body.length === 0) return { ok: true, value: undefined };
  try {
    return { ok: true, value: JSON.parse(ctx.body.toString('utf8')) };
  } catch {
    return { ok: false, reply: err(400, 'malformed JSON body') };
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function pageParams(ctx: RestCtx): { perPage: number; page: number } {
  const perPage = Math.max(1, Math.min(100, Number(ctx.query.get('per_page') ?? '30') || 30));
  const page = Math.max(1, Number(ctx.query.get('page') ?? '1') || 1);
  return { perPage, page };
}

function paginate<T>(items: readonly T[], perPage: number, page: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}

function linkHeader(origin: string, path: string, query: URLSearchParams, perPage: number, page: number, total: number): string | null {
  const pages = Math.max(1, Math.ceil(total / perPage));
  if (pages <= 1) return null;
  const urlFor = (p: number): string => {
    const q = new URLSearchParams(query);
    q.set('per_page', String(perPage));
    q.set('page', String(p));
    return `${origin}${path}?${q.toString()}`;
  };
  const parts: string[] = [];
  if (page < pages) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(pages)}>; rel="last"`);
  return parts.join(', ');
}

export function handleRest(forge: Forge, ctx: RestCtx): RestReply {
  if (!ctx.authed) return err(401, 'Requires authentication');
  const path = ctx.path;
  const method = ctx.method;

  // -- root + meta -----------------------------------------------------------
  if (path === '/api/v3/' || path === '/api/v3') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, {}, { 'X-OAuth-Scopes': 'repo, read:user' });
  }
  if (path === '/api/v3/meta') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { installed_version: 'github-core-clone-01/1.0.0' });
  }

  // -- /user -----------------------------------------------------------------
  if (path === '/api/v3/user') {
    if (method !== 'GET') return err(404, 'Not Found');
    return json(200, { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' });
  }

  // -- /user/repos -----------------------------------------------------------
  if (path === '/api/v3/user/repos') {
    if (method === 'GET') {
      const { perPage, page } = pageParams(ctx);
      const all = forge.listRepos(VIEWER_LOGIN);
      const items = paginate(all, perPage, page).map((r) => repoJson(r));
      const link = linkHeader(ctx.origin, path, ctx.query, perPage, page, all.length);
      return json(200, items, link !== null ? { Link: link } : undefined);
    }
    if (method === 'POST') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'name is required');
      const repo = forge.createRepo(
        VIEWER_LOGIN,
        name,
        typeof body.description === 'string' ? body.description : '',
        body.private === true,
      );
      if (repo === null) return err(422, 'a repository with this name already exists');
      return json(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // -- /repos/{owner}/{repo}/... ---------------------------------------------
  const m = /^\/api\/v3\/repos\/([^/]+)\/([^/]+)(?:\/(.*))?$/.exec(path);
  if (m === null) return err(404, 'Not Found');
  const owner = decode(m[1]!);
  const repoName = decode(m[2]!);
  const rest = m[3] ?? '';
  const repo = resolveRepo(forge, owner, repoName);
  if (repo === null) return notFound('Not Found');

  if (rest === '') {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      repo.repoJson = null;
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      forge.deleteRepo(owner, repoName);
      return { status: 204, body: '' };
    }
    return err(404, 'Not Found');
  }

  const segs = rest.split('/').map(decode);

  // -- branches ---------------------------------------------------------------
  if (segs[0] === 'branches') {
    if (method === 'GET' && segs.length === 1) {
      if (repo.branchesJson !== null) return { status: 200, body: repo.branchesJson };
      const list = [...repo.refs.keys()]
        .filter((r) => r.startsWith('refs/heads/'))
        .map((r) => r.slice('refs/heads/'.length))
        .sort()
        .map((name) => branchObject(name, repo.getRef(`refs/heads/${name}`)!));
      const text = JSON.stringify(list);
      repo.branchesJson = text;
      return { status: 200, body: text };
    }
    if (method === 'GET' && segs.length === 2) {
      const sha = repo.getRef(`refs/heads/${segs[1]}`);
      if (sha === undefined) return notFound('Branch not found');
      return json(200, branchObject(segs[1]!, sha));
    }
    return err(404, 'Not Found');
  }

  // -- commits ----------------------------------------------------------------
  if (segs[0] === 'commits') {
    if (method === 'GET' && segs.length === 1) {
      const shaParam = ctx.query.get('sha');
      const refName = shaParam !== null && shaParam !== '' ? `refs/heads/${shaParam}` : repo.headRefName();
      let tip = repo.getRef(refName);
      if (tip === undefined && shaParam !== null && repo.getObject(shaParam)?.type === 'commit') tip = shaParam;
      if (tip === undefined) return json(200, []);
      const out: unknown[] = [];
      for (const oid of repo.walkCommits(tip)) {
        const c = commitObject(repo, oid);
        if (c !== null) out.push(c);
      }
      return json(200, out);
    }
    return err(404, 'Not Found');
  }

  // -- git/refs ---------------------------------------------------------------
  if (segs[0] === 'git' && segs[1] === 'refs') {
    if (method === 'POST' && segs.length === 2) {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !/^[0-9a-f]{40}$/.test(sha)) return err(422, 'ref and sha are required');
      if (repo.getObject(sha) === undefined || repo.getObject(sha)?.type !== 'commit') {
        return err(422, 'object does not exist');
      }
      if (repo.getRef(ref) !== undefined) return err(422, 'reference already exists');
      repo.setRef(ref, sha);
      return json(201, { ref, object: { sha }, node_id: globalId('Ref', repo.id) });
    }
    if (method === 'GET' && segs.length === 4 && segs[2] === 'heads') {
      const sha = repo.getRef(`refs/heads/${segs[3]}`);
      if (sha === undefined) return notFound('Reference does not exist');
      return json(200, { ref: `refs/heads/${segs[3]}`, object: { sha } });
    }
    return err(404, 'Not Found');
  }

  // -- contents ---------------------------------------------------------------
  if (segs[0] === 'contents') {
    const filePath = segs.slice(1).join('/');
    if (method === 'PUT') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const message = typeof body.message === 'string' ? body.message : 'update';
      const contentB64 = typeof body.content === 'string' ? body.content : '';
      if (contentB64 === '') return err(422, 'content is required');
      let content: Buffer;
      try {
        content = Buffer.from(contentB64, 'base64');
      } catch {
        return err(422, 'content is not valid base64');
      }
      const result = putContents(repo, {
        path: filePath,
        content,
        message,
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (!result.ok) return err(result.status, result.error ?? 'failed');
      return json(result.status, {
        content: { name: filePath.split('/').pop() ?? '', path: filePath, sha: result.contentSha, size: content.length, encoding: 'base64' },
        commit: { sha: result.commitSha, message },
      });
    }
    if (method === 'GET') {
      const entry = getContents(repo, filePath, ctx.query.get('ref') ?? undefined);
      if (entry === null) return notFound('Not Found');
      if (entry.kind === 'file') {
        return json(200, {
          type: 'file',
          encoding: 'base64',
          content: entry.content.toString('base64'),
          sha: entry.sha,
          size: entry.size,
          name: filePath.split('/').pop() ?? '',
          path: filePath,
        });
      }
      return json(200, entry.entries);
    }
    if (method === 'DELETE') {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const result = deleteContents(repo, {
        path: filePath,
        message: typeof body.message === 'string' ? body.message : 'delete',
        branch: typeof body.branch === 'string' ? body.branch : undefined,
        sha: typeof body.sha === 'string' ? body.sha : undefined,
      });
      if (!result.ok) return err(result.status, result.error ?? 'failed');
      return json(200, { commit: { sha: result.commitSha } });
    }
    return err(404, 'Not Found');
  }

  // -- labels -----------------------------------------------------------------
  if (segs[0] === 'labels') {
    if (method === 'GET' && segs.length === 1) {
      return json(200, [...repo.labels.values()].map((l) => labelObject(l)));
    }
    if (method === 'POST' && segs.length === 1) {
      const parsed = parseBody(ctx);
      if (!parsed.ok) return parsed.reply;
      const body = isRecord(parsed.value) ? parsed.value : {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return err(422, 'name is required');
      const color = typeof body.color === 'string' ? body.color : 'ededed';
      const existing = repo.labels.get(name);
      if (existing !== undefined) return json(200, labelObject(existing));
      const label = { name, color };
      repo.labels.set(name, label);
      return json(201, labelObject(label));
    }
    return err(404, 'Not Found');
  }

  // -- issues -----------------------------------------------------------------
  if (segs[0] === 'issues') {
    if (segs.length === 1) {
      if (method === 'POST') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof body.title === 'string' ? body.title : '';
        if (title === '') return err(422, 'title is required');
        const labelNames: string[] = Array.isArray(body.labels)
          ? body.labels.filter((l): l is string => typeof l === 'string')
          : [];
        const labels: { name: string; color: string }[] = [];
        for (const name of labelNames) {
          const found = repo.labels.get(name);
          if (found === undefined) return err(422, `label does not exist: ${name}`);
          labels.push(found);
        }
        const issue = repo.createIssue(title, typeof body.body === 'string' ? body.body : '', labels);
        return { status: 201, body: issueJsonString(repo, issue) };
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        const sort = ctx.query.get('sort') ?? 'created';
        const direction = ctx.query.get('direction') ?? 'desc';
        let list = [...repo.issues];
        if (state === 'open') list = list.filter((i) => i.state === 'open');
        else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
        if (sort === 'created') {
          list.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
        }
        const { perPage, page } = pageParams(ctx);
        return json(200, paginate(list, perPage, page).map((i) => issueObject(repo, i)));
      }
      return err(404, 'Not Found');
    }
    const num = Number(segs[1]);
    if (!Number.isInteger(num) || num <= 0) return err(404, 'Not Found');
    if (segs.length === 2) {
      if (method === 'GET') {
        const issue = repo.getIssue(num);
        if (issue === undefined) return notFound('Not Found');
        return { status: 200, body: issueJsonString(repo, issue) };
      }
      if (method === 'PATCH') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const issue = repo.getIssue(num);
        if (issue === undefined) return notFound('Not Found');
        if (body.state === 'open' || body.state === 'closed') {
          issue.state = body.state;
          repo.issueJson.delete(num);
        }
        if (typeof body.title === 'string') {
          issue.title = body.title;
          repo.issueJson.delete(num);
        }
        if (typeof body.body === 'string') {
          issue.body = body.body;
          repo.issueJson.delete(num);
        }
        return { status: 200, body: issueJsonString(repo, issue) };
      }
      return err(404, 'Not Found');
    }
    if (segs.length === 3 && segs[2] === 'comments') {
      if (method === 'POST') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const issue = repo.getIssue(num);
        if (issue === undefined) return notFound('Not Found');
        const text = typeof body.body === 'string' ? body.body : '';
        repo.commentSeq += 1;
        repo.clock += 1;
        const comment = { id: repo.commentSeq, body: text, seq: repo.clock };
        repo.comments.get(num)!.push(comment);
        return json(201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } });
      }
      if (method === 'GET') {
        const issue = repo.getIssue(num);
        if (issue === undefined) return notFound('Not Found');
        const list = (repo.comments.get(num) ?? []).map((c) => ({ id: c.id, body: c.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID } }));
        return json(200, list);
      }
      return err(404, 'Not Found');
    }
    return err(404, 'Not Found');
  }

  // -- pulls ------------------------------------------------------------------
  if (segs[0] === 'pulls') {
    if (segs.length === 1) {
      if (method === 'POST') {
        const parsed = parseBody(ctx);
        if (!parsed.ok) return parsed.reply;
        const body = isRecord(parsed.value) ? parsed.value : {};
        const title = typeof body.title === 'string' ? body.title : '';
        const head = typeof body.head === 'string' ? body.head : '';
        const base = typeof body.base === 'string' ? body.base : '';
        if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
        const result = createPull(repo, { title, body: typeof body.body === 'string' ? body.body : '', head, base });
        if (!result.ok || result.pull === undefined) return err(result.status, result.error ?? 'failed');
        return json(201, pullObject(repo, result.pull));
      }
      if (method === 'GET') {
        const state = ctx.query.get('state') ?? 'open';
        let list = [...repo.pulls];
        if (state === 'open') list = list.filter((p) => p.state === 'open');
        else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
        list.sort((a, b) => b.seq - a.seq);
        const { perPage, page } = pageParams(ctx);
        return json(200, paginate(list, perPage, page).map((p) => pullObject(repo, p)));
      }
      return err(404, 'Not Found');
    }
    const num = Number(segs[1]);
    if (!Number.isInteger(num) || num <= 0) return err(404, 'Not Found');
    if (segs.length === 2 && method === 'GET') {
      const pull = repo.getPull(num);
      if (pull === undefined) return notFound('Not Found');
      return json(200, pullObject(repo, pull));
    }
    if (segs.length === 3 && segs[2] === 'files' && method === 'GET') {
      const pull = repo.getPull(num);
      if (pull === undefined) return notFound('Not Found');
      return json(200, prFiles(repo, pull));
    }
    if (segs.length === 3 && segs[2] === 'merge' && method === 'PUT') {
      const pull = repo.getPull(num);
      if (pull === undefined) return notFound('Not Found');
      const result = mergePull(repo, pull);
      if (!result.ok) return err(result.status, result.error ?? 'failed');
      return json(200, { merged: true, sha: result.mergeSha, message: 'Pull request successfully merged' });
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}
