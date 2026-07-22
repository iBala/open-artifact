import { describe, it, expect } from 'vitest';
import { loadConfig, ConfigError } from '../src/config.js';

/** The minimum env a self-hoster must set for the server to boot. */
const MINIMAL = {
  BASE_URL: 'https://artifacts.example.com',
  SESSION_SECRET: 'x'.repeat(32),
};

describe('loadConfig', () => {
  it('accepts the minimal required env', () => {
    const config = loadConfig(MINIMAL);
    expect(config.baseUrl).toBe('https://artifacts.example.com');
    expect(config.sessionSecret).toBe('x'.repeat(32));
  });

  it('applies documented defaults', () => {
    const config = loadConfig(MINIMAL);
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
    expect(config.logLevel).toBe('info');
    expect(config.maxArtifactBytes).toBe(5 * 1024 * 1024);
    expect(config.signupMode).toBe('invite-only');
    expect(config.databasePath).toBe('./data/open-artifact.db');
  });

  it('overrides defaults from env', () => {
    const config = loadConfig({
      ...MINIMAL,
      PORT: '8080',
      LOG_LEVEL: 'debug',
      MAX_ARTIFACT_BYTES: '1048576',
      DATABASE_PATH: '/var/lib/oa/oa.db',
    });
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('debug');
    expect(config.maxArtifactBytes).toBe(1048576);
    expect(config.databasePath).toBe('/var/lib/oa/oa.db');
  });

  it('names every missing required variable in one readable message', () => {
    let error: unknown;
    try {
      loadConfig({});
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ConfigError);
    const message = (error as ConfigError).message;
    expect(message).toContain('BASE_URL');
    expect(message).toContain('SESSION_SECRET');
    expect(message).toMatch(/required/i);
  });

  it('lists every problem at once rather than only the first', () => {
    const error = captureError({ ...MINIMAL, PORT: 'not-a-number', LOG_LEVEL: 'loud' });
    expect(error.message).toContain('PORT');
    expect(error.message).toContain('LOG_LEVEL');
  });

  it('rejects a BASE_URL that is not an absolute http(s) URL', () => {
    expect(captureError({ ...MINIMAL, BASE_URL: 'artifacts.example.com' }).message).toContain(
      'BASE_URL',
    );
  });

  it('strips a trailing slash from BASE_URL so link building stays simple', () => {
    expect(loadConfig({ ...MINIMAL, BASE_URL: 'https://a.example.com/' }).baseUrl).toBe(
      'https://a.example.com',
    );
  });

  it('rejects a session secret that is too short to be safe', () => {
    expect(captureError({ ...MINIMAL, SESSION_SECRET: 'short' }).message).toContain(
      'SESSION_SECRET',
    );
  });

  it('rejects a port outside the valid range', () => {
    expect(captureError({ ...MINIMAL, PORT: '70000' }).message).toContain('PORT');
  });

  it('rejects an unknown signup mode and names the valid ones', () => {
    const message = captureError({ ...MINIMAL, SIGNUP_MODE: 'everyone' }).message;
    expect(message).toContain('SIGNUP_MODE');
    expect(message).toContain('domain-allowlist');
  });

  it('requires an allowlist when signup mode is domain-allowlist', () => {
    expect(
      captureError({ ...MINIMAL, SIGNUP_MODE: 'domain-allowlist' }).message,
    ).toContain('SIGNUP_ALLOWED_DOMAINS');
  });

  it('parses and normalises the signup domain allowlist', () => {
    const config = loadConfig({
      ...MINIMAL,
      SIGNUP_MODE: 'domain-allowlist',
      SIGNUP_ALLOWED_DOMAINS: 'Example.com, zorp.one ,',
    });
    expect(config.signupAllowedDomains).toEqual(['example.com', 'zorp.one']);
  });

  it('reports Google sign-in as disabled when no credentials are set', () => {
    expect(loadConfig(MINIMAL).google).toBeNull();
  });

  it('enables Google sign-in when both credentials are set', () => {
    const config = loadConfig({
      ...MINIMAL,
      GOOGLE_CLIENT_ID: 'id.apps.googleusercontent.com',
      GOOGLE_CLIENT_SECRET: 'secret',
    });
    expect(config.google).toEqual({
      clientId: 'id.apps.googleusercontent.com',
      clientSecret: 'secret',
    });
  });

  it('rejects half-configured Google credentials instead of silently disabling', () => {
    expect(captureError({ ...MINIMAL, GOOGLE_CLIENT_ID: 'id' }).message).toContain(
      'GOOGLE_CLIENT_SECRET',
    );
  });

  it('reports email as unconfigured when no SMTP host is set', () => {
    expect(loadConfig(MINIMAL).smtp).toBeNull();
  });

  it('reads SMTP settings when a host is set', () => {
    const config = loadConfig({
      ...MINIMAL,
      SMTP_HOST: 'email-smtp.ap-south-1.amazonaws.com',
      SMTP_PORT: '587',
      SMTP_USER: 'user',
      SMTP_PASSWORD: 'pass',
      MAIL_FROM: 'Open Artifact <no-reply@example.com>',
    });
    expect(config.smtp).toEqual({
      host: 'email-smtp.ap-south-1.amazonaws.com',
      port: 587,
      secure: false,
      user: 'user',
      password: 'pass',
      from: 'Open Artifact <no-reply@example.com>',
    });
  });

  it('requires a from address whenever SMTP is configured', () => {
    expect(captureError({ ...MINIMAL, SMTP_HOST: 'smtp.example.com' }).message).toContain(
      'MAIL_FROM',
    );
  });

  it('requires SMTP in production, because sign-in emails cannot be sent without it', () => {
    const message = captureError({ ...MINIMAL, NODE_ENV: 'production' }).message;
    expect(message).toContain('SMTP_HOST');
  });

  it('does not require SMTP in development', () => {
    expect(loadConfig({ ...MINIMAL, NODE_ENV: 'development' }).smtp).toBeNull();
  });
});

function captureError(env: Record<string, string | undefined>): ConfigError {
  try {
    loadConfig(env);
  } catch (caught) {
    if (caught instanceof ConfigError) return caught;
    throw caught;
  }
  throw new Error('expected loadConfig to throw a ConfigError');
}
