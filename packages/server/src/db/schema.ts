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
  email: text('email').notNull().unique(),
  displayName: text('display_name'),
  createdAt: text('created_at').notNull(),
});

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
export type ArtifactRow = typeof artifacts.$inferSelect;
export type ArtifactVersionRow = typeof artifactVersions.$inferSelect;
