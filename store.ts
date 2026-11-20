// store.ts — the forge's single in-memory store.
//
// One Repo holds everything for one repository: git objects + refs, REST
// issues/pulls/labels/comments, and the small caches the perf workloads need.
// All state is deterministic: commit timestamps come from MAKEFUN_TRIAL_NOW
// (or a fixed epoch), never from a wall clock; ids come from counters, never
// from randomness. No I/O happens here; the HTTP layers call into this.

import { createHash } from 'node:crypto';

// ---------------------------------------------------------------- constants

/** The login the suite's token names (sealed scenario, wire.ts SCENARIO_SEED_HEX). */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
/** Any owner that is not the viewer is a 404, never a 403 (foreign-token). */
export const OTHER_OWNER = 'olgabauer';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The only "now" a request may carry: the trial's opening time, seconds. */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW;
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return 1700000000;
}

/** Deterministic timestamp string for a git ident line. */
export function identLine(): string {
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${trialNowSec()} +0000`;
}

// ---------------------------------------------------------------- git objects

export type ObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  type: ObjectType;
  /** Raw object payload (no "type len\0" header). */
  data: Buffer;
}

export function sha1Object(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export interface TreeEntry {
  mode: string; // e.g. '100644', '40000'
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    if (sp < 0) break;
    const mode = data.toString('utf8', i, sp);
    const nul = data.indexOf(0, sp + 1);
    if (nul < 0) break;
    const name = data.toString('utf8', sp + 1, nul);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? a.name + '/' : a.name;
    const bn = b.mode === '40000' ? b.name + '/' : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const header = [`tree ${info.tree}`];
  for (const p of info.parents) header.push(`parent ${p}`);
  header.push(`author ${info.author}`);
  header.push(`committer ${info.committer}`);
  return Buffer.from(`${header.join('\n')}\n\n${info.message}`, 'utf8');
}

// ---------------------------------------------------------------- global ids

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

export function globalId(kind: string, repoId: number, num?: number): string {
  return b64url(num === undefined ? `${kind}:${repoId}` : `${kind}:${repoId}:${num}`);
}

export function parseGlobalId(id: string): { kind: string; repoId: number; num?: number } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    const kind = parts[0]!;
    const repoId = Number(parts[1]);
    if (!Number.isSafeInteger(repoId)) return null;
    if (parts.length === 3) {
      const num = Number(parts[2]);
      if (!Number.isSafeInteger(num)) return null;
      return { kind, repoId, num };
    }
    return { kind, repoId };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- issues / pulls

export interface Label {
  name: string;
  color: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  /** Monotonic creation order (for sort=created). */
  seq: number;
  id: string;
}

export interface Pull {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  /** Base tip at creation time (for merge-conflict detection). */
  baseShaAtCreation: string;
  seq: number;
  id: string;
}

export interface Comment {
  id: number;
  body: string;
  seq: number;
}

// ---------------------------------------------------------------- repo

export class Repo {
  readonly id: number;
  readonly owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch = DEFAULT_BRANCH;
  /** refname -> commit oid. */
  readonly refs = new Map<string, string>();
  /** oid -> object. */
  readonly objects = new Map<string, GitObject>();
  readonly issues: Issue[] = [];
  readonly pulls: Pull[] = [];
  /** O(1) lookups by number (the read workload hammers getIssue). */
  private readonly issueByNumber = new Map<number, Issue>();
  private readonly pullByNumber = new Map<number, Pull>();
  readonly labels = new Map<string, Label>();
  /** issue number -> comments */
  readonly comments = new Map<number, Comment[]>();
  issueSeq = 0;
  pullSeq = 0;
  commentSeq = 0;
  /** Monotonic creation counter shared by issues/pulls/comments (sort order). */
  clock = 0;

  /** Cache: serialized REST issue JSON per number (read workload fast path). */
  readonly issueJson = new Map<number, string>();
  /** Cache: depth-1 / full pack bytes per pack key (clone workload fast path). */
  readonly packCache = new Map<string, Buffer>();
  /** Cache: serialized repo JSON (GET /repos fast path). */
  repoJson: string | null = null;
  /** Cache: serialized branches list. */
  branchesJson: string | null = null;

  constructor(id: number, owner: string, name: string, description: string, isPrivate: boolean) {
    this.id = id;
    this.owner = owner;
    this.name = name;
    this.description = description;
    this.isPrivate = isPrivate;
  }

  // -- objects ---------------------------------------------------------------
  putObject(type: ObjectType, data: Buffer): string {
    const oid = sha1Object(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObject | undefined {
    return this.objects.get(oid);
  }

  // -- refs ------------------------------------------------------------------
  getRef(name: string): string | undefined {
    return this.refs.get(name);
  }

  setRef(name: string, oid: string): void {
    this.refs.set(name, oid);
    this.branchesJson = null;
    this.packCache.clear();
  }

  deleteRef(name: string): boolean {
    const ok = this.refs.delete(name);
    if (ok) {
      this.branchesJson = null;
      this.packCache.clear();
    }
    return ok;
  }

  headRefName(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  headOid(): string | undefined {
    return this.refs.get(this.headRefName());
  }

  // -- trees -----------------------------------------------------------------
  /** Resolve a path inside a tree; returns the entry or null. */
  resolvePath(treeOid: string, path: string): { type: 'blob' | 'tree'; oid: string; mode: string } | null {
    const parts = path.split('/').filter((p) => p !== '');
    let currentOid = treeOid;
    for (let i = 0; i < parts.length; i += 1) {
      const obj = this.objects.get(currentOid);
      if (obj === undefined || obj.type !== 'tree') return null;
      const entries = parseTree(obj.data);
      const entry = entries.find((e) => e.name === parts[i]);
      if (entry === undefined) return null;
      const isLast = i === parts.length - 1;
      if (isLast) {
        if (entry.mode === '40000') return { type: 'tree', oid: entry.oid, mode: entry.mode };
        return { type: 'blob', oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      currentOid = entry.oid;
    }
    return { type: 'tree', oid: currentOid, mode: '40000' };
  }

  /** Return a new root tree oid with `path` set to `blobOid` (or removed when null). */
  setPath(rootTreeOid: string | undefined, path: string, blobOid: string | null): string {
    const parts = path.split('/').filter((p) => p !== '');
    const rec = (treeOid: string | undefined, depth: number): string => {
      const entries: TreeEntry[] = treeOid === undefined ? [] : parseTree(this.objects.get(treeOid)?.data ?? Buffer.alloc(0));
      const name = parts[depth]!;
      const idx = entries.findIndex((e) => e.name === name);
      if (depth === parts.length - 1) {
        if (blobOid === null) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '100644', name, oid: blobOid };
        } else {
          entries.push({ mode: '100644', name, oid: blobOid });
        }
      } else {
        const childOid = idx >= 0 && entries[idx]!.mode === '40000' ? entries[idx]!.oid : undefined;
        const newChild = rec(childOid, depth + 1);
        const childEntries = parseTree(this.objects.get(newChild)?.data ?? Buffer.alloc(0));
        if (childEntries.length === 0) {
          if (idx >= 0) entries.splice(idx, 1);
        } else if (idx >= 0) {
          entries[idx] = { mode: '40000', name, oid: newChild };
        } else {
          entries.push({ mode: '40000', name, oid: newChild });
        }
      }
      return this.putObject('tree', buildTree(entries));
    };
    return rec(rootTreeOid, 0);
  }

  /** Flat list of all files under a tree: {path, oid, mode}. */
  listFiles(treeOid: string): { path: string; oid: string; mode: string }[] {
    const out: { path: string; oid: string; mode: string }[] = [];
    const walk = (oid: string, prefix: string): void => {
      const obj = this.objects.get(oid);
      if (obj === undefined || obj.type !== 'tree') return;
      for (const e of parseTree(obj.data)) {
        const p = prefix === '' ? e.name : `${prefix}/${e.name}`;
        if (e.mode === '40000') walk(e.oid, p);
        else out.push({ path: p, oid: e.oid, mode: e.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Diff base tree -> head tree: changed paths with old/new blob oids. */
  diffTrees(baseTreeOid: string, headTreeOid: string): { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] {
    const base = new Map(this.listFiles(baseTreeOid).map((f) => [f.path, f.oid]));
    const head = new Map(this.listFiles(headTreeOid).map((f) => [f.path, f.oid]));
    const out: { path: string; status: 'added' | 'modified' | 'removed'; oldOid: string | null; newOid: string | null }[] = [];
    for (const [path, oid] of head) {
      const old = base.get(path);
      if (old === undefined) out.push({ path, status: 'added', oldOid: null, newOid: oid });
      else if (old !== oid) out.push({ path, status: 'modified', oldOid: old, newOid: oid });
    }
    for (const [path, oid] of base) {
      if (!head.has(path)) out.push({ path, status: 'removed', oldOid: oid, newOid: null });
    }
    out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return out;
  }

  /** First-parent walk from a tip, newest first. */
  walkCommits(tipOid: string, limit = 1000): string[] {
    const out: string[] = [];
    let current: string | undefined = tipOid;
    const seen = new Set<string>();
    while (current !== undefined && current !== ZERO_OID && out.length < limit && !seen.has(current)) {
      seen.add(current);
      out.push(current);
      const obj = this.objects.get(current);
      if (obj === undefined || obj.type !== 'commit') break;
      const info = parseCommit(obj.data);
      current = info.parents[0];
    }
    return out;
  }

  /** All objects reachable from a set of tips (for pack generation). */
  reachable(tips: readonly string[], depth: number | null): Set<string> {
    const out = new Set<string>();
    const queue: { oid: string; d: number }[] = tips.map((oid) => ({ oid, d: 0 }));
    while (queue.length > 0) {
      const { oid, d } = queue.pop()!;
      if (out.has(oid)) continue;
      const obj = this.objects.get(oid);
      if (obj === undefined) continue;
      out.add(oid);
      if (obj.type === 'commit') {
        if (depth !== null && d >= depth) continue;
        const info = parseCommit(obj.data);
        if (!out.has(info.tree)) queue.push({ oid: info.tree, d: d + 1 });
        for (const p of info.parents) queue.push({ oid: p, d: d + 1 });
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) queue.push({ oid: e.oid, d });
      } else if (obj.type === 'tag') {
        const text = obj.data.toString('utf8');
        const m = /^object ([0-9a-f]{40})$/m.exec(text);
        if (m !== null) queue.push({ oid: m[1]!, d });
      }
    }
    return out;
  }

  // -- commits ---------------------------------------------------------------
  makeCommit(treeOid: string, parents: string[], message: string): string {
    const ident = identLine();
    const data = buildCommit({ tree: treeOid, parents, author: ident, committer: ident, message });
    return this.putObject('commit', data);
  }

  // -- issues ----------------------------------------------------------------
  createIssue(title: string, body: string, labels: Label[]): Issue {
    this.issueSeq += 1;
    this.clock += 1;
    const issue: Issue = {
      number: this.issueSeq,
      title,
      body,
      state: 'open',
      labels,
      seq: this.clock,
      id: globalId('Issue', this.id, this.issueSeq),
    };
    this.issues.push(issue);
    this.issueByNumber.set(issue.number, issue);
    this.comments.set(issue.number, []);
    this.issueJson.delete(issue.number);
    return issue;
  }

  getIssue(number: number): Issue | undefined {
    return this.issueByNumber.get(number);
  }

  // -- pulls -----------------------------------------------------------------
  createPull(title: string, body: string, headRef: string, baseRef: string, baseShaAtCreation: string): Pull {
    this.pullSeq += 1;
    this.clock += 1;
    const pull: Pull = {
      number: this.pullSeq,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      baseShaAtCreation,
      seq: this.clock,
      id: globalId('PullRequest', this.id, this.pullSeq),
    };
    this.pulls.push(pull);
    this.pullByNumber.set(pull.number, pull);
    return pull;
  }

  getPull(number: number): Pull | undefined {
    return this.pullByNumber.get(number);
  }
}

// ---------------------------------------------------------------- forge

export class Forge {
  readonly repos = new Map<string, Repo>(); // key: `${owner}/${name}`
  repoIdSeq = 5000;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    if (this.repos.has(this.key(owner, name))) return null;
    const repo = new Repo(this.repoIdSeq, owner, name, description, isPrivate);
    this.repoIdSeq += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.id - b.id);
    return out;
  }

  findRepoById(id: number): Repo | undefined {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return undefined;
  }
}
