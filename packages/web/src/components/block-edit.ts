/**
 * Turning a click on the rendered page into a range of Markdown.
 *
 * The server stamps every top-level block with the source range it came from
 * (see server/src/render/block-offsets.ts). This module reads those stamps back
 * and decides, for a given click, which block may be edited and what its source
 * is.
 *
 *     <p data-src-start="9" data-src-end="21">A paragraph.</p>
 *                      |             |
 *                      +-------------+---- source.slice(9, 21)
 *
 * Everything here exists to stop one failure: editing the wrong text. The
 * offsets come from the page, so they are a hint and never a promise. A range
 * that does not fit the source we hold means the page and the source came from
 * different versions of the document, and splicing against it would replace a
 * paragraph nobody touched while sending a version number the server accepts.
 * The existing conflict check cannot catch that. So every function here refuses
 * rather than guesses, and refusing only ever costs a reload.
 *
 * These are string indices, not byte offsets. `slice` is right; anything
 * counting bytes puts every block after the first emoji or CJK character onto
 * the wrong text.
 */

import { ApiError } from '../api.js';

/** A range of the source, as string indices. */
export interface BlockRange {
  start: number;
  end: number;
}

/**
 * The part of a DOM element this module needs.
 *
 * Declared structurally so the logic can be tested without a DOM. A real
 * `Element` already satisfies it.
 */
export interface ElementLike {
  getAttribute(name: string): string | null;
  readonly parentElement: ElementLike | null;
}

/** A whole number written plainly, or null. Rejects '', ' 9', '9.5', '0x9', 'NaN'. */
function plainIndex(raw: string | null): number | null {
  if (raw === null || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : null;
}

/**
 * The source range an element was rendered from, or null when there is nothing
 * here we can trust.
 *
 * `sourceLength` is what makes this more than attribute parsing: a range that
 * runs past the source we are holding is the clearest sign the page and the
 * source disagree about which version they are.
 */
export function blockRangeOf(element: ElementLike, sourceLength: number): BlockRange | null {
  const start = plainIndex(element.getAttribute('data-src-start'));
  const end = plainIndex(element.getAttribute('data-src-end'));
  if (start === null || end === null) return null;

  // Empty and backwards ranges are meaningless; a range past the end means the
  // source moved under the page.
  if (start >= end || end > sourceLength) return null;

  return { start, end };
}

/**
 * The editable block a click landed in, or null.
 *
 * Climbs from the clicked node to the child of `root` that contains it, because
 * only top-level blocks carry offsets. Clicking a bold run edits its paragraph;
 * clicking a list item edits the whole list, so the bullets travel with it.
 *
 *     root
 *      └── <ul data-src-start=... >   <-- what gets edited
 *           └── <li>
 *                └── text             <-- what was clicked
 */
export function editableBlockAt(
  root: ElementLike,
  target: ElementLike,
  sourceLength: number,
): { element: ElementLike; range: BlockRange } | null {
  if (target === root) return null;

  let node: ElementLike | null = target;
  while (node !== null && node.parentElement !== root) {
    node = node.parentElement;
  }
  // Ran out of ancestors without meeting the root: the click was not inside it.
  if (node === null) return null;

  const range = blockRangeOf(node, sourceLength);
  return range === null ? null : { element: node, range };
}

/**
 * The document with `range` replaced by `replacement`.
 *
 * Trailing newlines are stripped from the replacement, and that is load-bearing
 * rather than tidiness. A block's range stops at its last character: mdast
 * reports `para one` in `"para one\n\npara two\n"` as [0, 8], with the blank
 * line that separates the blocks outside it. The rich editor serialises through
 * remark, which always ends its output with a newline. Splicing that in adds one
 * blank line to the document on every single save, forever:
 *
 *     "para one\n\npara two\n"
 *       -> save -> "para one edited\n\n\npara two\n"
 *       -> save -> "para one edited\n\n\n\npara two\n"
 *
 * It renders the same, so nobody would see it, and the Markdown source is what
 * this product actually stores and hands back.
 */
export function spliceBlock(source: string, range: BlockRange, replacement: string): string {
  return source.slice(0, range.start) + withoutTrailingNewlines(replacement) + source.slice(range.end);
}

/** What actually gets written for a block, with the newlines the range never held. */
function withoutTrailingNewlines(block: string): string {
  return block.replace(/\n+$/, '');
}

/**
 * Whether the rendered page and the source in hand can be trusted to line up.
 *
 * `renderedVersion` is the `X-Artifact-Version` the content response carried. A
 * missing header means we cannot tell, which is treated exactly like a
 * mismatch: refusing costs a reload, guessing costs the reader a paragraph.
 */
export function sourceMatchesRender(
  renderedVersion: number | null,
  sourceVersion: number,
): boolean {
  return renderedVersion !== null && renderedVersion === sourceVersion;
}

/**
 * Whether the whole-document box should be filled from the server.
 *
 * Once per version, and never again while that version is on screen. The box is
 * seeded when whole-source editing starts, and re-seeded after a save, because
 * the document really did change. It must NOT be re-seeded merely because the
 * source was fetched again: the page around it re-renders for all sorts of
 * reasons, and reloading the box on any of them would silently throw away
 * whatever had been typed into it.
 */
export function shouldSeedWholeSource(
  mode: 'blocks' | 'source',
  loadedVersion: number | null,
  seededVersion: number | null,
): boolean {
  if (mode !== 'source' || loadedVersion === null) return false;
  return loadedVersion !== seededVersion;
}

/**
 * What to tell somebody whose save did not land.
 *
 * Every branch says the same thing underneath: your text is still here. Losing
 * what somebody just typed is the one failure this feature must not have, so
 * the message never implies the work is gone and never asks them to retype it
 * from memory.
 */
export function saveFailureMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'version_conflict') {
      return 'This document changed since you opened it. Your text is safe here — reload the page and apply it again.';
    }
    if (error.status === 429) {
      return 'Too many saves in a short time. Your text is still here — wait a minute and try again.';
    }
    if (error.isUnauthenticated) {
      return 'Your session ended. Your text is still here — sign in again in another tab, then save.';
    }
    return `${error.message} Your text is still here.`;
  }
  return 'That did not save. Your text is still here — check your connection and try again.';
}

/**
 * Whether a block can be edited as rich text, or has to stay raw Markdown.
 *
 * The rich editor holds the block as a ProseMirror document and writes Markdown
 * back out. Anything its schema cannot represent does not survive that trip: it
 * is not mangled, it is silently gone, and the save that follows is a normal
 * successful save of a document that quietly lost a footnote.
 *
 * So the rule is the conservative one. A block goes to the rich editor only
 * when nothing in it looks like a construct the editor cannot model, and every
 * doubtful case gets the raw textarea instead. A textarea for a paragraph that
 * would have been fine is a small disappointment; a dropped footnote is data
 * loss the author has no way to notice.
 *
 * What is refused, and why each one:
 *
 * - Footnotes. Verified absent from the editor's Markdown support, while the
 *   server renders them through remark-gfm. Round-tripping deletes them.
 * - Link reference definitions. The definition lives elsewhere in the document,
 *   so a block holding one is not self-contained and re-serialising it moves
 *   the link inline, orphaning every other use of the same label.
 * - Raw HTML. The server strips it when rendering, but it is still in the
 *   author's source and deleting it from there is destructive in a way that
 *   declining to render it is not.
 * - Math. Nothing in the server's pipeline renders it, so it is text the author
 *   put there deliberately, and the editor would treat it as a construct.
 *
 * This is deliberately syntactic and deliberately eager to refuse. It reads a
 * fenced code block containing `<div>` as unsafe, which is wrong but harmless:
 * the author gets the same textarea they have today.
 */
export function linkDefinitionLabels(source: string): Set<string> {
  const labels = new Set<string>();
  for (const match of source.matchAll(/^[ \t]{0,3}\[([^\]]+)\]:/gm)) {
    // The capture group is part of the pattern, so it is always present.
    labels.add(normaliseLabel(match[1] ?? ''));
  }
  return labels;
}

/** CommonMark matches reference labels case-insensitively, with runs of whitespace collapsed. */
function normaliseLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase();
}

export function richTextSafe(markdown: string, definedLabels?: ReadonlySet<string>): boolean {
  // A footnote reference or definition: [^1], [^note]:
  if (/\[\^[^\]]+\]/.test(markdown)) return false;
  // A link reference definition at the head of a line: [label]: https://...
  if (/^[ \t]{0,3}\[[^\]]+\]:/m.test(markdown)) return false;

  /*
   * A reference to a definition that lives somewhere else in the document.
   *
   * This is the one that bites hardest, because the block looks completely
   * ordinary. `See [the spec][spec] for more.` has nothing unusual in it — but
   * the rich editor is handed the block ALONE, and a reference link only parses
   * as a link when its definition is in the same text. Without it the whole
   * thing is plain prose, and writing that back out escapes the brackets:
   *
   *     See [the spec][spec] for more.   ->   See \[the spec]\[spec] for more.
   *
   * The definition is still in the document, but nothing binds to it any more.
   * The link is gone from the published page, the words the reader sees have
   * changed, and any comment anchored across that sentence loses its place.
   *
   * Which labels are actually defined comes from the whole document, so this
   * refuses the blocks that would really break and leaves ordinary bracketed
   * prose — `[sic]`, `array[0]`, `[1]` — on the rich editor where it belongs.
   */
  if (definedLabels && definedLabels.size > 0) {
    for (const match of markdown.matchAll(/\[([^\]]+)\]/g)) {
      if (definedLabels.has(normaliseLabel(match[1] ?? ''))) return false;
    }
  }
  // An HTML tag or comment. Deliberately loose.
  if (/<\/?[a-zA-Z][^>]*>|<!--/.test(markdown)) return false;
  // Display or inline math.
  if (/\$\$|(?<!\\)\$[^$\n]+\$/.test(markdown)) return false;
  return true;
}

/**
 * Whether the open block has been changed by the person editing it.
 *
 * `baseline` is what the rich editor produced from the block before anybody
 * touched it, or null for a raw Markdown box, where the source itself is the
 * baseline. The distinction matters: the rich editor re-serialises what it
 * parsed, so an untouched `* one` comes back as `- one`. Comparing that against
 * the original would call every rich block dirty the moment it opened.
 */
export function blockDirty(draft: string, original: string, baseline: string | null): boolean {
  /*
   * Compared the way the block will actually be written, which means ignoring
   * trailing newlines — `spliceBlock` strips them, so two values differing only
   * there produce a byte-identical document and cannot be a change.
   *
   * Not a nicety. The rich editor appends an empty trailing paragraph to its
   * document a moment after it starts, which reports a new value that differs
   * from the baseline by exactly one blank line. Compared literally, every rich
   * block was dirty the instant it opened: Save showed on untouched text, and
   * a reflexive Cmd+S published a version nobody had edited.
   */
  return withoutTrailingNewlines(draft) !== withoutTrailingNewlines(baseline ?? original);
}
