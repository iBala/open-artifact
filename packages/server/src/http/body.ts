/**
 * Reading a JSON request body without trusting how big it is.
 *
 * The artifact size check runs on parsed content, which is too late to protect
 * the process: by the time it runs, whatever was sent is already in memory. In
 * production a reverse proxy usually refuses a huge body first, but relying on
 * that means the application is only safe when somebody else configured it
 * correctly. This is the application's own guard.
 *
 * Two checks, because either alone is easy to walk past:
 *
 * 1. A declared length over the cap is refused on the strength of the claim. No
 *    reading at all.
 * 2. A body with no declared length, or a lying one, is read in chunks and
 *    abandoned the moment it goes over.
 */

import { ApiError } from '../errors.js';

/**
 * How much room JSON framing and the other fields get on top of the content.
 *
 * A publish is roughly `{"type":"markdown","content":"..."}`, so the body is the
 * content plus a title, plus escaping, which can double the size of content that
 * is mostly quotes and newlines. Generous on purpose: this cap is here to stop a
 * gigabyte, not to second-guess the size check that follows it.
 */
const FRAMING_HEADROOM_BYTES = 64 * 1024;

export function jsonBodyCap(maxArtifactBytes: number): number {
  return maxArtifactBytes * 2 + FRAMING_HEADROOM_BYTES;
}

/**
 * Reads a JSON object, refusing anything over the cap with 413.
 *
 * Returns the parsed object. Anything that is not a JSON object — an array, a
 * bare string, malformed text — is a validation failure, the same as before.
 */
export async function readJsonObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const text = await readTextWithin(request, maxBytes);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ApiError('validation_failed', 'The request body must be JSON.');
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ApiError('validation_failed', 'The request body must be a JSON object.');
  }

  return parsed as Record<string, unknown>;
}

/**
 * Reads the whole body as text, refusing anything over the cap before it is
 * buffered. Exposed so the MCP route can share exactly this guard while parsing
 * the body itself as JSON-RPC rather than as a plain object.
 */
export async function readTextWithin(request: Request, maxBytes: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const length = Number(declared);
    if (Number.isFinite(length) && length > maxBytes) throw tooLarge(maxBytes);
  }

  const body = request.body;
  // No stream to read in chunks: some runtimes and most tests hand over a body
  // that is already a string. It is in memory either way, so measure and move on.
  if (!body) {
    const text = await request.text();
    if (byteLength(text) > maxBytes) throw tooLarge(maxBytes);
    return text;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      total += value.byteLength;
      if (total > maxBytes) {
        // Stop pulling. Whatever else the caller meant to send is not read.
        await reader.cancel().catch(() => undefined);
        throw tooLarge(maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return new TextDecoder().decode(concat(chunks, total));
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return joined;
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

function tooLarge(maxBytes: number): ApiError {
  return new ApiError(
    'payload_too_large',
    `That request body is larger than this instance accepts. The limit is ${Math.floor(maxBytes / 1024)} KB.`,
    { maxBytes },
  );
}
