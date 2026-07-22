/**
 * A real SMTP server, in process, for tests.
 *
 * Mailpit runs in the development stack so a developer can look at emails in a
 * browser. Tests use this instead: it speaks the same protocol through the same
 * nodemailer transport, but starts in milliseconds and cannot leave a container
 * running when a test fails.
 */

import { SMTPServer } from 'smtp-server';
import { simpleParser, type ParsedMail } from 'mailparser';
import type { AddressInfo } from 'node:net';

export interface CapturedEmail {
  from: string;
  to: string[];
  subject: string;
  text: string;
  html: string | false;
}

export interface TestSmtpServer {
  port: number;
  received: CapturedEmail[];
  /** Resolves once at least `count` messages have arrived, or rejects on timeout. */
  waitFor(count: number, timeoutMs?: number): Promise<CapturedEmail[]>;
  stop(): Promise<void>;
}

export async function startTestSmtpServer(): Promise<TestSmtpServer> {
  const received: CapturedEmail[] = [];

  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    onData(stream, _session, callback) {
      simpleParser(stream)
        .then((parsed: ParsedMail) => {
          received.push({
            from: parsed.from?.value[0]?.address ?? '',
            to: addressesOf(parsed),
            subject: parsed.subject ?? '',
            text: parsed.text ?? '',
            html: parsed.html,
          });
          callback();
        })
        .catch((error: Error) => callback(error));
    },
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.server.address() as AddressInfo).port;

  return {
    port,
    received,
    async waitFor(count, timeoutMs = 5000) {
      const deadline = Date.now() + timeoutMs;
      while (received.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`expected ${count} emails, received ${received.length}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return received;
    },
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function addressesOf(parsed: ParsedMail): string[] {
  const to = parsed.to;
  if (!to) return [];
  const list = Array.isArray(to) ? to : [to];
  return list.flatMap((entry) => entry.value.map((value) => value.address ?? ''));
}
