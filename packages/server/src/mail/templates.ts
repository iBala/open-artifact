/**
 * What our emails say.
 *
 * Kept in one file because the tone should be consistent and because an operator
 * customising their instance should have one place to look.
 *
 * Every email has a plain text body. Plenty of people read mail as text, plenty of
 * clients block HTML, and a sign-in link that only works in a rich client is a
 * sign-in link that sometimes does not work.
 */

import { escapeHtml } from '../render/escape.js';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface MagicLinkEmailInput {
  link: string;
  /** True when following this link will create the account. */
  isNewAccount: boolean;
  /** The instance's own address, shown so people know where the link goes. */
  instanceName: string;
  expiryMinutes: number;
}

export function magicLinkEmail({
  link,
  isNewAccount,
  instanceName,
  expiryMinutes,
}: MagicLinkEmailInput): EmailContent {
  const subject = isNewAccount
    ? `Finish setting up your ${instanceName} account`
    : `Your ${instanceName} sign-in link`;

  const opening = isNewAccount
    ? `Open the link below to finish setting up your account on ${instanceName}.`
    : `Open the link below to sign in to ${instanceName}.`;

  const text = [
    opening,
    '',
    link,
    '',
    `The link works once and expires in ${expiryMinutes} minutes.`,
    '',
    'If you did not ask for this, you can ignore this email. Nobody can sign in without opening the link.',
  ].join('\n');

  return { subject, text, html: layout(subject, [paragraph(opening), button('Sign in', link), paragraph(`The link works once and expires in ${expiryMinutes} minutes.`), footnote('If you did not ask for this, you can ignore this email. Nobody can sign in without opening the link.')]) };
}

// ---------------------------------------------------------------------------
// The bits every email is built from
// ---------------------------------------------------------------------------

function layout(title: string, blocks: string[]): string {
  // Table-based and inline-styled on purpose: email clients are twenty years
  // behind browsers, and a layout that quietly collapses in Outlook is worse than
  // a plain one that works everywhere.
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head>
<body style="margin:0;padding:0;background:#f6f6f5;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f6f6f5;padding:32px 16px;">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a19;">
<tr><td>
${blocks.join('\n')}
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function paragraph(text: string): string {
  return `<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${escapeHtml(text)}</p>`;
}

function footnote(text: string): string {
  return `<p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#78716c;">${escapeHtml(text)}</p>`;
}

function button(label: string, href: string): string {
  return `<p style="margin:0 0 20px;">
  <a href="${escapeHtml(href)}" style="display:inline-block;background:#1a1a19;color:#ffffff;text-decoration:none;padding:11px 20px;border-radius:8px;font-size:15px;font-weight:500;">${escapeHtml(label)}</a>
</p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.6;color:#78716c;word-break:break-all;">Or paste this into your browser:<br>${escapeHtml(href)}</p>`;
}

export interface SharedArtifactEmailInput {
  /** The name or address of whoever shared it. */
  sharedBy: string;
  artifactTitle: string;
  url: string;
  instanceName: string;
  /** False when this person has never signed in here, which changes the wording. */
  recipientHasAccount: boolean;
}

/**
 * "Somebody shared something with you."
 *
 * The wording differs for somebody who has never used this instance: they need
 * to know that opening the link means signing in, and that signing in is just
 * another email. Otherwise the link looks like it leads to a wall.
 */
export function sharedArtifactEmail({
  sharedBy,
  artifactTitle,
  url,
  instanceName,
  recipientHasAccount,
}: SharedArtifactEmailInput): EmailContent {
  const subject = `${sharedBy} shared "${artifactTitle}" with you`;

  const opening = `${sharedBy} shared ${artifactTitle} with you on ${instanceName}.`;
  const howToOpen = recipientHasAccount
    ? 'Open it with the link below.'
    : 'Open the link below. You will be asked for your email address and sent a sign-in link, and then it will be there waiting for you.';

  const text = [opening, '', howToOpen, '', url].join('\n');

  return {
    subject,
    text,
    html: layout(subject, [
      paragraph(opening),
      button('Open it', url),
      recipientHasAccount ? '' : footnote(howToOpen),
    ]),
  };
}
