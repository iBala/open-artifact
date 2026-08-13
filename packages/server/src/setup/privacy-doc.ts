/**
 * The privacy policy, written once as Markdown and served two ways: rendered at
 * /privacy for a person, raw at /privacy.md for anything that would rather read
 * the source. See routes/legal.ts.
 *
 * Every claim here is a claim about code in this repository, and it has to stay
 * that way. If you add a table, a third party, or a piece of telemetry, this
 * document is part of the change. The specific claims that are load-bearing:
 *
 * - No analytics, no trackers, no third-party scripts. Grep the repo for a
 *   telemetry SDK and you find nothing; the CSP in routes/web-app.ts would not
 *   let one load anyway.
 * - IP addresses are used for rate limiting and never stored. The windows in
 *   http/rate-limit.ts live in memory and no table has an address column.
 * - Closing an account really removes it. auth/account-deletion.ts deletes the
 *   artifacts, the sessions, the tokens and the grants in one transaction.
 *
 * The operator of an instance is not necessarily the author of this software, so
 * the parts that name a controller come from config rather than being written in.
 */

export interface PrivacyDocInput {
  /** Public origin of this instance. Identifies who the policy is about. */
  baseUrl: string;
  /**
   * Where a person asks a privacy question, from PRIVACY_CONTACT_EMAIL. Null when
   * the operator has not set one, and the document then says so plainly rather
   * than inventing an address that bounces.
   */
  contactEmail: string | null;
  /** Whether sign-in codes and notifications leave the instance over SMTP. */
  sendsEmail: boolean;
}

export function privacyDoc(input: PrivacyDocInput): string {
  const host = hostOf(input.baseUrl);

  return `# Privacy policy

**Instance:** ${host} · **Last updated:** 13 August 2026

This policy describes what ${host} does with your information. ${host} runs
[Open Artifact](https://github.com/iBala/open-artifact), which anyone can host
themselves — if you reached this page from a different address, that operator is
responsible for their own instance, not this one.

## What this service is

Open Artifact turns a document — Markdown or HTML — into a web page at a stable
URL, so it can be shared with named people and commented on. You publish from an
assistant or the command line; the people you share with read and comment in a
browser.

## What is collected

**Your email address.** This is the account. It is how you sign in, how other
people share a document with you, and where notifications go. There is no
password: signing in emails you a six-digit code.

**A display name, if you set one.** Optional, and shown next to your comments.

**What you publish.** The document's content, its title, its type, and every
earlier version, so a document can be republished without losing what it said
before.

**Who you share with.** The email address of each person a document is shared
with, and any email domain a document is opened to.

**Comments.** What was written, who wrote it, and the passage or element it was
attached to.

**Sessions and connections.** One row for each browser you are signed in on and
each assistant you have connected, holding a label you chose, when it was created
and when it was last used. Credentials themselves are stored only as hashes: the
raw session token, CLI token, sign-in code and OAuth code exist in the database
as a hash and nowhere else.

## What is not collected

**No analytics and no trackers.** There is no analytics SDK, no session
recording, no advertising pixel and no third-party script of any kind. The
content security policy the app is served under would block one.

**No IP address logging.** Addresses are read to rate-limit requests and are held
in memory for the length of the rate-limit window. No table stores an address.

**No cookies except the one that signs you in.** There is a session cookie, and a
short-lived one during Google sign-in if the operator has enabled it. There are
no advertising or analytics cookies, so there is no consent banner to click.

**Nothing is sold, and nothing is shared for advertising.** Ever.

**Your documents are not training data.** Nobody reads them to build a model,
here or anywhere downstream.

## Who else sees it

${
  input.sendsEmail
    ? `**A mail provider.** Sign-in codes and share notifications are sent over SMTP,
so the provider ${host} sends through handles the recipient address and the
message. That is the only third party in the path.`
    : `**Nobody.** This instance has no mail provider configured, so nothing leaves
it over email.`
}

**The people you share with.** A document is private when published. It becomes
visible to somebody only when you share it with their address, open it to an
email domain, or make it public. Making a document public means anyone with the
link can read it, and search engines may index it.

**An assistant you connect.** A connected assistant acts as you, within limits:
it can publish, update and share its own documents and read the comments on them.
It cannot delete anything, make anything public, or read documents other people
shared with you.

## How long it is kept

Documents, comments and shares are kept until you delete them. Sign-in codes
expire in minutes. Sessions and tokens carry their own expiry and are removed
when they are revoked or when you close your account.

## Deleting your account

You can close your account yourself, from **Settings → Sessions** in the web app.
It is not a flag on a row: closing an account deletes your documents and every
version of them, the comments on them, the shares, the notifications, your
sessions and every connected assistant's access, in a single transaction.
Comments you left on documents belonging to other people are detached from you
rather than removed, because deleting them would cut holes in a conversation
somebody else is still having.

## Your rights

You can see everything held about you through the app, correct your display name,
pull back any document you published with \`open-artifact get\`, and delete your
account and its contents yourself. If you would rather somebody did it for you, or
you want to know what is held before you decide, ask.

## Security

Credentials are stored as hashes. Published HTML runs in a sandboxed frame at an
opaque origin with a content security policy that permits no network access, so a
document cannot reach your session or call out to another site. Traffic is served
over TLS.

## Changes

Material changes will be reflected here with a new date at the top of the page.

## Asking

${
  input.contactEmail
    ? `Privacy questions, requests and complaints: **${input.contactEmail}**.`
    : `The operator of this instance has not published a contact address. Whoever
runs ${host} is responsible for answering privacy questions about it.`
}
`;
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}
