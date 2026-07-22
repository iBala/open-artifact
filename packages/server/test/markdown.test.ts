import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/render/markdown.js';

describe('GitHub Flavored Markdown', () => {
  it('renders headings with ids, which comment anchors are built from', () => {
    expect(renderMarkdown('## Findings and next steps')).toContain(
      '<h2 id="findings-and-next-steps">',
    );
  });

  it('renders tables', () => {
    const html = renderMarkdown('| Name | Count |\n| --- | --- |\n| Alpha | 2 |');
    expect(html).toContain('<table>');
    expect(html).toContain('<th>Name</th>');
    expect(html).toContain('<td>Alpha</td>');
  });

  it('renders task lists as checkboxes', () => {
    const html = renderMarkdown('- [x] shipped\n- [ ] pending');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked');
    expect(html).toContain('disabled');
  });

  it('renders strikethrough', () => {
    expect(renderMarkdown('~~dropped~~')).toContain('<del>dropped</del>');
  });

  it('highlights fenced code with a declared language', () => {
    const html = renderMarkdown('```js\nconst answer = 42;\n```');
    expect(html).toContain('language-js');
    expect(html).toContain('hljs-');
  });

  it('renders a code fence with an unknown language without failing', () => {
    expect(() => renderMarkdown('```notalanguage\nx\n```')).not.toThrow();
  });

  it('renders ordinary links', () => {
    expect(renderMarkdown('[docs](https://example.com/docs)')).toContain(
      '<a href="https://example.com/docs">docs</a>',
    );
  });
});

/**
 * These are the attacks. A published artifact is read by other people, so a
 * Markdown file must never be able to run script in the reader's session.
 */
describe('sanitisation of hostile Markdown', () => {
  const noScriptRuns = (html: string) => {
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/\son\w+\s*=/i);
  };

  it('removes script tags', () => {
    noScriptRuns(renderMarkdown('Before\n\n<script>alert(document.cookie)</script>\n\nAfter'));
  });

  it('removes inline event handlers', () => {
    noScriptRuns(renderMarkdown('<img src="x" onerror="alert(1)">'));
  });

  it('removes javascript: links', () => {
    const html = renderMarkdown('[click me](javascript:alert(1))');
    noScriptRuns(html);
    expect(html).toContain('click me');
  });

  it('removes javascript: links written with mixed case and whitespace', () => {
    noScriptRuns(renderMarkdown('[x](JaVaScRiPt&#58;alert(1))'));
    noScriptRuns(renderMarkdown('[x](  javascript:alert(1))'));
  });

  it('removes data: URLs, which can carry a whole HTML document', () => {
    const html = renderMarkdown(
      '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)',
    );
    expect(html).not.toContain('data:text/html');
  });

  it('removes iframes', () => {
    expect(renderMarkdown('<iframe src="https://evil.example.com"></iframe>')).not.toMatch(
      /<iframe/i,
    );
  });

  it('removes style tags and style attributes, which can be used to overlay the page', () => {
    const html = renderMarkdown('<style>body{display:none}</style>\n\n<p style="x">text</p>');
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/style=/i);
  });

  it('removes form elements', () => {
    const html = renderMarkdown('<form action="https://evil.example.com"><input name="p"></form>');
    expect(html).not.toMatch(/<form/i);
    expect(html).not.toMatch(/action=/i);
  });

  it('removes svg, which can carry script', () => {
    expect(renderMarkdown('<svg><script>alert(1)</script></svg>')).not.toMatch(/<svg/i);
  });

  it('removes object and embed tags', () => {
    const html = renderMarkdown('<object data="x"></object><embed src="y">');
    expect(html).not.toMatch(/<object/i);
    expect(html).not.toMatch(/<embed/i);
  });

  it('removes meta refresh, which would redirect the reader', () => {
    expect(renderMarkdown('<meta http-equiv="refresh" content="0;url=https://evil.example.com">'))
      .not.toMatch(/<meta/i);
  });

  it('escapes text that looks like a tag rather than rendering it', () => {
    expect(renderMarkdown('The `<script>` tag is written like this.')).toContain('&#x3C;script>');
  });

  it('keeps the surrounding prose when it strips markup', () => {
    const html = renderMarkdown('Real content here.\n\n<script>alert(1)</script>\n\nMore content.');
    expect(html).toContain('Real content here.');
    expect(html).toContain('More content.');
  });
});

/**
 * A public artifact is written by a stranger and served from this instance's own
 * domain. Off-site links are rewritten to pass through the /leaving interstitial,
 * so a reader is never carried silently from a domain they trust to a hostile one.
 * These check exactly which links count as off-site.
 */
describe('off-site links in a public artifact', () => {
  const BASE = 'https://artifacts.test';
  const publicRender = (markdown: string) =>
    renderMarkdown(markdown, { wrapExternalLinks: { baseUrl: BASE } });

  it('wraps an absolute link to a different origin', () => {
    const html = publicRender('[go](https://evil.example.com/p)');
    expect(html).toContain('href="/leaving?to=https%3A%2F%2Fevil.example.com%2Fp"');
    // The visible link text is untouched.
    expect(html).toContain('>go</a>');
  });

  it('wraps a subdomain of the instance, because it is a different origin', () => {
    const html = publicRender('[go](https://other.artifacts.test/p)');
    expect(html).toContain('href="/leaving?to=https%3A%2F%2Fother.artifacts.test%2Fp"');
  });

  it('wraps a protocol-relative link, which resolves to a different origin', () => {
    const html = publicRender('[go](//other.example/p)');
    // It resolves against the instance scheme (https) to a full absolute URL.
    expect(html).toContain('href="/leaving?to=https%3A%2F%2Fother.example%2Fp"');
  });

  it('leaves a same-origin absolute link untouched', () => {
    const html = publicRender('[go](https://artifacts.test/other)');
    expect(html).toContain('href="https://artifacts.test/other"');
    expect(html).not.toContain('/leaving');
  });

  it('leaves a relative link untouched', () => {
    const html = publicRender('[go](/other-artifact)');
    expect(html).toContain('href="/other-artifact"');
    expect(html).not.toContain('/leaving');
  });

  it('leaves a fragment link untouched', () => {
    const html = publicRender('[go](#findings)');
    expect(html).toContain('href="#findings"');
    expect(html).not.toContain('/leaving');
  });

  it('leaves mailto and tel links untouched', () => {
    const mail = publicRender('[write](mailto:someone@example.com)');
    expect(mail).toContain('href="mailto:someone@example.com"');
    expect(mail).not.toContain('/leaving');

    const call = publicRender('[call](tel:+15551234567)');
    expect(call).toContain('href="tel:+15551234567"');
    expect(call).not.toContain('/leaving');
  });

  it('does not rewrite anything when the option is off (a private artifact)', () => {
    const html = renderMarkdown('[go](https://evil.example.com/p)');
    expect(html).toContain('href="https://evil.example.com/p"');
    expect(html).not.toContain('/leaving');
  });
});
