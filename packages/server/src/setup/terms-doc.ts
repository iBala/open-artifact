/**
 * The terms of use, written once as Markdown and served two ways: rendered at
 * /terms for a person, raw at /terms.md for anything that would rather read the
 * source. See routes/legal.ts, and setup/privacy-doc.ts, which this mirrors.
 *
 * These are terms for *using a hosted instance*. They are not the software
 * licence: the code is under the Sustainable Use License in LICENSE, and running
 * your own instance is governed by that, not by this. An operator's relationship
 * with the people signing into their instance is what this covers.
 *
 * Written to describe how the software actually behaves — the storage limits are
 * real limits enforced in config.ts, and the deletion promise is the one
 * auth/account-deletion.ts keeps. Where a term is the operator's choice rather
 * than the software's behaviour, it comes from config.
 */

export interface TermsDocInput {
  /** Public origin of this instance. Identifies who the terms are for. */
  baseUrl: string;
  /** Where questions go, from PRIVACY_CONTACT_EMAIL. Null when unset. */
  contactEmail: string | null;
}

export function termsDoc(input: TermsDocInput): string {
  const host = hostOf(input.baseUrl);

  return `# Terms of use

**Instance:** ${host} · **Last updated:** 14 August 2026

These terms cover using ${host}. They are not the software licence — Open
Artifact's source is under the [Sustainable Use License](https://github.com/iBala/open-artifact/blob/main/LICENSE),
and running your own copy is governed by that instead.

## What you are agreeing to

Signing in means you accept these terms. If you do not, do not sign in.

## What the service does

Open Artifact publishes a document you write — Markdown or HTML — as a web page
at a stable URL, lets you control who can see it, and collects comments from the
people you share it with. That is the whole of it.

## Your documents stay yours

You keep every right you had in what you publish. Nothing here transfers
ownership, and nothing you publish is used to train a model, here or anywhere
downstream.

What you grant ${host} is narrow and practical: permission to store your
documents, render them, and show them to the people you have shared them with.
That permission exists so the service can do the thing you asked it to do, and it
ends when you delete the document.

## What you may not publish

Do not use ${host} to publish:

- anything unlawful, or anything that infringes somebody else's rights
- material that sexualises children, incites violence, or harasses a person
- malware, phishing pages, or anything designed to deceive a reader into giving
  up credentials
- content that impersonates a person or an organisation

Published HTML runs sandboxed, with no network access and no reach into a
reader's session. Attempting to break out of that sandbox, or to reach another
account's documents, is a breach of these terms.

## Reliability

This service is provided as it is, with no guarantee that it will be available,
uninterrupted, or free of faults. There is no uptime commitment.

**Keep your own copies of anything you cannot afford to lose.** Documents are
published from files you already have; the published page is a copy, not a
backup, and it should not be the only place something exists.

## Limits

An instance sets how much one account may store and how quickly it may act, and
${host} enforces those limits. Going around them — automating sign-ups, or
spreading usage across accounts to defeat a limit — is a breach of these terms.

## Ending it

You can close your account whenever you like, and doing so deletes your
documents, their versions, the shares and your sessions. See the
[privacy policy](/privacy) for exactly what that removes.

${host} may suspend or close an account that breaches these terms. Where it is
reasonable to do so, you will be told why and given a chance to put it right
first; where the breach is causing active harm, that may happen immediately.

The service may itself be discontinued. If that happens you will be given
reasonable notice and a way to retrieve your documents.

## Liability

To the extent the law allows, ${host} is not liable for indirect or
consequential loss, for lost profits, or for lost data — which is why the
paragraph about keeping your own copies is there.

Nothing here limits liability that cannot lawfully be limited.

## Changes

These terms may change. Material changes will appear here with a new date at the
top, and continuing to use the service afterwards means accepting them.

## Asking

${
  input.contactEmail
    ? `Questions about these terms: **${input.contactEmail}**.`
    : `The operator of this instance has not published a contact address.`
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
