import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, copyFileSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { openDatabase } from '../src/db/index.js';
import { artifacts, apiTokens } from '../src/db/schema.js';
import { AuthService } from '../src/auth/service.js';
import { generateToken, hashToken } from '../src/auth/tokens.js';

/**
 * Upgrading an instance that predates the MCP endpoint.
 *
 * A self-hoster restarting after a pull has real rows in the old api_tokens and
 * artifacts tables. Adding the kind column and the connection references is
 * exactly where an SQLite migration can go wrong, so this replays it: bring a
 * database up to the pre-MCP build, put a CLI token and an artifact in it, then
 * upgrade forward and check nothing was lost.
 */

describe('upgrading past the MCP endpoint', () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'open-artifact-mcp-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('migrates existing CLI tokens and artifacts cleanly, and the tokens still authenticate', () => {
    const path = join(directory, 'existing.db');
    const now = '2026-01-01T00:00:00.000Z';
    const future = '2099-01-01T00:00:00.000Z';
    const token = generateToken();

    // Stand the database up at the last build before the MCP endpoint.
    const preMcp = migrationsUpTo(directory, 8);
    const old = openDatabase({ path, migrationsFolder: preMcp });
    old.raw
      .prepare('insert into users (id, email, email_verified, created_at, updated_at) values (?, ?, 1, ?, ?)')
      .run('usr_old', 'existing@example.com', now, now);
    old.raw
      .prepare(
        'insert into api_tokens (id, user_id, token_hash, label, created_at, expires_at) values (?, ?, ?, ?, ?, ?)',
      )
      .run('tok_old', 'usr_old', hashToken(token), 'Claude Code', now, future);
    old.raw
      .prepare(
        `insert into artifacts
          (id, slug, owner_id, type, title, title_is_explicit, content, current_version, is_public, created_at, updated_at)
         values (?, ?, ?, 'markdown', 'Old report', 0, '# Old report', 1, 0, ?, ?)`,
      )
      .run('art_old', 'slug_old_000000000000000', 'usr_old', now, now);
    old.close();

    // Upgrade the way restarting the container after a pull does.
    const handle = openDatabase({ path });
    try {
      // The kind column was backfilled to 'cli' for the existing token.
      const token_row = handle.db.select().from(apiTokens).where(eq(apiTokens.id, 'tok_old')).get();
      expect(token_row?.kind).toBe('cli');
      expect(token_row?.connectionId).toBeNull();

      // The existing artifact belongs to no connection, which is what null means.
      const artifact = handle.db.select().from(artifacts).where(eq(artifacts.id, 'art_old')).get();
      expect(artifact?.connectionId).toBeNull();
      expect(artifact?.content).toBe('# Old report');

      // And the token still works: the CLI authenticator accepts it, unchanged.
      const auth = new AuthService({
        db: handle.db,
        sessionSecret: 'a-secret-long-enough-for-the-config-check',
        signupMode: 'open',
        signupAllowedDomains: [],
      });
      expect(auth.authenticateApiToken(token)?.id).toBe('usr_old');
    } finally {
      handle.close();
    }
  });
});

/** Builds a migrations folder holding only the first `count` migrations. */
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
  writeFileSync(join(target, 'meta', '_journal.json'), JSON.stringify({ ...journal, entries: kept }));
  return target;
}
