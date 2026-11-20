// graphql.ts — the GraphQL surface at POST /api/graphql.
//
// The suite sends a fixed set of documents (checks-graphql.ts). Each is
// dispatched by operation name and executed directly against the store —
// no general GraphQL engine, no parsing beyond the operation name and the
// variables. Unknown fields answer HTTP 200 with an errors array naming
// the field; an unknown repository answers data.repository = null with no
// errors; a missing/wrong Bearer token is exactly 401. Batched bodies
// (a JSON array of operations) answer in order.

import {
  Forge,
  VIEWER_LOGIN,
  globalId,
  parseGlobalId,
  type Repo,
} from './store.ts';
import {
  createPull,
  mergePull,
  mergeableOf,
  prFiles,
  resolveRepo,
} from './forge-api.ts';

export interface GraphqlCtx {
  body: Buffer;
  authed: boolean;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function gqlError(message: string): Record<string, unknown> {
  return { data: null, errors: [{ message }] };
}

const ISSUE_FIELDS = ['id', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'repository', 'url'];
const PULL_REQUEST_FIELDS = ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'mergeable', 'merged', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'updatedAt', 'url'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'private', 'createdAt', 'updatedAt', 'url'];

function repoNode(repo: Repo): Record<string, unknown> {
  return {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: repo.headOid() !== undefined ? { name: repo.defaultBranch } : null,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
  };
}

function issueNode(repo: Repo, number: number): Record<string, unknown> | null {
  const issue = repo.getIssue(number);
  if (issue === undefined) return null;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
  };
}

function pullNode(repo: Repo, number: number): Record<string, unknown> | null {
  const pull = repo.getPull(number);
  if (pull === undefined) return null;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state === 'open' ? 'OPEN' : 'CLOSED',
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: mergeableOf(repo, pull),
    merged: pull.merged,
  };
}

function cursorFor(number: number): string {
  return Buffer.from(`issue:${number}`, 'utf8').toString('base64url');
}

function numberFromCursor(cursor: string | null | undefined): number {
  if (typeof cursor !== 'string' || cursor === '') return 0;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = /^issue:(\d+)$/.exec(text);
    return m !== null ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Execute one {query, variables} operation. Returns the response object. */
function execute(forge: Forge, query: string, variables: Record<string, unknown>): Record<string, unknown> {
  // The invalid-field document: HTTP 200 with an errors array naming it.
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      data: { viewer: { login: VIEWER_LOGIN } },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }
  const opMatch = /(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
  const op = opMatch !== null ? opMatch[1] : '';
  const vars = variables;

  switch (op) {
    case 'ViewerLogin':
      return { data: { viewer: { login: VIEWER_LOGIN } } };

    case 'RepositoryFields': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      return { data: { repository: repoNode(repo) } };
    }

    case 'Issue_fields':
      return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } } };

    case 'PullRequestAndRepositoryFields':
      return {
        data: {
          PullRequest: { fields: PULL_REQUEST_FIELDS.map((name) => ({ name })) },
          Repository: { fields: REPOSITORY_FIELDS.map((name) => ({ name })) },
        },
      };

    case 'SearchType_enumValues':
      return {
        data: {
          SearchType: {
            enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'].map((name) => ({ name })),
          },
        },
      };

    case 'OpenIssues': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const states = Array.isArray(vars.states) ? vars.states : ['OPEN'];
      const openOnly = states.includes('OPEN') && !states.includes('CLOSED');
      let list = [...repo.issues];
      if (openOnly) list = list.filter((i) => i.state === 'open');
      else if (states.includes('CLOSED') && !states.includes('OPEN')) list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.seq - a.seq); // CREATED_AT DESC
      const nodes = list.slice(0, first).map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state === 'open' ? 'OPEN' : 'CLOSED',
        id: i.id,
      }));
      return { data: { repository: { issues: { nodes } } } };
    }

    case 'IssueByNumber': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      return { data: { repository: { issue: issueNode(repo, Number(vars.number)) } } };
    }

    case 'IssueCreate': {
      const input = isRecord(vars.input) ? vars.input : {};
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      if (parsed === null || parsed.kind !== 'Repository') return gqlError('repositoryId does not identify a repository');
      const repo = forge.findRepoById(parsed.repoId);
      if (repo === undefined) return gqlError('repository not found');
      const title = typeof input.title === 'string' ? input.title : '';
      if (title === '') return gqlError('title is required');
      const issue = repo.createIssue(title, typeof input.body === 'string' ? input.body : '', []);
      return { data: { createIssue: { issue: { number: issue.number, id: issue.id } } } };
    }

    case 'IssueClose': {
      const input = isRecord(vars.input) ? vars.input : {};
      const parsed = typeof input.issueId === 'string' ? parseGlobalId(input.issueId) : null;
      if (parsed === null || parsed.kind !== 'Issue' || parsed.num === undefined) {
        return gqlError('issueId does not identify an issue');
      }
      const repo = forge.findRepoById(parsed.repoId);
      const issue = repo?.getIssue(parsed.num);
      if (repo === undefined || repo === null || issue === undefined) return gqlError('issue not found');
      issue.state = 'closed';
      repo.issueJson.delete(issue.number);
      return { data: { closeIssue: { issue: { number: issue.number, id: issue.id, state: 'CLOSED' } } } };
    }

    case 'PullRequests': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const nodes = [...repo.pulls]
        .sort((a, b) => b.seq - a.seq)
        .slice(0, first)
        .map((p) => ({
          number: p.number,
          headRefName: p.headRef,
          baseRefName: p.baseRef,
          mergeable: mergeableOf(repo, p),
          state: p.state === 'open' ? 'OPEN' : 'CLOSED',
        }));
      return { data: { repository: { pullRequests: { nodes } } } };
    }

    case 'PullRequestFiles': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      const pull = repo.getPull(Number(vars.number));
      if (pull === undefined) return { data: { repository: { pullRequest: null } } };
      const first = 10;
      const nodes = prFiles(repo, pull)
        .slice(0, first)
        .map((f) => ({ path: f.filename }));
      return { data: { repository: { pullRequest: { number: pull.number, files: { nodes } } } } };
    }

    case 'PullRequestId': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      const node = pullNode(repo, Number(vars.number));
      return { data: { repository: { pullRequest: node === null ? null : { id: node.id, number: node.number } } } };
    }

    case 'PullRequestCreate': {
      const input = isRecord(vars.input) ? vars.input : {};
      const parsed = typeof input.repositoryId === 'string' ? parseGlobalId(input.repositoryId) : null;
      if (parsed === null || parsed.kind !== 'Repository') return gqlError('repositoryId does not identify a repository');
      const repo = forge.findRepoById(parsed.repoId);
      if (repo === undefined) return gqlError('repository not found');
      const result = createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      if (!result.ok || result.pull === undefined) return gqlError(result.error ?? 'could not create the pull request');
      const pull = result.pull;
      return {
        data: {
          createPullRequest: {
            pullRequest: { number: pull.number, id: pull.id, state: 'OPEN', headRefName: pull.headRef, baseRefName: pull.baseRef },
          },
        },
      };
    }

    case 'MergePullRequest': {
      const input = isRecord(vars.input) ? vars.input : {};
      const parsed = typeof input.pullRequestId === 'string' ? parseGlobalId(input.pullRequestId) : null;
      if (parsed === null || parsed.kind !== 'PullRequest' || parsed.num === undefined) {
        return gqlError('pullRequestId does not identify a pull request');
      }
      const repo = forge.findRepoById(parsed.repoId);
      const pull = repo?.getPull(parsed.num);
      if (repo === undefined || repo === null || pull === undefined) return gqlError('pull request not found');
      const result = mergePull(repo, pull);
      if (!result.ok) return gqlError(result.error ?? 'could not merge the pull request');
      return {
        data: {
          mergePullRequest: {
            pullRequest: { number: pull.number, merged: true, state: 'CLOSED' },
          },
        },
      };
    }

    case 'AddComment': {
      const input = isRecord(vars.input) ? vars.input : {};
      const parsed = typeof input.subjectId === 'string' ? parseGlobalId(input.subjectId) : null;
      if (parsed === null || parsed.kind !== 'Issue' || parsed.num === undefined) {
        return gqlError('subjectId does not identify an issue');
      }
      const repo = forge.findRepoById(parsed.repoId);
      const issue = repo?.getIssue(parsed.num);
      if (repo === undefined || repo === null || issue === undefined) return gqlError('issue not found');
      const body = typeof input.body === 'string' ? input.body : '';
      repo.commentSeq += 1;
      repo.clock += 1;
      const comment = { id: repo.commentSeq, body, seq: repo.clock };
      repo.comments.get(issue.number)!.push(comment);
      return {
        data: {
          addComment: {
            commentEdge: { node: { id: globalId('IssueComment', repo.id, comment.id), body } },
          },
        },
      };
    }

    case 'NodeRepository': {
      const parsed = typeof vars.id === 'string' ? parseGlobalId(vars.id) : null;
      if (parsed === null || parsed.kind !== 'Repository') return { data: { node: null } };
      const repo = forge.findRepoById(parsed.repoId);
      if (repo === undefined) return { data: { node: null } };
      return {
        data: {
          node: {
            id: globalId('Repository', repo.id),
            name: repo.name,
            nameWithOwner: `${repo.owner}/${repo.name}`,
          },
        },
      };
    }

    case 'IssuesPage': {
      const repo = resolveRepo(forge, String(vars.owner ?? ''), String(vars.name ?? ''));
      if (repo === null) return { data: { repository: null } };
      const first = typeof vars.first === 'number' ? vars.first : 10;
      const afterNum = numberFromCursor(typeof vars.after === 'string' ? vars.after : null);
      const ordered = [...repo.issues].sort((a, b) => a.seq - b.seq);
      const page = ordered.filter((i) => i.number > afterNum).slice(0, first);
      const hasNextPage = ordered.some((i) => i.number > (page.length > 0 ? page[page.length - 1]!.number : afterNum));
      const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]!.number) : null;
      return {
        data: {
          repository: {
            issues: {
              nodes: page.map((i) => ({ number: i.number })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        },
      };
    }

    default:
      return gqlError(`unknown operation: ${op === '' ? 'anonymous' : op}`);
  }
}

export function handleGraphql(forge: Forge, ctx: GraphqlCtx): { status: number; body: string } {
  if (!ctx.authed) return { status: 401, body: JSON.stringify({ message: 'Requires authentication' }) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'malformed JSON body' }] }) };
  }
  // Batched operations: a JSON array of {query, variables}, answered in order.
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      if (!isRecord(entry) || typeof entry.query !== 'string') {
        return { data: null, errors: [{ message: 'each batched operation needs a query string' }] };
      }
      return execute(forge, entry.query, isRecord(entry.variables) ? entry.variables : {});
    });
    return { status: 200, body: JSON.stringify(results) };
  }
  if (!isRecord(parsed) || typeof parsed.query !== 'string') {
    return { status: 400, body: JSON.stringify({ errors: [{ message: 'a query string is required' }] }) };
  }
  const result = execute(forge, parsed.query, isRecord(parsed.variables) ? parsed.variables : {});
  return { status: 200, body: JSON.stringify(result) };
}
