/**
 * Where each rendered block came from in the source.
 *
 * The web editor lets an owner click a block and edit the Markdown that produced
 * it. To do that it needs to map a rendered element back to a range of the
 * source, which is what this plugin writes onto the page:
 *
 *     <p data-src-start="9" data-src-end="35">A paragraph.</p>
 *                     |              |
 *                     +--------------+---- source.slice(9, 35) === "A paragraph."
 *
 * THESE ARE STRING INDICES, NOT BYTE OFFSETS. mdast reports positions as offsets
 * into the source string, so `source.slice(start, end)` is right and
 * `Buffer.subarray(start, end)` is wrong. Byte indexing looks correct on ASCII
 * and then shifts every block after the first emoji, CJK character or accent
 * onto the wrong text, which corrupts the document on save with no error at all.
 * `test/block-offsets.test.ts` pins this with a Unicode corpus. Keep it.
 *
 * Only top-level blocks are stamped. A list gets one range covering the whole
 * list, not one per item, because the unit a person edits is the block they
 * clicked and its Markdown syntax has to travel with it.
 *
 * Blocks with no position are left alone rather than given a guess. Elements
 * generated during rendering, such as the GFM footnote section, have no source
 * to point at; an invented offset would splice against the wrong text. The
 * editor treats an unstamped block as not editable and offers full source
 * instead.
 */

import type { Root } from 'hast';

/** Stamps each top-level block with the source range it was rendered from. */
export function rehypeBlockOffsets() {
  return (tree: Root): void => {
    for (const child of tree.children) {
      if (child.type !== 'element') continue;

      const start = child.position?.start?.offset;
      const end = child.position?.end?.offset;
      // Generated elements carry no position. Leave them unstamped.
      if (start === undefined || end === undefined) continue;

      child.properties = child.properties ?? {};
      child.properties.dataSrcStart = start;
      child.properties.dataSrcEnd = end;
    }
  };
}
