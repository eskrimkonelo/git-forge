// git.ts — git smart-HTTP layer for the make.fun git forge.
//
// makefun anchor d37ca18d1e09db19d22ef02c3fc5a2b93adcc3ec round 34117243
//
// Serves, for one existing Repo (looked up by the caller), the suite's git
// surface: GET info/refs (upload-pack v2/v0, receive-pack v0), POST
// git-upload-pack (protocol v2, with a v0 fallback) and POST git-receive-pack
// (v0). All state lives in the shared store (store.ts): objects and refs are
// read/written only through `repo`, so REST-created commits and git-pushed
// commits share one object/refs store. Node 22 stdlib only, synchronous,
// deterministic (no wall clock, no randomness). Pushed objects are stored
// byte-for-byte; emitted packs are undeltified (plain type+size+zlib).
//
// Exported handler (the parent's app.ts wires it in):
//   export function handleGit(req, repo): { status, headers, body }
//   req:  { method: string; url: string;
//           headers: Record<string, string | string[] | undefined>;
//           body: Buffer }
//   repo: Repo | null | undefined  (null/undefined -> 404; the caller normally
//           404s first when the repo does not exist)
//   returns { status: number; headers: Record<string, string>; body: Buffer }
//
// Wiring example for app.ts (5 lines, inside the request handler, after the
// repo has been looked up from the path /{owner}/{repo}.git/...):
//   import { handleGit } from './git.ts';
//   if (path.includes('.git/')) {
//     const res = handleGit({ method, url: req.url ?? '/', headers: req.headers, body }, repo);
//     res.writeHead(res.status, res.headers); res.end(res.body); return;
//   }
//   // `body` is the request body already buffered by app.ts; `repo` is the
//   // Repo from the forge, or null/undefined when it does not exist.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { parseCommit, parseTree, sha1Object, ZERO_OID, type GitObject, type ObjectType, type Repo } from './store.ts';

// ---------------------------------------------------------------------------
// types + constants
// ---------------------------------------------------------------------------

export interface GitRequest {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export interface GitResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

export const GIT_AGENT = 'makefun-git-forge/1.0';
const PKT_LINE_MAX = 65520;
const SIDEBAND_MAX_DATA = PKT_LINE_MAX - 4 - 1; // pkt header (4) + band byte (1)
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const MAX_TREE_BYTES = 16 * 1024 * 1024;
const HEX40 = /^[0-9a-f]{40}$/;
const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function headerValue(headers: Record<string, string | string[] | undefined>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) {
      const v = headers[key];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return undefined;
}

function json404(): GitResponse {
  const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
  return { status: 404, headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': String(body.length) }, body };
}

function textResponse(status: number, text: string, contentType = 'text/plain; charset=utf-8'): GitResponse {
  const body = Buffer.from(text, 'utf8');
  return { status, headers: { 'content-type': contentType, 'content-length': String(body.length) }, body };
}

function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  return [...repo.refs.entries()].map(([name, oid]) => ({ name, oid })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Peel an annotated tag (recursively) to the non-tag object it names. */
function peelOid(repo: Repo, oid: string): string | undefined {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.getObject(current);
    if (obj === undefined || obj.type !== 'tag') return current;
    const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
    if (m === null) return undefined;
    current = m[1]!;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// pkt-line codec
// ---------------------------------------------------------------------------

function pktLine(payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (data.length > PKT_LINE_MAX - 4) throw new Error('pkt-line payload too large');
  const head = Buffer.allocUnsafe(4);
  head.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([head, data]);
}

const PKT_FLUSH = Buffer.from('0000', 'ascii');
const PKT_DELIM = Buffer.from('0001', 'ascii');

function pktLines(items: readonly (Buffer | string)[]): Buffer {
  return Buffer.concat(items.map((item) => pktLine(item)));
}

type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/** Decode a whole buffer into pkt-lines. Returns null on any malformed framing. */
function decodePktLines(buf: Buffer): Pkt[] | null {
  const out: Pkt[] = [];
  let off = 0;
  while (off < buf.length) {
    if (off + 4 > buf.length) return null;
    const head = buf.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return null;
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      off += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      off += 4;
      continue;
    }
    if (len === 2) {
      out.push({ kind: 'response-end' });
      off += 4;
      continue;
    }
    if (len === 3 || len > PKT_LINE_MAX || off + len > buf.length) return null;
    out.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
    off += len;
  }
  return out;
}

/** Split decoded packets into sections separated by flush/delim control packets. */
function pktSections(packets: readonly Pkt[]): Buffer[][] {
  const sections: Buffer[][] = [];
  let current: Buffer[] = [];
  for (const p of packets) {
    if (p.kind === 'data') current.push(p.payload);
    else {
      sections.push(current);
      current = [];
    }
  }
  sections.push(current);
  return sections;
}

// ---------------------------------------------------------------------------
// advertisements
// ---------------------------------------------------------------------------

function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine(`agent=${GIT_AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done filter\n'),
    pktLine('object-format=sha1\n'),
    pktLine('side-band-64k\n'),
    PKT_FLUSH,
  ]);
}

function v0Advertisement(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `side-band-64k thin-pack ofs-delta multi_ack multi_ack_detailed shallow symref=HEAD:refs/heads/main agent=${GIT_AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${GIT_AGENT}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const head = repo.headOid();
  const lines: string[] = [];
  if (head !== undefined) lines.push(`${head} HEAD`);
  for (const ref of refs) {
    lines.push(`${ref.oid} ${ref.name}`);
    const obj = repo.getObject(ref.oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelOid(repo, ref.oid);
      if (peeled !== undefined && peeled !== ref.oid) lines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  if (lines.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pktLine(`${lines[0]!}\0${caps}\n`));
    for (const line of lines.slice(1)) parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

interface LsRef {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

function listRefsV2(repo: Repo, opts: { peel: boolean; symrefs: boolean; unborn: boolean; prefixes: string[] }): LsRef[] {
  const out: LsRef[] = [];
  const head = repo.headOid();
  const headName = repo.headRefName();
  if (head !== undefined) {
    out.push({ oid: head, name: 'HEAD', symrefTarget: opts.symrefs ? headName : undefined });
  } else if (opts.unborn) {
    out.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: opts.symrefs ? headName : undefined, unborn: true });
  }
  for (const ref of sortedRefs(repo)) {
    const entry: LsRef = { oid: ref.oid, name: ref.name };
    if (opts.peel) {
      const obj = repo.getObject(ref.oid);
      if (obj !== undefined && obj.type === 'tag') {
        const peeled = peelOid(repo, ref.oid);
        if (peeled !== undefined && peeled !== ref.oid) entry.peeled = peeled;
      }
    }
    out.push(entry);
  }
  if (opts.prefixes.length === 0) return out;
  return out.filter((r) => opts.prefixes.some((p) => r.name.startsWith(p)));
}

function handleLsRefs(repo: Repo, body: Buffer): GitResponse {
  const packets = decodePktLines(body);
  if (packets === null) return textResponse(400, 'bad pkt-line framing');
  const sections = pktSections(packets);
  // Section 0: command lines; section 1 (after delim): arguments.
  const args = sections.length > 1 ? sections[1]! : [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const raw of args) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const refs = listRefsV2(repo, { peel, symrefs, unborn, prefixes });
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (ref.unborn) {
      parts.push(pktLine(`unborn ${ref.name}${ref.symrefTarget ? ` symref-target:${ref.symrefTarget}` : ''}\n`));
    } else {
      let line = `${ref.oid} ${ref.name}`;
      if (ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      if (ref.peeled) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  return {
    status: 200,
    headers: { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) },
    body: out,
  };
}

// ---------------------------------------------------------------------------
// pack building (undeltified)
// ---------------------------------------------------------------------------

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a version-2 pack from plain objects (no deltas), deterministically ordered by oid. */
export function buildPack(objects: readonly { type: ObjectType; data: Buffer }[]): Buffer {
  const sorted = [...objects].sort((a, b) => {
    const ao = sha1Object(a.type, a.data);
    const bo = sha1Object(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(sorted.length, 8);
  parts.push(header);
  for (const obj of sorted) {
    parts.push(packObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** Split a pack into sideband band-1 pkt-lines (band byte + data per packet). */
function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  for (let off = 0; off < pack.length; off += SIDEBAND_MAX_DATA) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + SIDEBAND_MAX_DATA));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) out.push(pktLine(Buffer.from([1])));
  return out;
}

// ---------------------------------------------------------------------------
// fetch planning: wants / haves / shallow / depth
// ---------------------------------------------------------------------------

interface FetchPlan {
  /** Objects to send (oid -> object), after subtracting what the client holds. */
  send: Map<string, GitObject>;
  /** Everything reachable from the wants (before subtracting haves). */
  wantSet: Set<string>;
  shallowOut: string[];
  unshallowOut: string[];
}

/** Full closure of `tips`, except that a commit listed in `stopAt` contributes its tree but not its parents. */
function haveClosure(repo: Repo, tips: readonly string[], stopAt: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (out.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    out.add(oid);
    if (obj.type === 'commit') {
      const info = parseCommit(obj.data);
      stack.push(info.tree);
      if (!stopAt.has(oid)) for (const p of info.parents) stack.push(p);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') stack.push(e.oid);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m !== null) stack.push(m[1]!);
    }
  }
  return out;
}

function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowIn: readonly string[],
  depth: number | null,
): FetchPlan {
  const shallowSet = new Set(shallowIn);
  const haveSet = haveClosure(repo, haves, shallowSet);
  // Walk the wants, tracking each commit's generation from the nearest want.
  const wantSet = new Set<string>();
  const commitGen = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = wants.map((oid) => ({ oid, gen: 0 }));
  for (let qi = 0; qi < queue.length; qi += 1) {
    const { oid, gen } = queue[qi]!;
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      const prev = commitGen.get(oid);
      if (prev !== undefined && prev <= gen) continue;
      commitGen.set(oid, gen);
      wantSet.add(oid);
      if (depth !== null && gen >= depth) continue;
      const info = parseCommit(obj.data);
      queue.push({ oid: info.tree, gen });
      if (depth === null || gen + 1 < depth) for (const p of info.parents) queue.push({ oid: p, gen: gen + 1 });
    } else if (obj.type === 'tag') {
      if (wantSet.has(oid)) continue;
      wantSet.add(oid);
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m !== null) queue.push({ oid: m[1]!, gen });
    } else if (obj.type === 'tree') {
      if (wantSet.has(oid)) continue;
      wantSet.add(oid);
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push({ oid: e.oid, gen });
    } else {
      wantSet.add(oid);
    }
  }
  const send = new Map<string, GitObject>();
  for (const oid of wantSet) {
    if (haveSet.has(oid)) continue;
    const obj = repo.getObject(oid);
    if (obj !== undefined) send.set(oid, obj);
  }
  const shallowOut: string[] = [];
  if (depth !== null) {
    for (const [oid, gen] of commitGen) {
      if (gen === depth - 1 && send.has(oid)) shallowOut.push(oid);
    }
    shallowOut.sort();
  }
  const unshallowOut: string[] = [];
  for (const oid of shallowIn) {
    const gen = commitGen.get(oid);
    if (gen !== undefined && (depth === null || gen < depth - 1)) unshallowOut.push(oid);
  }
  unshallowOut.sort();
  return { send, wantSet, shallowOut, unshallowOut };
}

// ---------------------------------------------------------------------------
// upload-pack: fetch (v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
  /** True when the client sent 'done' (it is ready for the packfile). */
  done: boolean;
}

function parseFetchArgs(lines: readonly Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null, done: false };
  for (const raw of lines) {
    const line = raw.toString('utf8').replace(/\n$/, '');
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0]!);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line === 'done') args.done = true;
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7), 10);
      if (Number.isSafeInteger(n) && n > 0) args.depth = n;
    } else if (line.startsWith('filter ')) args.filter = line.slice(7);
    // deepen-since / deepen-not / thin-pack / no-progress / ofs-delta: parsed, not needed.
  }
  return args;
}

function fetchResponseV2(repo: Repo, args: FetchArgs): GitResponse {
  const missing = args.wants.filter((oid) => !HEX40.test(oid) || repo.getObject(oid) === undefined);
  const parts: Buffer[] = [];
  // Real git upload-pack ACKs ANY have the server holds (not only ancestors
  // of the wants): a have is a commit both sides already share, so the
  // server can exclude its closure from the pack. ACKing a have ends the
  // negotiation — the server sends 'ready' and the packfile even when the
  // client has not sent 'done' yet.
  const plan = missing.length === 0 ? planFetch(repo, args.wants, args.haves, args.shallow, args.depth) : null;
  let acked = false;
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    for (const have of args.haves) {
      if (repo.getObject(have) !== undefined) {
        parts.push(pktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(pktLine('NAK\n'));
    else parts.push(pktLine('ready\n'));
    parts.push(PKT_DELIM);
  }
  // No common base and the client is still negotiating (it has more haves
  // to offer in a follow-up request): answer with acknowledgments only and
  // no packfile. Sending the packfile here makes real git fail with
  // "expected no other sections to be sent after no 'ready'". With no haves
  // there is nothing to negotiate, so the packfile is sent regardless.
  if (!args.done && !acked && args.haves.length > 0) {
    parts.push(PKT_FLUSH);
    const out = Buffer.concat(parts);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) }, body: out };
  }
  if (missing.length > 0) {
    parts.push(pktLine('packfile\n'));
    parts.push(pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR want ${missing[0]} not found\n`, 'utf8')])));
    parts.push(PKT_FLUSH);
    const out = Buffer.concat(parts);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) }, body: out };
  }
  // No missing wants, so the plan above is set.
  const fetchPlan = plan as FetchPlan;
  if (fetchPlan.shallowOut.length > 0 || fetchPlan.unshallowOut.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of fetchPlan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of fetchPlan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  const cacheKey = `v1|d=${args.depth ?? ''}|w=${[...args.wants].sort().join(',')}|h=${[...args.haves].sort().join(',')}|s=${[...args.shallow].sort().join(',')}|f=${args.filter ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = buildPack([...fetchPlan.send.values()]);
    repo.packCache.set(cacheKey, pack);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) }, body: out };
}

function fetchResponseV0(repo: Repo, args: FetchArgs): GitResponse {
  const missing = args.wants.filter((oid) => !HEX40.test(oid) || repo.getObject(oid) === undefined);
  const parts: Buffer[] = [];
  const plan = missing.length === 0 ? planFetch(repo, args.wants, args.haves, args.shallow, args.depth) : null;
  // multi_ack_detailed: ACK every have the server holds (see fetchResponseV2
  // — a have is any object both sides already share), then 'ready' so the
  // client knows the pack follows. No haves (or none held) is a plain NAK,
  // which a fresh v0 clone expects before the pack.
  if (args.haves.length > 0) {
    const common = args.haves.filter((h) => repo.getObject(h) !== undefined);
    if (common.length > 0) {
      for (const oid of common) parts.push(pktLine(`ACK ${oid} common\n`));
      parts.push(pktLine(`ACK ${common[common.length - 1]} ready\n`));
    } else {
      parts.push(pktLine('NAK\n'));
    }
  } else {
    parts.push(pktLine('NAK\n'));
  }
  if (missing.length > 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from([3]), Buffer.from(`ERR want ${missing[0]} not found\n`, 'utf8')])));
    parts.push(PKT_FLUSH);
    const out = Buffer.concat(parts);
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) }, body: out };
  }
  // No missing wants, so the plan above is set.
  const fetchPlan = plan as FetchPlan;
  for (const oid of fetchPlan.shallowOut) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of fetchPlan.unshallowOut) parts.push(pktLine(`unshallow ${oid}\n`));
  const cacheKey = `v1|d=${args.depth ?? ''}|w=${[...args.wants].sort().join(',')}|h=${[...args.haves].sort().join(',')}|s=${[...args.shallow].sort().join(',')}|f=${args.filter ?? ''}`;
  let pack = repo.packCache.get(cacheKey);
  if (pack === undefined) {
    pack = buildPack([...fetchPlan.send.values()]);
    repo.packCache.set(cacheKey, pack);
  }
  parts.push(...sidebandPack(pack));
  parts.push(PKT_FLUSH);
  const out = Buffer.concat(parts);
  return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', 'content-length': String(out.length) }, body: out };
}

function handleUploadPack(req: GitRequest, repo: Repo): GitResponse {
  const packets = decodePktLines(req.body);
  if (packets === null) return textResponse(400, 'bad pkt-line framing');
  const isV2 = headerValue(req.headers, 'git-protocol') === 'version=2';
  const sections = pktSections(packets);
  const firstLines = sections[0] ?? [];
  const command = (firstLines[0] ?? Buffer.alloc(0)).toString('utf8').replace(/\n$/, '');
  if (command.startsWith('command=ls-refs')) {
    if (!isV2) return textResponse(400, 'ls-refs requires protocol v2');
    return handleLsRefs(repo, req.body);
  }
  if (command.startsWith('command=fetch')) {
    if (!isV2) return textResponse(400, 'fetch requires protocol v2');
    const args = parseFetchArgs(sections.length > 1 ? sections[1]! : []);
    return fetchResponseV2(repo, args);
  }
  if (!isV2) {
    // v0 fetch: wants in section 0, haves/done in section 1.
    const args = parseFetchArgs([...(sections[0] ?? []), ...(sections[1] ?? [])]);
    if (args.wants.length === 0) return textResponse(400, 'v0 fetch needs a want line');
    return fetchResponseV0(repo, args);
  }
  return textResponse(400, `unknown upload-pack command ${JSON.stringify(command.slice(0, 40))}`);
}

// ---------------------------------------------------------------------------
// receive-pack (v0): pack reading (incl. OFS/REF deltas), fast-forward rules
// ---------------------------------------------------------------------------

/** Inflate one zlib stream starting at `offset` (bounded by `end`); returns data + next offset. */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

/** Apply a git delta instruction stream to a base object's bytes. */
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (off >= delta.length) throw new Error('delta size varint is truncated');
      const byte = delta[off++]!;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
      if (shift > 63) throw new Error('delta size varint is too long');
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  if (sourceSize !== base.length) throw new Error(`delta expects a ${sourceSize}-byte base, got ${base.length}`);
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy offset is truncated');
          copyOffset += delta[off++]! * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          if (off >= delta.length) throw new Error('delta copy size is truncated');
          copySize += delta[off++]! * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta copy is out of the base');
      if (written + copySize > targetSize) throw new Error('delta writes past its target size');
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      if (off + literal > delta.length) throw new Error('delta insert is truncated');
      if (written + literal > targetSize) throw new Error('delta writes past its target size');
      delta.copy(out, written, off, off + literal);
      off += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error(`delta produced ${written} of ${targetSize} bytes`);
  return out;
}

interface ParsedPack {
  objects: Map<string, { type: ObjectType; data: Buffer }>;
  error?: string;
}

/**
 * Parse a version 2/3 packfile and resolve every object, including OFS_DELTA
 * and REF_DELTA (bases in the pack itself, or — thin packs — already in the
 * repo). Verifies the trailer SHA-1 and every declared size.
 */
function parsePack(buf: Buffer, repo: Repo): ParsedPack {
  try {
    if (buf.length < 32) return { objects: new Map(), error: 'pack is too short' };
    if (buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects: new Map(), error: 'pack does not start with PACK' };
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) return { objects: new Map(), error: `unsupported pack version ${version}` };
    const count = buf.readUInt32BE(8);
    const trailerStart = buf.length - 20;
    const trailer = buf.subarray(trailerStart).toString('hex');
    const computed = createHash('sha1').update(buf.subarray(0, trailerStart)).digest('hex');
    if (trailer !== computed) return { objects: new Map(), error: 'pack trailer checksum mismatch' };

    interface Raw {
      offset: number;
      typeCode: number;
      size: number;
      data: Buffer;
      baseOffset?: number;
      baseOid?: string;
      resolved?: { type: ObjectType; data: Buffer; oid: string };
    }
    const raw: Raw[] = [];
    const byOffset = new Map<number, Raw>();
    let off = 12;
    for (let i = 0; i < count; i += 1) {
      const entryOffset = off;
      if (off >= trailerStart) return { objects: new Map(), error: 'pack entry is truncated' };
      let byte = buf[off]!;
      const first = byte;
      let size = byte & 0x0f;
      let shift = 4;
      off += 1;
      while (byte & 0x80) {
        if (off >= trailerStart) return { objects: new Map(), error: 'pack entry size varint is truncated' };
        byte = buf[off++]!;
        size += (byte & 0x7f) * 2 ** shift;
        shift += 7;
        if (shift > 63) return { objects: new Map(), error: 'pack entry size varint is too long' };
      }
      const typeCode = (first >> 4) & 0x07;
      const entry: Raw = { offset: entryOffset, typeCode, size, data: Buffer.alloc(0) };
      if (typeCode === 6) {
        if (off >= trailerStart) return { objects: new Map(), error: 'ofs-delta has no base offset' };
        byte = buf[off]!;
        off += 1;
        let value = byte & 0x7f;
        while (byte & 0x80) {
          if (off >= trailerStart) return { objects: new Map(), error: 'ofs-delta base offset is truncated' };
          byte = buf[off++]!;
          value = (value + 1) * 128 + (byte & 0x7f);
        }
        if (value <= 0 || value > entryOffset) return { objects: new Map(), error: 'ofs-delta names an invalid base offset' };
        entry.baseOffset = entryOffset - value;
      } else if (typeCode === 7) {
        if (off + 20 > trailerStart) return { objects: new Map(), error: 'ref-delta base id is truncated' };
        entry.baseOid = buf.subarray(off, off + 20).toString('hex');
        off += 20;
      } else if (!CODE_TYPE[typeCode]) {
        return { objects: new Map(), error: `pack entry ${i} has unknown type code ${typeCode}` };
      }
      const inflated = inflateAt(buf, off, trailerStart);
      if (inflated.data.length !== size) {
        return { objects: new Map(), error: `pack entry at ${entryOffset} declares ${size} bytes but inflated to ${inflated.data.length}` };
      }
      entry.data = inflated.data;
      off = inflated.next;
      raw.push(entry);
      byOffset.set(entryOffset, entry);
    }
    if (off !== trailerStart) return { objects: new Map(), error: 'pack has stray bytes before its trailer' };

    const resolvedByOid = new Map<string, Raw>();
    const resolving = new Set<number>();
    const resolve = (entry: Raw): { type: ObjectType; data: Buffer; oid: string } => {
      if (entry.resolved !== undefined) return entry.resolved;
      if (resolving.has(entry.offset)) throw new Error(`delta cycle at pack offset ${entry.offset}`);
      resolving.add(entry.offset);
      let type: ObjectType;
      let data: Buffer;
      if (entry.typeCode === 6) {
        const baseEntry = byOffset.get(entry.baseOffset!);
        if (baseEntry === undefined) throw new Error(`ofs-delta base at offset ${entry.baseOffset} is not in the pack`);
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else if (entry.typeCode === 7) {
        const wanted = entry.baseOid!;
        const baseEntry = resolvedByOid.get(wanted);
        if (baseEntry !== undefined) {
          const base = resolve(baseEntry);
          type = base.type;
          data = applyDelta(base.data, entry.data);
        } else {
          const external = repo.getObject(wanted);
          if (external === undefined) throw new Error(`ref-delta base ${wanted} is neither in the pack nor in the repo`);
          type = external.type;
          data = applyDelta(external.data, entry.data);
        }
      } else {
        type = CODE_TYPE[entry.typeCode]!;
        data = entry.data;
      }
      const oid = sha1Object(type, data);
      entry.resolved = { type, data, oid };
      resolvedByOid.set(oid, entry);
      resolving.delete(entry.offset);
      return entry.resolved;
    };

    const objects = new Map<string, { type: ObjectType; data: Buffer }>();
    for (const entry of raw) {
      const r = resolve(entry);
      if (!objects.has(r.oid)) objects.set(r.oid, { type: r.type, data: r.data });
    }
    return { objects };
  } catch (err) {
    return { objects: new Map(), error: err instanceof Error ? err.message : String(err) };
  }
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse the pkt-line command list at the start of a receive-pack body; the rest is the pack. */
function parseReceiveCommands(body: Buffer): { commands: PushCommand[]; pack: Buffer; error?: string } {
  const lines: Buffer[] = [];
  let off = 0;
  let sawFlush = false;
  while (off + 4 <= body.length) {
    const head = body.toString('ascii', off, off + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(head)) return { commands: [], pack: Buffer.alloc(0), error: 'bad pkt-line framing' };
    const len = Number.parseInt(head, 16);
    if (len === 0) {
      off += 4;
      sawFlush = true;
      break;
    }
    if (len === 1 || len === 2) {
      off += 4;
      continue;
    }
    if (len === 3 || len > PKT_LINE_MAX || off + len > body.length) {
      return { commands: [], pack: Buffer.alloc(0), error: 'bad pkt-line framing' };
    }
    lines.push(body.subarray(off + 4, off + len));
    off += len;
  }
  if (!sawFlush) return { commands: [], pack: Buffer.alloc(0), error: 'command list has no flush' };
  const commands: PushCommand[] = [];
  for (const raw of lines) {
    const nul = raw.indexOf(0);
    const text = (nul >= 0 ? raw.subarray(0, nul) : raw).toString('utf8').replace(/\n$/, '');
    const parts = text.split(' ');
    if (parts.length !== 3 || !HEX40.test(parts[0]!) || !HEX40.test(parts[1]!) || !parts[2]!.startsWith('refs/')) {
      return { commands: [], pack: Buffer.alloc(0), error: `bad push command ${JSON.stringify(text.slice(0, 60))}` };
    }
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts[2]! });
  }
  return { commands, pack: body.subarray(off) };
}

/** True when `oldOid` is an ancestor of `newOid` (or equal); tags unwrap to their target. */
function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === newOid) return true;
  const stack = [newOid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === oldOid) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.getObject(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit') {
      for (const p of parseCommit(obj.data).parents) stack.push(p);
    } else if (obj.type === 'tag') {
      const m = /^object ([0-9a-f]{40})$/m.exec(obj.data.toString('utf8'));
      if (m !== null) stack.push(m[1]!);
    }
  }
  return false;
}

/** Size-cap violation for the tree a new ref would point at, or null when it fits. */
function treeSizeViolation(repo: Repo, newOid: string): string | null {
  let target = newOid;
  const tagObj = repo.getObject(target);
  if (tagObj !== undefined && tagObj.type === 'tag') {
    const peeled = peelOid(repo, target);
    if (peeled === undefined) return null;
    target = peeled;
  }
  const obj = repo.getObject(target);
  if (obj === undefined) return null;
  if (obj.type === 'blob') return obj.data.length > MAX_BLOB_BYTES ? 'object too large' : null;
  if (obj.type === 'tree') {
    let total = 0;
    for (const file of repo.listFiles(target)) {
      const blob = repo.getObject(file.oid);
      if (blob === undefined) continue;
      if (blob.data.length > MAX_BLOB_BYTES) return 'object too large';
      total += blob.data.length;
      if (total > MAX_TREE_BYTES) return 'tree too large';
    }
    return null;
  }
  if (obj.type === 'commit') {
    const tree = parseCommit(obj.data).tree;
    let total = 0;
    for (const file of repo.listFiles(tree)) {
      const blob = repo.getObject(file.oid);
      if (blob === undefined) continue;
      if (blob.data.length > MAX_BLOB_BYTES) return 'object too large';
      total += blob.data.length;
      if (total > MAX_TREE_BYTES) return 'tree too large';
    }
    return null;
  }
  return null;
}

function cleanReason(reason: string): string {
  return reason.replace(/[\r\n]+/g, ' ').slice(0, 120) || 'refused';
}

/** Build the report-status stream (pkt-lined) framed in sideband band 1. */
function reportResponse(unpackOk: boolean, unpackDetail: string, refs: readonly { ref: string; ok: boolean; reason: string }[]): GitResponse {
  const innerParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : cleanReason(unpackDetail)}\n`)];
  for (const r of refs) {
    innerParts.push(pktLine(r.ok ? `ok ${r.ref}\n` : `ng ${r.ref} ${cleanReason(r.reason)}\n`));
  }
  innerParts.push(PKT_FLUSH);
  const inner = Buffer.concat(innerParts);
  const outer: Buffer[] = [];
  for (let off = 0; off < inner.length; off += SIDEBAND_MAX_DATA) {
    const chunk = inner.subarray(off, Math.min(inner.length, off + SIDEBAND_MAX_DATA));
    outer.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  outer.push(PKT_FLUSH);
  const out = Buffer.concat(outer);
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', 'content-length': String(out.length) }, body: out };
}

function handleReceivePack(req: GitRequest, repo: Repo): GitResponse {
  const parsed = parseReceiveCommands(req.body);
  if (parsed.error !== undefined || parsed.commands.length === 0) {
    return reportResponse(false, parsed.error ?? 'no push commands', []);
  }
  const commands = parsed.commands;
  const updatesRef = commands.some((c) => c.newOid !== ZERO_OID);
  let unpackError: string | undefined;
  let packOversize: string | undefined;
  if (updatesRef) {
    if (parsed.pack.length === 0) {
      unpackError = 'missing packfile';
    } else {
      const pack = parsePack(parsed.pack, repo);
      if (pack.error !== undefined) {
        unpackError = pack.error;
      } else {
        let blobTotal = 0;
        for (const obj of pack.objects.values()) {
          if (obj.type === 'blob') {
            if (obj.data.length > MAX_BLOB_BYTES) packOversize = 'object too large';
            blobTotal += obj.data.length;
            if (blobTotal > MAX_TREE_BYTES) packOversize = 'tree too large';
          }
        }
        if (packOversize === undefined) {
          for (const obj of pack.objects.values()) repo.putObject(obj.type, obj.data);
        } else {
          // Store everything except the oversize blobs, so the repo stays consistent.
          for (const obj of pack.objects.values()) {
            if (obj.type === 'blob' && obj.data.length > MAX_BLOB_BYTES) continue;
            repo.putObject(obj.type, obj.data);
          }
        }
      }
    }
  }
  if (unpackError !== undefined) {
    return reportResponse(false, unpackError, commands.map((c) => ({ ref: c.ref, ok: false, reason: unpackError! })));
  }
  // Decide every ref against the pre-push ref state, then apply the ok ones.
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  for (const cmd of commands) {
    const current = repo.getRef(cmd.ref);
    if (packOversize !== undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: packOversize });
      continue;
    }
    if (cmd.newOid === ZERO_OID) {
      if (current === undefined) results.push({ ref: cmd.ref, ok: false, reason: 'remote ref does not exist' });
      else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
      else results.push({ ref: cmd.ref, ok: true, reason: '' });
      continue;
    }
    if (repo.getObject(cmd.newOid) === undefined) {
      results.push({ ref: cmd.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (cmd.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    } else {
      if (current === undefined || cmd.oldOid !== current) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      if (!isFastForward(repo, cmd.oldOid, cmd.newOid)) {
        results.push({ ref: cmd.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
    }
    const violation = treeSizeViolation(repo, cmd.newOid);
    if (violation !== null) {
      results.push({ ref: cmd.ref, ok: false, reason: violation });
      continue;
    }
    results.push({ ref: cmd.ref, ok: true, reason: '' });
  }
  for (let i = 0; i < commands.length; i += 1) {
    if (!results[i]!.ok) continue;
    const cmd = commands[i]!;
    if (cmd.newOid === ZERO_OID) repo.deleteRef(cmd.ref);
    else repo.setRef(cmd.ref, cmd.newOid);
  }
  return reportResponse(true, 'ok', results);
}

// ---------------------------------------------------------------------------
// dispatcher
// ---------------------------------------------------------------------------

export function handleGit(req: GitRequest, repo: Repo | null | undefined): GitResponse {
  try {
    if (repo === null || repo === undefined) return json404();
    const method = (req.method ?? 'GET').toUpperCase();
    let path: string;
    try {
      path = new URL(req.url, 'http://forge').pathname;
    } catch {
      return json404();
    }
    const gitIdx = path.indexOf('.git/');
    if (gitIdx < 0) return json404();
    const suffix = path.slice(gitIdx + 5);
    if (method === 'GET' && suffix === 'info/refs') {
      let service: string | null = null;
      try {
        service = new URL(req.url, 'http://forge').searchParams.get('service');
      } catch {
        service = null;
      }
      if (service === 'git-upload-pack') {
        const body = headerValue(req.headers, 'git-protocol') === 'version=2' ? v2Advertisement() : v0Advertisement(repo, 'git-upload-pack');
        return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-advertisement', 'content-length': String(body.length) }, body };
      }
      if (service === 'git-receive-pack') {
        const body = v0Advertisement(repo, 'git-receive-pack');
        return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-advertisement', 'content-length': String(body.length) }, body };
      }
      return json404();
    }
    if (method === 'POST' && suffix === 'git-upload-pack') return handleUploadPack(req, repo);
    if (method === 'POST' && suffix === 'git-receive-pack') return handleReceivePack(req, repo);
    return json404();
  } catch {
    return textResponse(400, 'bad request');
  }
}
