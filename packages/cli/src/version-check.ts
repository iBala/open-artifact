/**
 * Telling the user when a newer version is out.
 *
 * Runs on every command, but does real work at most once a day: the latest
 * version is cached, and the network is only touched when that cache is stale.
 * It never blocks for long and never breaks the command it runs alongside — a
 * slow or unreachable npm just means no notice this time.
 *
 * It always asks public npm directly, never the machine's default registry,
 * because that default may be a private one that does not carry this package.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { configDir } from './credentials.js';

/** Public npm, always — a private default registry would not have this package. */
const LATEST_URL = 'https://registry.npmjs.org/open-artifact/latest';
const CHECK_EVERY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 1500;

export interface UpdateInfo {
  current: string;
  latest: string;
  /** The one command that upgrades it, public registry spelled out. */
  upgradeCommand: string;
}

interface Cache {
  checkedAt: number;
  latest: string;
}

export interface VersionCheckDeps {
  current: string;
  fetchImpl: typeof fetch;
  now: () => number;
}

/**
 * The update, or null when there is none, when the check is switched off, or
 * when anything at all goes wrong. Callers treat null as "say nothing".
 */
export async function checkForUpdate(deps: VersionCheckDeps): Promise<UpdateInfo | null> {
  if (isDisabled()) return null;

  try {
    const latest = await latestVersion(deps);
    if (!latest || !isNewer(latest, deps.current)) return null;
    return {
      current: deps.current,
      latest,
      upgradeCommand: 'npm install -g open-artifact@latest --registry https://registry.npmjs.org/',
    };
  } catch {
    // A version check is never worth failing a command over.
    return null;
  }
}

/** A short line for a person; printed to stderr so it never pollutes --json. */
export function updateNotice(update: UpdateInfo): string {
  return [
    ``,
    `  A newer open-artifact is out: ${update.latest} (you have ${update.current}).`,
    `  Upgrade with: ${update.upgradeCommand}`,
    ``,
  ].join('\n');
}

/** Switched off in CI and scripts, the same levers people already know. */
function isDisabled(): boolean {
  return Boolean(
    process.env.OPEN_ARTIFACT_NO_UPDATE_CHECK ||
      process.env.NO_UPDATE_NOTIFIER ||
      process.env.CI,
  );
}

async function latestVersion(deps: VersionCheckDeps): Promise<string | null> {
  const cached = readCache();
  if (cached && deps.now() - cached.checkedAt < CHECK_EVERY_MS) {
    return cached.latest;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await deps.fetchImpl(LATEST_URL, {
      signal: controller.signal,
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return cached?.latest ?? null;

    const body = (await response.json()) as { version?: unknown };
    const latest = typeof body.version === 'string' ? body.version : null;
    if (latest) writeCache({ checkedAt: deps.now(), latest });
    return latest ?? cached?.latest ?? null;
  } finally {
    clearTimeout(timer);
  }
}

function cachePath(): string {
  return join(configDir(), 'version-check.json');
}

function readCache(): Cache | null {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(), 'utf8')) as Partial<Cache>;
    if (typeof parsed.checkedAt === 'number' && typeof parsed.latest === 'string') {
      return { checkedAt: parsed.checkedAt, latest: parsed.latest };
    }
  } catch {
    // No cache, or an unreadable one. Treat as never checked.
  }
  return null;
}

function writeCache(cache: Cache): void {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(cachePath(), JSON.stringify(cache));
  } catch {
    // A cache we cannot write just means we check again next time.
  }
}

/**
 * Is `candidate` a later release than `current`? A plain numeric compare of the
 * dot-separated parts, which is all our versions are. Anything with a pre-release
 * suffix (a "-" part) is treated as not newer, so a beta never nags a stable user.
 */
export function isNewer(candidate: string, current: string): boolean {
  if (candidate.includes('-')) return false;
  const a = candidate.split('.').map((n) => Number(n));
  const b = current.split('.').map((n) => Number(n));
  if (a.some((n) => Number.isNaN(n)) || b.some((n) => Number.isNaN(n))) return false;

  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0;
    const right = b[i] ?? 0;
    if (left !== right) return left > right;
  }
  return false;
}
