/**
 * The error contract.
 *
 * Every failure the API returns has a stable machine-readable `code`. Agents and
 * the CLI branch on the code; the `message` is for humans and may be reworded.
 * Adding a code is fine; changing what an existing one means is a breaking change.
 *
 * Response shape: { "error": { "code": "...", "message": "...", "details": {...} } }
 */

export const ERROR_CODES = {
  /** No credentials, or credentials that are expired or revoked. */
  unauthenticated: 401,
  /** Authenticated, but not allowed to do this. Used only where hiding the
   *  resource would be more confusing than helpful; private artifacts return
   *  not_found instead, so nobody can probe for which ids exist. */
  forbidden: 403,
  /** No such thing, or you are not allowed to know it exists. */
  not_found: 404,
  /** It existed and was deleted. */
  gone: 410,
  /** The request body or parameters are wrong. */
  validation_failed: 400,
  /** The file is not Markdown or HTML. */
  unsupported_type: 400,
  /** The file is larger than this instance allows. */
  payload_too_large: 413,
  /** Someone else changed the artifact since the version you based this on. */
  version_conflict: 409,
  /** Too many requests. */
  rate_limited: 429,
  /** Something went wrong on the server. */
  internal_error: 500,
} as const;

export type ErrorCode = keyof typeof ERROR_CODES;

export class ApiError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = ERROR_CODES[code];
    this.details = details;
  }

  toResponseBody(): { error: { code: ErrorCode; message: string; details?: Record<string, unknown> } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** Shorthand for the case that comes up most: this does not exist, or you cannot see it. */
export function notFound(what = 'artifact'): ApiError {
  return new ApiError('not_found', `No such ${what}, or you do not have access to it.`);
}
