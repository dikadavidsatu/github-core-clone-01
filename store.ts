// store.ts: the forge's data model and its git object store.
//
// Everything lives in memory: repositories with their objects (commits, trees, blobs, tags stored
// by SHA-1 exactly as git computes it), refs, labels, issues, comments and pull requests. The git
// helpers here implement the object formats, packfile read/write (with OFS/REF delta resolution on
// read; packs we write carry no deltas), tree flatten/rebuild for the contents API, ancestry walks
// for fetch negotiation and fast-forward checks, and the three-way tree merge a squash merge needs.
//
// No wall clock and no randomness anywhere: commit timestamps come from a counter over a fixed
// epoch, so two runs of the same request sequence build byte-identical objects.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObj {
  type: ObjType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';
/** The one login the bearer token owns in this single-user forge. */
export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;

const TYPE_CODE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: bytewise by name, with directories sorting as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function parseTag(data: Buffer): { object: string; type: string; tag: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  let tag = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line === '') break;
  }
  return { object, type, tag };
}

/** The epoch-second inside an author/committer line ("Name <mail> 1735689600 +0000"), or 0. */
export function identTimestamp(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident);
  return match ? Number(match[1]) : 0;
}

/** An ISO date for a git epoch-second, as the REST API reports authors. */
export function isoOf(epochSec: number): string {
  return new Date(epochSec * 1000).toISOString();
}

/** Name and email out of an ident line. */
export function identParts(ident: string): { name: string; email: string } {
  const match = /^(.*?) <([^>]*)>/.exec(ident);
  return match ? { name: match[1], email: match[2] } : { name: ident, email: '' };
}

// ---------------------------------------------------------------- packfiles

export function writePack(objects: readonly GitObj[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function packObjectHeader(type: ObjType, size: number): Buffer {
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

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile into a map of resolved objects. Throws on any structural problem.
 * `resolveBase` supplies objects a thin pack's REF_DELTA entries name.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObj | undefined): Map<string, GitObj> {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`bad pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack checksum mismatch');

  interface Raw {
    offset: number;
    typeCode: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    const first = byte;
    let size = byte & 0x0f;
    let shift = 4;
    offset += 1;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    const typeCode = (first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      let b = pack[offset++];
      let value = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        value = (value + 1) * 128 + (b & 0x7f);
      }
      entry.baseOffset = entryOffset - value;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inflated = inflateAt(pack.subarray(0, trailerStart), offset);
    if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const objects = new Map<string, GitObj>();
  const resolvedByOid = new Map<string, Raw & { type: ObjType; resolved: Buffer }>();
  const resolve = (entry: Raw): { type: ObjType; data: Buffer; oid: string } => {
    let type: ObjType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset ?? -1);
      if (!baseEntry) throw new Error('ofs-delta base missing');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid ?? '');
      if (baseEntry) {
        type = baseEntry.type;
        data = applyDelta(baseEntry.resolved, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid ?? '');
        if (!external) throw new Error('ref-delta base missing');
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    resolvedByOid.set(oid, { ...entry, type, resolved: data });
    return { type, data, oid };
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

// ---------------------------------------------------------------- the forge

export interface Label {
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  seq: number;
}

export interface PullRec {
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  seq: number;
}

const EPOCH_BASE = 1_735_689_600; // 2025-01-01T00:00:00Z; commit times are this + a counter.

export class Repo {
  readonly id: number;
  readonly name: string;
  isPrivate: boolean;
  description: string | null;
  readonly defaultBranch = 'main';
  readonly objects = new Map<string, GitObj>();
  readonly refs = new Map<string, string>();
  readonly labels = new Map<string, Label>();
  readonly issues = new Map<number, IssueRec>();
  readonly pulls = new Map<number, PullRec>();
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber = 1;
  private seqCounter = 0;

  constructor(id: number, name: string, isPrivate: boolean, description: string | null) {
    this.id = id;
    this.name = name;
    this.isPrivate = isPrivate;
    this.description = description;
  }

  nextSeq(): number {
    this.seqCounter += 1;
    return this.seqCounter;
  }

  putObject(type: ObjType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!this.objects.has(oid)) this.objects.set(oid, { type, data });
    return oid;
  }

  getObject(oid: string): GitObj | undefined {
    return this.objects.get(oid);
  }

  /** The current tip of a branch (short name), or undefined when it does not exist. */
  branchTip(branch: string): string | undefined {
    return this.refs.get(`refs/heads/${branch}`);
  }

  headTarget(): string {
    return `refs/heads/${this.defaultBranch}`;
  }

  /** Create and store a commit; the caller moves the ref. */
  makeCommit(forge: Forge, tree: string, parents: readonly string[], message: string): string {
    const ts = forge.nextTimestamp();
    const ident = `${VIEWER_LOGIN} <${VIEWER_LOGIN}@example.invalid> ${ts} +0000`;
    const lines = [`tree ${tree}`];
    for (const parent of parents) lines.push(`parent ${parent}`);
    lines.push(`author ${ident}`, `committer ${ident}`, '', message.endsWith('\n') ? message : `${message}\n`);
    return this.putObject('commit', Buffer.from(lines.join('\n'), 'utf8'));
  }

  commitView(oid: string): CommitView | null {
    const object = this.objects.get(oid);
    if (!object || object.type !== 'commit') return null;
    return parseCommit(object.data);
  }

  /** Flatten a tree (default: a commit's tree) into path -> {mode, oid}; empty for no tree. */
  flatten(treeOid: string | null): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = this.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
        else out.set(path, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** Build (and store) nested trees from a flattened path map; returns the root tree oid. */
  buildFromFlat(flat: ReadonlyMap<string, { mode: string; oid: string }>): string {
    interface Node {
      files: Map<string, { mode: string; oid: string }>;
      dirs: Map<string, Node>;
    }
    const root: Node = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const segments = path.split('/');
      let node = root;
      for (let i = 0; i < segments.length - 1; i += 1) {
        const name = segments[i];
        if (!node.dirs.has(name)) node.dirs.set(name, { files: new Map(), dirs: new Map() });
        node = node.dirs.get(name) as Node;
      }
      node.files.set(segments[segments.length - 1], entry);
    }
    const build = (node: Node): string => {
      const entries: TreeEntry[] = [];
      for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
      for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
      return this.putObject('tree', buildTree(entries));
    };
    return build(root);
  }

  /** The tree oid of a commit, or null. */
  treeOfCommit(commitOid: string): string | null {
    const view = this.commitView(commitOid);
    return view ? view.tree : null;
  }

  /** Every commit reachable from `tip`, newest first (by ancestry walk order). */
  ancestorsOf(tip: string): string[] {
    const seen = new Set<string>();
    const order: string[] = [];
    const queue: string[] = [tip];
    while (queue.length) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      const view = this.commitView(oid);
      if (!view) continue;
      seen.add(oid);
      order.push(oid);
      for (const parent of view.parents) queue.push(parent);
    }
    return order;
  }

  isAncestor(ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestorsOf(descendant).includes(ancestor);
  }

  /** The best common ancestor of two commits (first shared commit walking back from `b`). */
  mergeBase(a: string, b: string): string | null {
    const aAncestors = new Set(this.ancestorsOf(a));
    for (const candidate of this.ancestorsOf(b)) {
      if (aAncestors.has(candidate)) return candidate;
    }
    return null;
  }

  /** Peel a tag (or any object) down to the commit it names, or null. */
  peelToCommit(oid: string): string | null {
    let current = oid;
    for (let guard = 0; guard < 32; guard += 1) {
      const object = this.objects.get(current);
      if (!object) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }
}

export class Forge {
  readonly repos = new Map<string, Repo>();
  private nextRepoId = 1000;
  private nextIssueId = 1;
  private nextCommentId = 1;
  private timestampCounter = 0;

  nextTimestamp(): number {
    this.timestampCounter += 1;
    return EPOCH_BASE + this.timestampCounter * 60;
  }

  allocIssueId(): number {
    const id = this.nextIssueId;
    this.nextIssueId += 1;
    return id;
  }

  allocCommentId(): number {
    const id = this.nextCommentId;
    this.nextCommentId += 1;
    return id;
  }

  createRepo(name: string, isPrivate: boolean, description: string | null): Repo | null {
    if (this.repos.has(name)) return null;
    const repo = new Repo(this.nextRepoId, name, isPrivate, description);
    this.nextRepoId += 1;
    this.repos.set(name, repo);
    return repo;
  }

  getRepo(name: string): Repo | undefined {
    return this.repos.get(name);
  }

  deleteRepo(name: string): boolean {
    return this.repos.delete(name);
  }
}

/** Every object reachable from `roots` in a repo (commits walk trees and parents, tags peel). */
export function collectReachable(repo: Repo, roots: Iterable<string>, allowMissing = false): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [...roots];
  while (queue.length) {
    const oid = queue.pop() as string;
    if (seen.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) {
      if (allowMissing) continue;
      throw new Error(`missing object ${oid}`);
    }
    seen.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      queue.push(view.tree);
      queue.push(...view.parents);
    } else if (object.type === 'tag') {
      queue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode === '160000') continue;
        queue.push(entry.oid);
      }
    }
  }
  return seen;
}

// ---------------------------------------------------------------- pull-request merging and diffs

export interface MergeOutcome {
  conflict: boolean;
  tree: string | null;
}

/** Three-way tree merge: apply head's changes (against the merge base) onto the base branch's tree. */
export function threeWayMerge(repo: Repo, baseCommit: string, headCommit: string, targetCommit: string): MergeOutcome {
  const baseFlat = repo.flatten(repo.treeOfCommit(baseCommit));
  const headFlat = repo.flatten(repo.treeOfCommit(headCommit));
  const targetFlat = repo.flatten(repo.treeOfCommit(targetCommit));
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...targetFlat.keys()]);
  const result = new Map(targetFlat);
  for (const path of paths) {
    const base = baseFlat.get(path);
    const head = headFlat.get(path);
    const target = targetFlat.get(path);
    const headChanged = base?.oid !== head?.oid || base?.mode !== head?.mode;
    const targetChanged = base?.oid !== target?.oid || base?.mode !== target?.mode;
    if (!headChanged) continue;
    if (targetChanged && (target?.oid !== head?.oid || target?.mode !== head?.mode)) {
      return { conflict: true, tree: null };
    }
    if (head === undefined) result.delete(path);
    else result.set(path, head);
  }
  return { conflict: false, tree: repo.buildFromFlat(result) };
}

export interface PullMergePlan {
  conflict: boolean;
  mergeBase: string | null;
  headTip: string | null;
  baseTip: string | null;
  tree: string | null;
}

export function planPullMerge(repo: Repo, pull: PullRec): PullMergePlan {
  const headTip = repo.branchTip(pull.head) ?? null;
  const baseTip = repo.branchTip(pull.base) ?? null;
  if (headTip === null || baseTip === null) return { conflict: true, mergeBase: null, headTip, baseTip, tree: null };
  if (repo.isAncestor(headTip, baseTip)) {
    // Already up to date: the squash result is the base tree itself.
    return { conflict: false, mergeBase: headTip, headTip, baseTip, tree: repo.treeOfCommit(baseTip) };
  }
  const mergeBase = repo.mergeBase(baseTip, headTip);
  if (mergeBase === null) return { conflict: true, mergeBase: null, headTip, baseTip, tree: null };
  const merged = threeWayMerge(repo, mergeBase, headTip, baseTip);
  return { conflict: merged.conflict, mergeBase, headTip, baseTip, tree: merged.tree };
}

export interface FileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-diff counts between two texts (LCS over lines; inputs here are small). */
export function lineDiffCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const a = oldText === '' ? [] : oldText.split('\n');
  const b = newText === '' ? [] : newText.split('\n');
  // LCS length via dynamic programming over the shorter axis.
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? diagonal + 1 : Math.max(dp[j], dp[j - 1]);
      diagonal = above;
    }
  }
  const common = dp[b.length];
  return { additions: b.length - common, deletions: a.length - common };
}

/** The file changes between two commits' trees (a pull request's files). */
export function diffCommits(repo: Repo, fromCommit: string, toCommit: string): FileChange[] {
  const fromFlat = repo.flatten(repo.treeOfCommit(fromCommit));
  const toFlat = repo.flatten(repo.treeOfCommit(toCommit));
  const paths = new Set<string>([...fromFlat.keys(), ...toFlat.keys()]);
  const changes: FileChange[] = [];
  const textOf = (oid: string | undefined): string => {
    if (oid === undefined) return '';
    const object = repo.objects.get(oid);
    return object && object.type === 'blob' ? object.data.toString('utf8') : '';
  };
  for (const path of [...paths].sort()) {
    const from = fromFlat.get(path);
    const to = toFlat.get(path);
    if (from?.oid === to?.oid && from?.mode === to?.mode) continue;
    const counts = lineDiffCounts(textOf(from?.oid), textOf(to?.oid));
    changes.push({
      filename: path,
      status: from === undefined ? 'added' : to === undefined ? 'removed' : 'modified',
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
    });
  }
  return changes;
}
