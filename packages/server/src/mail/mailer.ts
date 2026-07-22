/**
 * Sending email.
 *
 * Three implementations, one interface:
 *
 * - SMTP, for production and for any self-hoster with a mail server. Amazon SES
 *   is just an SMTP host as far as this code is concerned.
 * - Log, for development with no mail server. Sign-in codes are printed to the
 *   log so someone can clone the repo and sign in within a minute, without
 *   configuring anything. It refuses to be used in production.
 * - Memory, for tests.
 *
 * A failed send never takes down the request that triggered it. Someone losing a
 * share notification is a worse experience than losing the share itself, but not
 * a reason to lose the share too.
 */

import nodemailer from 'nodemailer';
import type { SmtpConfig } from '../config.js';
import type { Logger } from '../logging.js';

export interface Email {
  to: string;
  subject: string;
  /** Plain text body. Always present: some people, and some clients, only read this. */
  text: string;
  /** HTML body. Optional. */
  html?: string;
}

export interface Mailer {
  send(email: Email): Promise<void>;
  /** Human-readable description of where mail is going, for the startup log. */
  readonly description: string;
}

export function createSmtpMailer(smtp: SmtpConfig, logger: Logger): Mailer {
  const transport = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
  });

  return {
    description: `SMTP at ${smtp.host}:${smtp.port}`,
    async send(email) {
      try {
        await transport.sendMail({
          from: smtp.from,
          to: email.to,
          subject: email.subject,
          text: email.text,
          ...(email.html ? { html: email.html } : {}),
        });
        logger.info('email sent', { to: redactEmail(email.to), subject: email.subject });
      } catch (error) {
        // Logged, not thrown: see the note at the top of this file.
        logger.error('email failed to send', {
          to: redactEmail(email.to),
          subject: email.subject,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  };
}

/**
 * Prints emails to the log instead of sending them. This is what makes the
 * first-run experience work without a mail server: run the server, ask for a
 * sign-in code, read it out of the log.
 */
export function createLogMailer(logger: Logger): Mailer {
  return {
    description: 'the server log (no mail server configured)',
    async send(email) {
      logger.info('email not sent, no mail server configured', {
        to: email.to,
        subject: email.subject,
      });
      // Written straight to the console, not through the structured logger: this
      // is meant to be read by a person, and a code buried in escaped JSON is not.
      process.stdout.write(
        `\n${'─'.repeat(72)}\n` +
          `Email to: ${email.to}\n` +
          `Subject:  ${email.subject}\n\n` +
          `${email.text}\n` +
          `${'─'.repeat(72)}\n\n`,
      );
    },
  };
}

export interface MemoryMailer extends Mailer {
  readonly sent: Email[];
  /** The most recent email sent to an address, or undefined. */
  lastTo(address: string): Email | undefined;
  clear(): void;
}

export function createMemoryMailer(): MemoryMailer {
  const sent: Email[] = [];
  return {
    description: 'memory (tests)',
    sent,
    async send(email) {
      sent.push(email);
    },
    lastTo(address) {
      return [...sent].reverse().find((email) => email.to.toLowerCase() === address.toLowerCase());
    },
    clear() {
      sent.length = 0;
    },
  };
}

/** Picks the right mailer for how the instance is configured. */
export function createMailer(
  smtp: SmtpConfig | null,
  logger: Logger,
): Mailer {
  return smtp === null ? createLogMailer(logger) : createSmtpMailer(smtp, logger);
}

/** Keeps addresses out of logs in a form that is still useful for support. */
function redactEmail(address: string): string {
  const [local = '', domain = ''] = address.split('@');
  const visible = local.slice(0, 2);
  return `${visible}${'*'.repeat(Math.max(local.length - 2, 1))}@${domain}`;
}
