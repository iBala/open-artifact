import { describe, it, expect } from 'vitest';
import {
  blockRangeOf,
  editableBlockAt,
  spliceBlock,
  sourceMatchesRender,
  saveFailureMessage,
  shouldSeedWholeSource,
  richTextSafe,
  blockDirty,
  linkDefinitionLabels,
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

describe('filling the whole-document box', () => {
  /**
   * The box is filled from the server once per version and never again while
   * that version is on screen. The page around it re-renders for all sorts of
   * unrelated reasons, and each of those refetches the source; refilling the box
   * on any of them would silently discard whatever had been typed into it.
   */
  it('fills the box when whole-source editing starts', () => {
    expect(shouldSeedWholeSource('source', 4, null)).toBe(true);
  });

  it('does not refill it when the same version arrives again', () => {
    // The bug this pins: an unrelated re-render refetches the source, the box is
    // reset to the server's copy, and the typing is gone. Worse, the Save button
    // then reads as unchanged and disables itself.
    expect(shouldSeedWholeSource('source', 4, 4)).toBe(false);
  });

  it('refills after a save, because the document really did change', () => {
    expect(shouldSeedWholeSource('source', 5, 4)).toBe(true);
  });

  it('never fills the box while editing blocks', () => {
    expect(shouldSeedWholeSource('blocks', 4, null)).toBe(false);
  });

  it('waits until the source has actually loaded', () => {
    expect(shouldSeedWholeSource('source', null, null)).toBe(false);
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

describe('deciding which blocks may be edited as rich text', () => {
  it('accepts the ordinary prose that most blocks are', () => {
    expect(richTextSafe('A plain paragraph.')).toBe(true);
    expect(richTextSafe('Some **bold** and _italic_ and `code`.')).toBe(true);
    expect(richTextSafe('## A heading')).toBe(true);
    expect(richTextSafe('- one\n- two\n- three')).toBe(true);
    expect(richTextSafe('| a | b |\n|---|---|\n| 1 | 2 |')).toBe(true);
    expect(richTextSafe('[a link](https://example.com)')).toBe(true);
  });

  /*
   * Each of these would come back from the editor with something missing, and
   * the save that followed would look entirely successful. That is the whole
   * reason the check exists, so each one is pinned separately.
   */
  it('refuses footnotes, which the editor cannot represent at all', () => {
    expect(richTextSafe('A claim.[^1]')).toBe(false);
    expect(richTextSafe('[^1]: The supporting note.')).toBe(false);
  });

  it('refuses link reference definitions, which belong to the whole document', () => {
    expect(richTextSafe('[spec]: https://example.com/spec')).toBe(false);
    expect(richTextSafe('   [spec]: https://example.com/spec')).toBe(false);
  });

  it('refuses raw HTML, which is the author’s and not ours to drop', () => {
    expect(richTextSafe('<div class="note">Careful.</div>')).toBe(false);
    expect(richTextSafe('Text with <br> in it.')).toBe(false);
    expect(richTextSafe('<!-- a note to self -->')).toBe(false);
  });

  it('refuses math, which nothing in the pipeline renders', () => {
    expect(richTextSafe('$$x^2$$')).toBe(false);
    expect(richTextSafe('An inline $x + y$ formula.')).toBe(false);
  });

  it('errs towards the raw box rather than towards losing something', () => {
    // A fenced block that merely mentions HTML is safe in truth, and refused
    // anyway. The cost is a textarea; the cost of the opposite mistake is text.
    expect(richTextSafe('```\n<div>example</div>\n```')).toBe(false);
  });

  it('is not fooled by a dollar sign that is only ever money', () => {
    expect(richTextSafe('It cost $5 and change.')).toBe(true);
  });
});

describe('telling an edited block from an untouched one', () => {
  it('compares against the source when there is no rich editor', () => {
    expect(blockDirty('same', 'same', null)).toBe(false);
    expect(blockDirty('changed', 'same', null)).toBe(true);
  });

  /*
   * The rich editor rewrites what it parsed, so its first output differs from
   * the source with nothing edited. Measured against the source, every rich
   * block would open dirty: Save and Cancel on an untouched paragraph, and
   * Escape asking whether to discard changes nobody made.
   */
  it('compares against the editor’s own reading of the block when there is one', () => {
    expect(blockDirty('- one', '* one', '- one')).toBe(false);
    expect(blockDirty('- two', '* one', '- one')).toBe(true);
  });
});

describe('refusing blocks whose links live somewhere else', () => {
  /*
   * A reference link only parses as a link when its definition is in the same
   * text. The rich editor is handed one block, so the definition is not there,
   * the reference is read as prose, and writing it back escapes the brackets:
   * `[the spec][spec]` becomes `\[the spec]\[spec]` and the link is gone.
   */
  const defined = () =>
    linkDefinitionLabels(
      'See [the spec][spec] and [Installation].\n\n[spec]: https://example.com/spec\n[Installation]: https://example.com/install\n',
    );

  it('collects the labels a document defines', () => {
    expect([...defined()].sort()).toEqual(['installation', 'spec']);
  });

  it('matches labels the way CommonMark does, loosely', () => {
    const labels = linkDefinitionLabels('[Read   The  Docs]: https://example.com\n');
    expect(richTextSafe('See [read the docs] for more.', labels)).toBe(false);
  });

  it('refuses every shape of reference that would be destroyed', () => {
    const labels = defined();
    expect(richTextSafe('See [the spec][spec] for more.', labels)).toBe(false);
    expect(richTextSafe('See [spec][] for more.', labels)).toBe(false);
    expect(richTextSafe('See [Installation] for more.', labels)).toBe(false);
    expect(richTextSafe('An image: ![alt][spec]', labels)).toBe(false);
  });

  it('leaves ordinary bracketed prose alone', () => {
    // The reason this takes the document's labels rather than refusing every
    // bracket: none of these reference anything, and all of them are common.
    const labels = defined();
    expect(richTextSafe('It was fine [sic] at the time.', labels)).toBe(true);
    expect(richTextSafe('Read `array[0]` carefully.', labels)).toBe(true);
    expect(richTextSafe('The first item [1] is the one.', labels)).toBe(true);
  });

  it('is unchanged for a document that defines nothing', () => {
    expect(richTextSafe('See [the spec][spec] for more.', new Set())).toBe(true);
    expect(richTextSafe('See [the spec][spec] for more.')).toBe(true);
  });
});

describe('putting an edited block back without growing the document', () => {
  /*
   * A block's range stops at its last character, so the blank line separating
   * it from the next block is outside it. The rich editor serialises through
   * remark, which always ends with a newline. Splicing that in unchanged added
   * a blank line on every save, compounding forever while rendering the same.
   */
  it('drops the trailing newline the editor always adds', () => {
    const source = 'para one\n\npara two\n';
    const range = { start: 0, end: 8 };
    const once = spliceBlock(source, range, 'para one edited\n');
    expect(once).toBe('para one edited\n\npara two\n');

    // And again, to be sure it cannot creep: the same block, saved twice.
    const twice = spliceBlock(once, { start: 0, end: 15 }, 'para one edited again\n');
    expect(twice).toBe('para one edited again\n\npara two\n');
  });

  it('drops however many newlines it is given', () => {
    expect(spliceBlock('a\n\nb\n', { start: 0, end: 1 }, 'edited\n\n\n')).toBe('edited\n\nb\n');
  });

  it('still leaves newlines inside a block alone', () => {
    // A list is one block, and its line breaks are part of it.
    expect(spliceBlock('x\n\nb\n', { start: 0, end: 1 }, '- one\n- two\n')).toBe(
      '- one\n- two\n\nb\n',
    );
  });
});
