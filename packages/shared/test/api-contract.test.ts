import { describe, it, expect, expectTypeOf } from 'vitest';
import { API_ERROR_CODES } from '../src/index.js';
import type { ArtifactDetail, ArtifactSummary, ApiErrorBody } from '../src/index.js';

/**
 * The API surface, pinned.
 *
 * These types are what the server, the CLI and the web app all agree on. A change
 * here is a change to the product's contract, so it should be deliberate enough
 * to require editing this file.
 */

describe('the error codes clients branch on', () => {
  it('holds every code the server can return', () => {
    // Removing one, or renaming it, breaks every client that checks for it.
    expect([...API_ERROR_CODES]).toEqual([
      'unauthenticated',
      'forbidden',
      'not_found',
      'gone',
      'validation_failed',
      'unsupported_type',
      'payload_too_large',
      'version_conflict',
      'rate_limited',
      'internal_error',
    ]);
  });

  it('has no duplicates', () => {
    expect(new Set(API_ERROR_CODES).size).toBe(API_ERROR_CODES.length);
  });
});

describe('what an artifact response contains', () => {
  it('carries everything a client needs without a second request', () => {
    expectTypeOf<ArtifactSummary>().toHaveProperty('id');
    expectTypeOf<ArtifactSummary>().toHaveProperty('slug');
    expectTypeOf<ArtifactSummary>().toHaveProperty('ownerId');
    expectTypeOf<ArtifactSummary>().toHaveProperty('version');
    // The URL is returned rather than built by clients, so there is one place
    // that knows how an artifact address is shaped.
    expectTypeOf<ArtifactSummary>().toHaveProperty('url');
  });

  it('separates the summary from the one that carries content', () => {
    expectTypeOf<ArtifactDetail>().toMatchTypeOf<ArtifactSummary>();
    expectTypeOf<ArtifactDetail>().toHaveProperty('content');
  });
});

describe('the shape of a failure', () => {
  it('is one object with a code and a message', () => {
    const failure: ApiErrorBody = {
      error: { code: 'version_conflict', message: 'Somebody got there first.' },
    };
    expect(failure.error.code).toBe('version_conflict');
  });
});
