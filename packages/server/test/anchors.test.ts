import { describe, it, expect } from 'vitest';
import {
  sectionsOf,
  anchorFor,
  anchorForOccurrence,
  relocate,
  collapse,
  MIN_SNIPPET_LENGTH,
  type TextAnchor,
} from '../src/comments/anchors.js';

/**
 * Whether a comment keeps its place when the document changes.
 *
 * The rule these tests exist to hold down: an anchor either finds exactly what
 * it was attached to, or it admits it is lost. It must never quietly attach
 * itself to different text. A comment saying "this number is wrong" that has
 * moved to a different number is worse than one that says it lost its place,
 * because nobody can tell it happened.
 */

const DOCUMENT = `# Quarterly report

Revenue is up eighteen percent on the quarter.

## Europe

Europe was flat this quarter. See the note below.

## India

India grew thirty one percent. See the note below.
`;

function anchor(headingId: string | null, snippet: string, occurrence = 0): TextAnchor {
  return { kind: 'text', headingId, snippet: collapse(snippet), occurrence };
}

describe('splitting a document into sections', () => {
  it('gives each heading its own section, keyed by the id in the page', () => {
    const sections = sectionsOf(DOCUMENT);
    expect(sections.map((section) => section.headingId)).toEqual([
      'quarterly-report',
      'europe',
      'india',
    ]);
  });

  it('keeps text that comes before any heading', () => {
    const sections = sectionsOf('An opening line.\n\n# A heading\n\nMore text.');
    expect(sections[0]?.headingId).toBeNull();
    expect(sections[0]?.text).toContain('An opening line.');
  });

  it('reads the text a reader would see, not the Markdown behind it', () => {
    // Somebody selects "the big refactor". They never saw the asterisks.
    const sections = sectionsOf('# Title\n\nThe **big** `refactor` is [done](https://x.test).');
    expect(sections[0]?.text).toContain('The big refactor is done.');
  });

  it('collapses whitespace, so a reflowed paragraph is the same text', () => {
    const wrapped = sectionsOf('# Title\n\nOne sentence\nsplit over lines.');
    const single = sectionsOf('# Title\n\nOne sentence split over lines.');
    expect(wrapped[0]?.text).toBe(single[0]?.text);
  });

  it('includes table cells, which people comment on', () => {
    const sections = sectionsOf('# Numbers\n\n| Region | Revenue |\n| --- | --- |\n| India | 420 |');
    expect(sections[0]?.text).toContain('India');
    expect(sections[0]?.text).toContain('420');
  });
});

describe('anchoring to a passage', () => {
  it('records the heading, the exact text, and which occurrence it was', () => {
    const built = anchorFor(DOCUMENT, 'europe', 'Europe was flat this quarter');
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    expect(built.anchor).toEqual({
      kind: 'text',
      headingId: 'europe',
      snippet: 'Europe was flat this quarter',
      occurrence: 0,
    });
  });

  it('refuses a selection too short to find again', () => {
    // Two characters appear everywhere, so the occurrence index would shift on
    // almost any edit and the comment would keep losing its place.
    const built = anchorFor(DOCUMENT, 'europe', 'up');
    expect(built).toEqual({ ok: false, reason: 'too-short' });
    expect('up'.length).toBeLessThan(MIN_SNIPPET_LENGTH);
  });

  it('refuses text that is not in the section it claims to be in', () => {
    expect(anchorFor(DOCUMENT, 'europe', 'India grew thirty one percent')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('refuses a heading that does not exist', () => {
    expect(anchorFor(DOCUMENT, 'nowhere', 'Europe was flat this quarter')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('will not take an occurrence number that was never true', () => {
    // Otherwise a client could store an index pointing at nothing, and the
    // comment would drag itself somewhere it never belonged.
    expect(anchorForOccurrence(DOCUMENT, 'europe', 'Europe was flat this quarter', 4)).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });

  it('accepts a later occurrence when there genuinely is one', () => {
    const repeated = '# Notes\n\nSee above. Then some words. See above. And more.';
    const built = anchorForOccurrence(repeated, 'notes', 'See above.', 1);
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.anchor.occurrence).toBe(1);
  });
});

describe('finding a passage again after the document changed', () => {
  it('finds it when everything above it moved', () => {
    const rewritten = `# Quarterly report

An entirely new opening paragraph.

And another one, for good measure.

## Europe

Europe was flat this quarter. See the note below.

## India

India grew thirty one percent. See the note below.
`;
    expect(relocate(rewritten, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: true,
    });
  });

  it('finds it when the sentence was reflowed onto different lines', () => {
    const rewrapped = DOCUMENT.replace(
      'Europe was flat this quarter. See the note below.',
      'Europe was flat this\nquarter. See the note\nbelow.',
    );
    expect(relocate(rewrapped, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: true,
    });
  });

  it('loses it when the passage was deleted', () => {
    const without = DOCUMENT.replace('Europe was flat this quarter. See the note below.', 'Removed.');
    expect(relocate(without, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: false,
    });
  });

  it('loses it when the heading it lived under is gone', () => {
    const without = DOCUMENT.replace('## Europe', '## Europe and the Middle East');
    // The heading id changed, so the section it was anchored to no longer
    // exists. Better to admit that than to guess which new heading it meant.
    expect(relocate(without, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: false,
    });
  });

  it('loses it when the passage was edited even slightly', () => {
    const edited = DOCUMENT.replace('Europe was flat this quarter', 'Europe was flat this half');
    expect(relocate(edited, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: false,
    });
  });

  it('never moves a comment to a different copy of the same words', () => {
    // "See the note below." appears under both headings. A comment on the one
    // under India must not reattach to the one under Europe when India's is
    // deleted. This is the mis-attachment the whole design exists to prevent.
    const indiaGone = DOCUMENT.replace('India grew thirty one percent. See the note below.', 'Gone.');

    expect(relocate(indiaGone, anchor('india', 'See the note below.'))).toEqual({ found: false });
    // And the one under Europe is untouched.
    expect(relocate(indiaGone, anchor('europe', 'See the note below.'))).toEqual({ found: true });
  });

  it('loses a later occurrence when the document now has fewer', () => {
    const twice = '# Notes\n\nSee above. Words. See above. More.';
    const once = '# Notes\n\nSee above. Words. Removed. More.';

    expect(relocate(twice, anchor('notes', 'See above.', 1))).toEqual({ found: true });
    // Pointing it at the remaining copy would be inventing an answer.
    expect(relocate(once, anchor('notes', 'See above.', 1))).toEqual({ found: false });
    expect(relocate(once, anchor('notes', 'See above.', 0))).toEqual({ found: true });
  });

  it('finds a passage that moved to a different position within its section', () => {
    const reordered = DOCUMENT.replace(
      'Europe was flat this quarter. See the note below.',
      'See the note below. Europe was flat this quarter.',
    );
    expect(relocate(reordered, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: true,
    });
  });

  it('loses it when the passage moved to a different section', () => {
    // It still exists somewhere, but not where the comment was about. Following
    // it would change what the comment appears to be replying to.
    const moved = DOCUMENT
      .replace('Europe was flat this quarter. See the note below.', 'Nothing here.')
      .replace('India grew thirty one percent.', 'India grew thirty one percent. Europe was flat this quarter.');

    expect(relocate(moved, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: false,
    });
  });

  it('survives the document being rewritten around it entirely', () => {
    const rewritten = `# Quarterly report

Completely different opening.

## New section

Brand new content nobody has seen.

## Europe

Some new framing text first.

Europe was flat this quarter. See the note below.

More new text after it.
`;
    expect(relocate(rewritten, anchor('europe', 'Europe was flat this quarter'))).toEqual({
      found: true,
    });
  });
});

describe('anchoring without naming a heading', () => {
  it('finds the passage wherever it is', async () => {
    const { anchorAnywhere } = await import('../src/comments/anchors.js');

    // An agent working from a Markdown file has no idea what a heading slug is,
    // and should not have to derive one to leave a comment.
    const built = anchorAnywhere(DOCUMENT, 'India grew thirty one percent');
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.anchor.headingId).toBe('india');
  });

  it('finds a passage that sits before the first heading', async () => {
    const { anchorAnywhere } = await import('../src/comments/anchors.js');

    const built = anchorAnywhere('An opening line worth commenting on.\n\n# A heading\n\nMore.', 'An opening line worth commenting on.');
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.anchor.headingId).toBeNull();
  });

  it('refuses text that appears under more than one heading', async () => {
    const { anchorAnywhere } = await import('../src/comments/anchors.js');

    // "See the note below." is under both. Guessing which one was meant would
    // attach the remark to the wrong place exactly when it matters most.
    expect(anchorAnywhere(DOCUMENT, 'See the note below.')).toEqual({
      ok: false,
      reason: 'ambiguous',
    });
  });

  it('refuses text that is nowhere in the document', async () => {
    const { anchorAnywhere } = await import('../src/comments/anchors.js');
    expect(anchorAnywhere(DOCUMENT, 'Words that appear nowhere at all')).toEqual({
      ok: false,
      reason: 'not-found',
    });
  });
});
