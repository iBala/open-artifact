import { describe, it, expect } from 'vitest';
import { defaultSchema } from 'rehype-sanitize';
import { renderMarkdown, SANITIZE_SCHEMA } from '../src/render/markdown.js';

/**
 * Block source offsets.
 *
 * The web editor maps a rendered block back to the exact Markdown that produced
 * it, so a reader can click a paragraph and edit its source. That mapping is
 * these two attributes and nothing else.
 *
 * The offsets are JS string indices, not UTF-8 byte offsets. `source.slice()` is
 * correct; `Buffer.subarray()` is not, and silently returns the wrong text the
 * moment a document contains an emoji, a CJK character or an accent. The
 * round-trip test below is what keeps that mistake out.
 */

/** Every `data-src-start`/`data-src-end` pair in the rendered HTML, in order. */
function offsetsIn(html: string): Array<{ start: number; end: number }> {
  const found: Array<{ start: number; end: number }> = [];
  const pattern = /data-src-start="(\d+)"[^>]*data-src-end="(\d+)"/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    found.push({ start: Number(match[1]), end: Number(match[2]) });
  }
  return found;
}

/** What each stamped block points at in the source that produced it. */
function slicesOf(markdown: string): string[] {
  return offsetsIn(renderMarkdown(markdown)).map((o) => markdown.slice(o.start, o.end));
}

describe('block source offsets', () => {
  it('points a paragraph at its own source', () => {
    expect(slicesOf('A paragraph.')).toEqual(['A paragraph.']);
  });

  it('keeps the heading marker, so editing a heading does not silently demote it', () => {
    expect(slicesOf('## Findings')).toEqual(['## Findings']);
  });

  it('covers a whole list, not its items', () => {
    expect(slicesOf('- one\n- two')).toEqual(['- one\n- two']);
  });

  it('keeps the bullets of a nested list', () => {
    const md = '- one\n  - nested\n- two';
    expect(slicesOf(md)).toEqual([md]);
  });

  it('keeps the pipes and the alignment row of a table', () => {
    const md = '| a | b |\n| --- | --- |\n| 1 | 2 |';
    expect(slicesOf(md)).toEqual([md]);
  });

  it('keeps the fences of a code block, including its language', () => {
    const md = '```js\nconst answer = 42;\n```';
    expect(slicesOf(md)).toEqual([md]);
  });

  it('keeps the marker of a block quote', () => {
    expect(slicesOf('> quoted')).toEqual(['> quoted']);
  });

  it('covers a thematic break', () => {
    expect(slicesOf('---')).toEqual(['---']);
  });

  it('keeps the checkbox syntax of a task list', () => {
    const md = '- [x] shipped\n- [ ] pending';
    expect(slicesOf(md)).toEqual([md]);
  });

  it('stamps each block of a multi-block document separately', () => {
    const md = '# Title\n\nA paragraph.\n\n- a list';
    expect(slicesOf(md)).toEqual(['# Title', 'A paragraph.', '- a list']);
  });

  it('stamps only top-level blocks, so a nested element is not separately editable', () => {
    // One list, containing two items. One stamp, not three.
    expect(offsetsIn(renderMarkdown('- one\n- two'))).toHaveLength(1);
  });

  it('leaves a generated block unstamped rather than guessing at its source', () => {
    // The GFM footnote section is generated during rendering and has no position
    // in the source. An offset invented for it would splice against the wrong
    // text, so it gets none and the editor leaves it alone.
    const html = renderMarkdown('Text with a note[^1]\n\n[^1]: The body.');
    expect(html).toContain('<section');
    const sectionTag = html.slice(html.indexOf('<section'), html.indexOf('>', html.indexOf('<section')));
    expect(sectionTag).not.toContain('data-src-start');
  });

  it('survives a document that renders to nothing', () => {
    expect(() => renderMarkdown('')).not.toThrow();
    expect(offsetsIn(renderMarkdown(''))).toEqual([]);
  });
});

describe('block source offsets are string indices, not byte offsets', () => {
  /**
   * The bug this pins: mdast reports offsets into the source STRING. Reading
   * them as UTF-8 byte offsets shifts every block after the first multibyte
   * character onto the wrong text, and the document is corrupted on save
   * without any error.
   */
  it('points at the right text after an emoji', () => {
    const md = '# Title 🎉\n\nThe paragraph after the emoji.';
    expect(slicesOf(md)).toEqual(['# Title 🎉', 'The paragraph after the emoji.']);
  });

  it('points at the right text after CJK characters', () => {
    const md = '# 標題\n\nThe paragraph after the CJK heading.';
    expect(slicesOf(md)).toEqual(['# 標題', 'The paragraph after the CJK heading.']);
  });

  it('points at the right text after accented characters and symbols', () => {
    const md = 'Revenue grew to €4.2M in the café.\n\nThe next paragraph.';
    expect(slicesOf(md)).toEqual(['Revenue grew to €4.2M in the café.', 'The next paragraph.']);
  });
});

/**
 * The corpus the offset properties run over.
 *
 * Every entry earns its place by being a shape that has broken source mapping
 * somewhere before: multibyte text that byte indexing gets wrong, line endings
 * that shift every offset by one per line, a missing trailing newline that puts
 * the last block's end at the very last character, fences whose content looks
 * like Markdown, and tables whose alignment row is easy to leave out of a range.
 */
const CORPUS: Array<{ name: string; markdown: string; selfContained: boolean }> = [
  { name: 'plain prose', markdown: 'One paragraph.\n\nAnother paragraph.\n', selfContained: true },
  {
    name: 'emoji, CJK and accents',
    markdown: '# 標題 🎉\n\nRevenue grew to €4.2M in the café. 📈\n\n- naïve\n- 中文\n',
    selfContained: true,
  },
  {
    name: 'CRLF line endings',
    markdown: '# Title\r\n\r\nA paragraph.\r\n\r\n- one\r\n- two\r\n',
    selfContained: true,
  },
  { name: 'no trailing newline', markdown: '# Title\n\nThe very last line.', selfContained: true },
  {
    name: 'nested and task lists',
    markdown: '- one\n  - nested\n    - deeper\n- [x] done\n- [ ] todo\n',
    selfContained: true,
  },
  {
    name: 'table with alignment row',
    markdown: '| Left | Right |\n| :--- | ----: |\n| a | 1 |\n| b | 2 |\n',
    selfContained: true,
  },
  {
    name: 'fence containing Markdown',
    markdown: '```md\n# Not a real heading\n\n- not a real list\n```\n\nAfter the fence.\n',
    selfContained: true,
  },
  {
    name: 'headings of every level',
    markdown: '# One\n\n## Two\n\n### Three\n\n#### Four\n\n##### Five\n\n###### Six\n',
    selfContained: true,
  },
  {
    name: 'blockquote and thematic break',
    markdown: '> quoted\n>\n> - a list inside\n\n---\n\nAfter the rule.\n',
    selfContained: true,
  },
  {
    // Not self-contained: a paragraph using a reference link renders differently
    // on its own, because the definition it needs lives in another block. The
    // ordering and splice properties still hold, which is what matters, because
    // an edited block is always spliced back into the whole document.
    name: 'reference-style links',
    markdown: 'See [the docs][ref] for more.\n\n[ref]: https://example.com\n',
    selfContained: false,
  },
];

/** Every block's source range, in document order. */
function rangesOf(markdown: string): Array<{ start: number; end: number }> {
  return offsetsIn(renderMarkdown(markdown));
}

/** The rendered HTML with the offsets removed, for comparing shapes. */
function withoutOffsets(html: string): string {
  return html.replace(/ data-src-(start|end)="\d+"/g, '');
}

describe('block offsets bound the right source', () => {
  for (const { name, markdown } of CORPUS) {
    it(`gives ordered, non-overlapping, in-bounds ranges for ${name}`, () => {
      const ranges = rangesOf(markdown);
      expect(ranges.length).toBeGreaterThan(0);

      let previousEnd = -1;
      for (const { start, end } of ranges) {
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(markdown.length);
        expect(start).toBeLessThan(end);
        // Blocks never overlap and never go backwards, so an edit to one can
        // never disturb the range of another.
        expect(start).toBeGreaterThanOrEqual(previousEnd);
        previousEnd = end;
      }
    });
  }

  for (const { name, markdown } of CORPUS.filter((entry) => entry.selfContained)) {
    it(`renders each block's slice to the same markup it has in the whole document for ${name}`, () => {
      // This is the property with teeth. If a range were off by even one
      // character, the slice would parse differently and this would fail.
      const whole = withoutOffsets(renderMarkdown(markdown));
      for (const { start, end } of rangesOf(markdown)) {
        const slice = markdown.slice(start, end);
        expect(whole).toContain(withoutOffsets(renderMarkdown(slice)).trim());
      }
    });
  }

  for (const { name, markdown } of CORPUS) {
    it(`changes only the edited block when one block is replaced for ${name}`, () => {
      const ranges = rangesOf(markdown);
      for (const [index, { start, end }] of ranges.entries()) {
        const edited = `${markdown.slice(0, start)}EDITED${markdown.slice(end)}`;

        // Everything before and after the edited block is untouched, byte for byte.
        expect(edited.slice(0, start)).toBe(markdown.slice(0, start));
        expect(edited.slice(start + 'EDITED'.length)).toBe(markdown.slice(end));

        // And every other block's source still reads exactly as it did.
        for (const [otherIndex, other] of ranges.entries()) {
          if (otherIndex === index) continue;
          const shift = otherIndex > index ? 'EDITED'.length - (end - start) : 0;
          expect(edited.slice(other.start + shift, other.end + shift)).toBe(
            markdown.slice(other.start, other.end),
          );
        }
      }
    });
  }

  it('has a corpus that can actually tell string indices from byte offsets', () => {
    // Guards the guard. If every corpus entry were ASCII, the Unicode tests
    // above would pass against a Buffer-based implementation and prove nothing.
    const multibyte = CORPUS.filter(({ markdown }) => Buffer.byteLength(markdown) !== markdown.length);
    expect(multibyte.length).toBeGreaterThan(0);

    for (const { markdown } of multibyte) {
      const buffer = Buffer.from(markdown, 'utf8');
      const differs = rangesOf(markdown).some(
        ({ start, end }) => buffer.subarray(start, end).toString('utf8') !== markdown.slice(start, end),
      );
      expect(differs).toBe(true);
    }
  });
});

describe('the sanitiser allowlist only widened by these two attributes', () => {
  /**
   * The sanitiser is the security boundary for everything rendered into the
   * app's own page. Adding the offsets meant touching it, so this pins exactly
   * what that change permitted. A later edit that quietly allows something else
   * fails here instead of shipping.
   */
  it('adds the two offset attributes to the global allowlist and nothing else', () => {
    const before = new Set((defaultSchema.attributes?.['*'] ?? []) as unknown[]);
    const after = (SANITIZE_SCHEMA.attributes?.['*'] ?? []) as unknown[];
    expect(after.filter((attribute) => !before.has(attribute))).toEqual([
      'dataSrcStart',
      'dataSrcEnd',
    ]);
  });

  it('still refuses every URL scheme that is not http, https, mailto or tel', () => {
    expect(SANITIZE_SCHEMA.protocols?.href).toEqual(['http', 'https', 'mailto', 'tel']);
    expect(SANITIZE_SCHEMA.protocols?.src).toEqual(['http', 'https']);
  });

  it('allows no tag at all beyond the library default', () => {
    // The schema lists 'input' for task-list checkboxes, but the default already
    // permits it, so the real delta is empty. Asserting empty is the stronger
    // claim: this render pipeline widens the tag allowlist by nothing.
    const before = new Set((defaultSchema.tagNames ?? []) as unknown[]);
    const after = (SANITIZE_SCHEMA.tagNames ?? []) as unknown[];
    expect(after.filter((tag) => !before.has(tag))).toEqual([]);
  });

  it('drops a script even though raw HTML should never reach the sanitiser anyway', () => {
    expect(renderMarkdown('# Title\n\n<script>alert(1)</script>')).not.toMatch(/<script/i);
  });
});
