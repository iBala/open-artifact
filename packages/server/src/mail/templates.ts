/**
 * What our emails say.
 *
 * Kept in one file because the tone should be consistent and because an operator
 * customising their instance should have one place to look.
 *
 * Every email has a plain text body. Plenty of people read mail as text, plenty of
 * clients block HTML, and a sign-in code that only shows up in a rich client is a
 * sign-in code that sometimes does not arrive.
 */

import { escapeHtml } from '../render/escape.js';
import { formatSignInCode } from '../auth/codes.js';

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

export interface SignInCodeEmailInput {
  /** Six digits, unformatted. This template does the grouping. */
  code: string;
  /** True when using this code will create the account. */
  isNewAccount: boolean;
  /** The instance's own address, so people know which sign-in this answers. */
  instanceName: string;
  expiryMinutes: number;
}

/**
 * "Here is your sign-in code."
 *
 * The code is the only thing in this email that matters, so it is the first thing
 * in the subject line, sitting on its own line in the text body and set large in
 * the HTML one. Somebody glancing at a notification should be able to read the
 * digits without opening anything.
 *
 * It is written grouped, as "428 913", because six digits run together are read
 * back wrong. What the person types is normalised before it is checked, so the
 * space costs nothing.
 */
export function signInCodeEmail({
  code,
  isNewAccount,
  instanceName,
  expiryMinutes,
}: SignInCodeEmailInput): EmailContent {
  const grouped = formatSignInCode(code);
  const subject = `${grouped} is your ${instanceName} sign-in code`;

  const opening = isNewAccount
    ? `Enter this code to finish setting up your account on ${instanceName}.`
    : `Enter this code to sign in to ${instanceName}.`;

  const instruction = `Type it into the tab you started signing in from. It works once and expires in ${expiryMinutes} minutes.`;
  const reassurance =
    'If you did not ask for this, you can ignore this email. Nobody can sign in without the code.';

  const text = [opening, '', `    ${grouped}`, '', instruction, '', reassurance].join('\n');

  return {
    subject,
    text,
    html: layout(subject, [
      paragraph(opening),
      codeBlock(grouped),
      paragraph(instruction),
      footnote(reassurance),
    ]),
  };
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

/**
 * The code itself, set as large as an email client can be trusted to render.
 *
 * Monospaced and spaced out so no two digits blur together, and no link on or
 * near it: the whole point of this email is that there is nothing to click.
 */
function codeBlock(code: string): string {
  return `<p style="margin:0 0 20px;padding:20px 0;text-align:center;background:#f6f6f5;border-radius:10px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:34px;line-height:1.2;font-weight:600;letter-spacing:0.12em;color:#1a1a19;">${escapeHtml(code)}</p>`;
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
    : 'Open the link below. You will be asked for your email address and sent a sign-in code, and then it will be there waiting for you.';

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

export interface MentionEmailInput {
  /** Who named them. */
  mentionedBy: string;
  artifactTitle: string;
  /** What they said, trimmed to something readable in an inbox. */
  excerpt: string;
  /** Links straight to the comment, not just the artifact. */
  url: string;
  instanceName: string;
}

/**
 * "Somebody mentioned you."
 *
 * Carries an excerpt of what was actually said, because an email that only says
 * you were mentioned makes you open a tab to find out whether it mattered. The
 * link goes to the comment rather than the top of the document.
 */
export function mentionEmail({
  mentionedBy,
  artifactTitle,
  excerpt,
  url,
  instanceName,
}: MentionEmailInput): EmailContent {
  const subject = `${mentionedBy} mentioned you on "${artifactTitle}"`;
  const opening = `${mentionedBy} mentioned you in a comment on ${artifactTitle}, on ${instanceName}.`;

  const text = [opening, '', `"${excerpt}"`, '', url].join('\n');

  return {
    subject,
    text,
    html: layout(subject, [
      paragraph(opening),
      quote(excerpt),
      button('Open the comment', url),
    ]),
  };
}

function quote(text: string): string {
  return `<p style="margin:0 0 20px;padding:10px 14px;border-left:2px solid #d6d3d1;font-size:14px;line-height:1.6;color:#57534e;">${escapeHtml(text)}</p>`;
}
