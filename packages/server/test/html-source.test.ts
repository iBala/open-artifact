import { describe, it, expect } from 'vitest';
import {
  elementsOf,
  anchorForElement,
  relocateElement,
  sourceExcerpt,
  ELEMENT_TEXT_CAP,
  type ElementAnchor,
} from '../src/comments/html-source.js';

/**
 * Finding an element in the HTML an agent actually edits.
 *
 * The property under test throughout: an anchor resolves to a range in the
 * *source*, not to something in a rendered page. Rendered text is not source
 * text — tags, entities, text split across elements, anything drawn by script —
 * so a match against the rendering cannot tell an agent which bytes to change.
 */

const PAGE = [
  '<!doctype html>',
  '<html>',
  '  <body>',
  '    <h1>Plans</h1>',
  '    <p id="pricing-note">The team plan starts at $49 per seat.</p>',
  '    <p>We answer within one working day.</p>',
  '  </body>',
  '</html>',
].join('\n');

function anchorOn(html: string, elementId: string): ElementAnchor {
  const built = anchorForElement(html, { elementId });
  if (!built.ok) throw new Error(`could not anchor on #${elementId}: ${built.reason}`);
  return built.anchor;
}

// ---------------------------------------------------------------------------
// Reading the source
// ---------------------------------------------------------------------------

describe('elementsOf', () => {
  it('reads ids, tags and collapsed text', () => {
    const found = elementsOf(PAGE).find((element) => element.id === 'pricing-note');

    expect(found?.tag).toBe('p');
    expect(found?.text).toBe('The team plan starts at $49 per seat.');
  });

  it('gives offsets that slice back to the element’s own source', () => {
    const found = elementsOf(PAGE).find((element) => element.id === 'pricing-note');

    expect(PAGE.slice(found!.start!, found!.end!)).toBe(
      '<p id="pricing-note">The team plan starts at $49 per seat.</p>',
    );
  });

  it('reports no position for an element the parser invented rather than read', () => {
    // A fragment has no <html>, <head> or <body> of its own. parse5 makes them,
    // and they have no source to point at.
    const elements = elementsOf('<div id="a"><p>Hello there friend</p></div>');
    const body = elements.find((element) => element.tag === 'body');

    expect(body).toBeDefined();
    expect(body?.start).toBeNull();
  });

  it('reports no position for the tbody a parser inserts into a table', () => {
    const elements = elementsOf('<table><tr><td>a cell of text</td></tr></table>');
    const tbody = elements.find((element) => element.tag === 'tbody');

    expect(tbody?.start).toBeNull();
  });

  it('does not treat the contents of noscript as elements', () => {
    // This is the assertion that pins the parser choice. parse5's default matches
    // a real browser: inside <noscript>, that <p> is text, not an element.
    // hast-util-from-html forces scriptingEnabled: false, which would make the
    // server's tree disagree with the reader's DOM.
    const elements = elementsOf('<body><noscript><p id="n">x</p></noscript></body>');

    expect(elements.some((element) => element.id === 'n')).toBe(false);
  });

  it('keeps script and style text out of an element’s text', () => {
    const html = '<div id="d"><script>var hidden = "secret words here";</script>Real words here.</div>';
    const found = elementsOf(html).find((element) => element.id === 'd');

    expect(found?.text).toBe('Real words here.');
  });

  it('survives unclosed tags', () => {
    const elements = elementsOf('<div id="a"><p>text that never closes');

    expect(elements.some((element) => element.id === 'a')).toBe(true);
  });

  it('gives each element a path of child indices', () => {
    const found = elementsOf(PAGE).find((element) => element.id === 'pricing-note');

    expect(found?.path).toMatch(/^[0-9]+(\/[0-9]+)*$/);
  });

  it('gives two elements with the same tag different paths', () => {
    const paragraphs = elementsOf(PAGE).filter((element) => element.tag === 'p');

    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]!.path).not.toBe(paragraphs[1]!.path);
  });
});

// ---------------------------------------------------------------------------
// Building an anchor
// ---------------------------------------------------------------------------

describe('anchorForElement', () => {
  it('anchors by id', () => {
    const built = anchorForElement(PAGE, { elementId: 'pricing-note' });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.anchor.elementId).toBe('pricing-note');
    expect(built.anchor.tag).toBe('p');
    expect(built.anchor.text).toContain('$49');
  });

  it('anchors by path when there is no id', () => {
    const second = elementsOf(PAGE).filter((element) => element.tag === 'p')[1]!;
    const built = anchorForElement(PAGE, { path: second.path });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.anchor.elementId).toBeNull();
    expect(built.anchor.path).toBe(second.path);
  });

  it('falls through to the path when a page repeats an id', () => {
    // The reader selected a real paragraph. The id is not a handle, but their
    // comment should not be refused over a mistake in somebody else's page.
    const html = '<body><p id="dup">The first paragraph here.</p><p id="dup">The second paragraph here.</p></body>';
    const second = elementsOf(html).filter((element) => element.tag === 'p')[1]!;
    const built = anchorForElement(html, { elementId: 'dup', path: second.path });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.anchor.elementId).toBeNull();
    expect(built.anchor.text).toContain('second');
  });

  it('refuses a repeated id when there is no path to fall back on', () => {
    const html = '<body><p id="dup">The first paragraph here.</p><p id="dup">The second paragraph here.</p></body>';
    const built = anchorForElement(html, { elementId: 'dup' });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('repeated-id');
  });

  it('refuses an element with no source position', () => {
    const html = '<div id="a">Some words in a fragment.</div>';
    const body = elementsOf(html).find((element) => element.tag === 'body')!;
    const built = anchorForElement(html, { path: body.path });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('no-source-position');
  });

  it('refuses an unknown id', () => {
    const built = anchorForElement(PAGE, { elementId: 'nothing-here' });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('not-found');
  });

  it('accepts an element that has an id and no text at all', () => {
    // A chart div holding only a canvas, a figure holding only an image. These
    // are exactly the things people want to comment on in a generated page.
    const built = anchorForElement('<body><div id="chart"><canvas></canvas></div></body>', {
      elementId: 'chart',
    });

    expect(built.ok).toBe(true);
  });

  it('refuses an element with almost no text and no id, naming the missing id', () => {
    const html = '<body><div><canvas></canvas></div></body>';
    const div = elementsOf(html).find((element) => element.tag === 'div')!;
    const built = anchorForElement(html, { path: div.path });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.reason).toBe('too-little-text');
  });

  it('caps the text it stores for verification', () => {
    const long = 'word '.repeat(500).trim();
    const built = anchorForElement(`<body><p id="long">${long}</p></body>`, { elementId: 'long' });

    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.anchor.text.length).toBeLessThanOrEqual(ELEMENT_TEXT_CAP);
  });
});

// ---------------------------------------------------------------------------
// Finding it again
// ---------------------------------------------------------------------------

describe('relocateElement', () => {
  it('finds an element whose id survived a full rewrite', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    const rewritten = [
      '<!doctype html>',
      '<html><body>',
      '  <header><h1>Our plans</h1></header>',
      '  <section><p id="pricing-note">The team plan starts at $49 per seat.</p></section>',
      '</body></html>',
    ].join('\n');

    const moved = relocateElement(rewritten, anchor);

    expect(moved.found).toBe(true);
    if (!moved.found) return;
    expect(moved.drifted).toBe(false);
  });

  it('follows a kept id when the text under it changed, and says it drifted', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    const fixed = PAGE.replace('$49', '$59');

    const moved = relocateElement(fixed, anchor);

    expect(moved.found).toBe(true);
    if (!moved.found) return;
    expect(moved.drifted).toBe(true);
    // The refreshed text is what a later path match will compare against.
    expect(moved.anchor.text).toContain('$59');
  });

  it('finds an element by path and text when the id went', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    const withoutId = PAGE.replace(' id="pricing-note"', '');

    const moved = relocateElement(withoutId, anchor);

    expect(moved.found).toBe(true);
  });

  it('does not accept a path match whose text is different', () => {
    // A path is a guess about structure, and structure moves. Without the text
    // check this would attach the comment to whatever now sits in that slot.
    const anchor = anchorOn(PAGE, 'pricing-note');
    const replaced = PAGE.replace(
      '<p id="pricing-note">The team plan starts at $49 per seat.</p>',
      '<p>Something else entirely lives here now.</p>',
    );

    expect(relocateElement(replaced, anchor).found).toBe(false);
  });

  it('loses an element that was deleted', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    const gone = PAGE.replace('<p id="pricing-note">The team plan starts at $49 per seat.</p>', '');

    expect(relocateElement(gone, anchor).found).toBe(false);
  });

  it('finds an element again when a later version puts its id back', () => {
    // Loss must never be one-way. An agent that drops an id in one version and
    // restores it in the next should get its thread back.
    const anchor = anchorOn(PAGE, 'pricing-note');
    const gone = PAGE.replace('<p id="pricing-note">The team plan starts at $49 per seat.</p>', '');
    expect(relocateElement(gone, anchor).found).toBe(false);

    expect(relocateElement(PAGE, anchor).found).toBe(true);
  });

  it('stops trusting an id the page has started to repeat, and falls back to the path', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    const duplicated = PAGE.replace(
      '<p>We answer within one working day.</p>',
      '<p id="pricing-note">We answer within one working day.</p>',
    );

    const moved = relocateElement(duplicated, anchor);

    // The path still holds, so the comment keeps its place. What matters is
    // which paragraph it kept: the one it was written about, not the new
    // copy that happens to share the id.
    expect(moved.found).toBe(true);
    if (!moved.found) return;
    expect(moved.anchor.text).toContain('$49');
    expect(moved.anchor.text).not.toContain('working day');
  });

  it('loses an id that the page repeats once the path has moved too', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    // Both copies of the id exist and the original paragraph is gone from its
    // slot. Picking either would be guessing.
    const duplicated = PAGE.replace(
      '<p id="pricing-note">The team plan starts at $49 per seat.</p>',
      '<p id="pricing-note">One thing.</p><p id="pricing-note">Another thing.</p>',
    );

    expect(relocateElement(duplicated, anchor).found).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What the agent is shown
// ---------------------------------------------------------------------------

describe('sourceExcerpt', () => {
  it('returns the element’s own source, not the rendered text', () => {
    const excerpt = sourceExcerpt(PAGE, anchorOn(PAGE, 'pricing-note'));

    expect(excerpt?.excerpt).toBe('<p id="pricing-note">The team plan starts at $49 per seat.</p>');
  });

  it('gives the line the element starts and ends on', () => {
    const excerpt = sourceExcerpt(PAGE, anchorOn(PAGE, 'pricing-note'));

    expect(excerpt?.startLine).toBe(5);
    expect(excerpt?.endLine).toBe(5);
  });

  it('reports line 1 for a minified page, and still gives usable offsets', () => {
    const minified = '<!doctype html><html><body><p id="a">Some real words here.</p><p>more</p></body></html>';
    const excerpt = sourceExcerpt(minified, anchorOn(minified, 'a'));

    expect(excerpt?.startLine).toBe(1);
    expect(minified.slice(excerpt!.startOffset, excerpt!.endOffset)).toContain('Some real words here.');
  });

  it('caps a huge element rather than pouring the page into the agent', () => {
    const long = `<body><div id="wrapper">${'<p>a paragraph of filler text</p>'.repeat(500)}</div></body>`;
    const excerpt = sourceExcerpt(long, anchorOn(long, 'wrapper'), 1200);

    expect(excerpt!.excerpt.length).toBeLessThanOrEqual(1200);
    expect(excerpt!.excerpt).toContain('…');
  });

  it('gives nothing for an element that is no longer there', () => {
    const anchor = anchorOn(PAGE, 'pricing-note');
    const gone = PAGE.replace('<p id="pricing-note">The team plan starts at $49 per seat.</p>', '');

    expect(sourceExcerpt(gone, anchor)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What the source can do that a reader would not expect
// ---------------------------------------------------------------------------

describe('the shape of real HTML', () => {
  it('does not assume a child’s source range sits inside its parent’s', () => {
    // Foster parenting. The div is a sibling *before* the table in the tree,
    // while its offsets sit inside the table's. Anything that inferred
    // containment from offsets would be wrong on a real page.
    const html = '<table><div id="fostered">out of the table</div><tr><td>c</td></tr></table>';
    const elements = elementsOf(html);
    const div = elements.find((element) => element.id === 'fostered')!;
    const table = elements.find((element) => element.tag === 'table')!;

    expect(div.start).toBeGreaterThan(table.start!);
    expect(div.end).toBeLessThan(table.end!);
    expect(div.path.startsWith(table.path)).toBe(false);
  });
});
