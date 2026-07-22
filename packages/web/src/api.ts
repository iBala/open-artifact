/**
 * Talking to the server from the browser.
 *
 * The session lives in an HttpOnly cookie, so there is no token to carry here and
 * nothing for script on the page to leak. Every request just says "same origin,
 * send the cookie".
 */

export interface ApiFailure {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, failure: ApiFailure) {
    super(failure.message);
    this.name = 'ApiError';
    this.status = status;
    this.code = failure.code;
    this.details = failure.details;
  }

  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (response.status === 204) return undefined as T;

  if (!response.ok) {
    let failure: ApiFailure = { code: 'unknown', message: `Request failed (${response.status}).` };
    try {
      const body = (await response.json()) as { error?: ApiFailure };
      if (body.error) failure = body.error;
    } catch {
      // Not every failure carries a JSON body; a proxy in front of the instance
      // might not. The status is enough to say something useful.
    }
    throw new ApiError(response.status, failure);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// What the endpoints return
// ---------------------------------------------------------------------------

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
}

export interface SignInMethods {
  magicLink: boolean;
  google: boolean;
  signupMode: 'open' | 'invite-only' | 'domain-allowlist';
}

export interface ArtifactSummary {
  id: string;
  slug: string;
  ownerId: string;
  type: 'markdown' | 'html';
  title: string;
  version: number;
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionEntry {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  isCurrent: boolean;
}

export interface TokenEntry {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export const endpoints = {
  me: () => api<CurrentUser>('/api/auth/me'),
  signInMethods: () => api<SignInMethods>('/api/auth/methods'),
  requestMagicLink: (email: string, redirectTo: string | null) =>
    api<{ sent: boolean; message: string }>('/api/auth/magic-link', {
      method: 'POST',
      body: JSON.stringify({ email, redirectTo }),
    }),
  signOut: () => api<{ signedOut: boolean }>('/api/auth/sign-out', { method: 'POST' }),
  myArtifacts: () => api<{ artifacts: ArtifactSummary[] }>('/api/artifacts'),
  sessions: () => api<{ sessions: SessionEntry[]; tokens: TokenEntry[] }>('/api/auth/sessions'),
  revokeSession: (id: string) => api<void>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeToken: (id: string) => api<void>(`/api/auth/tokens/${id}`, { method: 'DELETE' }),
};
