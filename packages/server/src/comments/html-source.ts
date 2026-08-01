/**
 * Finding a comment's element in the HTML an agent actually edits.
 *
 * `anchors.ts` solves this for Markdown by matching the text a reader selected.
 * That works because rendered Markdown text and Markdown source text are near
 * enough the same thing. HTML is not like that. Tags, entities, text split
 * across elements, anything drawn by script — a match against the rendered page
 * cannot tell an agent which bytes to change. And an agent that cannot find the
 * bytes cannot make the fix, which is the whole point of the feature.
 *
 * So an HTML comment attaches to one element, and the element is resolved
 * against the source with parse5 and `sourceCodeLocationInfo`. Every element it
 * really read carries exact offsets, so a comment turns into a source excerpt
 * with line numbers rather than a description of something on screen.
 *
 * Why parse5 directly, rather than through hast:
 *
 * - `hast-util-from-html` forces `scriptingEnabled: false`. With parse5's
 *   default, which matches a real browser, the contents of `<noscript>` are text
 *   and not elements. With scripting disabled they become real elements, so the
 *   server's tree and the reader's DOM would disagree about what exists, and any
 *   path crossing a `<noscript>` would break silently.
 * - hast drops the separate start-tag and end-tag offsets, which an in-place
 *   edit will want later.
 * - `hast-util-from-parse5` records positions only when a VFile is threaded
 *   through it, which is an easy thing to get quietly wrong.
 *
 * Two facts about real HTML that this file is careful about, and callers must be
 * too:
 *
 * 1. **Some elements were never in the source.** A fragment has no `<html>`,
 *    `<head>` or `<body>` of its own, and a table written without one still gets
 *    a `<tbody>`. The parser invents them, and they have no offsets. There is
 *    nothing honest to quote, so they cannot be anchored to.
 * 2. **Source ranges do not nest.** HTML5 tree construction moves nodes — table
 *    foster parenting most obviously — so an element's offsets can sit inside a
 *    sibling's. Never infer containment from offsets; only ever slice one
 *    element's own range.
 */

import { parse } from 'parse5';
import type { DefaultTreeAdapterMap } from 'parse5';
import { collapse, MIN_SNIPPET_LENGTH } from './anchors.js';

type Node = DefaultTreeAdapterMap['node'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];
type Element = DefaultTreeAdapterMap['element'];

/**
 * The most element text kept for verification.
 *
 * This is not shown to anybody: the reader sees what they selected, and the
 * agent sees the source. It exists only so a path match can check it found the
 * same element, so a bounded prefix is as good as the whole thing and cheaper to
 * carry on every thread.
 */
export const ELEMENT_TEXT_CAP = 512;

/** The default cap on a source excerpt handed to an agent. */
export const EXCERPT_CAP = 1200;

/** Text that never counts as an element's words, because a reader never sees it. */
const NOT_TEXT = new Set(['script', 'style']);

export interface SourceElement {
  /** The id attribute, when it has one. */
  id: string | null;
  tag: string;
  /** Child indices among element siblings, from the document element down. */
  path: string;
  /** The element's words, whitespace collapsed. */
  text: string;
  /** Offsets into the source, or null when the parser invented this element. */
  start: number | null;
  end: number | null;
  startLine: number | null;
  endLine: number | null;
}

/** Where a comment sits in an HTML document. */
export interface ElementAnchor {
  kind: 'element';
  /** The stable handle, when the page gave us one we can trust. */
  elementId: string | null;
  /** The structural fallback. Always recorded, even when there is an id. */
  path: string;
  tag: string;
  /** The element's text when we last found it. Verifies a path match. */
  text: string;
  /**
   * What the reader selected, kept as they left it.
   *
   * Never matched against anything — `text` does that job and moves as the page
   * changes, while this does not. It exists to be shown to people, and to keep
   * clients that already shipped working: the CLI on somebody's machine reads
   * `anchor.snippet` for any anchor that is not a document anchor, so an element
   * anchor without one would print "undefined" on every HTML thread.
   */
  snippet: string;
}

export type ElementAnchorResult =
  | { ok: true; anchor: ElementAnchor }
  | {
      ok: false;
      reason: 'not-found' | 'no-source-position' | 'repeated-id' | 'too-little-text';
    };

export type ElementRelocation =
  | { found: false }
  /** `drifted` means the id held but the words under it are different now. */
  | { found: true; drifted: boolean; anchor: ElementAnchor };

// ---------------------------------------------------------------------------
// Reading the document
// ---------------------------------------------------------------------------

/**
 * Every element in the document, with where it came from in the source.
 *
 * Elements inside a `<template>` are absent on purpose. parse5 puts them on a
 * separate content fragment, and they are in the source but never in the
 * rendered page — the mirror of an element that only exists after script runs.
 * Neither can be anchored to honestly.
 */
export function elementsOf(html: string): SourceElement[] {
  const document = parse(html, { sourceCodeLocationInfo: true });
  const found: SourceElement[] = [];

  const walk = (node: ParentNode, path: string): void => {
    let index = 0;
    for (const child of node.childNodes) {
      if (!isElement(child)) continue;

      const childPath = path === '' ? `${index}` : `${path}/${index}`;
      const location = child.sourceCodeLocation ?? null;

      found.push({
        id: attribute(child, 'id'),
        tag: child.tagName,
        path: childPath,
        text: textOf(child),
        start: location?.startOffset ?? null,
        end: location?.endOffset ?? null,
        startLine: location?.startLine ?? null,
        endLine: location?.endLine ?? null,
      });

      walk(child, childPath);
      index += 1;
    }
  };

  walk(document, '');
  return found;
}

// ---------------------------------------------------------------------------
// Making an anchor
// ---------------------------------------------------------------------------

/**
 * Works out the anchor for the element somebody selected.
 *
 * The id is preferred, because it is the one handle that survives an agent
 * rewriting the page around it. A page that repeats an id has not given us a
 * handle at all, so we fall through to the path rather than picking one of them
 * — but we do not refuse the comment, because the reader selected a real
 * paragraph and cannot fix a mistake in somebody else's page.
 */
export function anchorForElement(
  html: string,
  target: { elementId?: string | null; path?: string | null; snippet?: string | null },
): ElementAnchorResult {
  const elements = elementsOf(html);

  let element: SourceElement | undefined;
  let usableId: string | null = null;

  if (target.elementId) {
    const byId = elements.filter((candidate) => candidate.id === target.elementId);
    if (byId.length === 1) {
      element = byId[0];
      usableId = target.elementId;
    } else if (byId.length > 1 && !target.path) {
      return { ok: false, reason: 'repeated-id' };
    }
  }

  if (!element && target.path) {
    element = elements.find((candidate) => candidate.path === target.path);
  }

  if (!element) return { ok: false, reason: 'not-found' };
  if (element.start === null) return { ok: false, reason: 'no-source-position' };

  // Without an id, the path is all we have, and a path is only trustworthy when
  // there is enough text to confirm it landed on the same element. With an id,
  // the id is the identity and an element with no words at all — a chart, a
  // figure holding one image — is a perfectly reasonable thing to comment on.
  if (usableId === null && element.text.length < MIN_SNIPPET_LENGTH) {
    return { ok: false, reason: 'too-little-text' };
  }

  return {
    ok: true,
    anchor: {
      kind: 'element',
      elementId: usableId,
      path: element.path,
      tag: element.tag,
      text: element.text.slice(0, ELEMENT_TEXT_CAP),
      snippet: snippetFor(target.snippet, element),
    },
  };
}

/**
 * What to show a person as the thing this comment is about.
 *
 * What the reader selected, when there is one. Otherwise the element's own
 * words, which is what an agent anchoring by id would want quoted back. When the
 * element has no words at all — a chart holding one canvas, a figure holding one
 * image — the tag itself, so something readable appears rather than empty quotes.
 */
function snippetFor(selected: string | null | undefined, element: SourceElement): string {
  const chosen = collapse(selected ?? '');
  if (chosen.length > 0) return chosen.slice(0, ELEMENT_TEXT_CAP);
  if (element.text.length > 0) return element.text.slice(0, ELEMENT_TEXT_CAP);
  return element.id ? `<${element.tag} id="${element.id}">` : `<${element.tag}>`;
}

// ---------------------------------------------------------------------------
// Finding it again after the document changed
// ---------------------------------------------------------------------------

/**
 * Whether an anchor still points at something in this version of the document.
 *
 * The id wins on its own, without checking the text. The agent changing that
 * text is usually the fix we asked for, and a rule that dropped the thread the
 * moment the work was done would be a strange thing to build. But a kept id is
 * evidence of identity, not proof of it — agents reuse `section-1` for entirely
 * new subject matter — so when the words no longer match, the thread keeps its
 * place and is marked as drifted. Nobody is told the comment is about text it
 * has never been about.
 *
 * A path match has no such standing and must still match the text exactly.
 */
export function relocateElement(html: string, anchor: ElementAnchor): ElementRelocation {
  const elements = elementsOf(html);

  if (anchor.elementId !== null) {
    const byId = elements.filter((candidate) => candidate.id === anchor.elementId);
    // A page that has grown a second copy of the id no longer offers a handle.
    if (byId.length === 1 && byId[0]!.start !== null) {
      const element = byId[0]!;
      const text = element.text.slice(0, ELEMENT_TEXT_CAP);
      return {
        found: true,
        drifted: text !== anchor.text,
        anchor: { ...anchor, path: element.path, tag: element.tag, text },
      };
    }
  }

  const byPath = elements.find((candidate) => candidate.path === anchor.path);
  if (byPath && byPath.start !== null && byPath.text.slice(0, ELEMENT_TEXT_CAP) === anchor.text) {
    return { found: true, drifted: false, anchor: { ...anchor, tag: byPath.tag } };
  }

  return { found: false };
}

// ---------------------------------------------------------------------------
// What the agent is shown
// ---------------------------------------------------------------------------

export interface SourceRange {
  excerpt: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

/**
 * The element's own source, with the lines it sits on.
 *
 * Capped from the middle: a comment on a wrapper should not pour the whole page
 * into the agent's context. Both ends are kept because the end of a block is
 * often where the thing being complained about sits.
 */
export function sourceExcerpt(
  html: string,
  anchor: ElementAnchor,
  max = EXCERPT_CAP,
): SourceRange | null {
  const moved = relocateElement(html, anchor);
  if (!moved.found) return null;

  const element = elementsOf(html).find((candidate) => candidate.path === moved.anchor.path);
  if (!element || element.start === null || element.end === null) return null;

  const source = html.slice(element.start, element.end);

  return {
    excerpt: source.length <= max ? source : elide(source, max),
    startLine: element.startLine ?? 1,
    endLine: element.endLine ?? 1,
    startOffset: element.start,
    endOffset: element.end,
  };
}

function elide(source: string, max: number): string {
  const marker = '\n…\n';
  const room = max - marker.length;
  const head = Math.ceil(room / 2);
  const tail = room - head;
  return `${source.slice(0, head)}${marker}${source.slice(source.length - tail)}`;
}

// ---------------------------------------------------------------------------
// Walking parse5's tree
// ---------------------------------------------------------------------------

function isElement(node: Node): node is Element {
  return 'tagName' in node && typeof (node as Element).tagName === 'string';
}

function attribute(element: Element, name: string): string | null {
  return element.attrs.find((attr) => attr.name === name)?.value ?? null;
}

/**
 * An element's words, as a reader would read them.
 *
 * Script and style bodies are text nodes in the tree but nothing anybody reads,
 * so they are skipped. Left in, a comment on a chart would verify against its
 * own JavaScript.
 */
function textOf(element: Element): string {
  const parts: string[] = [];

  const walk = (node: Node): void => {
    if (isElement(node)) {
      if (NOT_TEXT.has(node.tagName)) return;
      for (const child of node.childNodes) walk(child);
      return;
    }
    if (node.nodeName === '#text' && 'value' in node) {
      parts.push(node.value);
    }
  };

  walk(element);
  return collapse(parts.join(' '));
}
