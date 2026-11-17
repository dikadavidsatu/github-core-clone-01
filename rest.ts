// rest.ts: the REST API under /api/v3 — repositories, contents, refs, branches, commits, labels,
// issues, comments and pull requests, in GitHub's shapes. The JSON builders here are shared with
// the MCP tools so both surfaces describe the same objects identically.

import {
  Forge,
  IssueRec,
  PullRec,
  Repo,
  VIEWER_ID,
  VIEWER_LOGIN,
  ZERO_OID,
  diffCommits,
  identParts,
  isoOf,
  parseTree,
  planPullMerge,
} from './store.ts';

export interface RestResult {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

const API = '/api/v3';

function isoFromRepo(repo: Repo): string {
  return isoOf(1_735_689_600 + repo.id);
}

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER_LOGIN,
    id: VIEWER_ID,
    node_id: Buffer.from(`User:${VIEWER_ID}`, 'utf8').toString('base64'),
    type: 'User',
    site_admin: false,
    name: 'ada iversen',
    email: 'adaiversen@example.invalid',
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`, 'utf8').toString('base64'),
    name: repo.name,
    full_name: `${VIEWER_LOGIN}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}`,
    clone_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}.git`,
    git_url: `git://localhost/${VIEWER_LOGIN}/${repo.name}.git`,
    ssh_url: `git@localhost:${VIEWER_LOGIN}/${repo.name}.git`,
    default_branch: repo.defaultBranch,
    created_at: isoFromRepo(repo),
    updated_at: isoFromRepo(repo),
    pushed_at: isoFromRepo(repo),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label ? [...repo.labels.keys()].indexOf(name) + 1 : 0,
    name,
    color: label?.color ?? '000000',
    description: label?.description ?? null,
    default: false,
    url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/labels/${encodeURIComponent(name)}`,
  };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.number + repo.id * 100000,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`, 'utf8').toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => labelJson(repo, name)),
    user: userJson(),
    assignees: [],
    comments: issue.comments.length,
    created_at: isoOf(1_735_689_600 + issue.seq * 60),
    updated_at: isoOf(1_735_689_600 + issue.seq * 60),
    closed_at: issue.state === 'closed' ? isoOf(1_735_689_600 + issue.seq * 60) : null,
    url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
    html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: IssueRec, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${repo.id}:${issue.number}:${comment.id}`, 'utf8').toString('base64'),
    body: comment.body,
    user: userJson(),
    created_at: isoOf(1_735_689_600 + comment.id * 60),
    updated_at: isoOf(1_735_689_600 + comment.id * 60),
    url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/issues/comments/${comment.id}`,
    html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    issue_url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const headSha = repo.branchTip(pull.head) ?? ZERO_OID;
  const baseSha = repo.branchTip(pull.base) ?? ZERO_OID;
  return {
    id: pull.number + repo.id * 100000,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`, 'utf8').toString('base64'),
    number: pull.number,
    state: pull.merged || pull.state === 'closed' ? 'closed' : 'open',
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    draft: false,
    created_at: isoOf(1_735_689_600 + pull.seq * 60),
    updated_at: isoOf(1_735_689_600 + pull.seq * 60),
    closed_at: pull.state === 'closed' ? isoOf(1_735_689_600 + pull.seq * 60) : null,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    merged: pull.merged,
    head: {
      label: `${VIEWER_LOGIN}:${pull.head}`,
      ref: pull.head,
      sha: headSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    base: {
      label: `${VIEWER_LOGIN}:${pull.base}`,
      ref: pull.base,
      sha: baseSha,
      user: userJson(),
      repo: repoJson(repo),
    },
    url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
    html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: Repo, oid: string): Record<string, unknown> {
  const view = repo.commitView(oid);
  if (!view) return { sha: oid };
  const author = identParts(view.author);
  const committer = identParts(view.committer);
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`, 'utf8').toString('base64'),
    commit: {
      author: { name: author.name, email: author.email, date: isoOf(parseIdentTs(view.author)) },
      committer: { name: committer.name, email: committer.email, date: isoOf(parseIdentTs(view.committer)) },
      message: view.message.replace(/\n$/, ''),
      tree: { sha: view.tree, url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/trees/${view.tree}` },
      comment_count: 0,
    },
    author: null,
    committer: null,
    parents: view.parents.map((parent) => ({ sha: parent, url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/commits/${parent}` })),
    url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/commits/${oid}`,
    html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}/commit/${oid}`,
  };
}

function parseIdentTs(ident: string): number {
  const match = / (\d+) [+-]\d{4}$/.exec(ident);
  return match ? Number(match[1]) : 0;
}

const notFound = (): RestResult => ({ status: 404, body: { message: 'Not Found' } });
const unprocessable = (message: string): RestResult => ({ status: 422, body: { message } });

interface Ctx {
  forge: Forge;
  method: string;
  segments: string[];
  query: URLSearchParams;
  body: Record<string, unknown>;
  origin: string;
}

function resolveRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return ctx.forge.getRepo(name) ?? null;
}

/** Handle one REST request. `path` is the URL path after /api/v3 ('' for the root). */
export function handleRest(ctx: Ctx & { path: string }): RestResult {
  const { forge, method, query, body } = ctx;
  const segments = ctx.path === '' ? [] : ctx.path.split('/').map((part) => decodeURIComponent(part));

  if (segments.length === 0) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      headers: { 'x-oauth-scopes': 'repo, read:org' },
      body: {
        current_user_url: `${API}/user`,
        repository_url: `${API}/repos/{owner}/{repo}`,
        issue_url: `${API}/repos/{owner}/{repo}/issues{/number}`,
      },
    };
  }
  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return {
      status: 200,
      body: {
        installed_version: '1.0.0',
        verifiable_password_authentication: false,
        ssh_key_fingerprints: {},
        hooks: [],
      },
    };
  }
  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound();
    return { status: 200, body: userJson() };
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createRepo(ctx);
    return notFound();
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = resolveRepo(ctx, segments[1], segments[2]);
    if (!repo) return notFound();
    return handleRepo(ctx, repo, segments.slice(3));
  }
  return notFound();
}

function createRepo(ctx: Ctx): RestResult {
  const name = typeof ctx.body.name === 'string' ? ctx.body.name : '';
  if (name === '') return unprocessable('Validation Failed: name is required');
  if (ctx.forge.getRepo(name)) return unprocessable(`Validation Failed: name already exists on this account`);
  const repo = ctx.forge.createRepo(
    name,
    ctx.body.private === true,
    typeof ctx.body.description === 'string' ? ctx.body.description : null,
  );
  if (!repo) return unprocessable('Validation Failed: name already exists on this account');
  return { status: 201, body: repoJson(repo) };
}

function paginate(ctx: Ctx, items: unknown[], basePath: string): RestResult {
  const perPageRaw = Number(ctx.query.get('per_page'));
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number(ctx.query.get('page'));
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const nextUrl = `${ctx.origin}${basePath}?per_page=${perPage}&page=${page + 1}`;
    const lastUrl = `${ctx.origin}${basePath}?per_page=${perPage}&page=${lastPage}`;
    headers.link = `<${nextUrl}>; rel="next", <${lastUrl}>; rel="last"`;
  }
  return { status: 200, body: slice, headers };
}

function listUserRepos(ctx: Ctx): RestResult {
  const repos = [...ctx.forge.repos.values()].map((repo) => repoJson(repo));
  return paginate(ctx, repos, `${API}/user/repos`);
}

function handleRepo(ctx: Ctx, repo: Repo, rest: string[]): RestResult {
  const { method, body, query } = ctx;
  if (rest.length === 0) {
    if (method === 'GET') return { status: 200, body: repoJson(repo) };
    if (method === 'PATCH') {
      if (typeof body.description === 'string') repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.name === 'string' && body.name !== repo.name) {
        ctx.forge.repos.delete(repo.name);
        (repo as { name: string }).name = body.name;
        ctx.forge.repos.set(repo.name, repo);
      }
      return { status: 200, body: repoJson(repo) };
    }
    if (method === 'DELETE') {
      ctx.forge.deleteRepo(repo.name);
      return { status: 204 };
    }
    return notFound();
  }

  const head = rest[0];

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: oid, url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/commits/${oid}` },
          protected: false,
        }));
      return { status: 200, body: branches };
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const oid = repo.branchTip(branch);
      if (!oid) return notFound();
      return {
        status: 200,
        body: {
          name: branch,
          commit: commitJson(repo, oid),
          protected: false,
          _links: {},
        },
      };
    }
    return notFound();
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const refParam = query.get('sha') ?? repo.defaultBranch;
      const tip = repo.branchTip(refParam) ?? (repo.objects.has(refParam) ? refParam : undefined);
      if (!tip) return { status: 200, body: [] };
      const list = repo.ancestorsOf(tip).map((oid) => commitJson(repo, oid));
      return { status: 200, body: list };
    }
    if (rest.length === 2 && method === 'GET') {
      if (!repo.commitView(rest[1])) return notFound();
      return { status: 200, body: commitJson(repo, rest[1]) };
    }
    return notFound();
  }

  if (head === 'contents') {
    return handleContents(ctx, repo, rest.slice(1).join('/'));
  }

  if (head === 'git' && rest[1] === 'refs') {
    if (rest.length === 2 && method === 'POST') {
      const ref = typeof body.ref === 'string' ? body.ref : '';
      const sha = typeof body.sha === 'string' ? body.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return unprocessable('Validation Failed: invalid ref or sha');
      repo.refs.set(ref, sha);
      return {
        status: 201,
        body: {
          ref,
          node_id: Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64'),
          url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/${ref}`,
          object: { sha, type: repo.objects.get(sha)?.type ?? 'commit', url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/commits/${sha}` },
        },
      };
    }
    if (rest.length >= 3 && method === 'GET') {
      const ref = `refs/${rest.slice(2).join('/')}`;
      const oid = repo.refs.get(ref);
      if (!oid) return notFound();
      return {
        status: 200,
        body: {
          ref,
          node_id: Buffer.from(`Ref:${repo.id}:${ref}`, 'utf8').toString('base64'),
          url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/${ref}`,
          object: { sha: oid, type: repo.objects.get(oid)?.type ?? 'commit', url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/commits/${oid}` },
        },
      };
    }
    return notFound();
  }

  if (head === 'labels') {
    if (rest.length === 1 && method === 'POST') {
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '') return unprocessable('Validation Failed: name is required');
      if (repo.labels.has(name)) return unprocessable('Validation Failed: label already exists');
      repo.labels.set(name, {
        name,
        color: typeof body.color === 'string' ? body.color : '000000',
        description: typeof body.description === 'string' ? body.description : null,
      });
      return { status: 201, body: labelJson(repo, name) };
    }
    if (rest.length === 1 && method === 'GET') {
      return { status: 200, body: [...repo.labels.keys()].map((name) => labelJson(repo, name)) };
    }
    return notFound();
  }

  if (head === 'issues') return handleIssues(ctx, repo, rest.slice(1));
  if (head === 'pulls') return handlePulls(ctx, repo, rest.slice(1));

  return notFound();
}

function handleContents(ctx: Ctx, repo: Repo, path: string): RestResult {
  const { method, body, query } = ctx;

  if (method === 'PUT') {
    const message = typeof body.message === 'string' ? body.message : '';
    const contentBase64 = typeof body.content === 'string' ? body.content : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const expectedSha = typeof body.sha === 'string' ? body.sha : undefined;
    const tip = repo.branchTip(branch);
    const flat = repo.flatten(tip ? repo.treeOfCommit(tip) : null);
    const existing = flat.get(path);
    if (existing && expectedSha === undefined) return { status: 422, body: { message: `Validation Failed: sha is required when updating ${path}` } };
    if (existing && expectedSha !== existing.oid) return { status: 409, body: { message: `Conflict: ${path} has sha ${existing.oid}, not ${expectedSha}` } };
    if (!existing && expectedSha !== undefined) return { status: 404, body: { message: `Not Found: ${path} does not exist` } };
    const blobOid = repo.putObject('blob', Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64'));
    flat.set(path, { mode: '100644', oid: blobOid });
    const tree = repo.buildFromFlat(flat);
    const commit = repo.makeCommit(ctx.forge, tree, tip ? [tip] : [], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return {
      status: existing ? 200 : 201,
      body: {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: Buffer.from(contentBase64.replace(/[\r\n\t ]+/g, ''), 'base64').length,
          type: 'file',
          encoding: 'base64',
          url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/contents/${path}`,
        },
        commit: { sha: commit, ...commitSummary(repo, commit) },
      },
    };
  }

  if (method === 'DELETE') {
    const message = typeof body.message === 'string' ? body.message : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
    const tip = repo.branchTip(branch);
    if (!tip) return notFound();
    const flat = repo.flatten(repo.treeOfCommit(tip));
    const existing = flat.get(path);
    if (!existing) return notFound();
    if (sha !== existing.oid) return { status: 409, body: { message: `Conflict: ${path} has sha ${existing.oid}, not ${sha}` } };
    flat.delete(path);
    const tree = repo.buildFromFlat(flat);
    const commit = repo.makeCommit(ctx.forge, tree, [tip], message);
    repo.refs.set(`refs/heads/${branch}`, commit);
    return { status: 200, body: { content: null, commit: { sha: commit, ...commitSummary(repo, commit) } } };
  }

  if (method === 'GET') {
    const ref = query.get('ref');
    let treeOid: string | null = null;
    if (ref) {
      const asBranch = repo.branchTip(ref);
      if (asBranch) treeOid = repo.treeOfCommit(asBranch);
      else if (repo.objects.has(ref)) {
        const object = repo.objects.get(ref);
        treeOid = object?.type === 'commit' ? repo.treeOfCommit(ref) : object?.type === 'tree' ? ref : null;
      }
    } else {
      const tip = repo.branchTip(repo.defaultBranch);
      treeOid = tip ? repo.treeOfCommit(tip) : null;
    }
    if (treeOid === null) return notFound();
    return contentsGet(repo, treeOid, path);
  }

  return notFound();
}

function commitSummary(repo: Repo, oid: string): Record<string, unknown> {
  const view = repo.commitView(oid);
  if (!view) return {};
  const author = identParts(view.author);
  const committer = identParts(view.committer);
  return {
    message: view.message.replace(/\n$/, ''),
    author: { name: author.name, email: author.email, date: isoOf(parseIdentTs(view.author)) },
    committer: { name: committer.name, email: committer.email, date: isoOf(parseIdentTs(view.committer)) },
    tree: { sha: view.tree },
    parents: view.parents.map((parent) => ({ sha: parent })),
  };
}

function contentsGet(repo: Repo, rootTree: string, path: string): RestResult {
  if (path === '') {
    const object = repo.objects.get(rootTree);
    if (!object || object.type !== 'tree') return notFound();
    return { status: 200, body: dirListing(repo, rootTree, '') };
  }
  const segments = path.split('/');
  let treeOid = rootTree;
  for (let i = 0; i < segments.length; i += 1) {
    const object = repo.objects.get(treeOid);
    if (!object || object.type !== 'tree') return notFound();
    const entry = parseTree(object.data).find((candidate) => candidate.name === segments[i]);
    if (!entry) return notFound();
    const isLast = i === segments.length - 1;
    if (!isLast) {
      if (entry.mode !== '40000' && entry.mode !== '040000') return notFound();
      treeOid = entry.oid;
      continue;
    }
    if (entry.mode === '40000' || entry.mode === '040000') {
      return { status: 200, body: dirListing(repo, entry.oid, path) };
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob || blob.type !== 'blob') return notFound();
    return {
      status: 200,
      body: {
        type: 'file',
        encoding: 'base64',
        content: blob.data.toString('base64'),
        sha: entry.oid,
        size: blob.data.length,
        name: entry.name,
        path,
        url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/contents/${path}`,
        git_url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/blobs/${entry.oid}`,
        html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}/blob/${repo.defaultBranch}/${path}`,
        download_url: null,
        _links: { self: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/contents/${path}` },
      },
    };
  }
  return notFound();
}

function dirListing(repo: Repo, treeOid: string, prefix: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000' || entry.mode === '040000';
    const entryPath = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    return {
      type: isDir ? 'dir' : 'file',
      name: entry.name,
      path: entryPath,
      sha: entry.oid,
      size: 0,
      url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/contents/${entryPath}`,
      git_url: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
      html_url: `http://localhost/${VIEWER_LOGIN}/${repo.name}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${entryPath}`,
      download_url: null,
      _links: { self: `${API}/repos/${VIEWER_LOGIN}/${repo.name}/contents/${entryPath}` },
    };
  });
}

function handleIssues(ctx: Ctx, repo: Repo, rest: string[]): RestResult {
  const { method, body, query } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const title = typeof body.title === 'string' ? body.title : '';
      const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).map(String) : [];
      for (const label of labelNames) {
        if (!repo.labels.has(label)) return unprocessable(`Validation Failed: label '${label}' does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title,
        body: typeof body.body === 'string' ? body.body : '',
        state: 'open',
        labels: labelNames,
        comments: [],
        seq: repo.nextSeq(),
      };
      repo.issues.set(number, issue);
      return { status: 201, body: issueJson(repo, issue) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      const sort = query.get('sort') ?? 'created';
      const direction = query.get('direction') ?? (sort === 'created' ? 'desc' : 'asc');
      let issues = [...repo.issues.values()];
      if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => (direction === 'desc' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
      return { status: 200, body: issues.map((issue) => issueJson(repo, issue)) };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (!issue) return notFound();
    if (method === 'GET') return { status: 200, body: issueJson(repo, issue) };
    if (method === 'PATCH') {
      if (body.state === 'closed' || body.state === 'open') issue.state = body.state;
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string') issue.body = body.body;
      return { status: 200, body: issueJson(repo, issue) };
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    if (!issue) return notFound();
    if (method === 'POST') {
      const comment = { id: ctx.forge.allocCommentId(), body: typeof body.body === 'string' ? body.body : '' };
      issue.comments.push(comment);
      return { status: 201, body: commentJson(repo, issue, comment) };
    }
    if (method === 'GET') {
      return { status: 200, body: issue.comments.map((comment) => commentJson(repo, issue, comment)) };
    }
  }
  return notFound();
}

function handlePulls(ctx: Ctx, repo: Repo, rest: string[]): RestResult {
  const { method, body, query } = ctx;
  if (rest.length === 0) {
    if (method === 'POST') {
      const head = typeof body.head === 'string' ? body.head : '';
      const base = typeof body.base === 'string' ? body.base : '';
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.head === head && pull.base === base,
      );
      if (duplicate) return unprocessable(`Validation Failed: A pull request already exists for ${VIEWER_LOGIN}:${head} -> ${VIEWER_LOGIN}:${base}`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: typeof body.title === 'string' ? body.title : '',
        body: typeof body.body === 'string' ? body.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return { status: 201, body: pullJson(repo, pull) };
    }
    if (method === 'GET') {
      const state = query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.seq - b.seq);
      return { status: 200, body: pulls.map((pull) => pullJson(repo, pull)) };
    }
    return notFound();
  }
  const number = Number(rest[0]);
  const pull = repo.pulls.get(number);
  if (rest.length === 1) {
    if (!pull) return notFound();
    if (method === 'GET') return { status: 200, body: pullJson(repo, pull) };
    if (method === 'PATCH') {
      if (body.state === 'closed' || body.state === 'open') pull.state = body.state;
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string') pull.body = body.body;
      return { status: 200, body: pullJson(repo, pull) };
    }
    return notFound();
  }
  if (rest.length === 2 && rest[1] === 'files' && method === 'GET') {
    if (!pull) return notFound();
    const baseTip = repo.branchTip(pull.base);
    const headTip = repo.branchTip(pull.head);
    if (!baseTip || !headTip) return { status: 200, body: [] };
    const mergeBase = repo.mergeBase(baseTip, headTip);
    if (!mergeBase) return { status: 200, body: [] };
    const changes = diffCommits(repo, mergeBase, headTip);
    return {
      status: 200,
      body: changes.map((change) => ({
        sha: headTip,
        filename: change.filename,
        status: change.status,
        additions: change.additions,
        deletions: change.deletions,
        changes: change.changes,
        patch: '',
      })),
    };
  }
  if (rest.length === 2 && rest[1] === 'merge' && method === 'PUT') {
    if (!pull) return notFound();
    if (pull.merged) {
      return { status: 200, body: { sha: pull.mergeCommitSha, merged: true, message: 'Pull Request successfully merged' } };
    }
    if (pull.state !== 'open') return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    const plan = planPullMerge(repo, pull);
    if (plan.conflict || plan.tree === null || plan.baseTip === null) {
      return { status: 405, body: { message: 'Pull Request is not mergeable' } };
    }
    const sha = repo.makeCommit(ctx.forge, plan.tree, [plan.baseTip], `${pull.title} (#${pull.number})`);
    repo.refs.set(`refs/heads/${pull.base}`, sha);
    pull.merged = true;
    pull.state = 'closed';
    pull.mergeCommitSha = sha;
    pull.mergedAt = new Date(ctx.forge.nextTimestamp() * 1000).toISOString();
    return { status: 200, body: { sha, merged: true, message: 'Pull Request successfully merged' } };
  }
  return notFound();
}
