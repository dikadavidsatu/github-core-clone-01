// graphql.ts: a small GraphQL parser and executor covering the forge's schema — viewer,
// repository, node, issues and pull requests with cursor connections, the five mutations the API
// promises (createIssue, closeIssue, createPullRequest, mergePullRequest, addComment), and the
// introspection the clients probe (__type with fields and enum values, aliases included).
//
// Global ids are opaque base64 of "Type:rest" — stable per object, never the plain database id.

import {
  Forge,
  type IssueRec,
  type PullRec,
  Repo,
  VIEWER_ID,
  VIEWER_LOGIN,
  diffCommits,
  planPullMerge,
} from './store.ts';

// ---------------------------------------------------------------- values and ids

type Variables = Record<string, unknown>;

export function globalId(type: string, rest: string): string {
  return Buffer.from(`${type}:${rest}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { type: string; rest: string } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon === -1) return null;
    return { type: decoded.slice(0, colon), rest: decoded.slice(colon + 1) };
  } catch {
    return null;
  }
}

const repoGlobalId = (repo: Repo): string => globalId('Repository', String(repo.id));
const issueGlobalId = (repo: Repo, issue: IssueRec): string => globalId('Issue', `${repo.id}:${issue.number}`);
const pullGlobalId = (repo: Repo, pull: PullRec): string => globalId('PullRequest', `${repo.id}:${pull.number}`);
const commentGlobalId = (repo: Repo, issueNumber: number, commentId: number): string =>
  globalId('IssueComment', `${repo.id}:${issueNumber}:${commentId}`);

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  alias: string | null;
  name: string;
  args: { name: string; value: Value }[];
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'fragment'; typeCondition: string; selection: SelectionNode[] };

interface Operation {
  type: 'query' | 'mutation';
  selection: SelectionNode[];
}

class GqlSyntaxError extends Error {}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (/\s|,/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '.' && source.startsWith('...', i)) {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}()[]:@$!:=|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        if (end === -1) throw new GqlSyntaxError('unterminated block string');
        tokens.push(`"${source.slice(i + 3, end)}"`);
        i = end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\') {
          const escaped = source[j + 1];
          const escapes: Record<string, string> = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
          if (escaped === 'u') {
            value += String.fromCharCode(parseInt(source.slice(j + 2, j + 6), 16));
            j += 6;
          } else {
            value += escapes[escaped] ?? escaped;
            j += 2;
          }
        } else {
          value += source[j];
          j += 1;
        }
      }
      if (j >= source.length) throw new GqlSyntaxError('unterminated string');
      tokens.push(`"${value}"`);
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new GqlSyntaxError(`unexpected character ${JSON.stringify(ch)}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new GqlSyntaxError('unexpected end of document');
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new GqlSyntaxError(`expected ${token}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, SelectionNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, SelectionNode[]>();
    while (this.pos < this.tokens.length) {
      const head = this.peek();
      if (head === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
      } else if (head === 'query' || head === 'mutation') {
        const type = this.next() as 'query' | 'mutation';
        if (this.peek() !== undefined && /^[_A-Za-z]/.test(this.peek() as string) && this.peek() !== '(' && this.peek() !== '{') this.next();
        if (this.peek() === '(') this.skipBalanced();
        if (this.peek() === '@') this.skipDirective();
        operations.push({ type, selection: this.parseSelectionSet() });
      } else if (head === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        this.next(); // type condition
        if (this.peek() === '@') this.skipDirective();
        fragments.set(name, this.parseSelectionSet());
      } else if (head === 'schema' || head === 'scalar' || head === 'type' || head === 'extend') {
        throw new GqlSyntaxError('definitions are not supported');
      } else {
        throw new GqlSyntaxError(`unexpected token ${head}`);
      }
    }
    return { operations, fragments };
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token === '(' || token === '[' || token === '{') depth += 1;
      if (token === ')' || token === ']' || token === '}') depth -= 1;
    } while (depth > 0);
  }

  private skipDirective(): void {
    this.expect('@');
    this.next();
    if (this.peek() === '(') this.skipBalanced();
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const selections: SelectionNode[] = [];
    while (this.peek() !== '}') {
      if (this.peek() === '...') {
        this.next();
        if (this.peek() === 'on') {
          this.next();
          const typeCondition = this.next();
          if (this.peek() === '@') this.skipDirective();
          selections.push({ kind: 'fragment', typeCondition, selection: this.parseSelectionSet() });
        } else {
          // Named fragment spread: resolved by the executor through the fragment map marker.
          const name = this.next();
          selections.push({ kind: 'fragment', typeCondition: `:${name}`, selection: [] });
        }
      } else {
        selections.push({ kind: 'field', field: this.parseField() });
      }
    }
    this.expect('}');
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expect(')');
    }
    while (this.peek() === '@') this.skipDirective();
    const selection = this.peek() === '{' ? this.parseSelectionSet() : null;
    return { alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token.startsWith('"')) return { kind: 'string', value: token.slice(1, -1) };
    if (token === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true' || token === 'false') return { kind: 'boolean', value: token === 'true' };
    if (token === 'null') return { kind: 'null' };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number(token) };
    if (/^-?\d*(\.\d+)?([eE][+-]?\d+)?$/.test(token)) return { kind: 'float', value: Number(token) };
    return { kind: 'enum', value: token };
  }
}

function resolveValue(value: Value, variables: Variables): unknown {
  switch (value.kind) {
    case 'variable':
      return variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((entry) => resolveValue(entry, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- schema metadata (introspection)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: [
    'createIssue',
    'closeIssue',
    'createPullRequest',
    'mergePullRequest',
    'addComment',
  ],
  User: ['login', 'id', 'name'],
  Repository: [
    'id',
    'databaseId',
    'name',
    'nameWithOwner',
    'owner',
    'defaultBranchRef',
    'viewerPermission',
    'hasIssuesEnabled',
    'issue',
    'issues',
    'pullRequest',
    'pullRequests',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  Ref: ['name'],
  IssueComment: ['id', 'body'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  IssueCommentEdge: ['node'],
  SearchType: [],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  MergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
};

const OBJECT_KINDS: Record<string, string> = { SearchType: 'ENUM' };

// ---------------------------------------------------------------- execution

interface Ctx {
  forge: Forge;
  variables: Variables;
  fragments: Map<string, SelectionNode[]>;
  errors: { message: string }[];
}

type Source =
  | { __typename: 'Viewer' }
  | { __typename: 'Repository'; repo: Repo }
  | { __typename: 'Issue'; repo: Repo; issue: IssueRec }
  | { __typename: 'PullRequest'; repo: Repo; pull: PullRec }
  | { __typename: 'Ref'; name: string }
  | { __typename: 'IssueComment'; id: string; body: string }
  | { __typename: 'Generic'; type: string; fields: Record<string, unknown> };

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string' || after === '') return -1;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(decoded);
    return match ? Number(match[1]) : -1;
  } catch {
    return -1;
  }
}

interface ConnectionItem {
  source: Source;
  cursorIndex: number;
}

function connection(items: ConnectionItem[], args: Record<string, unknown>): Record<string, unknown> {
  const first = typeof args.first === 'number' ? (args.first as number) : items.length;
  const start = indexOfCursor(args.after) + 1;
  const page = items.slice(start, start + first);
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length ? cursorOf(page[page.length - 1].cursorIndex) : null;
  return {
    __conn: true,
    nodes: page.map((item) => item.source),
    pageInfo: {
      __typename: 'PageInfo',
      fields: {
        hasNextPage,
        hasPreviousPage: start > 0,
        startCursor: page.length ? cursorOf(page[0].cursorIndex) : null,
        endCursor,
      },
    },
    totalCount: items.length,
  };
}

function issueItems(repo: Repo, args: Record<string, unknown>): ConnectionItem[] {
  let issues = [...repo.issues.values()];
  const states = args.states;
  if (Array.isArray(states) && states.length) {
    const wanted = new Set(states.map((state) => String(state).toLowerCase()));
    issues = issues.filter((issue) => wanted.has(issue.state));
  }
  const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
  const direction = String(orderBy.direction ?? 'ASC').toUpperCase();
  issues.sort((a, b) => (direction === 'DESC' ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
  return issues.map((issue, index) => ({ source: { __typename: 'Issue', repo, issue } as Source, cursorIndex: index }));
}

function pullItems(repo: Repo): ConnectionItem[] {
  const pulls = [...repo.pulls.values()].sort((a, b) => a.seq - b.seq || a.number - b.number);
  return pulls.map((pull, index) => ({ source: { __typename: 'PullRequest', repo, pull } as Source, cursorIndex: index }));
}

function pullState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function resolveField(ctx: Ctx, typeName: string, source: Source | null, field: FieldNode): unknown {
  const args: Record<string, unknown> = {};
  for (const arg of field.args) args[arg.name] = resolveValue(arg.value, ctx.variables);
  const name = field.name;

  if (name === '__typename') return source?.__typename ?? typeName;
  if (name === '__type') {
    const typeArg = String(args.name ?? '');
    return { __typename: '__Type', fields: { __name: typeArg } } as unknown as Source;
  }
  if (name === '__schema') return { __typename: '__Schema', fields: {} } as unknown as Source;

  switch (typeName) {
    case 'Query': {
      if (name === 'viewer') return { __typename: 'Viewer' } as Source;
      if (name === 'repository') {
        if (String(args.owner ?? '') !== VIEWER_LOGIN) return null;
        const repo = ctx.forge.getRepo(String(args.name ?? ''));
        return repo ? ({ __typename: 'Repository', repo } as Source) : null;
      }
      if (name === 'node') return nodeById(ctx, String(args.id ?? ''));
      break;
    }
    case 'Mutation':
      return runMutation(ctx, name, args);
    case 'Viewer': {
      if (name === 'login') return VIEWER_LOGIN;
      if (name === 'id') return globalId('User', String(VIEWER_ID));
      if (name === 'name') return 'ada iversen';
      break;
    }
    case 'Repository': {
      const repo = (source as { repo: Repo }).repo;
      switch (name) {
        case 'id':
          return repoGlobalId(repo);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${VIEWER_LOGIN}/${repo.name}`;
        case 'owner':
          return { __typename: 'Viewer' } as Source;
        case 'defaultBranchRef': {
          const tip = repo.branchTip(repo.defaultBranch);
          return tip ? ({ __typename: 'Ref', name: repo.defaultBranch } as Source) : null;
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue ? ({ __typename: 'Issue', repo, issue } as Source) : null;
        }
        case 'issues':
          return connection(issueItems(repo, args), args);
        case 'pullRequest': {
          const pull = repo.pulls.get(Number(args.number));
          return pull ? ({ __typename: 'PullRequest', repo, pull } as Source) : null;
        }
        case 'pullRequests':
          return connection(pullItems(repo), args);
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: Repo; issue: IssueRec };
      switch (name) {
        case 'id':
          return issueGlobalId(repo, issue);
        case 'number':
          return issue.number;
        case 'title':
          return issue.title;
        case 'state':
          return issue.state.toUpperCase();
        case 'body':
          return issue.body;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: Repo; pull: PullRec };
      switch (name) {
        case 'id':
          return pullGlobalId(repo, pull);
        case 'number':
          return pull.number;
        case 'title':
          return pull.title;
        case 'body':
          return pull.body;
        case 'state':
          return pullState(pull);
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const plan = planPullMerge(repo, pull);
          return plan.conflict ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const mergeBase = repo.mergeBase(repo.branchTip(pull.base) ?? '', repo.branchTip(pull.head) ?? '');
          const headTip = repo.branchTip(pull.head);
          const files =
            mergeBase !== null && headTip
              ? diffCommits(repo, mergeBase, headTip).map((change) => ({
                  __typename: 'PullRequestChangedFile',
                  fields: { path: change.filename },
                }))
              : [];
          return connection(
            files.map((fileSource, index) => ({ source: fileSource as unknown as Source, cursorIndex: index })),
            args,
          );
        }
      }
      break;
    }
    case 'Ref': {
      if (name === 'name') return (source as { name: string }).name;
      break;
    }
    case 'IssueComment': {
      const comment = source as unknown as { id: string; body: string };
      if (name === 'id') return comment.id;
      if (name === 'body') return comment.body;
      break;
    }
    case '__Type': {
      const typeMeta = (source as unknown as { fields: { __name: string } }).fields;
      const typeNameArg = typeMeta.__name;
      if (name === 'name') return TYPE_FIELDS[typeNameArg] || ENUM_VALUES[typeNameArg] ? typeNameArg : null;
      if (name === 'kind') return OBJECT_KINDS[typeNameArg] ?? 'OBJECT';
      if (name === 'fields') {
        return (TYPE_FIELDS[typeNameArg] ?? []).map((fieldName) => ({
          __typename: '__Field',
          fields: { name: fieldName },
        }));
      }
      if (name === 'enumValues') {
        return (ENUM_VALUES[typeNameArg] ?? []).map((value) => ({
          __typename: '__EnumValue',
          fields: { name: value },
        }));
      }
      if (name === 'possibleTypes') return [];
      if (name === 'inputFields') return [];
      if (name === 'description') return null;
      break;
    }
    case '__Field':
    case '__EnumValue': {
      const generic = source as unknown as { fields: Record<string, unknown> };
      if (name === 'name') return generic.fields.name ?? null;
      return null;
    }
    case '__Schema': {
      if (name === 'queryType') return { __typename: '__Type', fields: { __name: 'Query' } } as unknown as Source;
      if (name === 'mutationType') return { __typename: '__Type', fields: { __name: 'Mutation' } } as unknown as Source;
      if (name === 'types') return [];
      if (name === 'directives') return [];
      break;
    }
    default: {
      // Payload objects and connections carry their fields in a bag.
      const generic = source as unknown as { fields?: Record<string, unknown>; __conn?: boolean } | null;
      if (generic && typeof generic === 'object') {
        if (generic.__conn) {
          if (name === 'nodes') return (generic as unknown as { nodes: unknown }).nodes;
          if (name === 'pageInfo') return (generic as unknown as { pageInfo: unknown }).pageInfo;
          if (name === 'totalCount') return (generic as unknown as { totalCount: unknown }).totalCount;
          if (name === 'edges') return [];
        }
        if (generic.fields && name in generic.fields) return generic.fields[name];
      }
      break;
    }
  }

  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${typeName}'` });
  return null;
}

function nodeById(ctx: Ctx, id: string): Source | null {
  const parsed = parseGlobalId(id);
  if (!parsed) return null;
  if (parsed.type === 'Repository') {
    for (const repo of ctx.forge.repos.values()) {
      if (repo.id === Number(parsed.rest)) return { __typename: 'Repository', repo };
    }
    return null;
  }
  if (parsed.type === 'Issue' || parsed.type === 'PullRequest') {
    const [repoId, number] = parsed.rest.split(':').map(Number);
    for (const repo of ctx.forge.repos.values()) {
      if (repo.id !== repoId) continue;
      if (parsed.type === 'Issue') {
        const issue = repo.issues.get(number);
        return issue ? { __typename: 'Issue', repo, issue } : null;
      }
      const pull = repo.pulls.get(number);
      return pull ? { __typename: 'PullRequest', repo, pull } : null;
    }
  }
  return null;
}

function findRepoByGlobalId(ctx: Ctx, id: string): Repo | null {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.type !== 'Repository') return null;
  for (const repo of ctx.forge.repos.values()) if (repo.id === Number(parsed.rest)) return repo;
  return null;
}

function runMutation(ctx: Ctx, name: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const payload = (type: string, fields: Record<string, unknown>): Source =>
    ({ __typename: type, fields } as unknown as Source);
  switch (name) {
    case 'createIssue': {
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: IssueRec = {
        number,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        state: 'open',
        labels: [],
        comments: [],
        seq: repo.nextSeq(),
      };
      repo.issues.set(number, issue);
      return payload('CreateIssuePayload', { issue: { __typename: 'Issue', repo, issue } as Source });
    }
    case 'closeIssue': {
      const parsed = parseGlobalId(String(input.issueId ?? ''));
      if (!parsed) throw new Error('issue not found');
      const [repoId, number] = parsed.rest.split(':').map(Number);
      for (const repo of ctx.forge.repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.get(number);
        if (!issue) throw new Error('issue not found');
        issue.state = 'closed';
        return payload('CloseIssuePayload', { issue: { __typename: 'Issue', repo, issue } as Source });
      }
      throw new Error('issue not found');
    }
    case 'createPullRequest': {
      const repo = findRepoByGlobalId(ctx, String(input.repositoryId ?? ''));
      if (!repo) throw new Error('repository not found');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pull: PullRec = {
        number,
        title: String(input.title ?? ''),
        body: typeof input.body === 'string' ? input.body : '',
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
        state: 'open',
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
        seq: repo.nextSeq(),
      };
      repo.pulls.set(number, pull);
      return payload('CreatePullRequestPayload', { pullRequest: { __typename: 'PullRequest', repo, pull } as Source });
    }
    case 'mergePullRequest': {
      const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
      if (!parsed) throw new Error('pull request not found');
      const [repoId, number] = parsed.rest.split(':').map(Number);
      for (const repo of ctx.forge.repos.values()) {
        if (repo.id !== repoId) continue;
        const pull = repo.pulls.get(number);
        if (!pull) throw new Error('pull request not found');
        if (pull.merged) return payload('MergePullRequestPayload', { pullRequest: { __typename: 'PullRequest', repo, pull } as Source });
        const plan = planPullMerge(repo, pull);
        if (plan.conflict || plan.tree === null || plan.baseTip === null) throw new Error('Pull Request is not mergeable');
        const sha = repo.makeCommit(ctx.forge, plan.tree, [plan.baseTip], `${pull.title} (#${pull.number})`);
        repo.refs.set(`refs/heads/${pull.base}`, sha);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeCommitSha = sha;
        pull.mergedAt = new Date(ctx.forge.nextTimestamp() * 1000).toISOString();
        return payload('MergePullRequestPayload', { pullRequest: { __typename: 'PullRequest', repo, pull } as Source });
      }
      throw new Error('pull request not found');
    }
    case 'addComment': {
      const parsed = parseGlobalId(String(input.subjectId ?? ''));
      if (!parsed) throw new Error('subject not found');
      const [repoId, number] = parsed.rest.split(':').map(Number);
      for (const repo of ctx.forge.repos.values()) {
        if (repo.id !== repoId) continue;
        const issue = repo.issues.get(number);
        const pull = repo.pulls.get(number);
        if (!issue && !pull) throw new Error('subject not found');
        const comment: IssueRec['comments'][number] = { id: ctx.forge.allocCommentId(), body: String(input.body ?? '') };
        if (issue) issue.comments.push(comment);
        const node: Source = {
          __typename: 'IssueComment',
          id: commentGlobalId(repo, number, comment.id),
          body: comment.body,
        } as Source;
        return payload('AddCommentPayload', {
          commentEdge: { __typename: 'IssueCommentEdge', fields: { node } } as unknown as Source,
        });
      }
      throw new Error('subject not found');
    }
  }
  ctx.errors.push({ message: `Field '${name}' doesn't exist on type 'Mutation'` });
  return null;
}

function typeNameOf(source: Source | null, fallback: string): string {
  if (source && typeof source === 'object' && '__typename' in source) return String((source as { __typename: string }).__typename);
  return fallback;
}

function applySelection(
  ctx: Ctx,
  typeName: string,
  source: Source | null,
  selections: SelectionNode[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition.startsWith(':')) {
        const fragment = ctx.fragments.get(selection.typeCondition.slice(1));
        if (fragment) Object.assign(out, applySelection(ctx, typeName, source, fragment));
        continue;
      }
      if (source === null) continue;
      if (typeNameOf(source, typeName) !== selection.typeCondition && typeName !== selection.typeCondition) continue;
      Object.assign(out, applySelection(ctx, selection.typeCondition, source, selection.selection));
      continue;
    }
    const field = selection.field;
    const key = field.alias ?? field.name;
    let value: unknown;
    try {
      value = resolveField(ctx, typeName, source, field);
    } catch (error) {
      ctx.errors.push({ message: error instanceof Error ? error.message : String(error) });
      value = null;
    }
    if (field.selection && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        value = value.map((item) =>
          item && typeof item === 'object' ? applySelection(ctx, typeNameOf(item as Source, ''), item as Source, field.selection as SelectionNode[]) : item,
        );
      } else if (typeof value === 'object') {
        value = applySelection(ctx, typeNameOf(value as Source, ''), value as Source, field.selection);
      }
    }
    out[key] = value === undefined ? null : value;
  }
  return out;
}

export interface GraphqlRequest {
  query: string;
  variables?: Variables;
  operationName?: string;
}

export function executeGraphql(forge: Forge, request: GraphqlRequest): { status: number; body: unknown } {
  let parsed: { operations: Operation[]; fragments: Map<string, SelectionNode[]> };
  try {
    parsed = new Parser(request.query).parseDocument();
  } catch (error) {
    return { status: 400, body: { errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
  }
  const operation = parsed.operations[0];
  if (!operation) return { status: 400, body: { errors: [{ message: 'no operation in document' }] } };
  const ctx: Ctx = { forge, variables: request.variables ?? {}, fragments: parsed.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = applySelection(ctx, rootType, null, operation.selection);
  const body: Record<string, unknown> = { data };
  if (ctx.errors.length) body.errors = ctx.errors;
  return { status: 200, body };
}
