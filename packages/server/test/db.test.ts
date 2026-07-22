import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DatabaseHandle } from '../src/db/index.js';
import { artifacts, users } from '../src/db/schema.js';

describe('database and migrations', () => {
  let directory: string;
  let handles: DatabaseHandle[];

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'open-artifact-db-'));
    handles = [];
  });

  afterEach(() => {
    for (const handle of handles) handle.close();
    rmSync(directory, { recursive: true, force: true });
  });

  function open(path: string): DatabaseHandle {
    const handle = openDatabase({ path });
    handles.push(handle);
    return handle;
  }

  function tableNames(handle: DatabaseHandle): string[] {
    return handle.raw
      .prepare<[], { name: string }>(
        "select name from sqlite_master where type = 'table' order by name",
      )
      .all()
      .map((row) => row.name);
  }

  it('creates every table on a fresh database', () => {
    const handle = open(join(directory, 'fresh.db'));
    expect(tableNames(handle)).toEqual(
      expect.arrayContaining(['users', 'artifacts', 'artifact_versions']),
    );
  });

  it('creates the database file and its parent directory if they are missing', () => {
    const path = join(directory, 'nested', 'deeper', 'open-artifact.db');
    open(path);
    expect(existsSync(path)).toBe(true);
  });

  it('is a no-op on an already-migrated database and keeps the data', () => {
    const path = join(directory, 'twice.db');

    const first = open(path);
    first.db
      .insert(users)
      .values({ id: 'user-1', email: 'a@example.com', createdAt: '2026-07-22T00:00:00.000Z' })
      .run();
    first.close();
    handles.pop();

    // Same as restarting the container after an upgrade.
    const second = open(path);
    expect(second.db.select().from(users).all()).toHaveLength(1);
  });

  it('enforces the unique constraint on artifact slugs', () => {
    const handle = open(join(directory, 'slug.db'));
    const row = {
      id: 'artifact-1',
      slug: 'duplicate-slug',
      type: 'markdown',
      title: 'One',
      content: '# One',
      createdAt: '2026-07-22T00:00:00.000Z',
      updatedAt: '2026-07-22T00:00:00.000Z',
    };
    handle.db.insert(artifacts).values(row).run();
    expect(() => handle.db.insert(artifacts).values({ ...row, id: 'artifact-2' }).run()).toThrow();
  });

  it('has foreign keys switched on, so version rows cannot outlive their artifact', () => {
    const handle = open(join(directory, 'fk.db'));
    expect(handle.raw.pragma('foreign_keys', { simple: true })).toBe(1);
  });

  it('uses write-ahead logging so reads are not blocked by a write', () => {
    const handle = open(join(directory, 'wal.db'));
    expect(handle.raw.pragma('journal_mode', { simple: true })).toBe('wal');
  });
});
