/**
 * The sentence under the title in a link preview.
 *
 * When somebody drops an artifact URL into Slack or a message, the card should
 * say what the document is about. The title alone rarely does: "Q3 review" and
 * "Notes" tell a reader nothing they did not already guess from the link.
 *
 * So this reads the opening prose the way a person skimming would. It looks past
 * the title itself, and past the furniture that carries no meaning on its own —
 * a rule, a lone image, a table's pipes, the badges at the top of a README — for
 * the first real sentence or two.
 *
 * Nothing here decides whether a description may be shown. That is access, and
 * it is settled before this is ever called; see link-preview.ts.
 */

import type { ArtifactType } from '@open-artifact/shared';

/**
 * How much of the document to show.
 *
 * Slack shows around 300 characters and Twitter around 200, both cutting
 * mid-word when they run out. Cutting at 200 ourselves, on a word boundary and
 * with an ellipsis, is how the card reads as a sentence rather than as text that
 * ran out.
 */
export const MAX_DESCRIPTION_LENGTH = 200;

export function deriveDescription(
  type: ArtifactType,
  content: string,
  /** The document's title, so the description does not simply repeat it. */
  title: string,
): string | null {
  const prose = type === 'html' ? proseFromHtml(content) : proseFromMarkdown(content);
  return normalise(prose, title);
}

/**
 * The opening prose of a Markdown document.
 *
 * Walks the source a line at a time rather than parsing it. A preview does not
 * need an AST, and this has to cope with whatever an agent wrote, including
 * things that never parse cleanly.
 */
function proseFromMarkdown(content: string): string {
  const lines = content.split(/\r?\n/);
  const collected: string[] = [];
  let inFence = false;
  let inFrontMatter = false;

  for (const [index, raw] of lines.entries()) {
    const line = raw ?? '';
    const trimmed = line.trim();

    // Front matter is metadata for a build step, not something to read out.
    if (index === 0 && /^---\s*$/.test(trimmed)) {
      inFrontMatter = true;
      continue;
    }
    if (inFrontMatter) {
      if (/^(---|\.\.\.)\s*$/.test(trimmed)) inFrontMatter = false;
      continue;
    }

    // Code is not prose. Its contents would read as noise in a preview.
    if (/^\s{0,3}(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (trimmed.length === 0) {
      // A blank line after we have something is the end of the first paragraph,
      // which is as much as a card can show anyway.
      if (collected.length > 0) break;
      continue;
    }

    // Headings, rules and table rows: structure rather than sentences.
    if (/^\s{0,3}#{1,6}\s+/.test(trimmed)) continue;
    if (/^\s{0,3}(\*\s*){3,}$/.test(trimmed) || /^\s{0,3}(-\s*){3,}$/.test(trimmed)) continue;
    if (/^(=+|-+)$/.test(trimmed) && collected.length === 0) continue;
    if (trimmed.startsWith('|')) continue;
    // A line that is nothing but images: the badge row at the top of a README.
    if (/^(\s*!\[[^\]]*\]\([^)]*\)\s*)+$/.test(trimmed)) continue;

    collected.push(stripMarkdown(trimmed));
    // Two lines of prose is more than the 200 characters below will keep.
    if (collected.length >= 3) break;
  }

  return collected.join(' ');
}

/** The opening prose of an HTML document, with everything unreadable removed. */
function proseFromHtml(content: string): string {
  const withoutHead = content
    // Script and style hold code, and would otherwise arrive as text.
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head\b[\s\S]*?<\/head>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  // Prefer the first paragraph, which is usually the document's opening line.
  const paragraph = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(withoutHead);
  const source = paragraph?.[1] ?? withoutHead;
  return decodeEntities(source.replace(/<[^>]*>/g, ' '));
}

/** Removes the inline syntax that would otherwise show up as punctuation. */
function stripMarkdown(fragment: string): string {
  return fragment
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images keep their text
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^\s{0,3}>\s*/, '') // a block quote reads fine without its marker
    .replace(/^\s{0,3}([*+-]|\d+[.)])\s+/, ''); // so does a list item
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
  };
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      return fromCodePoint(parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith('#')) return fromCodePoint(parseInt(entity.slice(1), 10), match);
    return named[entity.toLowerCase()] ?? match;
  });
}

function fromCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

/**
 * Tidies the prose, and decides there is none worth showing.
 *
 * Null rather than an empty string, because the caller has a real generic
 * sentence to fall back on. A card with a blank line under the title looks
 * broken; one with the product's own description looks deliberate.
 */
function normalise(prose: string, title: string): string | null {
  const collapsed = prose.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return null;

  // A document whose first line is its title — common when the title came from
  // that very line — would show the same words twice on the card.
  if (collapsed.toLowerCase() === title.toLowerCase()) return null;

  if (collapsed.length <= MAX_DESCRIPTION_LENGTH) return collapsed;

  const cut = collapsed.slice(0, MAX_DESCRIPTION_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > MAX_DESCRIPTION_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd().replace(/[,;:.]$/, '')}…`;
}
