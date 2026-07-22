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
import type { Root, Element } from 'hast';

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

export interface RenderOptions {
  /**
   * Turn on the off-site link interstitial. Set for PUBLIC artifacts only, and
   * carries the instance's own base URL so we know which links are off-site.
   *
   * A public artifact is written by a stranger and served from this instance's
   * own domain. Without this, a link inside it could carry a reader straight from
   * a domain they trust to a hostile site. When set, every off-site link is
   * rewritten to go through /leaving (see routes/leaving.ts) so the reader sees
   * where they are going and chooses to continue. Leaving this out renders the
   * Markdown exactly as a private artifact does today.
   */
  wrapExternalLinks?: { baseUrl: string };
}

/** Renders Markdown to HTML that is safe to place directly in a page. */
export function renderMarkdown(markdown: string, options: RenderOptions = {}): string {
  const processor = processorFor(options.wrapExternalLinks?.baseUrl ?? null);
  return String(processor.processSync(markdown));
}

/**
 * Processors are reusable and stateless once built, so we build one per mode and
 * keep it. The private mode (no wrapping) and the public mode (wrapping, one per
 * instance base URL) are separate objects. That separation is the point: a
 * private render can never travel through the wrapping processor, and a public
 * render can never skip it. There is no content-keyed cache anywhere in this
 * module — every call runs the pipeline fresh — so the public-vs-private
 * distinction cannot leak through a shared cache entry.
 */
const processorCache = new Map<string, ReturnType<typeof buildProcessor>>();

function processorFor(wrapBaseUrl: string | null): ReturnType<typeof buildProcessor> {
  const key = wrapBaseUrl ?? '';
  const existing = processorCache.get(key);
  if (existing) return existing;

  const built = buildProcessor(wrapBaseUrl);
  processorCache.set(key, built);
  return built;
}

function buildProcessor(wrapBaseUrl: string | null) {
  const base = unified()
    .use(remarkParse)
    .use(remarkGfm)
    // allowDangerousHtml is off, so raw HTML in the Markdown is dropped at this step.
    .use(remarkRehype)
    .use(rehypeSlug)
    .use(rehypeHighlight, { detect: false, ignoreMissing: true });

  // Runs before the sanitiser on purpose: the href we write ("/leaving?to=...")
  // is relative and still has to pass the allowlist below, so nothing this
  // plugin produces can escape sanitisation.
  const withWrap =
    wrapBaseUrl !== null ? base.use(rehypeWrapExternalLinks, { baseUrl: wrapBaseUrl }) : base;

  // Sanitise last, so nothing any earlier plugin produced escapes the allowlist.
  return withWrap.use(rehypeSanitize, SANITIZE_SCHEMA).use(rehypeStringify);
}

/**
 * Rewrites off-site anchors to go through the /leaving interstitial.
 *
 * The exact rule for what counts as off-site:
 *   - Resolve the href against the instance base URL.
 *   - Wrap it only if the result is an http/https URL whose ORIGIN
 *     (scheme + host + port) differs from the instance's origin.
 *   - Everything else is left untouched: relative links, fragment (#...) links,
 *     and same-origin absolute links all resolve to our own origin; mailto:, tel:
 *     and other schemes resolve to a non-http protocol.
 *   - A subdomain is a different origin, so it is wrapped.
 *   - A protocol-relative URL (//other.example) resolves to a different origin
 *     and is wrapped.
 */
function rehypeWrapExternalLinks(options: { baseUrl: string }) {
  const baseOrigin = new URL(options.baseUrl).origin;
  return (tree: Root): void => {
    forEachAnchor(tree, (anchor) => {
      const href = anchor.properties?.href;
      if (typeof href !== 'string') return;
      const rewritten = leavingHrefFor(href, options.baseUrl, baseOrigin);
      if (rewritten !== null && anchor.properties) anchor.properties.href = rewritten;
    });
  };
}

/** The /leaving href for an off-site link, or null to leave the link as it is. */
function leavingHrefFor(href: string, baseUrl: string, baseOrigin: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(href, baseUrl);
  } catch {
    // Not a URL we can resolve. Leave it for the sanitiser to judge.
    return null;
  }

  // Only http/https destinations get an interstitial. mailto:, tel: and anything
  // else resolves to its own scheme and is none of our concern here.
  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return null;

  // Same origin is our own site. Relative links, fragments and same-origin
  // absolute links all land here.
  if (resolved.origin === baseOrigin) return null;

  // Encode the whole absolute destination into the query. encodeURIComponent also
  // encodes the ":" and "/", which keeps the href relative so it still passes the
  // sanitiser's protocol check.
  return `/leaving?to=${encodeURIComponent(resolved.href)}`;
}

/**
 * Walks the tree and calls back for every <a>. A tiny hand-written walk rather
 * than a new dependency; the tree is small and this is the only place that needs it.
 */
function forEachAnchor(node: Root | Element, visit: (anchor: Element) => void): void {
  for (const child of node.children) {
    if (child.type !== 'element') continue;
    if (child.tagName === 'a') visit(child);
    forEachAnchor(child, visit);
  }
}
