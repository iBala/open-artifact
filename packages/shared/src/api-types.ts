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
}

export type SignupMode = 'open' | 'invite-only' | 'domain-allowlist';

export interface SignInMethods {
  magicLink: boolean;
  /** False when the instance has no Google credentials configured. */
  google: boolean;
  signupMode: SignupMode;
}

export interface RequestMagicLinkRequest {
  email: string;
  /** A path on this instance to return to after signing in. */
  redirectTo?: string | null;
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
