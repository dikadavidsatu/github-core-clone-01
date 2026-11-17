// git.ts: the git smart-HTTP transport — reference advertisement, upload-pack (protocol v0 and
// v2, including ls-refs and shallow fetch) and receive-pack (v0, with report-status). Everything
// speaks pkt-lines; packs we send carry plain (non-delta) objects, which any client accepts.

import {
  Forge,
  type GitObj,
  Repo,
  ZERO_OID,
  collectReachable,
  identTimestamp,
  isOid,

  parseCommit,
  parseTag,
  readPack,
  writePack,
} from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

const PKT_MAX_PAYLOAD = 65516;

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  if (body.length > PKT_MAX_PAYLOAD) throw new Error('pkt-line too long');
  const header = Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function decodePkts(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('truncated pkt-line header');
    const header = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) throw new Error(`bad pkt-line header ${JSON.stringify(header)}`);
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'end' });
      offset += 4;
    } else {
      if (length < 4 || offset + length > buffer.length) throw new Error('truncated pkt-line');
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const chunkSize = 32768;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(offset + chunkSize, pack.length));
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return packets;
}

// ---------------------------------------------------------------- advertisement

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

function errorResult(status: number, message: string): GitHttpResult {
  return { status, contentType: 'text/plain; charset=utf-8', body: Buffer.from(`${message}\n`, 'utf8') };
}

/** Sorted ref list for advertisement: branch refs and tags, as git shows them. */
function advertisedRefs(repo: Repo): { name: string; oid: string }[] {
  const names = [...repo.refs.keys()].sort();
  return names.map((name) => ({ name, oid: repo.refs.get(name) as string }));
}

export function advertiseRefs(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack', protocolV2: boolean): GitHttpResult {
  if (service === 'git-upload-pack' && protocolV2) {
    const lines = [
      pktLine('version 2'),
      pktLine('agent=forge/1.0'),
      pktLine('ls-refs=unborn'),
      pktLine('fetch=shallow'),
      pktLine('object-format=sha1'),
      PKT_FLUSH,
    ];
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: Buffer.concat(lines) };
  }

  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow no-progress symref=HEAD:${repo.headTarget()} agent=forge/1.0`
      : 'report-status delete-refs side-band-64k ofs-delta agent=forge/1.0';

  const refs = advertisedRefs(repo);
  const headOid = repo.refs.get(repo.headTarget());
  const lines: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refLines: string[] = [];
  if (refs.length === 0) {
    refLines.push(`${ZERO_OID} capabilities^{}`);
  } else {
    refLines.push(`${headOid ?? ZERO_OID} HEAD`);
    for (const ref of refs) {
      refLines.push(`${ref.oid} ${ref.name}`);
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null && peeled !== ref.oid) refLines.push(`${peeled} ${ref.name}^{}`);
    }
  }
  refLines.forEach((line, index) => {
    lines.push(index === 0 ? pktLine(`${line}\0${caps}\n`) : pktLine(`${line}\n`));
  });
  lines.push(PKT_FLUSH);
  return {
    status: 200,
    contentType: `application/x-${service}-advertisement`,
    body: Buffer.concat(lines),
  };
}

/** Peel a ref's target through tag objects to the commit beneath, if it is a tag; else null. */
function peelTag(repo: Repo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (!object || object.type !== 'tag') return null;
  return repo.peelToCommit(oid);
}

// ---------------------------------------------------------------- ls-refs (protocol v2)

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function runLsRefs(repo: Repo, args: LsRefsArgs): Buffer {
  const matchesPrefix = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const headRef = repo.headTarget();
  const headOid = repo.refs.get(headRef);
  if (matchesPrefix('HEAD')) {
    if (headOid !== undefined) {
      const attrs = args.symrefs ? ` symref-target:${headRef}` : '';
      lines.push(pktLine(`${headOid} HEAD${attrs}`));
    } else if (args.unborn) {
      const attrs = args.symrefs ? ` symref-target:${headRef}` : '';
      lines.push(pktLine(`unborn HEAD${attrs}`));
    }
  }
  for (const ref of advertisedRefs(repo)) {
    if (!matchesPrefix(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (args.peel) {
      const peeled = peelTag(repo, ref.oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(line));
  }
  lines.push(PKT_FLUSH);
  return Buffer.concat(lines);
}

// ---------------------------------------------------------------- fetch planning

interface FetchRequest {
  wants: string[];
  haves: string[];
  clientShallow: string[];
  depth: number | null;
  deepenSince: number | null;
  deepenNot: string[];
}

interface FetchPlan {
  pack: Buffer;
  shallow: string[];
  unshallow: string[];
  common: string[];
}

/**
 * Plan a fetch: the objects to send, and the shallow boundary after it.
 *
 * Commit generations count from the wants (a want commit is generation 0); a depth of N includes
 * generations 0..N-1. The client's graph is the closure of its haves, with parent traversal
 * stopping at the commits it calls shallow. What we send is the wanted closure minus the client's
 * graph; the new boundary is the included commits with a parent outside the union.
 */
function planFetch(repo: Repo, request: FetchRequest): FetchPlan {
  const { depth } = request;

  // Commit generations from the wants (tags peel at the same generation).
  const generation = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of request.wants) queue.push({ oid: want, gen: 0 });
  const included = new Set<string>();
  while (queue.length) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    const object = repo.objects.get(oid);
    if (!object) continue;
    const known = generation.get(oid);
    if (object.type === 'commit') {
      if (depth !== null && gen >= depth) continue;
      if (known !== undefined && known <= gen) continue;
      generation.set(oid, gen);
      included.add(oid);
      const view = parseCommit(object.data);
      queue.push({ oid: view.tree, gen });
      for (const parent of view.parents) queue.push({ oid: parent, gen: gen + 1 });
    } else if (object.type === 'tag') {
      if (known !== undefined && known <= gen) continue;
      generation.set(oid, gen);
      included.add(oid);
      queue.push({ oid: parseTag(object.data).object, gen });
    } else {
      if (included.has(oid)) continue;
      included.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTreeEntries(object.data)) queue.push({ oid: entry, gen });
      }
    }
  }
  if (request.deepenNot.length) {
    const excluded = collectReachable(repo, request.deepenNot.filter((oid) => repo.objects.has(oid)), true);
    for (const oid of excluded) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') included.delete(oid);
    }
  }
  if (request.deepenSince !== null) {
    for (const oid of [...included]) {
      const object = repo.objects.get(oid);
      if (object && object.type === 'commit') {
        const view = parseCommit(object.data);
        if (identTimestamp(view.committer) < (request.deepenSince as number)) included.delete(oid);
      }
    }
  }

  // The client's existing graph: closure of haves, commits listed shallow are not expanded.
  const clientShallowSet = new Set(request.clientShallow);
  const clientHas = new Set<string>();
  const clientQueue: string[] = [...request.haves];
  while (clientQueue.length) {
    const oid = clientQueue.pop() as string;
    if (clientHas.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    clientHas.add(oid);
    if (object.type === 'commit') {
      const view = parseCommit(object.data);
      clientQueue.push(view.tree);
      if (!clientShallowSet.has(oid)) clientQueue.push(...view.parents);
    } else if (object.type === 'tag') {
      clientQueue.push(parseTag(object.data).object);
    } else if (object.type === 'tree') {
      clientQueue.push(...parseTreeEntries(object.data));
    }
  }

  const finalCommits = new Set<string>();
  for (const oid of included) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') finalCommits.add(oid);
  }
  for (const oid of clientHas) {
    const object = repo.objects.get(oid);
    if (object && object.type === 'commit') finalCommits.add(oid);
  }
  const boundary = new Set<string>();
  for (const oid of finalCommits) {
    const view = repo.commitView(oid);
    if (!view) continue;
    if (view.parents.some((parent) => !finalCommits.has(parent))) boundary.add(oid);
  }
  const toSend: GitObj[] = [];
  const sendOids: string[] = [];
  for (const oid of included) {
    if (clientHas.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (!object) continue;
    sendOids.push(oid);
    toSend.push(object);
  }
  const typeOrder: Record<string, number> = { commit: 0, tag: 1, tree: 2, blob: 3 };
  toSend.sort((a, b) => typeOrder[a.type] - typeOrder[b.type]);
  const sendSet = new Set(sendOids);
  const shallow = [...boundary].filter((oid) => sendSet.has(oid));
  const unshallow = request.clientShallow.filter((oid) => finalCommits.has(oid) && !boundary.has(oid));
  const common = request.haves.filter((oid) => repo.objects.has(oid));
  return { pack: writePack(toSend), shallow, unshallow, common };
}

function parseTreeEntries(data: Buffer): string[] {
  const oids: string[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    if (mode !== '160000') oids.push(oid);
    offset = nul + 21;
  }
  return oids;
}

// ---------------------------------------------------------------- upload-pack

export function handleUploadPack(repo: Repo, body: Buffer): GitHttpResult {
  const packets = decodePkts(body);
  const first = packets[0];
  if (first && first.kind === 'data') {
    const firstLine = first.payload.toString('utf8').replace(/\n$/, '');
    if (firstLine.startsWith('command=ls-refs')) return handleLsRefsCommand(repo, packets);
    if (firstLine.startsWith('command=fetch')) return handleFetchV2(repo, packets);
  }
  return handleFetchV0(repo, packets);
}

function handleLsRefsCommand(repo: Repo, packets: Pkt[]): GitHttpResult {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (!inArgs || packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: runLsRefs(repo, args) };
}

function parseFetchLines(lines: string[], request: FetchRequest): void {
  for (const line of lines) {
    if (line.startsWith('want ')) request.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) request.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) request.clientShallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7).trim());
    else if (line.startsWith('deepen-since ')) request.deepenSince = Number(line.slice(13).trim());
    else if (line.startsWith('deepen-not ')) request.deepenNot.push(line.slice(11).trim());
  }
}

function handleFetchV2(repo: Repo, packets: Pkt[]): GitHttpResult {
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [] };
  let inArgs = false;
  let done = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (!inArgs || packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (line === 'done') {
      done = true;
      continue;
    }
    parseFetchLines([line], request);
  }
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  if (!done) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.common.length) for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}`));
    else parts.push(pktLine('NAK'));
    parts.push(PKT_FLUSH);
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
  }
  if (request.haves.length) {
    parts.push(pktLine('acknowledgments\n'));
    if (plan.common.length) for (const oid of plan.common) parts.push(pktLine(`ACK ${oid}`));
    else parts.push(pktLine('NAK'));
    parts.push(PKT_FLUSH);
  }
  if (plan.shallow.length || plan.unshallow.length) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

function handleFetchV0(repo: Repo, packets: Pkt[]): GitHttpResult {
  const request: FetchRequest = { wants: [], haves: [], clientShallow: [], depth: null, deepenSince: null, deepenNot: [] };
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul !== -1) line = line.slice(0, nul);
    parseFetchLines([line], request);
  }
  const plan = planFetch(repo, request);
  const parts: Buffer[] = [];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  parts.push(...sidebandPackets(plan.pack));
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) };
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(repo: Repo, body: Buffer): GitHttpResult {
  const splitAt = findPackStart(body);
  if (splitAt === -1) throw new Error('malformed push: no flush after commands');
  const commandBytes = body.subarray(0, splitAt);
  const packBytes = body.subarray(splitAt + 4);
  const packets = decodePkts(commandBytes);
  const commands: PushCommand[] = [];
  let sideBand = false;
  packets.forEach((packet, index) => {
    if (packet.kind !== 'data') return;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (index === 0) {
      const nul = line.indexOf('\0');
      if (nul !== -1) {
        const caps = line.slice(nul + 1);
        if (caps.split(' ').includes('side-band-64k')) sideBand = true;
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
    }
  });

  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : String(error);
    }
  }
  const lines: string[] = [unpackError === null ? 'unpack ok' : `unpack ${unpackError}`];
  for (const command of commands) {
    const outcome = applyPushCommand(repo, command, unpackError !== null);
    lines.push(outcome === 'ok' ? `ok ${command.ref}` : `ng ${command.ref} ${outcome.slice(3)}`);
  }

  const reportBytes = Buffer.concat(lines.map((line) => pktLine(`${line}\n`)));
  const parts: Buffer[] = [];
  if (sideBand) {
    const chunkSize = 32768;
    for (let offset = 0; offset < reportBytes.length; offset += chunkSize) {
      parts.push(pktLine(Buffer.concat([Buffer.from([1]), reportBytes.subarray(offset, Math.min(offset + chunkSize, reportBytes.length))])));
    }
  } else {
    parts.push(reportBytes);
  }
  parts.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(parts) };
}

/** Returns "ok" or "ng <reason>" for one ref update; applies it when ok. */
function applyPushCommand(repo: Repo, command: PushCommand, unpackFailed: boolean): string {
  if (!command.ref.startsWith('refs/')) return 'ng invalid ref';
  if (unpackFailed) return 'ng unpacker error';
  const current = repo.refs.get(command.ref) ?? ZERO_OID;
  if (command.newOid === ZERO_OID) {
    if (current === ZERO_OID) return 'ng reference does not exist';
    repo.refs.delete(command.ref);
    return 'ok';
  }
  if (!repo.objects.has(command.newOid)) return 'ng missing object';
  if (current !== ZERO_OID && current !== command.newOid) {
    const newCommit = repo.peelToCommit(command.newOid);
    const currentCommit = repo.peelToCommit(current);
    if (newCommit !== null && currentCommit !== null && !repo.isAncestor(currentCommit, newCommit)) {
      return 'ng non-fast-forward';
    }
  }
  repo.refs.set(command.ref, command.newOid);
  return 'ok';
}

/** Byte offset of the flush packet that ends the command list, or -1 when there is none. */
function findPackStart(body: Buffer): number {
  let offset = 0;
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(header)) return -1;
    const length = parseInt(header, 16);
    if (length === 0) return offset;
    if (length < 4) return -1;
    offset += length;
  }
  return -1;
}
