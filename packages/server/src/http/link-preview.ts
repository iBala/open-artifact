/**
 * What an artifact URL says about itself when it is pasted somewhere.
 *
 * Slack, iMessage, X and the rest fetch the page and read its meta tags to draw
 * a card. Until now every artifact URL drew the same card — the product's own
 * pitch — so sharing a document told the reader nothing about the document.
 *
 * ## The rule this file exists to hold
 *
 * An unfurler arrives with no cookies. It is not signed in, it never will be,
 * and whatever these tags say is shown to everybody who can see the message the
 * link was pasted into. So the ONLY thing that may decide what a card says is
 * whether the artifact is public. Never who is asking.
 *
 * That is not a simplification, it is the safety property. If the card varied by
 * session, an owner's browser and a shared cache between it and the internet
 * would be one misconfiguration away from handing a stranger a private
 * document's title. Reading `isPublic` and nothing else makes that impossible
 * rather than unlikely.
 *
 *   public, live      ->  the document's own title and opening line
 *   anything else     ->  that an artifact is here, and nothing about it
 *   no such artifact  ->  the site's ordinary card
 *
 * ## What the middle row gives away, and why that was chosen
 *
 * A private artifact's card confirms the URL belongs to something real, which
 * the generic card would not. That was a deliberate call: slugs are 24 random
 * characters, about 141 bits (see ids.ts), so nobody reaches this page by
 * guessing. Confirming existence to somebody already holding the URL tells them
 * what the sign-in page they are about to see would tell them anyway.
 *
 * It does mean a leaked URL — a forwarded mail, a proxy log — now says "this is
 * a real private artifact" rather than nothing at all. That is the whole of the
 * trade, and it buys recipients of a legitimately shared link a card that does
 * not look like a broken advert.
 */

import { escapeHtml } from '../render/escape.js';
import { deriveDescription } from '../artifacts/description.js';
import { isExpired } from '@open-artifact/shared';
import type { ArtifactDetail } from '../artifacts/service.js';

/** What the card should say, once access has been settled. */
export interface PreviewCopy {
  title: string;
  description: string;
}

/** The card for an artifact that exists but this viewer may not read. */
export const PRIVATE_PREVIEW: PreviewCopy = {
  title: 'A private artifact',
  description:
    'This document is not public. Sign in to open it — only the people it is shared with can read it.',
};

/** The card for an artifact whose link has run out. */
export const EXPIRED_PREVIEW: PreviewCopy = {
  title: 'This link has expired',
  description:
    'The artifact this link pointed to is no longer shared. Ask whoever sent it for a new link.',
};

/**
 * What the card for this artifact should say.
 *
 * Takes the row and the current time, and nothing about the person asking —
 * see the note at the top of this file, which is the reason there is no
 * principal parameter to pass by mistake.
 */
export function previewFor(artifact: ArtifactDetail, now: string): PreviewCopy {
  if (isExpired(artifact.expiresAt, now)) return EXPIRED_PREVIEW;
  if (!artifact.isPublic) return PRIVATE_PREVIEW;

  const description = deriveDescription(artifact.type, artifact.content, artifact.title);
  return {
    title: artifact.title,
    // A public document with nothing readable in it — an empty file, a page of
    // images — falls back to saying what it is rather than showing a blank line.
    description: description ?? `A ${artifact.type === 'html' ? 'page' : 'document'} on Open Artifact.`,
  };
}

/**
 * The app shell with its preview tags rewritten.
 *
 * Only the meta tags and the document title change. The inline script that
 * settles the theme is left exactly as it was, because its SHA-256 is in the
 * Content-Security-Policy this response carries: touching it would take the
 * page down rather than merely look wrong.
 */
export function applyPreview(shell: string, copy: PreviewCopy, canonicalUrl: string): string {
  const title = escapeHtml(copy.title);
  const description = escapeHtml(copy.description);

  let html = shell.replace(/<title>[\s\S]*?<\/title>/i, `<title>${title}</title>`);
  html = replaceMeta(html, 'name', 'description', description);
  html = replaceMeta(html, 'property', 'og:title', title);
  html = replaceMeta(html, 'property', 'og:description', description);
  html = replaceMeta(html, 'property', 'og:url', escapeHtml(canonicalUrl));
  html = replaceMeta(html, 'name', 'twitter:title', title);
  html = replaceMeta(html, 'name', 'twitter:description', description);
  return html;
}

/** Swaps the content of one meta tag, however it happens to be wrapped. */
function replaceMeta(html: string, attribute: 'name' | 'property', key: string, value: string): string {
  // The shell writes some of these across several lines, so the pattern has to
  // cross newlines. Anchored on the attribute pair so it can only ever match the
  // one tag it was asked for.
  const pattern = new RegExp(`<meta\\s+${attribute}="${escapeRegExp(key)}"[\\s\\S]*?/>`, 'i');
  return html.replace(pattern, `<meta ${attribute}="${key}" content="${value}" />`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
