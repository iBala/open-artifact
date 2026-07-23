/**
 * The hosted MCP endpoint.
 *
 * `POST /mcp`, stateless streamable-HTTP JSON-RPC: no session id, no server-sent
 * events, no session table. Every request is complete on its own. `GET` and
 * `DELETE` answer 405.
 *
 * Identity comes purely from the `Authorization` header, checked with
 * `authenticateMcpToken`, which accepts only `mcp` tokens. This handler never
 * reads the request's attached user, so a session cookie can never authenticate
 * here — and the session middleware skips `/mcp` besides, as defence in depth.
 *
 * Two shapes of failure, kept apart on purpose:
 *   - Transport failures (bad origin, oversized body, unsupported protocol
 *     version, missing credentials) are HTTP-level: a status and a small body.
 *   - Everything a tool call can hit comes back as a JSON-RPC result, and tool
 *     errors as tool results, never protocol errors, so the model sees them.
 */

import type { Context, Hono } from 'hono';
import type { AppContext, AppEnv } from '../app.js';
import { ApiError } from '../../errors.js';
import { readTextWithin } from '../body.js';
import { addressOf } from '../rate-limit.js';
import {
  callMcpTool,
  listMcpTools,
  isMcpTool,
  MCP_CONTENT_CAP_BYTES,
  type McpToolContext,
} from '../../mcp/tools.js';

/**
 * The cap on a whole MCP request body, checked before the body is buffered.
 *
 * Above the content cap, not equal to it: a one-megabyte document escaped into
 * JSON can nearly double in size, and the content cap is the gate that reports a
 * runaway generation as a readable tool result. This cap sits above that to stop
 * a genuinely enormous body from ever being read into memory.
 */
const MCP_BODY_CAP_BYTES = MCP_CONTENT_CAP_BYTES * 2 + 64 * 1024;

/** Failed authentications per client address before the endpoint stops answering. */
const MCP_AUTH_FAILURE_LIMIT = { limit: 20, windowSeconds: 3600 };

/**
 * Protocol revisions this server speaks. The newest is what a fresh client is
 * answered with; older ones are still accepted, both in the `initialize` body and
 * in the `MCP-Protocol-Version` header on later requests.
 */
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'Open Artifact', version: '1' };

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function registerMcpRoutes(app: Hono<AppEnv>, context: AppContext): void {
  const { auth, rateLimiter } = context;

  // Only POST carries JSON-RPC. A browser hitting the URL, or a client trying the
  // SSE transport we do not offer, gets a clear 405 rather than a 404.
  app.on(['GET', 'DELETE'], '/mcp', (c) =>
    c.json(
      { error: { code: 'method_not_allowed', message: 'The MCP endpoint accepts POST only.' } },
      405,
    ),
  );

  app.post('/mcp', async (c) => {
    // DNS-rebinding defence: a browser page on another origin must not be able to
    // drive this endpoint. Checked only when an Origin is present; header-only
    // clients like Claude Code send none.
    const origin = c.req.header('origin');
    if (origin !== undefined && origin !== originOf(context.config.baseUrl)) {
      throw new ApiError('forbidden', 'This request came from an origin this endpoint does not accept.');
    }

    // Validate and echo the protocol version. A client that names one we do not
    // speak is told so rather than left to guess why a call was misread.
    const protocolVersion = negotiateHeaderVersion(c.req.header('mcp-protocol-version'));
    c.header('MCP-Protocol-Version', protocolVersion);

    const principal = authenticate(c, auth);
    if (!principal) {
      const retryAfter = rateLimiter.check('mcp-auth', addressOf(c), MCP_AUTH_FAILURE_LIMIT);
      if (retryAfter !== null) {
        return c.json(
          { error: { code: 'rate_limited', message: 'Too many failed attempts. Try again later.' } },
          429,
          { 'Retry-After': String(retryAfter) },
        );
      }
      // Point an OAuth-capable client at the protected-resource metadata, per
      // RFC 9728. A header-token client that sent a valid token never reaches
      // this branch, so it never sees the header and nothing changes for it.
      const resourceMetadata = `${context.config.baseUrl}/.well-known/oauth-protected-resource/mcp`;
      return c.json(
        {
          error: {
            code: 'unauthenticated',
            message: 'This endpoint needs a valid MCP token in the Authorization header.',
          },
        },
        401,
        { 'WWW-Authenticate': `Bearer resource_metadata="${resourceMetadata}"` },
      );
    }

    // Read within the cap before buffering. Oversized bodies never make it into
    // memory; this throws a 413 the same as the rest of the API.
    const raw = await readTextWithin(c.req.raw, MCP_BODY_CAP_BYTES);

    const message = parseEnvelope(raw);
    if (message.kind === 'invalid') {
      return c.json(rpcError(null, message.code, message.reason), 200);
    }
    // A notification carries no id and expects no reply: answer 202 with no body.
    if (message.kind === 'notification') {
      return c.body(null, 202);
    }

    const toolContext: McpToolContext = {
      artifacts: context.artifacts,
      sharing: context.sharing,
      comments: context.comments,
      notifications: context.notifications,
      mailer: context.mailer,
      rateLimiter,
      config: context.config,
      user: principal.user,
      connection: principal.connection,
    };

    const response = await dispatch(message.id, message.method, message.params, toolContext);
    return c.json(response, 200);
  });
}

// ---------------------------------------------------------------------------
// JSON-RPC dispatch
// ---------------------------------------------------------------------------

async function dispatch(
  id: JsonRpcId,
  method: string,
  params: Record<string, unknown>,
  ctx: McpToolContext,
): Promise<JsonRpcResponse> {
  switch (method) {
    case 'initialize':
      return rpcResult(id, {
        protocolVersion: negotiateBodyVersion(params),
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
      });

    case 'tools/list':
      return rpcResult(id, { tools: listMcpTools() });

    case 'tools/call': {
      const name = params.name;
      if (typeof name !== 'string') {
        return rpcErrorResponse(id, INVALID_PARAMS, 'tools/call needs a tool name.');
      }
      if (!isMcpTool(name)) {
        return rpcErrorResponse(id, INVALID_PARAMS, `No such tool: ${name}.`);
      }
      const args =
        params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments)
          ? (params.arguments as Record<string, unknown>)
          : {};
      try {
        const result = await callMcpTool(name, args, ctx);
        return rpcResult(id, result);
      } catch {
        // A real bug, not a tool-level failure: those come back as tool results.
        return rpcErrorResponse(id, INTERNAL_ERROR, 'The tool call could not be completed.');
      }
    }

    default:
      return rpcErrorResponse(id, METHOD_NOT_FOUND, `Unknown method: ${method}.`);
  }
}

// ---------------------------------------------------------------------------
// Envelope parsing
// ---------------------------------------------------------------------------

type ParsedEnvelope =
  | { kind: 'invalid'; code: number; reason: string }
  | { kind: 'notification' }
  | { kind: 'request'; id: JsonRpcId; method: string; params: Record<string, unknown> };

function parseEnvelope(raw: string): ParsedEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'invalid', code: PARSE_ERROR, reason: 'The request body is not valid JSON.' };
  }

  // Batching was removed from the MCP spec, so an array is never a valid envelope.
  if (Array.isArray(parsed)) {
    return { kind: 'invalid', code: INVALID_REQUEST, reason: 'Batch requests are not supported.' };
  }
  if (parsed === null || typeof parsed !== 'object') {
    return { kind: 'invalid', code: INVALID_REQUEST, reason: 'The request must be a JSON-RPC object.' };
  }

  const envelope = parsed as Record<string, unknown>;
  const method = envelope.method;
  if (typeof method !== 'string') {
    return { kind: 'invalid', code: INVALID_REQUEST, reason: 'The request needs a method.' };
  }

  // A JSON-RPC notification has no id and expects no response.
  if (!('id' in envelope) || envelope.id === undefined) {
    return { kind: 'notification' };
  }

  const params =
    envelope.params && typeof envelope.params === 'object' && !Array.isArray(envelope.params)
      ? (envelope.params as Record<string, unknown>)
      : {};

  return { kind: 'request', id: envelope.id as JsonRpcId, method, params };
}

// ---------------------------------------------------------------------------
// Protocol version negotiation
// ---------------------------------------------------------------------------

/** The version to echo, from the header. Throws 400 when it is one we do not speak. */
function negotiateHeaderVersion(header: string | undefined): string {
  if (header === undefined) return LATEST_PROTOCOL_VERSION;
  if (!SUPPORTED_PROTOCOL_VERSIONS.includes(header)) {
    throw new ApiError('validation_failed', `Unsupported MCP-Protocol-Version: "${header}".`);
  }
  return header;
}

/** The version to answer initialize with: the client's, if we speak it, else ours. */
function negotiateBodyVersion(params: Record<string, unknown>): string {
  const requested = params.protocolVersion;
  if (typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)) {
    return requested;
  }
  return LATEST_PROTOCOL_VERSION;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function authenticate(c: Context<AppEnv>, auth: AppContext['auth']) {
  const header = c.req.header('authorization');
  if (!header || !header.startsWith('Bearer ')) return null;
  return auth.authenticateMcpToken(header.slice('Bearer '.length).trim());
}

function originOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return baseUrl;
  }
}

type JsonRpcId = string | number | null;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string };
}

function rpcResult(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function rpcErrorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** For a malformed envelope, where there may be no usable id. */
function rpcError(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}
