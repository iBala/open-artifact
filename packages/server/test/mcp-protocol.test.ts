import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  jsonBody,
  signIn,
  signInCodeFor,
  type TestServer,
  type SignedInUser,
} from './helpers/server.js';

/**
 * The MCP endpoint as a JSON-RPC transport, before any tool runs.
 *
 * These are the guarantees a connector depends on: the handshake, the framing,
 * the header echo, and the ways in that must be refused — a session cookie, a CLI
 * token, another origin, an oversized body.
 */

let server: TestServer;
let owner: SignedInUser;
let token: string;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  token = await connect(owner);
});

afterEach(() => {
  server.close();
});

async function connect(user: SignedInUser, label = 'Claude on the web'): Promise<string> {
  const response = await user.as('/api/auth/mcp-tokens', jsonBody({ label }));
  if (response.status !== 201) throw new Error(`could not connect: ${await response.text()}`);
  return ((await response.json()) as { token: string }).token;
}

interface RpcResult {
  status: number;
  headers: Headers;
  body: Record<string, unknown> | null;
}

async function post(
  bearer: string | null,
  body: string,
  extraHeaders: Record<string, string> = {},
): Promise<RpcResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  const response = await server.request('/mcp', { method: 'POST', headers, body });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : null,
  };
}

function rpc(bearer: string | null, message: unknown, headers?: Record<string, string>) {
  return post(bearer, JSON.stringify(message), headers);
}

describe('the handshake', () => {
  it('answers initialize with the latest protocol version and the tools capability', async () => {
    const { body } = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });

    const result = body?.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: {} });
    expect((result.serverInfo as { name: string }).name).toBe('Open Artifact');
  });

  it('meets an older client on a version they both speak', async () => {
    const { body } = await rpc(token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-03-26' },
    });
    expect((body?.result as { protocolVersion: string }).protocolVersion).toBe('2025-03-26');
  });

  it('lists exactly the eight tools, and only those', async () => {
    const { body } = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const names = ((body?.result as { tools: { name: string }[] }).tools).map((tool) => tool.name);

    expect(names).toEqual([
      'publish_artifact',
      'update_artifact',
      'get_artifact',
      'list_artifacts',
      'share_artifact',
      'list_comments',
      'reply_to_comment',
      'resolve_comment_thread',
    ]);
  });
});

describe('JSON-RPC framing', () => {
  it('refuses an unknown method with a method-not-found error', async () => {
    const { body } = await rpc(token, { jsonrpc: '2.0', id: 1, method: 'tools/teleport', params: {} });
    expect((body?.error as { code: number }).code).toBe(-32601);
  });

  it('refuses a malformed body with a parse error', async () => {
    const { body } = await post(token, '{ not json');
    expect((body?.error as { code: number }).code).toBe(-32700);
  });

  it('refuses an array envelope, because batching was removed from the spec', async () => {
    const { body } = await post(token, JSON.stringify([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]));
    expect((body?.error as { code: number }).code).toBe(-32600);
  });

  it('acknowledges a notification with 202 and no body', async () => {
    const response = await rpc(token, { jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });
});

describe('the protocol version header', () => {
  it('echoes a supported version back on the response', async () => {
    const response = await rpc(
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'MCP-Protocol-Version': '2025-03-26' },
    );
    expect(response.headers.get('MCP-Protocol-Version')).toBe('2025-03-26');
  });

  it('refuses a version it does not speak', async () => {
    const response = await rpc(
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { 'MCP-Protocol-Version': '1999-01-01' },
    );
    expect(response.status).toBe(400);
  });
});

describe('methods other than POST', () => {
  it('answers GET with 405', async () => {
    expect((await server.request('/mcp', { method: 'GET' })).status).toBe(405);
  });
  it('answers DELETE with 405', async () => {
    expect((await server.request('/mcp', { method: 'DELETE' })).status).toBe(405);
  });
});

describe('who is refused at the door', () => {
  it('refuses a session cookie on its own', async () => {
    const response = await server.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: owner.sessionCookie },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(401);
  });

  it('refuses a CLI token', async () => {
    await server.request('/api/auth/code', jsonBody({ email: 'owner@example.com' }));
    const cli = (await (
      await server.request(
        '/api/auth/cli-token',
        jsonBody({ email: 'owner@example.com', code: signInCodeFor(server, 'owner@example.com'), label: 'cli' }),
      )
    ).json()) as { token: string };

    const { status } = await rpc(cli.token, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(status).toBe(401);
  });

  it('refuses a request with no credential at all', async () => {
    const { status } = await rpc(null, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    expect(status).toBe(401);
  });

  it('refuses a request from another origin', async () => {
    const response = await rpc(
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Origin: 'https://evil.example' },
    );
    expect(response.status).toBe(403);
  });

  it('accepts a request from its own origin', async () => {
    const response = await rpc(
      token,
      { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      { Origin: 'https://artifacts.test' },
    );
    expect(response.status).toBe(200);
  });

  it('refuses an oversized body before buffering it', async () => {
    // Over the whole-body cap, which sits above the content cap on purpose.
    const huge = 'x'.repeat(2_300_000);
    const { status } = await post(token, JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { note: huge } }));
    expect(status).toBe(413);
  });
});
