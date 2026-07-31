import { describe, it, expect } from 'vitest';
import {
  excerpt,
  renderThreads,
  SNIPPET_CAP,
  DATA_NOT_INSTRUCTIONS,
} from '../src/mcp/render-threads.js';
import type { ThreadView } from '../src/comments/service.js';

/**
 * What an agent is told about a comment.
 *
 * The property under test: an agent can tell what a comment is about without
 * guessing. Before this existed, `list_comments` returned a thread id and some
 * bodies, so "this number is stale" arrived with no way to know which number.
 */

function thread(over: Partial<ThreadView> = {}): ThreadView {
  return {
    id: 't_1',
    artifactId: 'a_1',
    status: 'open',
    anchor: { kind: 'document' },
    anchorLost: false,
    createdAt: '2026-07-30T09:00:00.000Z',
    resolvedAt: null,
    comments: [
      {
        id: 'c_1',
        threadId: 't_1',
        author: { id: 'u_1', email: 'reader@example.com', displayName: null },
        body: 'this number is stale',
        createdAt: '2026-07-30T09:00:00.000Z',
        editedAt: null,
        deleted: false,
      },
    ],
    ...over,
  };
}

const onPassage = { kind: 'text', headingId: 'pricing', snippet: 'starts at $49 per seat', occurrence: 0 } as const;

// ---------------------------------------------------------------------------
// excerpt
// ---------------------------------------------------------------------------

describe('excerpt', () => {
  it('leaves a short passage exactly as it was', () => {
    expect(excerpt('starts at $49 per seat', 240)).toBe('starts at $49 per seat');
  });

  it('leaves a passage of exactly the cap alone', () => {
    const text = 'x'.repeat(40);
    expect(excerpt(text, 40)).toBe(text);
  });

  it('elides the middle of a long passage, keeping both ends', () => {
    const text = `${'a'.repeat(50)}MIDDLE${'z'.repeat(50)}`;
    const result = excerpt(text, 40);

    expect(result.length).toBeLessThanOrEqual(40);
    expect(result).toContain('…');
    expect(result.startsWith('a')).toBe(true);
    expect(result.endsWith('z')).toBe(true);
    expect(result).not.toContain('MIDDLE');
  });

  it('never splits a multi-byte character in half', () => {
    // Four-byte emoji. Cutting by UTF-16 code unit would leave half a surrogate
    // pair and a replacement character in what the agent reads.
    const text = '👩‍🚀'.repeat(40);
    const result = excerpt(text, 20);

    expect(result).not.toContain('�');
    expect([...result].every((character) => character !== '\uD83D')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// renderThreads
// ---------------------------------------------------------------------------

describe('renderThreads', () => {
  it('quotes the passage and names the heading it sits under', () => {
    const text = renderThreads([thread({ anchor: onPassage })], 1);

    expect(text).toContain('starts at $49 per seat');
    expect(text).toContain('#pricing');
    expect(text).toContain('this number is stale');
    expect(text).toContain('thread_id: t_1');
  });

  it('says a passage sits before the first heading rather than naming none', () => {
    const text = renderThreads([thread({ anchor: { ...onPassage, headingId: null } })], 1);

    expect(text).toContain('starts at $49 per seat');
    expect(text).toContain('before the first heading');
  });

  it('says plainly when a comment is about the whole document', () => {
    const text = renderThreads([thread()], 1);

    expect(text).toContain('the whole document');
    expect(text).not.toContain('under #');
  });

  it('tells the agent when a thread lost the passage it was on', () => {
    const text = renderThreads([thread({ anchorLost: true })], 1);

    expect(text).toMatch(/lost/i);
    expect(text).toMatch(/changed/i);
  });

  it('caps a very long passage rather than pouring it into the agent', () => {
    const snippet = 'word '.repeat(400).trim();
    const text = renderThreads([thread({ anchor: { ...onPassage, snippet } })], 1);

    expect(text).toContain('…');
    expect(text.length).toBeLessThan(snippet.length);
    // The quoted passage is capped; the comment bodies are not touched.
    expect(text).toContain('this number is stale');
  });

  it('keeps the data-not-instructions preamble', () => {
    const text = renderThreads([thread()], 1);

    expect(text).toContain(DATA_NOT_INSTRUCTIONS);
  });

  it('marks a resolved thread as resolved', () => {
    const text = renderThreads([thread({ status: 'resolved', resolvedAt: '2026-07-30T10:00:00.000Z' })], 1);

    expect(text).toContain('(resolved)');
  });

  it('names a deleted author rather than dropping the comment', () => {
    const one = thread();
    const text = renderThreads(
      [{ ...one, comments: [{ ...one.comments[0]!, author: null }] }],
      1,
    );

    expect(text).toContain('a deleted user');
    expect(text).toContain('this number is stale');
  });

  it('shows every reply on a thread, oldest first', () => {
    const one = thread();
    const withReply: ThreadView = {
      ...one,
      comments: [
        one.comments[0]!,
        { ...one.comments[0]!, id: 'c_2', body: 'agreed, it moved to $59' },
      ],
    };
    const text = renderThreads([withReply], 1);

    expect(text.indexOf('this number is stale')).toBeLessThan(text.indexOf('agreed, it moved to $59'));
  });

  // -------------------------------------------------------------------------
  // The cap
  // -------------------------------------------------------------------------

  it('says nothing about a cap when everything is shown', () => {
    const text = renderThreads([thread(), thread({ id: 't_2' })], 2);

    expect(text).not.toMatch(/showing/i);
  });

  it('states how many it left out when it capped', () => {
    const shown = [thread(), thread({ id: 't_2' })];
    const text = renderThreads(shown, 137);

    expect(text).toContain('2');
    expect(text).toContain('137');
    expect(text).toMatch(/oldest/i);
  });

  it('counts threads, not comments, when it reports the cap', () => {
    const one = thread();
    const chatty: ThreadView = {
      ...one,
      comments: [one.comments[0]!, { ...one.comments[0]!, id: 'c_2' }, { ...one.comments[0]!, id: 'c_3' }],
    };
    const text = renderThreads([chatty], 4);

    expect(text).toContain('1 of 4');
  });
});

describe('the caps themselves', () => {
  it('caps a quoted passage well below a comment body', () => {
    // A passage is context, not content. If it grows to the size of the document
    // the agent is reading, quoting it stops being a help.
    expect(SNIPPET_CAP).toBeLessThanOrEqual(400);
  });
});
