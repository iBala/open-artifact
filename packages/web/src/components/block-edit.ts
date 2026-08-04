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

/** The document with `range` replaced by `replacement`. */
export function spliceBlock(source: string, range: BlockRange, replacement: string): string {
  return source.slice(0, range.start) + replacement + source.slice(range.end);
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
