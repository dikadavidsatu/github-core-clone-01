// mcp.ts: the MCP surface — Streamable HTTP JSON-RPC 2.0 at /mcp.
//
// The modern era is answered from `server/discover` (the client probes it first and connects
// without an initialize handshake when it succeeds); the legacy initialize handshake is served
// too. The tool list is one constant array, so two tools/list calls are byte-identical. Every
// tool acts on the same store the REST API serves, with the same shapes, so ids are stable
// across surfaces. The server is stateless per request: concurrent calls answer under their
// own JSON-RPC ids.

import { Forge, type IssueRec, type PullRec, type Repo, VIEWER_LOGIN, planPullMerge } from './store.ts';
import { repoJson, issueJson, pullJson } from './rest.ts';

const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'github-core-clone', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: boolean;
  };
}

const str = (description: string): { type: string; description: string } => ({ type: 'string', description });

export const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('The repository name.'),
        description: str('A short description of the repository.'),
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: { owner: str('The repository owner login.'), repo: str('The repository name.') },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_repos',
    description: 'List the repositories owned by the authenticated user.',
    inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: true },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The issue title.'),
        body: str('The issue body.'),
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: true,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        state: str('Filter by state: open, closed or all.'),
      },
      required: ['owner', 'repo'],
      additionalProperties: true,
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        issue_number: { type: 'number', description: 'The issue number.' },
      },
      required: ['owner', 'repo', 'issue_number'],
      additionalProperties: true,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        title: str('The pull request title.'),
        body: str('The pull request body.'),
        head: str('The head branch name.'),
        base: str('The base branch name.'),
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: true,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: str('The repository owner login.'),
        repo: str('The repository name.'),
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: true,
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((tool) => [tool.name, tool]));

export interface McpHttpResult {
  status: number;
  body: string | null;
}

function rpcResult(id: unknown, result: unknown): McpHttpResult {
  return { status: 200, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result }) };
}

function rpcError(id: unknown, status: number, code: number, message: string): McpHttpResult {
  return { status, body: JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }) };
}

function toolResult(value: unknown): Record<string, unknown> {
  const text = JSON.stringify(value) ?? 'null';
  return { content: [{ type: 'text', text }], structuredContent: value, isError: false };
}

function toolFailure(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function lookupRepo(forge: Forge, args: Record<string, unknown>): Repo | null {
  if (String(args.owner ?? '') !== VIEWER_LOGIN) return null;
  return forge.getRepo(String(args.repo ?? '')) ?? null;
}

function callTool(forge: Forge, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (name) {
    case 'create_repo': {
      const repoName = String(args.name ?? '');
      const existing = forge.getRepo(repoName);
      if (existing) return toolFailure(`Repository ${VIEWER_LOGIN}/${repoName} already exists`);
      const repo = forge.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : null);
      if (!repo) return toolFailure('could not create repository');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      return toolResult(repoJson(repo));
    }
    case 'list_repos': {
      return toolResult({ repositories: [...forge.repos.values()].map((repo) => repoJson(repo)) });
    }
    case 'create_issue': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const labels = Array.isArray(args.labels) ? (args.labels as unknown[]).map(String) : [];
      for (const label of labels) {
        if (!repo.labels.has(label)) return toolFailure(`label not found: ${label}`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        state: 'open',
        labels,
        comments: [],
        seq: repo.nextSeq(),
      };
      repo.issues.set(number, issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      const issues = [...repo.issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => a.seq - b.seq)
        .map((issue) => issueJson(repo, issue));
      return toolResult({ issues });
    }
    case 'get_issue': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const issue = repo.issues.get(Number(args.issue_number));
      if (!issue) return toolFailure('issue not found');
      return toolResult(issueJson(repo, issue));
    }
    case 'create_pull_request': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const head = String(args.head ?? '');
      const base = String(args.base ?? '');
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.head === head && pull.base === base,
      );
      if (duplicate) return toolFailure(`A pull request for ${head} into ${base} already exists`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: String(args.title ?? ''),
        body: typeof args.body === 'string' ? args.body : '',
        head,
        base,
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(forge, args);
      if (!repo) return toolFailure('repository not found');
      const pull = repo.pulls.get(Number(args.pull_number));
      if (!pull) return toolFailure('pull request not found');
      if (pull.merged) return toolResult({ ...pullJson(repo, pull), merged: true });
      const plan = planPullMerge(repo, pull);
      if (plan.conflict || plan.tree === null || plan.baseTip === null) return toolFailure('Pull Request is not mergeable');
      const sha = repo.makeCommit(forge, plan.tree, [plan.baseTip], `${pull.title} (#${pull.number})`);
      repo.refs.set(`refs/heads/${pull.base}`, sha);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = sha;
      pull.mergedAt = new Date(forge.nextTimestamp() * 1000).toISOString();
      return toolResult({ ...pullJson(repo, pull), sha, merged: true, message: 'Pull Request successfully merged' });
    }
  }
  return toolFailure(`unknown tool ${name}`);
}

/**
 * Handle one POST /mcp body. JSON parsing happens in the caller where the parse-error shape is
 * decided; this function receives the parsed message.
 */
export function handleMcpMessage(forge: Forge, message: unknown): McpHttpResult {
  if (Array.isArray(message)) {
    const results: unknown[] = [];
    for (const entry of message) {
      const single = handleMcpMessage(forge, entry);
      if (single.body !== null) results.push(JSON.parse(single.body));
    }
    return { status: 200, body: JSON.stringify(results) };
  }
  if (!message || typeof message !== 'object') return rpcError(null, 400, -32600, 'Invalid Request');
  const record = message as Record<string, unknown>;
  const id = record.id;
  const method = typeof record.method === 'string' ? record.method : '';
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: SUPPORTED_VERSIONS,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A GitHub-compatible forge: repositories, issues and pull requests over MCP.',
      });
    case 'initialize': {
      const params = (record.params ?? {}) as Record<string, unknown>;
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const protocolVersion = SUPPORTED_VERSIONS.includes(requested) ? requested : '2025-11-25';
      return rpcResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: SERVER_INFO });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const params = (record.params ?? {}) as Record<string, unknown>;
      const toolName = typeof params.name === 'string' ? params.name : '';
      const tool = TOOLS_BY_NAME.get(toolName);
      if (!tool) return rpcError(id, 200, -32602, `Unknown tool: ${toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      for (const required of tool.inputSchema.required) {
        if (args[required] === undefined || args[required] === null) {
          return rpcError(id, 200, -32602, `Missing required argument: ${required}`);
        }
      }
      try {
        return rpcResult(id, callTool(forge, toolName, args));
      } catch (error) {
        return rpcResult(id, toolFailure(error instanceof Error ? error.message : String(error)));
      }
    }
    default: {
      if (isNotification || method.startsWith('notifications/')) return { status: 202, body: null };
      return rpcError(id, 200, -32601, `Method not found: ${method}`);
    }
  }
}
