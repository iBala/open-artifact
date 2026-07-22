/**
 * Working out an artifact's title from its content.
 *
 * The publisher can always set a title explicitly. When they do not, we pick the
 * most obvious thing a person would call the document: its <title>, its first
 * heading, or its first line. The result is what appears in the dashboard and in
 * share emails, so it is worth getting right rather than showing a file name.
 */

import type { ArtifactType } from '@open-artifact/shared';

export const MAX_TITLE_LENGTH = 200;
export const FALLBACK_TITLE = 'Untitled artifact';

export function deriveTitle(type: ArtifactType, content: string): string {
  const raw = type === 'html' ? titleFromHtml(content) : titleFromMarkdown(content);
  return normaliseTitle(raw);
}

function titleFromHtml(content: string): string | null {
  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(content);
  const fromTitleTag = titleTag?.[1] ? cleanHtml(titleTag[1]) : '';
  if (fromTitleTag) return fromTitleTag;

  const heading = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/i.exec(content);
  const fromHeading = heading?.[1] ? cleanHtml(heading[1]) : '';
  if (fromHeading) return fromHeading;

  return null;
}

function titleFromMarkdown(content: string): string | null {
  const lines = content.split(/\r?\n/);
  let inFence = false;
  let firstTextLine: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';

    // A heading inside a code fence is sample content, not the document's title.
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const atx = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (atx?.[1]) return cleanMarkdown(atx[1]);

    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    // Setext heading: text on one line, underlined by === or --- on the next.
    const next = (lines[index + 1] ?? '').trim();
    if (/^(=+|-+)$/.test(next) && next.length >= 2) return cleanMarkdown(trimmed);

    if (firstTextLine === null) firstTextLine = cleanMarkdown(trimmed);
  }

  return firstTextLine;
}

/** Removes tags and decodes the handful of entities that show up in titles. */
function cleanHtml(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ' ')).trim();
}

/** Removes the inline Markdown syntax that would otherwise show up as punctuation. */
function cleanMarkdown(fragment: string): string {
  return fragment
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // links and images keep their text
    .replace(/`+/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1')
    .replace(/^>\s*/, '');
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
      return safeFromCodePoint(parseInt(entity.slice(2), 16), match);
    }
    if (entity.startsWith('#')) {
      return safeFromCodePoint(parseInt(entity.slice(1), 10), match);
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(codePoint: number, fallback: string): string {
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return fallback;
  return String.fromCodePoint(codePoint);
}

function normaliseTitle(raw: string | null): string {
  const collapsed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) return FALLBACK_TITLE;
  if (collapsed.length <= MAX_TITLE_LENGTH) return collapsed;

  // Cut at a word boundary so a truncated title still reads as words.
  const cut = collapsed.slice(0, MAX_TITLE_LENGTH - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const body = lastSpace > MAX_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut;
  return `${body.trimEnd()}…`;
}
