/**
 * Markdown rendering.
 *
 * GitHub Flavored Markdown in, safe HTML out. Sanitisation is a step in the
 * pipeline rather than a pass afterwards, so there is no window where unsanitised
 * HTML exists as a string that someone could accidentally use.
 *
 * Raw HTML inside a .md file is removed, not escaped and not rendered. Someone
 * who wants HTML publishes an HTML artifact, which gets the sandboxed iframe
 * treatment. Markdown is rendered into the page itself, so it has to be clean.
 *
 * Heading ids are added here because comment anchors are built from them
 * (Sprint 6). Changing how they are generated moves existing comments.
 */

import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkRehype from 'remark-rehype';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import rehypeSlug from 'rehype-slug';
import rehypeHighlight from 'rehype-highlight';
import rehypeStringify from 'rehype-stringify';
import type { Schema } from 'hast-util-sanitize';

/**
 * What survives sanitisation. Starts from the library's default (a conservative
 * GitHub-like allowlist) and adds only what our features need.
 */
const SANITIZE_SCHEMA: Schema = {
  ...defaultSchema,
  /**
   * By default the sanitizer prefixes every id with "user-content-" to stop an
   * author's id from clobbering a global the page's own script relies on. We turn
   * that off, because these ids are user-visible: they are the anchors in shared
   * links ("#findings") and the anchors comments attach to.
   *
   * Two things make that safe. Raw HTML never survives this pipeline, so the only
   * ids on the page are ones rehype-slug generated from heading text. And the
   * viewer page never reads a global by name, so there is nothing to clobber.
   * Both of those are load-bearing: keep them true.
   */
  clobberPrefix: '',
  attributes: {
    ...defaultSchema.attributes,
    // Heading ids are anchor targets for comments.
    h1: [...(defaultSchema.attributes?.h1 ?? []), 'id'],
    h2: [...(defaultSchema.attributes?.h2 ?? []), 'id'],
    h3: [...(defaultSchema.attributes?.h3 ?? []), 'id'],
    h4: [...(defaultSchema.attributes?.h4 ?? []), 'id'],
    h5: [...(defaultSchema.attributes?.h5 ?? []), 'id'],
    h6: [...(defaultSchema.attributes?.h6 ?? []), 'id'],
    // Syntax highlighting works by putting class names on spans.
    span: [...(defaultSchema.attributes?.span ?? []), ['className', /^hljs-/]],
    code: [...(defaultSchema.attributes?.code ?? []), ['className', /^(language|hljs)-/]],
    // Task list checkboxes, which GFM renders as disabled inputs.
    input: ['type', 'checked', 'disabled'],
  },
  tagNames: [...(defaultSchema.tagNames ?? []), 'input'],
  // Only these URL schemes are allowed to appear in links and images. This is
  // what stops javascript: and data: URLs.
  protocols: {
    ...defaultSchema.protocols,
    href: ['http', 'https', 'mailto', 'tel'],
    src: ['http', 'https'],
  },
};

const pipeline = unified()
  .use(remarkParse)
  .use(remarkGfm)
  // allowDangerousHtml is off, so raw HTML in the Markdown is dropped at this step.
  .use(remarkRehype)
  .use(rehypeSlug)
  .use(rehypeHighlight, { detect: false, ignoreMissing: true })
  // Sanitise last, so nothing any earlier plugin produced escapes the allowlist.
  .use(rehypeSanitize, SANITIZE_SCHEMA)
  .use(rehypeStringify);

/** Renders Markdown to HTML that is safe to place directly in a page. */
export function renderMarkdown(markdown: string): string {
  return String(pipeline.processSync(markdown));
}
