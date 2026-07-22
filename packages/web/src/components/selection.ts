/**
 * Turning something somebody highlighted into an anchor the server will accept.
 *
 * The server records three things about a passage: the heading it sits under,
 * the exact text, and which occurrence of that text within the section. This
 * file works those out from a live DOM selection, and it has to agree with the
 * server exactly, because the server recounts the occurrence and refuses
 * anything that does not match what it finds in the artifact.
 *
 * Two things make the agreement hold:
 *
 * - Whitespace is collapsed the same way on both sides, so a selection spanning
 *   a line break matches text the server sees as one line.
 * - The occurrence is counted over the same slice of text the server calls a
 *   section: everything from one heading up to the next.
 *
 * If you change how either side collapses whitespace or divides sections, change
 * both, or every positioned comment starts being refused.
 */

export interface SelectedPassage {
  /** The id of the heading it sits under. Null before the first heading. */
  headingId: string | null;
  /** The text, whitespace collapsed. */
  snippet: string;
  /** Which occurrence of that text within the section, from zero. */
  occurrence: number;
  /** Where to put the popover, in viewport coordinates. */
  rect: { top: number; left: number; width: number; height: number };
}

/** Matches the server's `collapse`. Both sides must agree. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

const HEADINGS = 'h1, h2, h3, h4, h5, h6';

/**
 * Reads the current selection, or null when there is nothing usable.
 *
 * Returns null rather than throwing for every ordinary case: no selection, a
 * collapsed caret, a selection outside the article, or one that spans out of
 * the article entirely.
 */
export function readSelection(article: HTMLElement): SelectedPassage | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  const snippet = collapse(range.toString());
  if (snippet.length === 0) return null;

  // Both ends have to be inside the document being commented on. A selection
  // that started in the sidebar and ran into the article is not a passage.
  if (!article.contains(range.startContainer) || !article.contains(range.endContainer)) {
    return null;
  }

  const headingId = headingAbove(article, range.startContainer);
  const occurrence = occurrenceOf(article, headingId, snippet, range);
  if (occurrence === null) return null;

  const rect = range.getBoundingClientRect();
  return {
    headingId,
    snippet,
    occurrence,
    rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
  };
}

/** The nearest heading before a node, by document order. */
function headingAbove(article: HTMLElement, node: Node): string | null {
  const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
  if (!element) return null;

  const headings = [...article.querySelectorAll(HEADINGS)];

  let found: string | null = null;
  for (const heading of headings) {
    // DOCUMENT_POSITION_FOLLOWING means the element comes after the heading.
    const isAfterHeading =
      (heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 ||
      heading.contains(element);
    if (isAfterHeading) found = heading.id || null;
    else break;
  }
  return found;
}

/**
 * Which occurrence of the snippet this selection is, within its section.
 *
 * Counted by walking the section's text and finding where the selection starts,
 * so a comment on the third "See above" is recorded as the third rather than
 * the first.
 */
function occurrenceOf(
  article: HTMLElement,
  headingId: string | null,
  snippet: string,
  range: Range,
): number | null {
  const section = sectionText(article, headingId);
  if (section.length === 0) return null;

  // The text of the section up to where the selection begins. Counting how many
  // times the snippet appears in that prefix gives the index of this one.
  const before = new Range();
  before.setStart(sectionStart(article, headingId), 0);
  before.setEnd(range.startContainer, range.startOffset);

  const prefix = collapse(before.toString());
  return countOccurrences(prefix, snippet);
}

/** The first node of a section, for measuring from. */
function sectionStart(article: HTMLElement, headingId: string | null): Node {
  if (headingId === null) return article;
  return article.querySelector(`#${CSS.escape(headingId)}`) ?? article;
}

/** Everything from one heading up to the next, as text. */
function sectionText(article: HTMLElement, headingId: string | null): string {
  const headings = [...article.querySelectorAll(HEADINGS)];

  if (headingId === null) {
    // Whatever comes before the first heading.
    const first = headings[0];
    if (!first) return collapse(article.textContent ?? '');

    const upToFirst = new Range();
    upToFirst.setStart(article, 0);
    upToFirst.setEndBefore(first);
    return collapse(upToFirst.toString());
  }

  const heading = article.querySelector(`#${CSS.escape(headingId)}`);
  if (!heading) return '';

  const index = headings.indexOf(heading);
  const next = headings[index + 1];

  const section = new Range();
  section.setStartBefore(heading);
  if (next) section.setEndBefore(next);
  else section.setEnd(article, article.childNodes.length);

  return collapse(section.toString());
}

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

/**
 * Finds a passage again in the rendered page, so a comment can be shown next to
 * what it is about.
 *
 * Returns the range, or null when it is not there, which happens between a
 * re-publish and the server re-checking anchors.
 */
export function locatePassage(
  article: HTMLElement,
  headingId: string | null,
  snippet: string,
  occurrence: number,
): Range | null {
  const walker = document.createTreeWalker(
    headingId === null ? article : (article.querySelector(`#${CSS.escape(headingId)}`)?.parentElement ?? article),
    NodeFilter.SHOW_TEXT,
  );

  // Walk the text nodes of the whole article, building a running string, and
  // stop at the nth match. Working in the DOM rather than on a plain string is
  // what lets us hand back a Range that can be measured on screen.
  const nodes: { node: Text; start: number }[] = [];
  let running = '';

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push({ node: text, start: running.length });
    running += text.data;
  }

  const flat = running.replace(/\s+/g, ' ');
  let searchFrom = 0;
  for (let seen = 0; ; seen += 1) {
    const at = flat.indexOf(snippet, searchFrom);
    if (at === -1) return null;
    if (seen === occurrence) return rangeAt(nodes, running, at, snippet.length);
    searchFrom = at + snippet.length;
  }
}

/**
 * Maps a position in the collapsed text back to a Range in the original nodes.
 *
 * Approximate by design: it walks the raw text counting non-whitespace, which is
 * enough to place a marker beside the right paragraph. It is never used to
 * decide what a comment is attached to; that is the server's answer.
 */
function rangeAt(
  nodes: { node: Text; start: number }[],
  raw: string,
  collapsedIndex: number,
  length: number,
): Range | null {
  let seen = 0;
  let rawIndex = 0;
  let lastWasSpace = false;

  while (rawIndex < raw.length && seen < collapsedIndex) {
    const isSpace = /\s/.test(raw[rawIndex] ?? '');
    if (!isSpace || !lastWasSpace) seen += 1;
    lastWasSpace = isSpace;
    rawIndex += 1;
  }

  const start = locate(nodes, rawIndex);
  const end = locate(nodes, Math.min(rawIndex + length, raw.length));
  if (!start || !end) return null;

  const range = new Range();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

function locate(
  nodes: { node: Text; start: number }[],
  index: number,
): { node: Text; offset: number } | null {
  for (const entry of nodes) {
    const end = entry.start + entry.node.data.length;
    if (index <= end) return { node: entry.node, offset: Math.max(0, index - entry.start) };
  }
  const last = nodes.at(-1);
  return last ? { node: last.node, offset: last.node.data.length } : null;
}
