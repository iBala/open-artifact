/**
 * Artifact storage: create, read, update, delete.
 *
 * Two rules worth knowing before reading the code:
 *
 * 1. Every write also writes a version row. Versions are internal — no UI, no CLI
 *    exposure — but they mean an accidental overwrite is recoverable and comment
 *    anchors have a previous text to re-match against.
 *
 * 2. Updates carry the version they were based on. If it does not match what is
 *    stored, the update is rejected. Two agents publishing to the same artifact is
 *    a realistic accident, and silently keeping only the last one loses work.
 */

import { eq, and, desc } from 'drizzle-orm';
import type { ArtifactType } from '@open-artifact/shared';
import { isArtifactType } from '@open-artifact/shared';
import type { Db } from '../db/index.js';
import { artifacts, artifactVersions, type ArtifactRow } from '../db/schema.js';
import { newId, newSlug } from '../ids.js';
import { nowIso } from '../time.js';
import { ApiError, notFound } from '../errors.js';
import { deriveTitle } from './title.js';

export interface CreateArtifactInput {
  ownerId: string;
  type: string;
  content: string;
  /** Optional. When given it is kept as-is and never re-derived on later updates. */
  title?: string | undefined;
}

export interface UpdateArtifactInput {
  content: string;
  type?: string | undefined;
  title?: string | undefined;
  /** The version the caller last saw. Anything else means someone got there first. */
  baseVersion: number;
}

export interface ArtifactSummary {
  id: string;
  slug: string;
  ownerId: string;
  /** 1 when anybody with the link can read it. Kept as the stored 0/1. */
  isPublic: number;
  type: ArtifactType;
  title: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactDetail extends ArtifactSummary {
  content: string;
}

export interface ArtifactServiceOptions {
  db: Db;
  maxArtifactBytes: number;
}

export class ArtifactService {
  private readonly db: Db;
  private readonly maxArtifactBytes: number;

  constructor({ db, maxArtifactBytes }: ArtifactServiceOptions) {
    this.db = db;
    this.maxArtifactBytes = maxArtifactBytes;
  }

  create(input: CreateArtifactInput): ArtifactDetail {
    const type = this.requireType(input.type);
    const content = this.requireContent(input.content);
    const explicitTitle = normaliseGivenTitle(input.title);

    const timestamp = nowIso();
    const row = {
      id: newId('art'),
      slug: newSlug(),
      ownerId: input.ownerId,
      type,
      title: explicitTitle ?? deriveTitle(type, content),
      titleIsExplicit: explicitTitle === null ? 0 : 1,
      content,
      currentVersion: 1,
      isPublic: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    this.db.transaction((tx) => {
      tx.insert(artifacts).values(row).run();
      tx.insert(artifactVersions)
        .values({
          id: newId('ver'),
          artifactId: row.id,
          version: 1,
          type: row.type,
          title: row.title,
          content: row.content,
          createdAt: timestamp,
        })
        .run();
    });

    return toDetail(row as ArtifactRow);
  }

  update(id: string, input: UpdateArtifactInput): ArtifactDetail {
    const existing = this.requireRow(id);
    const type = input.type === undefined ? existing.type : this.requireType(input.type);
    const content = this.requireContent(input.content);
    const explicitTitle = normaliseGivenTitle(input.title);

    if (!Number.isInteger(input.baseVersion)) {
      throw new ApiError(
        'validation_failed',
        'baseVersion is required and must be the version number you last saw.',
      );
    }

    if (input.baseVersion !== existing.currentVersion) {
      throw new ApiError(
        'version_conflict',
        `This artifact has changed since you last read it. You based this update on version ${input.baseVersion}, but it is now at version ${existing.currentVersion}. Read it again and re-apply your change.`,
        { currentVersion: existing.currentVersion, baseVersion: input.baseVersion },
      );
    }

    const titleIsExplicit = explicitTitle !== null || existing.titleIsExplicit === 1;
    const title =
      explicitTitle ??
      // A title someone chose on purpose survives content updates; a derived one
      // follows the content.
      (existing.titleIsExplicit === 1 ? existing.title : deriveTitle(type as ArtifactType, content));

    const version = existing.currentVersion + 1;
    const timestamp = nowIso();

    this.db.transaction((tx) => {
      tx.update(artifacts)
        .set({
          type,
          content,
          title,
          titleIsExplicit: titleIsExplicit ? 1 : 0,
          currentVersion: version,
          updatedAt: timestamp,
        })
        // Guarding on the version here too closes the gap between the read above
        // and this write when two requests arrive at the same moment.
        .where(and(eq(artifacts.id, id), eq(artifacts.currentVersion, existing.currentVersion)))
        .run();

      tx.insert(artifactVersions)
        .values({
          id: newId('ver'),
          artifactId: id,
          version,
          type,
          title,
          content,
          createdAt: timestamp,
        })
        .run();
    });

    return this.get(id);
  }

  get(id: string): ArtifactDetail {
    return toDetail(this.requireRow(id));
  }

  getBySlug(slug: string): ArtifactDetail {
    const row = this.db.select().from(artifacts).where(eq(artifacts.slug, slug)).get();
    if (!row) throw notFound();
    return toDetail(row);
  }

  /** Everything this person published, newest change first. */
  listOwnedBy(ownerId: string): ArtifactSummary[] {
    return this.db
      .select()
      .from(artifacts)
      .where(eq(artifacts.ownerId, ownerId))
      .orderBy(desc(artifacts.updatedAt))
      .all()
      .map(toSummary);
  }

  delete(id: string): void {
    const existing = this.requireRow(id);
    // Version rows go with it: the foreign key cascades.
    this.db.delete(artifacts).where(eq(artifacts.id, existing.id)).run();
  }

  /** How many versions an artifact has. Internal; used by tests and by anchor re-matching. */
  versionCount(id: string): number {
    return this.db
      .select()
      .from(artifactVersions)
      .where(eq(artifactVersions.artifactId, id))
      .all().length;
  }

  private requireRow(id: string): ArtifactRow {
    const row = this.db.select().from(artifacts).where(eq(artifacts.id, id)).get();
    if (!row) throw notFound();
    return row;
  }

  private requireType(type: string): ArtifactType {
    if (!isArtifactType(type)) {
      throw new ApiError(
        'unsupported_type',
        `Artifacts can be "markdown" or "html". Got "${type}".`,
      );
    }
    return type;
  }

  private requireContent(content: string): string {
    if (typeof content !== 'string' || content.length === 0) {
      throw new ApiError('validation_failed', 'content is required and cannot be empty.');
    }
    const bytes = Buffer.byteLength(content, 'utf8');
    if (bytes > this.maxArtifactBytes) {
      throw new ApiError(
        'payload_too_large',
        `This artifact is ${formatBytes(bytes)}. This instance accepts up to ${formatBytes(this.maxArtifactBytes)}.`,
        { bytes, maxBytes: this.maxArtifactBytes },
      );
    }
    return content;
  }
}

function normaliseGivenTitle(title: string | undefined): string | null {
  if (title === undefined) return null;
  const trimmed = title.replace(/\s+/g, ' ').trim();
  if (trimmed.length === 0) {
    throw new ApiError('validation_failed', 'title cannot be blank. Leave it out to derive one.');
  }
  return trimmed.slice(0, 200);
}

function toSummary(row: ArtifactRow): ArtifactSummary {
  return {
    id: row.id,
    slug: row.slug,
    ownerId: row.ownerId,
    isPublic: row.isPublic,
    type: row.type as ArtifactType,
    title: row.title,
    version: row.currentVersion,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toDetail(row: ArtifactRow): ArtifactDetail {
  return { ...toSummary(row), content: row.content };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
