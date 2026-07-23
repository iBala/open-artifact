/**
 * The shape of the HTTP API.
 *
 * The API is the product's contract: the CLI, the web app, the skill and any
 * third-party client all speak it. These types are the one written-down version
 * of it, imported by the server that produces the responses and by the clients
 * that consume them, so the two cannot drift apart without the compiler noticing.
 *
 * Every timestamp here is UTC ISO-8601. No exceptions, anywhere.
 */

import type { ArtifactType } from './index.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Every failure the API returns. Clients branch on `code`; `message` is written
 * for people and may be reworded. Adding a code is safe; changing what an
 * existing one means is a breaking change.
 */
export const API_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'not_found',
  'gone',
  'validation_failed',
  'unsupported_type',
  'payload_too_large',
  'version_conflict',
  'rate_limited',
  'internal_error',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Artifacts
// ---------------------------------------------------------------------------

export interface ArtifactSummary {
  id: string;
  /** The unguessable part of the artifact's URL. */
  slug: string;
  ownerId: string;
  /** 1 when anybody with the link can read it, 0 otherwise. */
  isPublic: number;
  type: ArtifactType;
  title: string;
  /** Increments on every update. Send it back as `baseVersion` when updating. */
  version: number;
  /** The full viewing URL, so no client has to know how to build one. */
  url: string;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  content: string;
}

/**
 * What the reader of an artifact is allowed to do with it.
 *
 * Answered by the server rather than worked out by the client, which could not
 * work it out anyway: seeing who an artifact is shared with is itself something
 * only its owner may do.
 */
export interface ArtifactPermissions {
  comment: boolean;
  manage: boolean;
}

export interface CreateArtifactRequest {
  type: ArtifactType;
  content: string;
  /** When given, it is kept as-is and never re-derived by a later update. */
  title?: string;
}

export interface UpdateArtifactRequest {
  content: string;
  type?: ArtifactType;
  title?: string;
  /**
   * The version the caller last read. If it is not the current one the update is
   * refused with `version_conflict`, rather than overwriting somebody's change.
   */
  baseVersion: number;
}

export interface ListArtifactsResponse {
  artifacts: ArtifactSummary[];
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string | null;
  createdAt: string;
  /**
   * The assistants this person has connected the command line from, by the label
   * each sign-in gave itself. Empty means they have not installed it anywhere, so
   * the web app offers to help; non-empty means they are set up, so it does not.
   */
  connectedApps: string[];
}

export type SignupMode = 'open' | 'invite-only' | 'domain-allowlist';

export interface SignInMethods {
  /** Whether this instance emails sign-in codes. Always true today. */
  /** Always true: an emailed code is how this product signs anybody in. */
  emailCode: boolean;
  /** False when the instance has no Google credentials configured. */
  google: boolean;
  signupMode: SignupMode;
}

/**
 * Signing in by email is two calls: ask for a code, then send back what arrived.
 *
 * There is no link to click. A link in an email opens in the mail client's own
 * browser, which has none of the person's tabs and none of their session, so the
 * sign-in finishes somewhere they never asked to be. Six digits typed back into
 * the tab they started in keeps them there.
 */
export interface RequestSignInCodeRequest {
  email: string;
  /** A path on this instance to return to after signing in. */
  redirectTo?: string | null;
}

/**
 * Identical for every address, on purpose. Whether the address has an account
 * here, and whether it would be allowed one, are not things this says.
 */
export interface RequestSignInCodeResponse {
  sent: true;
  message: string;
}

export interface VerifySignInCodeRequest {
  email: string;
  /** The six digits. Spaces and dashes are ignored, so "428 913" is fine. */
  code: string;
}

export interface VerifySignInCodeResponse {
  /**
   * Where this person asked to end up, taken from the request for the code. Null
   * when they just signed in, and the caller decides where that lands.
   */
  redirectTo: string | null;
}

// ---------------------------------------------------------------------------
// Signing in from a command line
// ---------------------------------------------------------------------------

export interface StartDeviceLoginResponse {
  /** The long secret the client keeps and never shows. */
  deviceCode: string;
  /** The short code the person reads and checks, like WXYZ-2345. */
  userCode: string;
  verificationUrl: string;
  expiresInSeconds: number;
  intervalSeconds: number;
}

export type DeviceLoginState = 'pending' | 'approved' | 'denied' | 'expired';

export interface DeviceTokenResponse {
  state: DeviceLoginState;
  /** Present only when the state is 'approved'. */
  token?: string;
  expiresAt?: string;
}

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface SessionEntry {
  id: string;
  label: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  /** True for the browser making the request. */
  isCurrent: boolean;
}

export interface ApiTokenEntry {
  id: string;
  label: string | null;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string;
}

export interface SessionsResponse {
  sessions: SessionEntry[];
  tokens: ApiTokenEntry[];
}

// ---------------------------------------------------------------------------
// Comments
// ---------------------------------------------------------------------------

export type ThreadStatus = 'open' | 'resolved';

/** A comment about the artifact as a whole. */
export interface DocumentAnchor {
  kind: 'document';
}

/**
 * A comment about a passage.
 *
 * The three things together are what let a comment survive a re-publish: the
 * same text, under the same heading, at the same occurrence. Anything less and
 * a comment could reattach to different words after an edit.
 */
export interface TextAnchor {
  kind: 'text';
  /** The id of the heading it sits under. Null before the first heading. */
  headingId: string | null;
  /** The exact text that was selected. */
  snippet: string;
  /** Which occurrence of that text within the section, from zero. */
  occurrence: number;
}

export type CommentAnchor = DocumentAnchor | TextAnchor;

export interface CommentAuthor {
  id: string;
  email: string;
  displayName: string | null;
}

export interface Comment {
  id: string;
  threadId: string;
  /** Null when the author closed their account. Their words stay. */
  author: CommentAuthor | null;
  /** A placeholder rather than what was written, when deleted is true. */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
}

export interface CommentThread {
  id: string;
  artifactId: string;
  status: ThreadStatus;
  anchor: CommentAnchor;
  /**
   * True when a re-publish could no longer find the passage this was about, so
   * it became a comment on the document. Shown to the reader, because a comment
   * that silently changes what it is about is worse than one that admits it.
   */
  anchorLost: boolean;
  createdAt: string;
  resolvedAt: string | null;
  /** Oldest first: the first one started the thread, the rest are replies. */
  comments: Comment[];
}

export interface ListCommentsResponse {
  threads: CommentThread[];
}

export interface StartThreadRequest {
  body: string;
  /** Leave out for a comment about the whole document. */
  position?: {
    headingId: string | null;
    snippet: string;
    occurrence?: number;
  };
}
