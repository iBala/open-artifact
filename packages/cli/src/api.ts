/**
 * Talking to an Open Artifact server.
 *
 * Every server error is turned into a CliError with a stable name here, in one
 * place, so no command has to know what an HTTP status means.
 */

import { CliError, notAuthenticated } from './errors.js';

export interface ApiClientOptions {
  baseUrl: string;
  token?: string | undefined;
  /** Swapped out in tests. */
  fetchImpl?: typeof fetch;
}

interface ServerError {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

export class ApiClient {
  readonly baseUrl: string;
  private readonly token: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor({ baseUrl, token, fetchImpl = fetch }: ApiClientOptions) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = token;
    this.fetchImpl = fetchImpl;
  }

  async request<T>(
    path: string,
    init: RequestInit & { expectNoContent?: boolean } = {},
  ): Promise<T> {
    const { expectNoContent, ...requestInit } = init;

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        ...requestInit,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(requestInit.body ? { 'Content-Type': 'application/json' } : {}),
          ...(requestInit.headers ?? {}),
        },
      });
    } catch (cause) {
      throw new CliError(
        'unreachable',
        `Could not reach ${this.baseUrl}.`,
        {
          hint: 'Check the address, and that the instance is running.',
          details: { cause: cause instanceof Error ? cause.message : String(cause) },
        },
      );
    }

    if (response.ok) {
      if (expectNoContent || response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }

    throw await this.toCliError(response);
  }

  private async toCliError(response: Response): Promise<CliError> {
    let body: ServerError = {};
    try {
      body = (await response.json()) as ServerError;
    } catch {
      // Not every failure has a JSON body: a proxy in front of the instance
      // might return HTML. The status still tells us enough.
    }

    const code = body.error?.code;
    const message = body.error?.message ?? `The server returned ${response.status}.`;
    const details = body.error?.details;

    switch (code) {
      case 'unauthenticated':
        return notAuthenticated(this.baseUrl);
      case 'not_found':
      case 'forbidden':
        return new CliError('noAccess', message);
      case 'unsupported_type':
        return new CliError('unsupportedType', message);
      case 'payload_too_large':
        return new CliError('tooLarge', message, details ? { details } : {});
      case 'version_conflict':
        return new CliError('conflict', message, {
          hint: 'Read the artifact again and re-apply your change.',
          ...(details ? { details } : {}),
        });
      default:
        break;
    }

    // No recognised code: fall back to what the status means.
    if (response.status === 401) return notAuthenticated(this.baseUrl);
    if (response.status === 404 || response.status === 403) {
      return new CliError('noAccess', message);
    }
    return new CliError('serverError', message, details ? { details } : {});
  }
}
