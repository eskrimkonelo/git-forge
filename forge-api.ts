// forge-api.ts — shared domain operations for the REST, GraphQL and MCP
// surfaces. Every surface calls these, so a repository, issue or pull
// request is the same object no matter which surface created or read it.
//
// All timestamps derive from MAKEFUN_TRIAL_NOW (store.trialNowSec), never
// from a wall clock. All ids derive from counters. Nothing here does I/O.

import {
  Forge,
  Repo,
  VIEWER_LOGIN,
  VIEWER_ID,
  ZERO_OID,
  globalId,
  parseCommit,
  parseTree,
  trialNowSec,
  type Issue,
  type Label,
  type Pull,
} from './store.ts';

export function isoNow(): string {
  return new Date(trialNowSec() * 1000).toISOString();
}

// ------------------------------------------------------------------ shapes

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    databaseId: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

export function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.id * 1_000_000 + issue.number,
    node_id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ name: l.name, color: l.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

/** Cached serialized issue JSON (read-workload fast path). */
export function issueJsonString(repo: Repo, issue: Issue): string {
  const cached = repo.issueJson.get(issue.number);
  if (cached !== undefined) return cached;
  const text = JSON.stringify(issueObject(repo, issue));
  repo.issueJson.set(issue.number, text);
  return text;
}

export function pullObject(repo: Repo, pull: Pull): Record<string, unknown> {
  const headSha = repo.getRef(`refs/heads/${pull.headRef}`) ?? ZERO_OID;
  const baseSha = repo.getRef(`refs/heads/${pull.baseRef}`) ?? ZERO_OID;
  return {
    id: repo.id * 1_000_000 + pull.number,
    node_id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID },
    created_at: isoNow(),
    updated_at: isoNow(),
  };
}

export function labelObject(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function commitObject(repo: Repo, oid: string): Record<string, unknown> | null {
  const obj = repo.getObject(oid);
  if (obj === undefined || obj.type !== 'commit') return null;
  const info = parseCommit(obj.data);
  const author = { name: VIEWER_LOGIN, email: `${VIEWER_LOGIN}@example.invalid`, date: isoNow() };
  return {
    sha: oid,
    commit: { message: info.message, author, committer: author, tree: { sha: info.tree } },
    parents: info.parents.map((p) => ({ sha: p })),
  };
}

export function branchObject(name: string, sha: string): Record<string, unknown> {
  return { name, commit: { sha }, protected: false };
}

// ------------------------------------------------------------------ helpers

export function resolveRepo(forge: Forge, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return forge.getRepo(owner, name) ?? null;
}

function blobAt(repo: Repo, treeOid: string, path: string): string | null {
  const hit = repo.resolvePath(treeOid, path);
  return hit !== null && hit.type === 'blob' ? hit.oid : null;
}

function treeOfCommit(repo: Repo, commitOid: string): string | null {
  const obj = repo.getObject(commitOid);
  if (obj === undefined || obj.type !== 'commit') return null;
  return parseCommit(obj.data).tree;
}

/** Simple line-multiset diff: additions/deletions counts for a file change. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const m = new Map<string, number>();
    if (text === '') return m;
    for (const line of text.split('\n')) m.set(line, (m.get(line) ?? 0) + 1);
    return m;
  };
  const oldLines = countLines(oldText);
  const newLines = countLines(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

export interface PrFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** The changed files of a pull request: diff(base at creation, head tip). */
export function prFiles(repo: Repo, pull: Pull): PrFile[] {
  const headTip = repo.getRef(`refs/heads/${pull.headRef}`);
  if (headTip === undefined) return [];
  const headTree = treeOfCommit(repo, headTip);
  const baseTree = treeOfCommit(repo, pull.baseShaAtCreation);
  if (headTree === null || baseTree === null) return [];
  const out: PrFile[] = [];
  for (const change of repo.diffTrees(baseTree, headTree)) {
    if (change.status === 'removed') {
      const oldText = change.oldOid !== null ? (repo.getObject(change.oldOid)?.data.toString('utf8') ?? '') : '';
      const d = lineDiff(oldText, '');
      out.push({ filename: change.path, status: 'removed', additions: 0, deletions: d.deletions, changes: d.deletions });
      continue;
    }
    const oldText = change.oldOid !== null ? (repo.getObject(change.oldOid)?.data.toString('utf8') ?? '') : '';
    const newText = change.newOid !== null ? (repo.getObject(change.newOid)?.data.toString('utf8') ?? '') : '';
    const d = lineDiff(oldText, newText);
    out.push({
      filename: change.path,
      status: change.status === 'added' ? 'added' : 'modified',
      additions: d.additions,
      deletions: d.deletions,
      changes: d.additions + d.deletions,
    });
  }
  return out;
}

/** Would merging this pull request conflict with the base's current tip? */
export function mergeConflicts(repo: Repo, pull: Pull): boolean {
  const headTip = repo.getRef(`refs/heads/${pull.headRef}`);
  const baseTip = repo.getRef(`refs/heads/${pull.baseRef}`);
  if (headTip === undefined || baseTip === undefined) return true;
  const headTree = treeOfCommit(repo, headTip);
  const baseTreeNow = treeOfCommit(repo, baseTip);
  const baseTreeThen = treeOfCommit(repo, pull.baseShaAtCreation);
  if (headTree === null || baseTreeNow === null || baseTreeThen === null) return true;
  for (const change of repo.diffTrees(baseTreeThen, headTree)) {
    if (change.status === 'removed') continue;
    const atBaseNow = blobAt(repo, baseTreeNow, change.path);
    const atBaseThen = blobAt(repo, baseTreeThen, change.path);
    // The base moved on this path since the PR was opened, and the head's
    // version differs from the base's current version: conflict.
    if (atBaseNow !== atBaseThen && atBaseNow !== change.newOid) return true;
  }
  return false;
}

export function mergeableOf(repo: Repo, pull: Pull): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.state !== 'open') return 'UNKNOWN';
  return mergeConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

// ------------------------------------------------------------------ contents

export interface ContentsResult {
  ok: boolean;
  /** 201 create, 200 update. */
  status: number;
  commitSha: string;
  contentSha: string;
  error?: string;
}

/**
 * Create or update a file on a branch (default branch when omitted).
 * `sha` is the blob sha the caller believes is current; a mismatch is 409.
 * Size caps: 8 MiB per file, 16 MiB total tree.
 */
export function putContents(
  repo: Repo,
  opts: { path: string; content: Buffer; message: string; branch?: string; sha?: string },
): ContentsResult {
  if (opts.content.length > 8 * 1024 * 1024) {
    return { ok: false, status: 422, commitSha: '', contentSha: '', error: 'file exceeds 8 MiB' };
  }
  const branch = opts.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.getRef(refName);
  const tipTree = tip !== undefined ? treeOfCommit(repo, tip) : null;
  const current = tipTree !== null ? blobAt(repo, tipTree, opts.path) : null;
  if (opts.sha !== undefined && opts.sha !== current) {
    return { ok: false, status: 409, commitSha: '', contentSha: '', error: 'sha does not match the current blob' };
  }
  const blobOid = repo.putObject('blob', opts.content);
  const newTree = repo.setPath(tipTree ?? undefined, opts.path, blobOid);
  // Total-tree cap: sum the blobs of the new tree.
  let total = 0;
  for (const f of repo.listFiles(newTree)) {
    const obj = repo.getObject(f.oid);
    if (obj !== undefined) total += obj.data.length;
    if (total > 16 * 1024 * 1024) {
      return { ok: false, status: 422, commitSha: '', contentSha: '', error: 'tree exceeds 16 MiB' };
    }
  }
  const parents = tip !== undefined ? [tip] : [];
  const commitSha = repo.makeCommit(newTree, parents, opts.message);
  repo.setRef(refName, commitSha);
  return { ok: true, status: current === null ? 201 : 200, commitSha, contentSha: blobOid };
}

export interface DeleteResult {
  ok: boolean;
  status: number;
  commitSha: string;
  error?: string;
}

export function deleteContents(
  repo: Repo,
  opts: { path: string; message: string; branch?: string; sha?: string },
): DeleteResult {
  const branch = opts.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.getRef(refName);
  if (tip === undefined) return { ok: false, status: 404, commitSha: '', error: 'no such branch' };
  const tipTree = treeOfCommit(repo, tip);
  if (tipTree === null) return { ok: false, status: 404, commitSha: '', error: 'no such branch' };
  const current = blobAt(repo, tipTree, opts.path);
  if (current === null) return { ok: false, status: 404, commitSha: '', error: 'no such file' };
  if (opts.sha !== undefined && opts.sha !== current) {
    return { ok: false, status: 409, commitSha: '', error: 'sha does not match the current blob' };
  }
  const newTree = repo.setPath(tipTree, opts.path, null);
  const commitSha = repo.makeCommit(newTree, [tip], opts.message);
  repo.setRef(refName, commitSha);
  return { ok: true, status: 200, commitSha };
}

export type ContentEntry =
  | { kind: 'file'; content: Buffer; sha: string; size: number }
  | { kind: 'dir'; entries: { type: 'file' | 'dir'; name: string; path: string; sha: string }[] };

export function getContents(repo: Repo, path: string, ref?: string): ContentEntry | null {
  const branch = ref ?? repo.defaultBranch;
  // `ref` may be a branch name or a full ref; resolve both.
  const refName = branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
  let tip = repo.getRef(refName);
  if (tip === undefined && !branch.startsWith('refs/')) {
    // Maybe `ref` is a commit sha.
    tip = repo.getObject(branch)?.type === 'commit' ? branch : undefined;
  }
  if (tip === undefined) return null;
  const tree = treeOfCommit(repo, tip);
  if (tree === null) return null;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    // Root listing.
    const obj = repo.getObject(tree);
    if (obj === undefined) return null;
    const entries = parseTree(obj.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: e.name,
      sha: e.oid,
    }));
    return { kind: 'dir', entries };
  }
  const hit = repo.resolvePath(tree, clean);
  if (hit === null) return null;
  if (hit.type === 'tree') {
    const obj = repo.getObject(hit.oid);
    if (obj === undefined) return null;
    const entries = parseTree(obj.data).map((e) => ({
      type: (e.mode === '40000' ? 'dir' : 'file') as 'file' | 'dir',
      name: e.name,
      path: `${clean}/${e.name}`,
      sha: e.oid,
    }));
    return { kind: 'dir', entries };
  }
  const blob = repo.getObject(hit.oid);
  if (blob === undefined) return null;
  return { kind: 'file', content: blob.data, sha: hit.oid, size: blob.data.length };
}

// ------------------------------------------------------------------ pulls

export interface CreatePullResult {
  ok: boolean;
  status: number;
  pull?: Pull;
  error?: string;
}

export function createPull(
  repo: Repo,
  input: { title: string; body: string; head: string; base: string },
): CreatePullResult {
  const headTip = repo.getRef(`refs/heads/${input.head}`);
  const baseTip = repo.getRef(`refs/heads/${input.base}`);
  if (headTip === undefined || baseTip === undefined) {
    return { ok: false, status: 422, error: 'head or base branch does not exist' };
  }
  for (const existing of repo.pulls) {
    if (existing.state === 'open' && existing.headRef === input.head && existing.baseRef === input.base) {
      return { ok: false, status: 422, error: 'a pull request is already open for this head and base' };
    }
  }
  const pull = repo.createPull(input.title, input.body ?? '', input.head, input.base, baseTip);
  return { ok: true, status: 201, pull };
}

export interface MergeResult {
  ok: boolean;
  status: number;
  mergeSha: string;
  error?: string;
}

/** Squash-merge a pull request onto its base branch. */
export function mergePull(repo: Repo, pull: Pull): MergeResult {
  if (pull.state !== 'open') {
    return { ok: false, status: 405, mergeSha: '', error: 'pull request is not open' };
  }
  if (mergeConflicts(repo, pull)) {
    return { ok: false, status: 405, mergeSha: '', error: 'merge conflict' };
  }
  const headTip = repo.getRef(`refs/heads/${pull.headRef}`)!;
  const baseTip = repo.getRef(`refs/heads/${pull.baseRef}`)!;
  const headTree = treeOfCommit(repo, headTip)!;
  const baseTreeNow = treeOfCommit(repo, baseTip)!;
  const baseTreeThen = treeOfCommit(repo, pull.baseShaAtCreation)!;
  // Apply the head's changes onto the base's current tree.
  let newTree = baseTreeNow;
  for (const change of repo.diffTrees(baseTreeThen, headTree)) {
    newTree = repo.setPath(newTree, change.path, change.newOid);
  }
  const message = `${pull.title} (#${pull.number})`;
  const mergeSha = repo.makeCommit(newTree, [baseTip], message);
  repo.setRef(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = isoNow();
  pull.mergeCommitSha = mergeSha;
  return { ok: true, status: 200, mergeSha };
}
