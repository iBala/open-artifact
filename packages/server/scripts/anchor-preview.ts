/**
 * See what an agent would be shown for a comment on an HTML element.
 *
 * The point of the whole feature is that a comment resolves to bytes an agent
 * can edit. This is how you check that by hand, on a real document, before any
 * of it is wired to a database or a browser.
 *
 *   pnpm --filter @open-artifact/server exec tsx scripts/anchor-preview.ts <file.html>
 *   pnpm --filter @open-artifact/server exec tsx scripts/anchor-preview.ts <file.html> pricing-note
 *   pnpm --filter @open-artifact/server exec tsx scripts/anchor-preview.ts <file.html> --path 0/1/2
 *
 * With no element named it lists what could be anchored to, with the path of
 * each, so there is something real to paste into the next command.
 */

import { readFileSync } from 'node:fs';
import {
  elementsOf,
  anchorForElement,
  sourceExcerpt,
} from '../src/comments/html-source.js';

const [, , file, first, second] = process.argv;

if (!file) {
  console.error('Give me an HTML file. Optionally an element id, or --path <path>.');
  process.exit(1);
}

const html = readFileSync(file, 'utf8');

if (!first) {
  listAnchorable();
  process.exit(0);
}

const target = first === '--path' ? { path: second } : { elementId: first };
const built = anchorForElement(html, target);

if (!built.ok) {
  console.error(`Cannot anchor there: ${built.reason}`);
  if (built.reason === 'no-source-position') {
    console.error('That element was invented by the parser, so it has no source to quote.');
  }
  if (built.reason === 'too-little-text') {
    console.error('No id and almost no text, so a path match could never be verified.');
  }
  process.exit(1);
}

const anchor = built.anchor;
const range = sourceExcerpt(html, anchor);

console.log(`tag:   <${anchor.tag}>`);
console.log(`id:    ${anchor.elementId ?? '(none — anchored by path)'}`);
console.log(`path:  ${anchor.path}`);
console.log(`lines: ${range?.startLine}-${range?.endLine}`);
console.log('');
console.log('This is what the agent is handed:');
console.log('');
console.log(range?.excerpt ?? '(nothing to quote)');

/** Everything with a source position, so the reader can pick a real target. */
function listAnchorable(): void {
  const elements = elementsOf(html).filter((element) => element.start !== null);

  console.log(`${elements.length} elements in ${file} can be anchored to.\n`);
  for (const element of elements) {
    const name = element.id ? `#${element.id}` : `path ${element.path}`;
    const words = element.text.length > 60 ? `${element.text.slice(0, 60)}…` : element.text;
    console.log(`  <${element.tag}> ${name}`.padEnd(44) + (words || '(no text)'));
  }
}
