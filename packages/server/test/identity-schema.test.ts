import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, type DatabaseHandle } from '../src/db/index.js';
import { users, authSessions, apiTokens, magicLinks } from '../src/db/schema.js';

describe('identity schema', () => {
  let directory: string;
  let handle: DatabaseHandle;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'open-artifact-identity-'));
    handle = openDatabase({ path: join(directory, 'test.db') });
  });

  afterEach(() => {
    try {
      handle.close();
    } catch {
      // already closed by a test
    }
    rmSync(directory, { recursive: true, force: true });
  });

  const now = '2026-07-22T10:00:00.000Z';

  function insertUser(id = 'user-1', email = 'a@example.com'): string {
    handle.db.insert(users).values({ id, email, createdAt: now, updatedAt: now }).run();
    return id;
  }

  it('creates the sign-in tables', () => {
    const names = handle.raw
      .prepare<[], { name: string }>("select name from sqlite_master where type = 'table'")
      .all()
      .map((row) => row.name);
    expect(names).toEqual(
      expect.arrayContaining(['users', 'auth_sessions', 'api_tokens', 'magic_links']),
    );
  });

  it('treats a new account as unverified until they prove they own the address', () => {
    insertUser();
    expect(handle.db.select().from(users).all()[0]?.emailVerified).toBe(0);
  });

  it('allows only one account per email address', () => {
    insertUser('user-1', 'same@example.com');
    expect(() => insertUser('user-2', 'same@example.com')).toThrow();
  });

  it('stores only a hash of a session token, never the token itself', () => {
    const userId = insertUser();
    handle.db
      .insert(authSessions)
      .values({
        id: 'session-1',
        userId,
        tokenHash: 'hash-value',
        createdAt: now,
        lastSeenAt: now,
        expiresAt: '2026-08-22T10:00:00.000Z',
      })
      .run();

    const columns = handle.raw
      .prepare<[], { name: string }>('select name from pragma_table_info(?)')
      .all('auth_sessions')
      .map((row) => row.name);
    expect(columns).toContain('token_hash');
    expect(columns).not.toContain('token');
  });

  it('stores only a hash of an API token', () => {
    const columns = handle.raw
      .prepare<[], { name: string }>('select name from pragma_table_info(?)')
      .all('api_tokens')
      .map((row) => row.name);
    expect(columns).toContain('token_hash');
    expect(columns).not.toContain('token');
  });

  it('refuses two sessions sharing a token hash', () => {
    const userId = insertUser();
    const session = {
      userId,
      tokenHash: 'same-hash',
      createdAt: now,
      lastSeenAt: now,
      expiresAt: '2026-08-22T10:00:00.000Z',
    };
    handle.db.insert(authSessions).values({ id: 'session-1', ...session }).run();
    expect(() =>
      handle.db.insert(authSessions).values({ id: 'session-2', ...session }).run(),
    ).toThrow();
  });

  it('deletes a person’s sessions and tokens with their account, leaving nothing behind', () => {
    const userId = insertUser();
    handle.db
      .insert(authSessions)
      .values({
        id: 'session-1',
        userId,
        tokenHash: 'session-hash',
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now,
      })
      .run();
    handle.db
      .insert(apiTokens)
      .values({ id: 'token-1', userId, tokenHash: 'token-hash', createdAt: now, expiresAt: now })
      .run();

    handle.raw.prepare('delete from users where id = ?').run(userId);

    expect(handle.db.select().from(authSessions).all()).toHaveLength(0);
    expect(handle.db.select().from(apiTokens).all()).toHaveLength(0);
  });

  it('records when a magic link was used, so it cannot be used twice', () => {
    handle.db
      .insert(magicLinks)
      .values({
        id: 'link-1',
        email: 'a@example.com',
        tokenHash: 'link-hash',
        createdAt: now,
        expiresAt: '2026-07-22T10:15:00.000Z',
      })
      .run();
    expect(handle.db.select().from(magicLinks).all()[0]?.usedAt).toBeNull();
  });
});

describe('upgrading an existing instance', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'open-artifact-upgrade-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  /**
   * Someone running the Sprint 1 build has rows in the old users table. Adding a
   * NOT NULL column to that table is exactly where SQLite migrations go wrong, so
   * this replays the upgrade rather than assuming it works.
   */
  it('adds the new columns to a database that already holds rows', () => {
    const path = join(directory, 'existing.db');

    // Bring the database up to the Sprint 1 build exactly, by running only the
    // migrations that existed then, and put a row in it.
    const olderMigrations = migrationsUpTo(directory, 1);
    const old = openDatabase({ path, migrationsFolder: olderMigrations });
    old.raw
      .prepare('insert into users (id, email, display_name, created_at) values (?, ?, ?, ?)')
      .run('user-old', 'existing@example.com', 'Existing person', '2026-01-01T00:00:00.000Z');
    old.close();

    // Then upgrade, the way restarting the container after a pull does.
    const handle = openDatabase({ path });
    try {
      const row = handle.db.select().from(users).all()[0];
      expect(row?.email).toBe('existing@example.com');
      expect(row?.emailVerified).toBe(0);
      // Backfilled from created_at rather than left at a placeholder.
      expect(row?.updatedAt).toBe('2026-01-01T00:00:00.000Z');
      expect(row?.deletedAt).toBeNull();
    } finally {
      handle.close();
    }
  });
});

/**
 * Builds a migrations folder holding only the first `count` migrations, so a test
 * can stand a database up at an earlier version of the product and then upgrade it.
 */
function migrationsUpTo(directory: string, count: number): string {
  const source = fileURLToPath(new URL('../migrations', import.meta.url));
  const target = join(directory, `migrations-up-to-${count}`);
  mkdirSync(join(target, 'meta'), { recursive: true });

  const journal = JSON.parse(readFileSync(join(source, 'meta', '_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const kept = journal.entries.slice(0, count);

  for (const entry of kept) {
    copyFileSync(join(source, `${entry.tag}.sql`), join(target, `${entry.tag}.sql`));
  }
  writeFileSync(
    join(target, 'meta', '_journal.json'),
    JSON.stringify({ ...journal, entries: kept }),
  );
  return target;
}
