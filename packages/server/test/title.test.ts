import { describe, it, expect } from 'vitest';
import { deriveTitle, MAX_TITLE_LENGTH } from '../src/artifacts/title.js';

describe('deriveTitle for HTML', () => {
  it('uses the title tag', () => {
    expect(deriveTitle('html', '<html><head><title>Quarterly review</title></head></html>')).toBe(
      'Quarterly review',
    );
  });

  it('ignores attributes and casing on the title tag', () => {
    expect(deriveTitle('html', '<TITLE lang="en">Sales dashboard</TITLE>')).toBe('Sales dashboard');
  });

  it('falls back to the first heading when there is no title tag', () => {
    expect(deriveTitle('html', '<body><h1>Runway model</h1><p>text</p></body>')).toBe(
      'Runway model',
    );
  });

  it('strips inline markup out of a heading', () => {
    expect(deriveTitle('html', '<h1>Runway <em>model</em></h1>')).toBe('Runway model');
  });

  it('decodes HTML entities so the title reads as written', () => {
    expect(deriveTitle('html', '<title>Sales &amp; marketing</title>')).toBe('Sales & marketing');
  });

  it('falls back to a placeholder when there is nothing to use', () => {
    expect(deriveTitle('html', '<div>no heading here</div>')).toBe('Untitled artifact');
  });

  it('ignores an empty title tag and uses the heading instead', () => {
    expect(deriveTitle('html', '<title>   </title><h1>Real title</h1>')).toBe('Real title');
  });
});

describe('deriveTitle for Markdown', () => {
  it('uses the first heading', () => {
    expect(deriveTitle('markdown', '# Weekly report\n\nSome text')).toBe('Weekly report');
  });

  it('uses a heading at any level when there is no top-level one', () => {
    expect(deriveTitle('markdown', 'Intro text\n\n## Findings\n')).toBe('Findings');
  });

  it('reads an underlined heading', () => {
    expect(deriveTitle('markdown', 'Weekly report\n=============\n\nbody')).toBe('Weekly report');
  });

  it('strips emphasis and inline code from the heading', () => {
    expect(deriveTitle('markdown', '# The **big** `refactor`')).toBe('The big refactor');
  });

  it('uses the link text when a heading is a link', () => {
    expect(deriveTitle('markdown', '# [Design doc](https://example.com)')).toBe('Design doc');
  });

  it('ignores a heading inside a fenced code block', () => {
    expect(deriveTitle('markdown', '```\n# not a heading\n```\n\n# Actual heading')).toBe(
      'Actual heading',
    );
  });

  it('falls back to the first line of text when there is no heading', () => {
    expect(deriveTitle('markdown', '\n\nJust a paragraph of text.\nMore text.')).toBe(
      'Just a paragraph of text.',
    );
  });

  it('falls back to a placeholder for empty content', () => {
    expect(deriveTitle('markdown', '   \n\n  ')).toBe('Untitled artifact');
  });
});

describe('title normalisation', () => {
  it('collapses whitespace and newlines to single spaces', () => {
    expect(deriveTitle('markdown', '#   Spread   over\n')).toBe('Spread over');
  });

  it('truncates a very long title without cutting mid-word', () => {
    const long = 'word '.repeat(100);
    const title = deriveTitle('markdown', `# ${long}`);
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(title.endsWith('…')).toBe(true);
    expect(title).not.toMatch(/wor…$/);
  });
});
