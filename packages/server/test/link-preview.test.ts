import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  createTestServer,
  signIn,
  jsonBody,
  TEST_BASE_URL,
  type TestServer,
} from './helpers/server.js';
import {
  previewFor,
  applyPreview,
  PRIVATE_PREVIEW,
  EXPIRED_PREVIEW,
} from '../src/http/link-preview.js';
import { deriveDescription } from '../src/artifacts/description.js';
import type { ArtifactDetail } from '../src/artifacts/service.js';

/**
 * What an artifact URL says about itself when it is pasted into Slack.
 *
 * The whole of the risk here is in one direction. An unfurler has no session,
 * so anything these tags say is said to everybody who can see the message. The
 * tests that matter are the ones asserting a private document's words never
 * reach them.
 */

const NOW = '2026-08-31T12:00:00.000Z';

function artifact(over: Partial<ArtifactDetail> = {}): ArtifactDetail {
  return {
    id: 'art_1',
    slug: 'abcdefghijklmnopqrstuvwx',
    ownerId: 'usr_1',
    type: 'markdown',
    title: 'Quarterly review',
    content: '# Quarterly review\n\nRevenue is up eighteen percent on the quarter.\n',
    isPublic: 1,
    expiresAt: null,
    version: 1,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as ArtifactDetail;
}

describe('what a link preview is allowed to say', () => {
  it('shows a public document’s own title and opening line', () => {
    expect(previewFor(artifact(), NOW)).toEqual({
      title: 'Quarterly review',
      description: 'Revenue is up eighteen percent on the quarter.',
    });
  });

  it('says nothing whatsoever about a private document', () => {
    const secret = artifact({
      isPublic: 0,
      title: 'Project Gemini layoffs',
      content: '# Project Gemini layoffs\n\nWe will cut forty roles in March.\n',
    });
    const copy = previewFor(secret, NOW);

    expect(copy).toEqual(PRIVATE_PREVIEW);
    // Said explicitly, because this is the failure that matters: not one word
    // of the document or its title may appear anywhere in the card.
    const card = `${copy.title} ${copy.description}`.toLowerCase();
    expect(card).not.toContain('gemini');
    expect(card).not.toContain('layoff');
    expect(card).not.toContain('forty');
    expect(card).not.toContain('march');
  });

  it('says nothing about a public document whose link has expired', () => {
    const stale = artifact({ expiresAt: '2026-08-30T00:00:00.000Z' });
    const copy = previewFor(stale, NOW);

    expect(copy).toEqual(EXPIRED_PREVIEW);
    expect(`${copy.title} ${copy.description}`).not.toContain('Quarterly');
  });

  it('treats expiry as final, even for something still marked public', () => {
    // isPublic and expiresAt are separate columns and expiry wins. Reading them
    // the other way round would keep publishing a document after its link died.
    const stale = artifact({ isPublic: 1, expiresAt: '2020-01-01T00:00:00.000Z' });
    expect(previewFor(stale, NOW)).toEqual(EXPIRED_PREVIEW);
  });

  it('falls back to saying what it is when a public document reads as nothing', () => {
    const empty = artifact({ title: 'Untitled artifact', content: '\n\n' });
    expect(previewFor(empty, NOW).description).toBe('A document on Open Artifact.');
  });
});

describe('writing the preview into the shell', () => {
  const SHELL = [
    '<!doctype html>',
    '<html><head>',
    '<title>Open Artifact — give your agent’s work a URL</title>',
    '<meta name="description" content="The generic one." />',
    '<meta property="og:title" content="Open Artifact" />',
    '<meta',
    '  property="og:description"',
    '  content="Written across several lines, as the real shell does."',
    '/>',
    '<meta property="og:url" content="https://open-artifact.com" />',
    '<meta name="twitter:title" content="Open Artifact" />',
    '<meta name="twitter:description" content="Another generic one." />',
    '<script>document.documentElement.dataset.theme = "dark";</script>',
    '</head><body></body></html>',
  ].join('\n');

  const applied = applyPreview(
    SHELL,
    { title: 'Quarterly review', description: 'Revenue is up.' },
    'https://open-artifact.com/a/abcdefghijklmnopqrstuvwx',
  );

  it('replaces every tag an unfurler reads', () => {
    expect(applied).toContain('<title>Quarterly review</title>');
    expect(applied).toContain('<meta name="description" content="Revenue is up." />');
    expect(applied).toContain('<meta property="og:title" content="Quarterly review" />');
    expect(applied).toContain('<meta property="og:description" content="Revenue is up." />');
    expect(applied).toContain('<meta name="twitter:title" content="Quarterly review" />');
    expect(applied).toContain('<meta name="twitter:description" content="Revenue is up." />');
  });

  it('points the canonical URL at this artifact', () => {
    expect(applied).toContain(
      '<meta property="og:url" content="https://open-artifact.com/a/abcdefghijklmnopqrstuvwx" />',
    );
  });

  it('leaves none of the generic copy behind', () => {
    expect(applied).not.toContain('The generic one.');
    expect(applied).not.toContain('Another generic one.');
    expect(applied).not.toContain('Written across several lines');
  });

  it('does not touch the inline script', () => {
    // Its SHA-256 is in the Content-Security-Policy this response carries, so
    // changing one byte of it would take the page down rather than look wrong.
    expect(applied).toContain('<script>document.documentElement.dataset.theme = "dark";</script>');
  });

  it('escapes a title that would otherwise close the tag', () => {
    const nasty = applyPreview(
      SHELL,
      { title: '"><script>alert(1)</script>', description: 'Fine & dandy' },
      'https://open-artifact.com/a/x',
    );
    expect(nasty).not.toContain('<script>alert(1)</script>');
    expect(nasty).toContain('&quot;&gt;&lt;script&gt;');
    expect(nasty).toContain('Fine &amp; dandy');
  });
});

describe('reading an opening line out of a document', () => {
  it('skips the title heading and takes the prose under it', () => {
    expect(
      deriveDescription('markdown', '# Quarterly review\n\nRevenue is up.\n', 'Quarterly review'),
    ).toBe('Revenue is up.');
  });

  it('skips front matter, badges and rules', () => {
    const readme = [
      '---',
      'title: Ignore me',
      '---',
      '',
      '# Project',
      '',
      '![build](https://img.shields.io/x) ![licence](https://img.shields.io/y)',
      '',
      '---',
      '',
      'A small tool for turning notes into pages.',
      '',
    ].join('\n');
    expect(deriveDescription('markdown', readme, 'Project')).toBe(
      'A small tool for turning notes into pages.',
    );
  });

  it('does not read code out of a fence', () => {
    const doc = '# Title\n\n```js\nconst secret = 1;\n```\n\nWhat the code does.\n';
    expect(deriveDescription('markdown', doc, 'Title')).toBe('What the code does.');
  });

  it('strips inline syntax so the card reads as a sentence', () => {
    const doc = '# T\n\nSee **the [docs](https://x.com)** for `setup` details.\n';
    expect(deriveDescription('markdown', doc, 'T')).toBe('See the docs for setup details.');
  });

  it('takes the first paragraph out of an HTML document', () => {
    const doc = '<html><head><title>T</title><style>p{color:red}</style></head><body><h1>T</h1><p>The opening line.</p></body></html>';
    expect(deriveDescription('html', doc, 'T')).toBe('The opening line.');
  });

  it('returns nothing when the document only repeats its title', () => {
    expect(deriveDescription('markdown', '# Quarterly review\n', 'Quarterly review')).toBeNull();
    expect(deriveDescription('markdown', '\n\n', 'Untitled artifact')).toBeNull();
  });

  it('cuts long prose at a word boundary', () => {
    const long = `# T\n\n${'word '.repeat(120)}\n`;
    const result = deriveDescription('markdown', long, 'T');
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(200);
    expect(result!.endsWith('…')).toBe(true);
    expect(result).not.toContain('wor…');
  });
});

/**
 * The same rule, over HTTP.
 *
 * The unit tests above prove the copy is chosen correctly; these prove the route
 * actually asks. A mistake in the wiring — matching the wrong path, or handing
 * the preview a signed-in principal — would leak a private document while every
 * test above still passed.
 */
describe.runIf(existsSync(resolve(process.cwd(), 'public/index.html')))(
  'the card an unfurler is served',
  () => {
    let server: TestServer;

    beforeEach(() => {
      server = createTestServer({ SIGNUP_MODE: 'open' }, { serveWebApp: true });
    });

    afterEach(() => {
      server.close();
    });

    /** Fetches a page the way Slack would: no cookie, no session, no anything. */
    async function cardFor(path: string): Promise<string> {
      const response = await server.request(path);
      return response.text();
    }

    it('shows a public artifact’s title and opening line to anybody', async () => {
      const owner = await signIn(server, 'owner@example.com');
      const published = await owner.publish({
        type: 'markdown',
        content: '# Quarterly review\n\nRevenue is up eighteen percent.\n',
      });
      const madePublic = await owner.as(`/api/artifacts/${published.id}/sharing/public`, {
        ...jsonBody({ isPublic: true }),
        method: 'PUT',
      });
      expect(madePublic.status).toBe(200);

      const html = await cardFor(`/a/${published.slug}`);
      expect(html).toContain('<meta property="og:title" content="Quarterly review" />');
      expect(html).toContain(
        '<meta property="og:description" content="Revenue is up eighteen percent." />',
      );
      expect(html).toContain(`content="${TEST_BASE_URL}/a/${published.slug}"`);
    });

    it('never shows a private artifact’s words, even to its own owner', async () => {
      /*
       * The owner is included on purpose. It is tempting to give the person who
       * wrote it the real card, and that is exactly the change that would leak:
       * the response is cacheable and the unfurler that draws the card is not
       * the browser that asked for it.
       */
      const owner = await signIn(server, 'owner@example.com');
      const published = await owner.publish({
        type: 'markdown',
        content: '# Project Gemini layoffs\n\nWe will cut forty roles in March.\n',
      });

      for (const html of [
        await cardFor(`/a/${published.slug}`),
        await (await owner.as(`/a/${published.slug}`)).text(),
      ]) {
        expect(html).toContain(`content="${PRIVATE_PREVIEW.title}"`);
        expect(html).not.toContain('Gemini');
        expect(html).not.toContain('layoffs');
        expect(html).not.toContain('forty roles');
      }
    });

    it('leaves the site’s own card on every other screen', async () => {
      for (const path of ['/', '/settings', '/a/nosuchartifactslughere12']) {
        const html = await cardFor(path);
        expect(html).toContain('Open Artifact');
        expect(html).not.toContain(PRIVATE_PREVIEW.title);
      }
    });
  },
);
