// app.ts: the HTTP surface of the forge.
//
// One server, four surfaces, one store:
//   /api/v3/...        the REST API (rest.ts)
//   /api/graphql       GraphQL (graphql.ts)
//   /mcp               MCP over Streamable HTTP JSON-RPC (mcp.ts)
//   /{owner}/{repo}.git/...   git smart HTTP (git.ts)
//
// Every surface requires `Authorization: Bearer $MAKEFUN_SHOP_TOKEN` except /healthz. Every reply
// is JSON (never an HTML error page) and carries a non-empty X-GitHub-Request-Id. Malformed JSON
// is a 400 with a JSON {message}; unknown routes are a 404 with a JSON {message}.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { Forge, VIEWER_LOGIN } from './store.ts';
import { handleRest } from './rest.ts';
import { executeGraphql, type GraphqlRequest } from './graphql.ts';
import { handleMcpMessage } from './mcp.ts';
import { advertiseRefs, handleReceivePack, handleUploadPack } from './git.ts';

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

export function createApp(): Server {
  const forge = new Forge();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  let requestCounter = 0;

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
    response.setHeader('x-github-request-id', requestId);
    handle(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({ message: 'Internal Server Error' }));
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const authorized = token !== '' && request.headers.authorization === `Bearer ${token}`;

    const sendJson = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): void => {
      const text = body === undefined ? '' : JSON.stringify(body);
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...extraHeaders });
      response.end(text);
    };
    const unauthorized = (): void => sendJson(401, { message: 'Bad credentials' });
    const notFound = (): void => sendJson(404, { message: 'Not Found' });

    if (path === '/healthz') {
      sendJson(200, { ok: true });
      return;
    }

    // MCP: the parse-error answer is owed even before auth is judged, so parse first.
    if (path === '/mcp') {
      if (method !== 'POST') {
        sendJson(405, { jsonrpc: '2.0', id: null, error: { code: -32601, message: 'Method not allowed' } });
        return;
      }
      const raw = (await readBody(request)).toString('utf8');
      let message: unknown;
      try {
        message = JSON.parse(raw);
      } catch {
        sendJson(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (!authorized) {
        unauthorized();
        return;
      }
      const result = handleMcpMessage(forge, message);
      if (result.body === null) {
        response.writeHead(result.status, { 'content-type': 'application/json' });
        response.end();
        return;
      }
      response.writeHead(result.status, { 'content-type': 'application/json' });
      response.end(result.body);
      return;
    }

    // GraphQL.
    if (path === '/api/graphql') {
      if (!authorized) {
        unauthorized();
        return;
      }
      if (method !== 'POST') {
        sendJson(405, { errors: [{ message: 'Method not allowed' }] });
        return;
      }
      const raw = (await readBody(request)).toString('utf8');
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        sendJson(400, { errors: [{ message: 'Problems parsing JSON' }] });
        return;
      }
      if (Array.isArray(parsed)) {
        const results = parsed.map((entry) => {
          const outcome = executeGraphql(forge, entry as GraphqlRequest);
          return outcome.body;
        });
        sendJson(200, results);
        return;
      }
      const outcome = executeGraphql(forge, (parsed ?? {}) as GraphqlRequest);
      sendJson(outcome.status, outcome.body);
      return;
    }

    // REST.
    if (path === '/api/v3' || path.startsWith('/api/v3/')) {
      if (!authorized) {
        unauthorized();
        return;
      }
      const subPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
      let body: Record<string, unknown> = {};
      if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
        const raw = await readBody(request);
        if (raw.length > 0) {
          try {
            const parsedBody: unknown = JSON.parse(raw.toString('utf8'));
            if (parsedBody && typeof parsedBody === 'object' && !Array.isArray(parsedBody)) {
              body = parsedBody as Record<string, unknown>;
            }
          } catch {
            sendJson(400, { message: 'Problems parsing JSON' });
            return;
          }
        }
      }
      const host = request.headers.host ?? 'localhost';
      const result = handleRest({
        forge,
        method,
        segments: [],
        query: url.searchParams,
        body,
        origin: `http://${host}`,
        path: subPath,
      });
      if (result.status === 204) {
        response.writeHead(204, result.headers ?? {});
        response.end();
        return;
      }
      sendJson(result.status, result.body, result.headers);
      return;
    }

    // Git smart HTTP: /{owner}/{repo}.git/{info/refs|git-upload-pack|git-receive-pack}
    const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(path);
    if (gitMatch) {
      if (!authorized) {
        unauthorized();
        return;
      }
      const [, owner, repoName, tail] = gitMatch;
      const repo = owner === VIEWER_LOGIN ? forge.getRepo(decodeURIComponent(repoName)) : undefined;
      if (!repo) {
        notFound();
        return;
      }
      try {
        if (tail === 'info/refs' && method === 'GET') {
          const service = url.searchParams.get('service');
          if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
            sendJson(400, { message: 'Missing or unknown service' });
            return;
          }
          const protocolHeader = request.headers['git-protocol'];
          const v2 = typeof protocolHeader === 'string' && protocolHeader.split(':').includes('version=2');
          const result = advertiseRefs(repo, service, v2);
          response.writeHead(result.status, {
            'content-type': result.contentType,
            'cache-control': 'no-cache, max-age=0, must-revalidate',
            expires: 'Fri, 01 Jan 1980 00:00:00 GMT',
            pragma: 'no-cache',
          });
          response.end(result.body);
          return;
        }
        if (tail === 'git-upload-pack' && method === 'POST') {
          const body = await readBody(request);
          const result = handleUploadPack(repo, body);
          response.writeHead(result.status, { 'content-type': result.contentType });
          response.end(result.body);
          return;
        }
        if (tail === 'git-receive-pack' && method === 'POST') {
          const body = await readBody(request);
          const result = handleReceivePack(repo, body);
          response.writeHead(result.status, { 'content-type': result.contentType });
          response.end(result.body);
          return;
        }
      } catch {
        // A malformed git request is a 400; the server and the repository stay healthy.
        sendJson(400, { message: 'Bad Request' });
        return;
      }
      notFound();
      return;
    }

    notFound();
  }

  return server;
}
