import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { startTestSmtpServer, type TestSmtpServer } from './helpers/smtp.js';
import { createSmtpMailer, createMemoryMailer, createMailer } from '../src/mail/mailer.js';
import { createLogger, silentLogger } from '../src/logging.js';
import type { SmtpConfig } from '../src/config.js';

let smtp: TestSmtpServer;

beforeAll(async () => {
  smtp = await startTestSmtpServer();
});

afterAll(async () => {
  await smtp.stop();
});

beforeEach(() => {
  smtp.received.length = 0;
});

function smtpConfig(): SmtpConfig {
  return {
    host: '127.0.0.1',
    port: smtp.port,
    secure: false,
    user: null,
    password: null,
    from: 'Open Artifact <no-reply@example.com>',
  };
}

describe('sending over SMTP', () => {
  it('delivers a message with the configured sender, subject and body', async () => {
    const mailer = createSmtpMailer(smtpConfig(), silentLogger());
    await mailer.send({
      to: 'reader@example.com',
      subject: 'Your sign-in link',
      text: 'Open this link to sign in: https://artifacts.example.com/auth/verify?token=abc',
    });

    const [email] = await smtp.waitFor(1);
    expect(email?.from).toBe('no-reply@example.com');
    expect(email?.to).toEqual(['reader@example.com']);
    expect(email?.subject).toBe('Your sign-in link');
    expect(email?.text).toContain('https://artifacts.example.com/auth/verify?token=abc');
  });

  it('sends an HTML body alongside the plain text one when given both', async () => {
    const mailer = createSmtpMailer(smtpConfig(), silentLogger());
    await mailer.send({
      to: 'reader@example.com',
      subject: 'Shared with you',
      text: 'Plain version',
      html: '<p>HTML version</p>',
    });

    const [email] = await smtp.waitFor(1);
    expect(email?.text).toContain('Plain version');
    expect(String(email?.html)).toContain('HTML version');
  });

  it('does not fail the caller when the mail server is unreachable', async () => {
    const mailer = createSmtpMailer(
      { ...smtpConfig(), port: 1, host: '127.0.0.1' },
      silentLogger(),
    );
    // Sharing an artifact must still succeed even if the notification cannot go out.
    await expect(
      mailer.send({ to: 'reader@example.com', subject: 'x', text: 'y' }),
    ).resolves.toBeUndefined();
  });

  it('logs the failure so an operator can see mail is broken', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });

    const mailer = createSmtpMailer({ ...smtpConfig(), port: 1 }, logger);
    await mailer.send({ to: 'reader@example.com', subject: 'x', text: 'y' });

    expect(lines.some((line) => line.message === 'email failed to send')).toBe(true);
  });

  it('keeps full email addresses out of the log', async () => {
    const lines: Record<string, unknown>[] = [];
    const logger = createLogger({
      level: 'debug',
      write: (line) => lines.push(JSON.parse(line) as Record<string, unknown>),
    });

    const mailer = createSmtpMailer(smtpConfig(), logger);
    await mailer.send({ to: 'someone@example.com', subject: 'x', text: 'y' });
    await smtp.waitFor(1);

    const line = lines.find((entry) => entry.message === 'email sent');
    expect(line?.to).not.toBe('someone@example.com');
    // Still enough to recognise which address it was when helping someone.
    expect(String(line?.to)).toContain('@example.com');
    expect(String(line?.to)).toMatch(/^so\*+@example\.com$/);
  });
});

describe('choosing a mailer', () => {
  it('uses SMTP when a mail server is configured', () => {
    expect(createMailer(smtpConfig(), silentLogger()).description).toContain('SMTP');
  });

  it('falls back to the log when no mail server is configured', () => {
    // This is what lets someone clone the repo and sign in without setting
    // anything up: the sign-in link is printed where they can read it.
    expect(createMailer(null, silentLogger()).description).toContain('log');
  });
});

describe('the memory mailer used by tests', () => {
  it('records what was sent and finds the latest message for an address', async () => {
    const mailer = createMemoryMailer();
    await mailer.send({ to: 'a@example.com', subject: 'First', text: 'one' });
    await mailer.send({ to: 'a@example.com', subject: 'Second', text: 'two' });
    await mailer.send({ to: 'b@example.com', subject: 'Other', text: 'three' });

    expect(mailer.sent).toHaveLength(3);
    expect(mailer.lastTo('a@example.com')?.subject).toBe('Second');
    expect(mailer.lastTo('A@EXAMPLE.COM')?.subject).toBe('Second');
    expect(mailer.lastTo('nobody@example.com')).toBeUndefined();
  });
});
