/**
 * Structured logging.
 *
 * Self-hosters debug their instance with `docker compose logs`. One JSON object
 * per line so those logs can be read by eye and also piped into anything.
 *
 * Nothing here logs artifact content, email bodies, tokens or cookies. Log lines
 * end up in other people's terminals and log aggregators.
 */

import type { LogLevel } from './config.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Returns a logger that stamps the given fields onto every line, e.g. a request id. */
  child(fields: Record<string, unknown>): Logger;
}

export interface CreateLoggerOptions {
  level: LogLevel;
  /** Where lines go. Swapped out in tests. */
  write?: (line: string) => void;
  /** Fields stamped onto every line from this logger. */
  base?: Record<string, unknown>;
  /** Overridable so tests get stable output. */
  now?: () => string;
}

export function createLogger({
  level,
  write = (line) => process.stdout.write(`${line}\n`),
  base = {},
  now = () => new Date().toISOString(),
}: CreateLoggerOptions): Logger {
  const threshold = LEVEL_ORDER[level];

  function log(entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    write(JSON.stringify({ time: now(), level: entryLevel, message, ...base, ...fields }));
  }

  return {
    debug: (message, fields) => log('debug', message, fields),
    info: (message, fields) => log('info', message, fields),
    warn: (message, fields) => log('warn', message, fields),
    error: (message, fields) => log('error', message, fields),
    child: (fields) => createLogger({ level, write, base: { ...base, ...fields }, now }),
  };
}

/** A logger that discards everything, for tests that do not assert on logs. */
export function silentLogger(): Logger {
  return createLogger({ level: 'error', write: () => {} });
}
