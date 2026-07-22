/**
 * Boot-time configuration.
 *
 * Self-host failures are almost always environment typos. This module turns them
 * into one readable error at boot instead of a mystery at runtime, and it reports
 * every problem at once so an operator fixes their .env in a single pass.
 *
 * Every supported variable is documented in deploy/env.example.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type SignupMode = 'open' | 'invite-only' | 'domain-allowlist';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null;
  from: string;
}

export interface GoogleConfig {
  clientId: string;
  clientSecret: string;
}

export interface Config {
  nodeEnv: 'development' | 'test' | 'production';
  isProduction: boolean;
  port: number;
  /** Public origin of this instance, no trailing slash. All links are built from it. */
  baseUrl: string;
  databasePath: string;
  sessionSecret: string;
  logLevel: LogLevel;
  maxArtifactBytes: number;
  signupMode: SignupMode;
  signupAllowedDomains: string[];
  /** Null when Google sign-in is not configured; the login page then offers email codes only. */
  google: GoogleConfig | null;
  /** Null when no mail server is configured; only allowed outside production. */
  smtp: SmtpConfig | null;

  /**
   * How much one person may keep and how fast they may do things.
   *
   * Defaults are sized for a team instance: generous enough that nobody working
   * normally will ever see them, tight enough that an agent stuck in a loop
   * stops before it fills a disk.
   */
  limits: {
    /** Artifacts one person may have at once. */
    artifactsPerUser: number;
    /** Total bytes of artifact content one person may keep. */
    storageBytesPerUser: number;
    /** Publishes or updates per hour, per person. */
    publishesPerHour: number;
    /** Comments per hour, per person. */
    commentsPerHour: number;
    /** Sign-in codes per hour, per address asking. Sends real email, so tightest. */
    authRequestsPerHour: number;
    /** New shares per hour, per person. Sends real email, so kept low. */
    sharesPerHour: number;
  };
}

const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const SIGNUP_MODES: SignupMode[] = ['open', 'invite-only', 'domain-allowlist'];
const NODE_ENVS = ['development', 'test', 'production'] as const;

const MIN_SESSION_SECRET_LENGTH = 32;

export class ConfigError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(
      `Configuration is not valid. Fix the following and start again:\n` +
        problems.map((problem) => `  - ${problem}`).join('\n'),
    );
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

type Env = Record<string, string | undefined>;

/** Collects problems so the operator sees all of them in one boot attempt. */
class Problems {
  private readonly list: string[] = [];

  add(message: string): void {
    this.list.push(message);
  }

  throwIfAny(): void {
    if (this.list.length > 0) throw new ConfigError(this.list);
  }
}

function read(env: Env, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

function readInteger(
  env: Env,
  key: string,
  fallback: number,
  problems: Problems,
  bounds: { min: number; max: number },
): number {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.add(`${key} must be a whole number, got "${raw}".`);
    return fallback;
  }
  if (value < bounds.min || value > bounds.max) {
    problems.add(`${key} must be between ${bounds.min} and ${bounds.max}, got ${value}.`);
    return fallback;
  }
  return value;
}

function readChoice<T extends string>(
  env: Env,
  key: string,
  choices: readonly T[],
  fallback: T,
  problems: Problems,
): T {
  const raw = read(env, key);
  if (raw === undefined) return fallback;
  if (!(choices as readonly string[]).includes(raw)) {
    problems.add(`${key} must be one of: ${choices.join(', ')}. Got "${raw}".`);
    return fallback;
  }
  return raw as T;
}

function readBaseUrl(env: Env, problems: Problems): string {
  const raw = read(env, 'BASE_URL');
  if (raw === undefined) {
    problems.add(
      'BASE_URL is required. Set it to the public address of this instance, for example https://artifacts.example.com',
    );
    return '';
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    problems.add(`BASE_URL must be a full URL including http:// or https://. Got "${raw}".`);
    return '';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    problems.add(`BASE_URL must use http or https. Got "${parsed.protocol}".`);
    return '';
  }
  return raw.replace(/\/+$/, '');
}

function readSignupDomains(env: Env, mode: SignupMode, problems: Problems): string[] {
  const raw = read(env, 'SIGNUP_ALLOWED_DOMAINS');
  const domains = (raw ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry.length > 0);
  if (mode === 'domain-allowlist' && domains.length === 0) {
    problems.add(
      'SIGNUP_ALLOWED_DOMAINS is required when SIGNUP_MODE is domain-allowlist. Give a comma separated list, for example: example.com,zorp.one',
    );
  }
  return domains;
}

function readGoogle(env: Env, problems: Problems): GoogleConfig | null {
  const clientId = read(env, 'GOOGLE_CLIENT_ID');
  const clientSecret = read(env, 'GOOGLE_CLIENT_SECRET');
  if (clientId === undefined && clientSecret === undefined) return null;
  if (clientId === undefined) {
    problems.add('GOOGLE_CLIENT_ID is required when GOOGLE_CLIENT_SECRET is set.');
    return null;
  }
  if (clientSecret === undefined) {
    problems.add('GOOGLE_CLIENT_SECRET is required when GOOGLE_CLIENT_ID is set.');
    return null;
  }
  return { clientId, clientSecret };
}

function readSmtp(env: Env, isProduction: boolean, problems: Problems): SmtpConfig | null {
  const host = read(env, 'SMTP_HOST');
  if (host === undefined) {
    if (isProduction) {
      problems.add(
        'SMTP_HOST is required in production. Sign-in links and share notifications are sent by email, so the server will not start without a mail server.',
      );
    }
    return null;
  }
  const port = readInteger(env, 'SMTP_PORT', 587, problems, { min: 1, max: 65535 });
  const from = read(env, 'MAIL_FROM');
  if (from === undefined) {
    problems.add(
      'MAIL_FROM is required when SMTP_HOST is set. Use the address emails are sent from, for example: Open Artifact <no-reply@example.com>',
    );
  }
  return {
    host,
    port,
    // Port 465 is implicit TLS; 587 and 25 upgrade with STARTTLS.
    secure: read(env, 'SMTP_SECURE') === 'true' || port === 465,
    user: read(env, 'SMTP_USER') ?? null,
    password: read(env, 'SMTP_PASSWORD') ?? null,
    from: from ?? '',
  };
}

function readSessionSecret(env: Env, problems: Problems): string {
  const secret = read(env, 'SESSION_SECRET');
  if (secret === undefined) {
    problems.add(
      `SESSION_SECRET is required. Generate one with: openssl rand -hex 32 (at least ${MIN_SESSION_SECRET_LENGTH} characters).`,
    );
    return '';
  }
  if (secret.length < MIN_SESSION_SECRET_LENGTH) {
    problems.add(
      `SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters. Generate one with: openssl rand -hex 32`,
    );
  }
  return secret;
}

/**
 * Parses and validates the environment. Throws ConfigError listing every problem.
 * Pure: takes the environment as an argument so tests never touch process.env.
 */
export function loadConfig(env: Env): Config {
  const problems = new Problems();

  const nodeEnv = readChoice(env, 'NODE_ENV', NODE_ENVS, 'development', problems);
  const isProduction = nodeEnv === 'production';
  const signupMode = readChoice(env, 'SIGNUP_MODE', SIGNUP_MODES, 'invite-only', problems);

  const config: Config = {
    nodeEnv,
    isProduction,
    port: readInteger(env, 'PORT', 3000, problems, { min: 1, max: 65535 }),
    baseUrl: readBaseUrl(env, problems),
    databasePath: read(env, 'DATABASE_PATH') ?? './data/open-artifact.db',
    sessionSecret: readSessionSecret(env, problems),
    logLevel: readChoice(env, 'LOG_LEVEL', LOG_LEVELS, 'info', problems),
    maxArtifactBytes: readInteger(env, 'MAX_ARTIFACT_BYTES', 5 * 1024 * 1024, problems, {
      min: 1024,
      max: 512 * 1024 * 1024,
    }),
    signupMode,
    signupAllowedDomains: readSignupDomains(env, signupMode, problems),
    google: readGoogle(env, problems),
    smtp: readSmtp(env, isProduction, problems),
    limits: {
      artifactsPerUser: readInteger(env, 'MAX_ARTIFACTS_PER_USER', 500, problems, {
        min: 1,
        max: 1_000_000,
      }),
      storageBytesPerUser: readInteger(
        env,
        'MAX_STORAGE_BYTES_PER_USER',
        500 * 1024 * 1024,
        problems,
        { min: 1024, max: 1024 * 1024 * 1024 * 100 },
      ),
      publishesPerHour: readInteger(env, 'MAX_PUBLISHES_PER_HOUR', 120, problems, {
        min: 1,
        max: 100_000,
      }),
      commentsPerHour: readInteger(env, 'MAX_COMMENTS_PER_HOUR', 300, problems, {
        min: 1,
        max: 100_000,
      }),
      authRequestsPerHour: readInteger(env, 'MAX_AUTH_REQUESTS_PER_HOUR', 20, problems, {
        min: 1,
        max: 10_000,
      }),
      sharesPerHour: readInteger(env, 'MAX_SHARES_PER_HOUR', 30, problems, {
        min: 1,
        max: 10_000,
      }),
    },
  };

  problems.throwIfAny();
  return config;
}
