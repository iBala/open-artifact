/**
 * Talking to the server from the browser.
 *
 * The session lives in an HttpOnly cookie, so there is no token to carry here
 * and nothing on the page for script to leak. Every request just says "same
 * origin, send the cookie".
 *
 * The response shapes come from @open-artifact/shared, which the server imports
 * too, so the app and the server cannot drift apart without the compiler saying
 * so.
 */

import type {
  CommentThread,
  Comment,
  ThreadStatus,
  CurrentUser,
  SignInMethods,
  ArtifactSummary,
  SessionsResponse,
} from '@open-artifact/shared';

export type {
  CommentThread,
  Comment,
  CommentAnchor,
  ThreadStatus,
  CurrentUser,
  SignInMethods,
  ArtifactSummary,
  ArtifactDetail,
  SessionEntry,
  ApiTokenEntry as TokenEntry,
  SessionsResponse,
} from '@open-artifact/shared';

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

  get isNotFound(): boolean {
    return this.status === 404;
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
      // might not. The status alone still says something useful.
    }
    throw new ApiError(response.status, failure);
  }

  return (await response.json()) as T;
}

// ---------------------------------------------------------------------------
// Shapes specific to this app
// ---------------------------------------------------------------------------

/** An artifact somebody else shared, with enough about them to say who. */
export interface SharedArtifact extends ArtifactSummary {
  ownerName: string | null;
  ownerEmail: string | null;
  /**
   * What this reader may do. Only present on the by-slug response, which is the
   * one the viewer loads.
   */
  youMay?: { comment: boolean; manage: boolean };
}

export interface PersonShare {
  id: string;
  email: string;
  /** True until that person has signed in with this address. */
  pending: boolean;
  createdAt: string;
}

export interface NotificationView {
  id: string;
  type: 'share' | 'mention' | 'reply' | 'access-request';
  createdAt: string;
  read: boolean;
  actor: { email: string; displayName: string | null } | null;
  artifact: { id: string; slug: string; title: string } | null;
  threadId: string | null;
  /** A short line of what happened, written by the server. */
  summary: string;
}

export interface AccessRequest {
  id: string;
  artifactId: string;
  artifactTitle: string;
  email: string;
  createdAt: string;
}

export interface MentionCandidate {
  email: string;
  displayName: string | null;
  userId: string | null;
}

export interface SharingState {
  artifactId: string;
  isPublic: boolean;
  people: PersonShare[];
  domains: { id: string; domain: string; createdAt: string }[];
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });

export const endpoints = {
  // --- Signing in ---
  me: () => api<CurrentUser>('/api/auth/me'),
  signInMethods: () => api<SignInMethods>('/api/auth/methods'),

  /** Sends a six-digit code. Answers the same way for every address. */
  requestCode: (email: string, redirectTo: string | null) =>
    api<{ sent: boolean }>('/api/auth/code', post({ email, redirectTo })),

  verifyCode: (email: string, code: string) =>
    api<{ redirectTo: string | null }>('/api/auth/verify-code', post({ email, code })),

  signOut: () => api<{ signedOut: boolean }>('/api/auth/sign-out', { method: 'POST' }),

  // --- Artifacts ---
  myArtifacts: () => api<{ artifacts: ArtifactSummary[] }>('/api/artifacts'),
  sharedWithMe: () => api<{ artifacts: SharedArtifact[] }>('/api/shared-with-me'),

  /** The viewer has a slug from the URL, not an id. */
  artifactBySlug: (slug: string) =>
    api<SharedArtifact>(`/api/artifacts/by-slug/${encodeURIComponent(slug)}`),

  deleteArtifact: (id: string) =>
    api<void>(`/api/artifacts/${id}?confirm=true`, { method: 'DELETE' }),

  // --- Sharing ---
  sharing: (id: string) => api<SharingState>(`/api/artifacts/${id}/sharing`),

  sharePerson: (id: string, email: string) =>
    api<SharingState>(`/api/artifacts/${id}/sharing/people`, post({ email })),

  unsharePerson: (id: string, email: string) =>
    api<SharingState>(`/api/artifacts/${id}/sharing/people/${encodeURIComponent(email)}`, {
      method: 'DELETE',
    }),

  shareDomain: (id: string, domain: string) =>
    api<SharingState>(`/api/artifacts/${id}/sharing/domains`, post({ domain })),

  unshareDomain: (id: string, domain: string) =>
    api<SharingState>(`/api/artifacts/${id}/sharing/domains/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    }),

  setPublic: (id: string, isPublic: boolean) =>
    api<SharingState>(`/api/artifacts/${id}/sharing/public`, {
      method: 'PUT',
      body: JSON.stringify({ isPublic }),
    }),

  // --- Comments ---
  comments: (artifactId: string, options: { status?: ThreadStatus; since?: string } = {}) => {
    const query = new URLSearchParams();
    if (options.status) query.set('status', options.status);
    if (options.since) query.set('since', options.since);
    const suffix = query.toString() ? `?${query.toString()}` : '';
    return api<{ threads: CommentThread[] }>(`/api/artifacts/${artifactId}/comments${suffix}`);
  },

  /** Leave out the position for a comment about the whole document. */
  startThread: (
    artifactId: string,
    body: string,
    position?: { headingId: string | null; snippet: string; occurrence: number },
  ) => api<CommentThread>(`/api/artifacts/${artifactId}/comments`, post({ body, position })),

  replyToThread: (threadId: string, body: string) =>
    api<Comment>(`/api/comments/threads/${threadId}/replies`, post({ body })),

  setThreadStatus: (threadId: string, status: ThreadStatus) =>
    api<CommentThread>(`/api/comments/threads/${threadId}/status`, {
      method: 'PUT',
      body: JSON.stringify({ status }),
    }),

  editComment: (commentId: string, body: string) =>
    api<Comment>(`/api/comments/${commentId}`, { method: 'PUT', body: JSON.stringify({ body }) }),

  deleteComment: (commentId: string) =>
    api<{ threadDeleted: boolean }>(`/api/comments/${commentId}`, { method: 'DELETE' }),

  // --- Notifications ---
  notifications: () =>
    api<{ notifications: NotificationView[]; unread: number }>('/api/notifications'),

  markNotificationRead: (id: string) =>
    api<void>(`/api/notifications/${id}/read`, { method: 'POST' }),

  markAllNotificationsRead: () =>
    api<{ marked: number }>('/api/notifications/read-all', { method: 'POST' }),

  accessRequests: () => api<{ requests: AccessRequest[] }>('/api/access-requests'),

  decideAccessRequest: (id: string, grant: boolean) =>
    api<{ granted: boolean }>(`/api/access-requests/${id}/decide`, post({ grant })),

  mentionCandidates: (artifactId: string) =>
    api<{ candidates: MentionCandidate[] }>(`/api/artifacts/${artifactId}/mention-candidates`),

  /** Closes the account. Deliberately unforgiving: there is no undo. */
  deleteAccount: () => api<void>('/api/auth/account?confirm=true', { method: 'DELETE' }),

  // --- Sessions ---
  sessions: () => api<SessionsResponse>('/api/auth/sessions'),
  revokeSession: (id: string) => api<void>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  revokeToken: (id: string) => api<void>(`/api/auth/tokens/${id}`, { method: 'DELETE' }),
};
