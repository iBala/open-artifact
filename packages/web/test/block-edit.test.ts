import { describe, it, expect } from 'vitest';
import {
  blockRangeOf,
  editableBlockAt,
  spliceBlock,
  sourceMatchesRender,
  saveFailureMessage,
  type ElementLike,
} from '../src/components/block-edit.js';
import { ApiError } from '../src/api.js';

/**
 * Turning a click into a range of Markdown.
 *
 * Everything here exists to stop one failure: editing the wrong text. The
 * offsets arrive from the page, so they are a hint and never a promise. A range
 * that does not fit the source we hold means the two came from different
 * versions of the document, and splicing against it would replace a paragraph
 * the reader never touched, with a version number the server accepts. So the
 * rule throughout is refuse rather than guess.
 */

/** A stand-in for a DOM element, which satisfies the same shape. */
function node(attributes: Record<string, string>, parent: ElementLike | null = null): ElementLike {
  return {
    getAttribute: (name) => attributes[name] ?? null,
    parentElement: parent,
  };
}

const SOURCE = '# Title\n\nA paragraph.\n';

describe('reading the range an element was rendered from', () => {
  it('reads a well-formed pair', () => {
    expect(blockRangeOf(node({ 'data-src-start': '9', 'data-src-end': '21' }), SOURCE.length)).toEqual(
      { start: 9, end: 21 },
    );
  });

  it('refuses an element with no offsets, such as a generated footnote section', () => {
    expect(blockRangeOf(node({}), SOURCE.length)).toBeNull();
  });

  it('refuses a half-stamped element', () => {
    expect(blockRangeOf(node({ 'data-src-start': '9' }), SOURCE.length)).toBeNull();
    expect(blockRangeOf(node({ 'data-src-end': '21' }), SOURCE.length)).toBeNull();
  });

  it('refuses anything that is not a plain number', () => {
    for (const bad of ['', 'abc', '9.5', '1e3', ' 9', '0x9', 'NaN', 'Infinity']) {
      expect(blockRangeOf(node({ 'data-src-start': bad, 'data-src-end': '21' }), SOURCE.length)).toBeNull();
    }
  });

  it('refuses a backwards or empty range', () => {
    expect(blockRangeOf(node({ 'data-src-start': '21', 'data-src-end': '9' }), SOURCE.length)).toBeNull();
    expect(blockRangeOf(node({ 'data-src-start': '9', 'data-src-end': '9' }), SOURCE.length)).toBeNull();
  });

  it('refuses a range that runs past the source, which means the two disagree', () => {
    // The clearest sign the rendered page and the source we hold came from
    // different versions. Editing here would hit the wrong text.
    expect(blockRangeOf(node({ 'data-src-start': '9', 'data-src-end': '999' }), SOURCE.length)).toBeNull();
    expect(blockRangeOf(node({ 'data-src-start': '-1', 'data-src-end': '9' }), SOURCE.length)).toBeNull();
  });
});

describe('finding the block a click belongs to', () => {
  it('takes the block itself when the block is clicked', () => {
    const root = node({});
    const paragraph = node({ 'data-src-start': '9', 'data-src-end': '21' }, root);
    expect(editableBlockAt(root, paragraph, SOURCE.length)?.range).toEqual({ start: 9, end: 21 });
  });

  it('climbs out of an inline element to the block holding it', () => {
    // Clicking a bold run inside a paragraph edits the paragraph.
    const root = node({});
    const paragraph = node({ 'data-src-start': '9', 'data-src-end': '21' }, root);
    const bold = node({}, paragraph);
    expect(editableBlockAt(root, bold, SOURCE.length)?.element).toBe(paragraph);
  });

  it('climbs out of a list item to the whole list', () => {
    // A list is one block. Editing an item means editing the list's source, so
    // the bullets travel with it.
    const root = node({});
    const list = node({ 'data-src-start': '0', 'data-src-end': '12' }, root);
    const item = node({}, list);
    const text = node({}, item);
    expect(editableBlockAt(root, text, SOURCE.length)?.element).toBe(list);
  });

  it('refuses a top-level block that carries no offsets', () => {
    const root = node({});
    const section = node({}, root);
    expect(editableBlockAt(root, section, SOURCE.length)).toBeNull();
  });

  it('refuses the root itself, so clicking the page margin does nothing', () => {
    const root = node({});
    expect(editableBlockAt(root, root, SOURCE.length)).toBeNull();
  });

  it('refuses a node that is not inside the root at all', () => {
    const root = node({});
    const elsewhere = node({ 'data-src-start': '0', 'data-src-end': '5' }, node({}));
    expect(editableBlockAt(root, elsewhere, SOURCE.length)).toBeNull();
  });
});

describe('putting an edited block back', () => {
  it('replaces only the range', () => {
    expect(spliceBlock(SOURCE, { start: 9, end: 21 }, 'Replaced.')).toBe('# Title\n\nReplaced.\n');
  });

  it('keeps every byte outside the range exactly as it was', () => {
    const result = spliceBlock(SOURCE, { start: 9, end: 21 }, 'Longer replacement text.');
    expect(result.slice(0, 9)).toBe(SOURCE.slice(0, 9));
    expect(result.endsWith(SOURCE.slice(21))).toBe(true);
  });

  it('handles a multi-line replacement', () => {
    expect(spliceBlock(SOURCE, { start: 0, end: 7 }, '## Two\n\n### Three')).toBe(
      '## Two\n\n### Three\n\nA paragraph.\n',
    );
  });

  it('handles emptying a block', () => {
    expect(spliceBlock(SOURCE, { start: 9, end: 21 }, '')).toBe('# Title\n\n\n');
  });

  it('leaves multibyte text intact, because these are string indices', () => {
    const source = '# 標題 🎉\n\nAfter.\n';
    const range = { start: source.indexOf('After.'), end: source.indexOf('After.') + 6 };
    expect(spliceBlock(source, range, 'Changed.')).toBe('# 標題 🎉\n\nChanged.\n');
  });
});

describe('deciding whether the page and the source can be trusted together', () => {
  it('agrees when both came from the same version', () => {
    expect(sourceMatchesRender(4, 4)).toBe(true);
  });

  it('disagrees when the source moved on', () => {
    expect(sourceMatchesRender(4, 5)).toBe(false);
  });

  it('refuses when the render did not say which version it was', () => {
    // A missing header means we cannot tell. Refusing costs a reload; guessing
    // costs the reader a paragraph they never touched.
    expect(sourceMatchesRender(null, 5)).toBe(false);
  });
});

describe('what a failed save says', () => {
  /**
   * The rule every one of these has to keep: never imply the typed text is
   * gone, and never ask somebody to retype from memory. A save can fail for
   * several reasons and none of them are the reader's fault.
   */
  const failures = [
    { name: 'the document moved on', error: new ApiError(409, { code: 'version_conflict', message: 'Changed.' }) },
    { name: 'too many saves', error: new ApiError(429, { code: 'rate_limited', message: 'Slow down.' }) },
    { name: 'the session ended', error: new ApiError(401, { code: 'unauthenticated', message: 'Signed out.' }) },
    { name: 'something else the server said', error: new ApiError(500, { code: 'boom', message: 'Server error.' }) },
    { name: 'the network', error: new TypeError('Failed to fetch') },
  ];

  for (const { name, error } of failures) {
    it(`promises the text is still there when ${name}`, () => {
      expect(saveFailureMessage(error)).toMatch(/still (here|there)|safe here/i);
    });
  }

  it('names the conflict, so the reader knows a reload is what is needed', () => {
    const message = saveFailureMessage(
      new ApiError(409, { code: 'version_conflict', message: 'Changed.' }),
    );
    expect(message).toContain('changed since you opened it');
    expect(message).toMatch(/reload/i);
  });

  it('tells somebody who is rate limited to wait rather than retry at once', () => {
    expect(saveFailureMessage(new ApiError(429, { code: 'rate_limited', message: '' }))).toMatch(
      /wait a minute/i,
    );
  });

  it('tells a signed-out reader to sign in elsewhere, not to reload and lose the box', () => {
    const message = saveFailureMessage(
      new ApiError(401, { code: 'unauthenticated', message: '' }),
    );
    expect(message).toMatch(/another tab/i);
    expect(message).not.toMatch(/reload/i);
  });
});
