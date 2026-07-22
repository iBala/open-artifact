/**
 * Where a comment is attached, and how it survives the document changing.
 *
 * The problem: somebody comments on a sentence, the author republishes with
 * three paragraphs added above it, and the comment has to still be about that
 * sentence. Line numbers and character offsets are useless the moment anything
 * shifts.
 *
 * The approach here is deliberately literal. An anchor records three things:
 *
 *   the heading it sits under, by the id in the rendered page
 *   the exact text that was selected
 *   which occurrence of that text within that section, counting from zero
 *
 * On re-publish, we look for the same text under the same heading at the same
 * occurrence. Found, and the comment keeps its place no matter how much moved
 * around it. Not found, and it falls back to being about the document, marked so
 * the reader is told it lost its position.
 *
 * What this does not do, on purpose: fuzzy matching. Nothing here tries to find
 * "the nearest similar text" after an edit. A comment saying "this number is
 * wrong" that quietly reattaches itself to a different number is worse than one
 * that admits it lost its place, because the reader has no way to tell it
 * happened. Exact match or fall back, nothing in between.
 *
 * Text is compared after collapsing runs of whitespace, because a reflowed
 * paragraph is the same sentence to a reader and should be to us.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSlug from 'rehype-slug';
import { toString as hastToString } from 'hast-util-to-string';
import type { Root, RootContent, Element } from 'hast';

/** A comment about the artifact as a whole. */
export interface DocumentAnchor {
  kind: 'document';
}

/** A comment about a passage inside it. */
export interface TextAnchor {
  kind: 'text';
  /** The id of the heading the passage sits under. Null before the first heading. */
  headingId: string | null;
  /** The exact text that was selected. */
  snippet: string;
  /** Which occurrence of that snippet within the section, from zero. */
  occurrence: number;
}

export type Anchor = DocumentAnchor | TextAnchor;

export const DOCUMENT_ANCHOR: DocumentAnchor = { kind: 'document' };

/**
 * The shortest passage worth anchoring to.
 *
 * A one or two character selection appears everywhere, so its occurrence index
 * would shift on almost any edit and the comment would keep losing its place. A
 * few words is short enough to be natural and long enough to be findable.
 */
export const MIN_SNIPPET_LENGTH = 8;

/** Longer than this and it is a paragraph, not a passage. Kept to bound storage. */
export const MAX_SNIPPET_LENGTH = 2000;

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

export interface Section {
  /** The heading's id, or null for whatever comes before the first heading. */
  headingId: string | null;
  /** Everything under that heading as plain text, whitespace collapsed. */
  text: string;
}

/**
 * The document split into sections, one per heading.
 *
 * Built from the same rendering pipeline the reader sees, rather than from the
 * Markdown source. That matters: the reader selects rendered text, so `**bold**`
 * is `bold` to them. Matching against the source would never find it.
 */
export function sectionsOf(markdown: string): Section[] {
  const tree = toHast(markdown);
  const sections: Section[] = [];
  let current: { headingId: string | null; parts: string[] } = { headingId: null, parts: [] };

  for (const node of tree.children) {
    if (isHeading(node)) {
      sections.push({ headingId: current.headingId, text: collapse(current.parts.join(' ')) });
      current = { headingId: idOf(node), parts: [hastToString(node)] };
      continue;
    }
    current.parts.push(hastToString(node as never));
  }
  sections.push({ headingId: current.headingId, text: collapse(current.parts.join(' ')) });

  // The leading section only exists if there was text before the first heading.
  return sections.filter((section, index) => index > 0 || section.text.length > 0);
}

function toHast(markdown: string): Root {
  return unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .use(rehypeSlug)
    .runSync(unified().use(remarkParse).use(remarkGfm).parse(markdown)) as Root;
}

function isHeading(node: RootContent): node is Element {
  return node.type === 'element' && /^h[1-6]$/.test(node.tagName);
}

function idOf(node: Element): string | null {
  const id = node.properties?.id;
  return typeof id === 'string' ? id : null;
}

/** One space between words, so a reflowed paragraph still matches. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

// ---------------------------------------------------------------------------
// Making an anchor
// ---------------------------------------------------------------------------

export type AnchorProblem =
  | { ok: true; anchor: TextAnchor }
  | { ok: false; reason: 'too-short' | 'too-long' | 'not-found' | 'ambiguous' };

/**
 * Works out the anchor for a passage somebody selected.
 *
 * The occurrence is counted here rather than trusted from the caller, so a
 * client cannot store an index that was never true and drag the comment
 * somewhere it does not belong.
 */
export function anchorFor(
  markdown: string,
  headingId: string | null,
  rawSnippet: string,
): AnchorProblem {
  const snippet = collapse(rawSnippet);

  if (snippet.length < MIN_SNIPPET_LENGTH) return { ok: false, reason: 'too-short' };
  if (snippet.length > MAX_SNIPPET_LENGTH) return { ok: false, reason: 'too-long' };

  const section = sectionsOf(markdown).find((candidate) => candidate.headingId === headingId);
  if (!section) return { ok: false, reason: 'not-found' };

  const occurrences = countOccurrences(section.text, snippet);
  if (occurrences === 0) return { ok: false, reason: 'not-found' };

  // The first occurrence, unless the caller tells us which one they meant. The
  // UI does, by passing the occurrence it counted in the DOM.
  return { ok: true, anchor: { kind: 'text', headingId, snippet, occurrence: 0 } };
}

/**
 * Works out the anchor for a passage when the caller does not know, or care,
 * which heading it sits under.
 *
 * The browser knows the heading because it can see the page. An agent working
 * from a Markdown file does not, and making it derive heading slugs to leave a
 * comment would be a strange thing to ask. So when no heading is named, the
 * passage is looked for across the whole document.
 *
 * It is refused if the text appears under more than one heading. That is not an
 * inconvenience to smooth over: it means "comment on this text" genuinely does
 * not say which text, and guessing would attach the remark to the wrong place
 * exactly when it matters most.
 */
export function anchorAnywhere(markdown: string, rawSnippet: string, occurrence = 0): AnchorProblem {
  const snippet = collapse(rawSnippet);

  if (snippet.length < MIN_SNIPPET_LENGTH) return { ok: false, reason: 'too-short' };
  if (snippet.length > MAX_SNIPPET_LENGTH) return { ok: false, reason: 'too-long' };

  const matching = sectionsOf(markdown).filter((section) =>
    section.text.includes(snippet),
  );

  if (matching.length === 0) return { ok: false, reason: 'not-found' };
  if (matching.length > 1) return { ok: false, reason: 'ambiguous' };

  return anchorForOccurrence(markdown, matching[0]?.headingId ?? null, snippet, occurrence);
}

/** Same as anchorFor, but for a caller that knows which occurrence it selected. */
export function anchorForOccurrence(
  markdown: string,
  headingId: string | null,
  rawSnippet: string,
  occurrence: number,
): AnchorProblem {
  const built = anchorFor(markdown, headingId, rawSnippet);
  if (!built.ok) return built;

  const section = sectionsOf(markdown).find((candidate) => candidate.headingId === headingId);
  const total = section ? countOccurrences(section.text, built.anchor.snippet) : 0;

  if (!Number.isInteger(occurrence) || occurrence < 0 || occurrence >= total) {
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true, anchor: { ...built.anchor, occurrence } };
}

// ---------------------------------------------------------------------------
// Finding it again after the document changed
// ---------------------------------------------------------------------------

export type Relocation =
  /** The passage is still there. The anchor is unchanged. */
  | { found: true }
  /** It is gone. The thread becomes about the document, and is marked as lost. */
  | { found: false };

/**
 * Whether an anchor still points at something in this version of the document.
 *
 * Called on every re-publish, for every thread on the artifact.
 */
export function relocate(markdown: string, anchor: TextAnchor): Relocation {
  const section = sectionsOf(markdown).find(
    (candidate) => candidate.headingId === anchor.headingId,
  );
  if (!section) return { found: false };

  // The occurrence must still exist. If the document went from three copies of
  // this sentence to one, a comment on the third has nothing to point at, and
  // pointing it at the first would be inventing an answer.
  return { found: countOccurrences(section.text, anchor.snippet) > anchor.occurrence };
}

/** How many times a snippet appears, counting overlaps as one each. */
function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;

  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}
