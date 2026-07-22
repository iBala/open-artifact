/**
 * Database schema.
 *
 * Conventions that hold across every table:
 * - Primary keys are opaque random text ids, never sequential integers, so an id
 *   in a URL or an API response never reveals how much data the instance holds.
 * - Timestamps are TEXT holding UTC ISO-8601. One convention everywhere: database,
 *   API and CLI. The web UI converts to the viewer's local time at render.
 * - Booleans are INTEGER 0/1, which is what SQLite actually stores.
 */

import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';

/**
 * People. Email is the identity key: signing in by email link and by Google with
 * the same address lands on the same row.
 *
 * Sprint 1 uses this as a stub so artifacts have somewhere to point. Sign-in
 * columns arrive in Sprint 2.
 */
export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  /** Always stored lowercased. Comparisons elsewhere assume that. */
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  /**
   * 1 once the person has proved they control the address, by following an email
   * link or by signing in with Google. Access granted by email share only
   * attaches to a verified address, so an unverified one can never claim someone
   * else's invitation.
   */
  emailVerified: integer('email_verified').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  /**
   * Set when the person deletes their account. The row stays so their comments on
   * other people's artifacts keep their shape, shown as "deleted user" (Sprint 7).
   */
  deletedAt: text('deleted_at'),
});

/**
 * Browser sessions. The cookie holds a random secret; only its hash is stored, so
 * a copy of the database is not a set of working sessions.
 */
export const authSessions = sqliteTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Shown on the sessions page so a person can tell their devices apart. */
    label: text('label'),
    createdAt: text('created_at').notNull(),
    lastSeenAt: text('last_seen_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => [index('auth_sessions_user_idx').on(table.userId)],
);

/**
 * Tokens the CLI uses. Ninety-day expiry that slides forward on use, so an agent
 * that publishes regularly never gets logged out, and one that goes quiet for a
 * quarter does.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** Where this token lives, for example "Claude Code on bala's laptop". */
    label: text('label'),
    createdAt: text('created_at').notNull(),
    lastUsedAt: text('last_used_at'),
    expiresAt: text('expires_at').notNull(),
    revokedAt: text('revoked_at'),
  },
  (table) => [index('api_tokens_user_idx').on(table.userId)],
);

/**
 * Sign-in links. Single use and short lived: an email sits in an inbox forever,
 * and a link that works forever is a password that never expires.
 */
export const magicLinks = sqliteTable(
  'magic_links',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    /** Where to send the person after signing in, so a shared link survives login. */
    redirectTo: text('redirect_to'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => [index('magic_links_email_idx').on(table.email)],
);

/**
 * A published document. Holds the current content so viewing is a single read;
 * every past state also lives in artifact_versions.
 */
export const artifacts = sqliteTable(
  'artifacts',
  {
    id: text('id').primaryKey(),
    /** The unguessable part of the artifact's URL. */
    slug: text('slug').notNull().unique(),
    /**
     * Who published it. They are the only one who can change sharing, update or
     * delete it. Deleting the account deletes their artifacts with it.
     */
    ownerId: text('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** 'markdown' or 'html'. */
    type: text('type').notNull(),
    title: text('title').notNull(),
    /**
     * 1 when the publisher set the title explicitly. Updates re-derive the title
     * from the content unless it was set explicitly, which would otherwise
     * silently overwrite a title someone chose on purpose.
     */
    titleIsExplicit: integer('title_is_explicit').notNull().default(0),
    content: text('content').notNull(),
    /** Matches the highest version number in artifact_versions. Used for conflict detection. */
    currentVersion: integer('current_version').notNull().default(1),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('artifacts_updated_at_idx').on(table.updatedAt)],
);

/**
 * Every state an artifact has ever been in. Kept internally so an accidental
 * overwrite is recoverable and so comment anchors can be re-matched against the
 * previous content. Not exposed in the UI or the skill by design.
 */
export const artifactVersions = sqliteTable(
  'artifact_versions',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    type: text('type').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    createdAt: text('created_at').notNull(),
  },
  (table) => [index('artifact_versions_artifact_idx').on(table.artifactId, table.version)],
);

export type UserRow = typeof users.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type MagicLinkRow = typeof magicLinks.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
