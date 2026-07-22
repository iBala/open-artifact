/**
 * Database connection and migrations.
 *
 * Migrations run at boot, every boot. A self-hoster who pulls a new image and
 * restarts gets the new schema with no extra step, and running them twice is
 * harmless because the migrator records what it has already applied.
 */

import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

const MIGRATIONS_FOLDER = resolve(fileURLToPath(new URL('../../migrations', import.meta.url)));

export interface OpenDatabaseOptions {
  /** File path, or ':memory:' for a throwaway database in tests. */
  path: string;
  /** Set false only in tests that want to inspect an unmigrated database. */
  runMigrations?: boolean;
}

export interface DatabaseHandle {
  db: Db;
  /** The underlying driver, for health checks and for closing cleanly. */
  raw: Database.Database;
  close: () => void;
}

export function openDatabase({ path, runMigrations = true }: OpenDatabaseOptions): DatabaseHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const raw = new Database(path);
  // Write-ahead logging lets readers work while a write is in flight, which is
  // what keeps a single-file database comfortable for a team-sized instance.
  raw.pragma('journal_mode = WAL');
  // Without this, SQLite ignores the foreign keys the schema declares.
  raw.pragma('foreign_keys = ON');
  // Wait rather than fail immediately when another write holds the lock.
  raw.pragma('busy_timeout = 5000');

  const db = drizzle(raw, { schema });

  if (runMigrations) {
    migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  }

  return {
    db,
    raw,
    close: () => raw.close(),
  };
}

export { schema };
