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
 * A hosted assistant connected to this account: Claude on the web, ChatGPT, or
 * any MCP client that has no terminal.
 *
 * Connections, not tokens, own the artifacts an assistant publishes. A personal
 * MCP token points at its connection; later an OAuth grant will point at the same
 * connection while its own access token rotates hourly. Recording the connection
 * rather than the token is what keeps that history from being orphaned every time
 * the token changes.
 *
 * Never hard-deleted except when the account closes. Taking a connection away is
 * a soft revoke, so what it published keeps its recorded origin.
 */
export const mcpConnections = sqliteTable(
  'mcp_connections',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The product this connection is for, for example "Claude on the web". */
    label: text('label').notNull(),
    createdAt: text('created_at').notNull(),
    /** Set when the connection is revoked. Its tokens are revoked with it. */
    revokedAt: text('revoked_at'),
  },
  (table) => [index('mcp_connections_user_idx').on(table.userId)],
);

/**
 * Tokens an assistant uses, of two kinds.
 *
 * A `cli` token has a ninety-day expiry that slides forward on use, so an agent
 * that publishes regularly never gets logged out and one that goes quiet for a
 * quarter does. An `mcp` token has an absolute ninety-day expiry that never
 * slides: it sits in a third party's database, and one that renewed itself on the
 * attacker's own traffic would be a permanent credential.
 *
 * The kind is enforced in the authenticator itself, not in middleware routing:
 * the CLI check accepts only `cli`, the MCP check only `mcp`. An MCP token can
 * therefore never be accepted on the ordinary API, where it would reach
 * delete-artifact and close-account.
 */
export const apiTokens = sqliteTable(
  'api_tokens',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    /** 'cli' or 'mcp'. Existing tokens predate the column and are all CLI. */
    kind: text('kind').notNull().default('cli'),
    /** The connection an MCP token belongs to. Null for a CLI token. */
    connectionId: text('connection_id').references(() => mcpConnections.id, {
      onDelete: 'cascade',
    }),
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
 * Sign-in codes: the six digits emailed to somebody who wants to sign in.
 * Single use and short lived, because an email sits in an inbox forever and a
 * code that works forever is a password that never expires.
 *
 * Six digits is only a million combinations, which is guessable if nothing stops
 * the guessing. `attempts` is what stops it: every guess against a code is
 * counted, and a code that has been guessed at too often is thrown away. There is
 * deliberately no unique index on code_hash, both because two addresses can hold
 * the same digits at the same time and because lookups are always by address.
 */
export const signInCodes = sqliteTable(
  'sign_in_codes',
  {
    id: text('id').primaryKey(),
    email: text('email').notNull(),
    /** SHA-256 of the address and the code together. The digits are never stored. */
    codeHash: text('code_hash').notNull(),
    /** How many codes have been tried against this row, right or wrong. */
    attempts: integer('attempts').notNull().default(0),
    /** Where to send the person after signing in, so a shared link survives login. */
    redirectTo: text('redirect_to'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    usedAt: text('used_at'),
  },
  (table) => [index('sign_in_codes_email_idx').on(table.email)],
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
    /**
     * Which MCP connection published this. Null means it came from the CLI or the
     * web, which own nothing through a connection. An MCP connection may only edit
     * what it published, so every MCP tool filters on this. Set null if the
     * connection is ever hard-deleted, so the artifact survives its origin.
     */
    connectionId: text('connection_id').references(() => mcpConnections.id, {
      onDelete: 'set null',
    }),
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
    /**
     * 1 when anybody with the link can read it, signed in or not. Commenting
     * still needs an explicit share: a public artifact is readable by the world,
     * and a comment box open to the world is a different product.
     */
    isPublic: integer('is_public').notNull().default(0),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (table) => [index('artifacts_updated_at_idx').on(table.updatedAt)],
);

/**
 * Sharing with a particular person.
 *
 * Held against the email address, not the account, because sharing with somebody
 * who has never signed in has to work. When they first sign in with a verified
 * address, the share attaches to their account (see userId below).
 */
export const artifactShares = sqliteTable(
  'artifact_shares',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** Always lowercased. */
    email: text('email').notNull(),
    /**
     * Filled in once somebody signs in with this address. Null means the
     * invitation is still waiting for them, which the sharing dialog shows.
     */
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** When the "shared with you" email went out. Null means it has not, so it can. */
    notifiedAt: text('notified_at'),
  },
  (table) => [
    index('artifact_shares_artifact_idx').on(table.artifactId),
    index('artifact_shares_email_idx').on(table.email),
  ],
);

/** Sharing with everybody at an email domain. */
export const artifactDomainShares = sqliteTable(
  'artifact_domain_shares',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** Always lowercased, never a public provider like gmail.com. */
    domain: text('domain').notNull(),
    createdAt: text('created_at').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [index('artifact_domain_shares_artifact_idx').on(table.artifactId)],
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

/**
 * In-progress CLI sign-ins.
 *
 * The command line cannot receive a redirect, so signing in works the way a TV
 * app does: the CLI shows a short code, the person approves it in a browser they
 * are already signed into, and the CLI polls until it is approved.
 *
 * The short code is what a person reads and types. The device code is the long
 * secret the CLI holds and never shows, and only its hash is stored. Approving a
 * short code alone gets an attacker nothing without it.
 */
export const deviceCodes = sqliteTable(
  'device_codes',
  {
    id: text('id').primaryKey(),
    /** Hash of the long secret the CLI holds. */
    deviceCodeHash: text('device_code_hash').notNull().unique(),
    /** The short code shown to the person, like WXYZ-2345. */
    userCode: text('user_code').notNull().unique(),
    /** What the CLI called itself, shown on the approval screen. */
    label: text('label'),
    createdAt: text('created_at').notNull(),
    expiresAt: text('expires_at').notNull(),
    /** Set when someone approves it in the browser. */
    approvedAt: text('approved_at'),
    approvedByUserId: text('approved_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    /** Set once the CLI has collected its token, so it can never be collected twice. */
    claimedAt: text('claimed_at'),
    deniedAt: text('denied_at'),
  },
  (table) => [index('device_codes_user_code_idx').on(table.userCode)],
);

/**
 * A conversation about one artifact, at one place in it.
 *
 * Threads carry the position; comments carry what people said. Keeping them
 * apart is what makes one nesting level structural rather than a rule somebody
 * has to remember: a reply is just another comment on the same thread, and there
 * is nowhere for a reply to a reply to go.
 */
export const commentThreads = sqliteTable(
  'comment_threads',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),

    /** 'open' or 'resolved'. */
    status: text('status').notNull().default('open'),

    /**
     * 'document' for a comment about the artifact as a whole, 'text' for one
     * attached to a passage. HTML artifacts only ever get 'document': their
     * content runs in a sandboxed frame we cannot reach into to find a selection.
     */
    anchorKind: text('anchor_kind').notNull().default('document'),

    /**
     * Which heading the passage sits under, by the id in the rendered page.
     * Null for a passage before any heading, and for document-level threads.
     */
    anchorHeadingId: text('anchor_heading_id'),

    /** The exact text that was selected. Matched literally on re-publish. */
    anchorSnippet: text('anchor_snippet'),

    /**
     * Which occurrence of that snippet within its section, counting from zero.
     * Without this, a comment on the second "See above" would re-attach to the
     * first one after an edit.
     */
    anchorOccurrence: integer('anchor_occurrence'),

    /**
     * Set to 1 when a re-publish could no longer find the passage and the thread
     * fell back to being about the document. The UI says so, because a comment
     * that silently changes what it is about is worse than one that admits it
     * lost its place.
     */
    anchorLost: integer('anchor_lost').notNull().default(0),

    createdAt: text('created_at').notNull(),
    createdByUserId: text('created_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    resolvedAt: text('resolved_at'),
    resolvedByUserId: text('resolved_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('comment_threads_artifact_idx').on(table.artifactId),
    index('comment_threads_status_idx').on(table.artifactId, table.status),
  ],
);

/** What somebody said. The first one on a thread starts it; the rest are replies. */
export const comments = sqliteTable(
  'comments',
  {
    id: text('id').primaryKey(),
    threadId: text('thread_id')
      .notNull()
      .references(() => commentThreads.id, { onDelete: 'cascade' }),

    /**
     * Null once the author deletes their account. Their words stay where they
     * are, shown as written by a deleted user, because removing them would tear
     * holes in conversations other people are still having.
     */
    authorId: text('author_id').references(() => users.id, { onDelete: 'set null' }),

    body: text('body').notNull(),

    createdAt: text('created_at').notNull(),
    /** Set when the author changes it. The UI marks an edited comment as edited. */
    editedAt: text('edited_at'),

    /**
     * Set when it is deleted. The row survives if replies came after it, so the
     * conversation keeps its shape and a reply never becomes an answer to
     * nothing. The body is not served once this is set.
     */
    deletedAt: text('deleted_at'),
  },
  (table) => [index('comments_thread_idx').on(table.threadId, table.createdAt)],
);

/**
 * Who a comment named.
 *
 * Stored when the comment is written, resolved against the people who could
 * actually be named at that moment. Working it out later by searching the text
 * would mean an address that becomes a user tomorrow silently turns into a
 * mention of something written today.
 */
export const commentMentions = sqliteTable(
  'comment_mentions',
  {
    id: text('id').primaryKey(),
    commentId: text('comment_id')
      .notNull()
      .references(() => comments.id, { onDelete: 'cascade' }),
    /** Always lowercased. Held even when there is no account yet. */
    email: text('email').notNull(),
    userId: text('user_id').references(() => users.id, { onDelete: 'cascade' }),
  },
  (table) => [index('comment_mentions_comment_idx').on(table.commentId)],
);

/**
 * Somebody was named who cannot see the artifact.
 *
 * Raised when a person who does not own the artifact mentions an outsider. They
 * cannot grant access themselves, so the owner is asked. Until it is answered
 * the mention notification is held rather than sent, because telling somebody
 * they were mentioned on a document they cannot open is worse than saying
 * nothing.
 */
export const accessRequests = sqliteTable(
  'access_requests',
  {
    id: text('id').primaryKey(),
    artifactId: text('artifact_id')
      .notNull()
      .references(() => artifacts.id, { onDelete: 'cascade' }),
    /** The person who should get access. Lowercased. */
    email: text('email').notNull(),
    requestedByUserId: text('requested_by_user_id').references(() => users.id, {
      onDelete: 'cascade',
    }),
    /** The comment that named them, so the held notification can be released. */
    commentId: text('comment_id').references(() => comments.id, { onDelete: 'cascade' }),
    createdAt: text('created_at').notNull(),
    /** Set when the owner answers, either way. */
    decidedAt: text('decided_at'),
    granted: integer('granted'),
  },
  (table) => [index('access_requests_artifact_idx').on(table.artifactId)],
);

/**
 * Something happened that somebody should know about.
 *
 * One row per person per event, so marking one as read never affects anybody
 * else's, and so a person who joins later never sees things that happened
 * before they could have cared.
 */
export const notifications = sqliteTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),

    /** 'share', 'mention', 'reply' or 'access-request'. */
    type: text('type').notNull(),

    /** Whoever caused it. Null once their account is closed. */
    actorUserId: text('actor_user_id').references(() => users.id, { onDelete: 'set null' }),

    artifactId: text('artifact_id').references(() => artifacts.id, { onDelete: 'cascade' }),
    threadId: text('thread_id').references(() => commentThreads.id, { onDelete: 'cascade' }),
    commentId: text('comment_id').references(() => comments.id, { onDelete: 'cascade' }),

    createdAt: text('created_at').notNull(),
    readAt: text('read_at'),

    /**
     * 1 while this is waiting on something before it can be shown. A mention of
     * somebody who cannot see the artifact is held until the owner grants
     * access, and released then. Telling them first would be pointing at a door
     * they cannot open.
     */
    held: integer('held').notNull().default(0),
  },
  (table) => [
    index('notifications_user_idx').on(table.userId, table.createdAt),
    index('notifications_unread_idx').on(table.userId, table.readAt),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type NotificationRow = typeof notifications.$inferSelect;
export type CommentMentionRow = typeof commentMentions.$inferSelect;
export type AccessRequestRow = typeof accessRequests.$inferSelect;
export type CommentThreadRow = typeof commentThreads.$inferSelect;
export type CommentRow = typeof comments.$inferSelect;
export type DeviceCodeRow = typeof deviceCodes.$inferSelect;
export type ArtifactShareRow = typeof artifactShares.$inferSelect;
export type ArtifactDomainShareRow = typeof artifactDomainShares.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
export type ApiTokenRow = typeof apiTokens.$inferSelect;
export type McpConnectionRow = typeof mcpConnections.$inferSelect;
export type SignInCodeRow = typeof signInCodes.$inferSelect;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
