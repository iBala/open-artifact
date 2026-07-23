/**
 * Where the CLI keeps its token.
 *
 * One file, `~/.open-artifact/credentials`, holding one entry per instance so
 * somebody can be signed into their team's server and a personal one at the same
 * time without them fighting.
 *
 * The file is written with 0600 and the directory with 0700: on a shared machine
 * this file is the account. Permissions are set at creation time rather than
 * afterwards, so there is never a moment where it exists and is readable.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';

export interface StoredCredential {
  baseUrl: string;
  token: string;
  email: string;
  expiresAt: string;
  savedAt: string;
}

interface CredentialsFile {
  version: 1;
  /** Which instance commands talk to when none is named. */
  defaultInstance: string | null;
  instances: Record<string, StoredCredential>;
}

const EMPTY: CredentialsFile = { version: 1, defaultInstance: null, instances: {} };

/** The directory holding everything the CLI keeps: the token, the version cache. */
export function configDir(): string {
  // Honoured mainly so tests never touch a real home directory.
  const override = process.env.OPEN_ARTIFACT_HOME;
  return override ?? join(homedir(), '.open-artifact');
}

export function credentialsPath(): string {
  return join(configDir(), 'credentials');
}

function readFile(): CredentialsFile {
  const path = credentialsPath();
  if (!existsSync(path)) return { ...EMPTY, instances: {} };

  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as CredentialsFile;
    if (parsed.version !== 1 || typeof parsed.instances !== 'object') {
      return { ...EMPTY, instances: {} };
    }
    return parsed;
  } catch {
    // A corrupt file should not stop somebody signing in again. Treat it as empty
    // and let the next save replace it.
    return { ...EMPTY, instances: {} };
  }
}

function writeFileSafely(contents: CredentialsFile): void {
  const path = credentialsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(contents, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync only applies the mode when creating the file, so an existing
  // one keeps whatever permissions it had. Set them again to be sure.
  chmodSync(path, 0o600);
}

/** The instance a command should use: the one named, or the default. */
export function resolveInstance(named?: string | undefined): string | null {
  if (named) return normaliseBaseUrl(named);
  const file = readFile();
  return file.defaultInstance;
}

export function loadCredential(baseUrl?: string | undefined): StoredCredential | null {
  const file = readFile();
  const key = baseUrl ? normaliseBaseUrl(baseUrl) : file.defaultInstance;
  if (!key) return null;
  return file.instances[key] ?? null;
}

export function saveCredential(credential: StoredCredential): void {
  const file = readFile();
  const key = normaliseBaseUrl(credential.baseUrl);
  file.instances[key] = { ...credential, baseUrl: key };
  // Signing into an instance makes it the one later commands use.
  file.defaultInstance = key;
  writeFileSafely(file);
}

export function forgetCredential(baseUrl?: string | undefined): StoredCredential | null {
  const file = readFile();
  const key = baseUrl ? normaliseBaseUrl(baseUrl) : file.defaultInstance;
  if (!key) return null;

  const removed = file.instances[key] ?? null;
  delete file.instances[key];

  if (file.defaultInstance === key) {
    // Fall back to whatever else is signed in, so removing one instance does not
    // leave the CLI pointing at nothing when another is available.
    file.defaultInstance = Object.keys(file.instances)[0] ?? null;
  }

  if (Object.keys(file.instances).length === 0) {
    if (existsSync(credentialsPath())) unlinkSync(credentialsPath());
  } else {
    writeFileSafely(file);
  }
  return removed;
}

export function listCredentials(): StoredCredential[] {
  return Object.values(readFile().instances);
}

/** One spelling per instance, so https://x and https://x/ are the same entry. */
export function normaliseBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '');
  return trimmed.includes('://') ? trimmed : `https://${trimmed}`;
}
