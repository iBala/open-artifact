import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createTestServer, type TestServer } from './helpers/server.js';
import { API_OPERATIONS, buildOpenApiDocument } from '../src/http/openapi.js';

/**
 * The description of the API and the API itself, checked against each other.
 *
 * A spec that has quietly gone stale is worse than none: somebody builds against
 * it and finds out later. So this walks the routes the server actually
 * registered and fails in both directions, on an endpoint that exists but is not
 * described and on one described but not implemented.
 */

let server: TestServer;

beforeEach(() => {
  server = createTestServer();
});

afterEach(() => {
  server.close();
});

/** Every route the server registered, as "METHOD /path". */
function registeredRoutes(): string[] {
  return server.app.routes
    .filter((route) => route.method !== 'ALL')
    .map((route) => `${route.method} ${route.path}`)
    // The catch-all that serves the web app is not part of the API.
    .filter((route) => !route.endsWith(' *'))
    .filter((route, index, all) => all.indexOf(route) === index)
    .sort();
}

describe('the spec and the routes agree', () => {
  it('describes every endpoint the server actually has', () => {
    const undocumented = registeredRoutes().filter((route) => !(route in API_OPERATIONS));

    expect(
      undocumented,
      'these endpoints exist but are not in openapi.ts. Describe them, or they are invisible to anyone building a client.',
    ).toEqual([]);
  });

  it('describes nothing the server does not have', () => {
    const registered = new Set(registeredRoutes());
    const missing = Object.keys(API_OPERATIONS).filter((route) => !registered.has(route));

    expect(
      missing,
      'these are described in openapi.ts but do not exist. Somebody building against the spec would get a 404.',
    ).toEqual([]);
  });
});

describe('the document served at /api/docs', () => {
  it('is valid enough to hand to a generator', async () => {
    const response = await server.request('/api/docs');
    expect(response.status).toBe(200);

    const document = (await response.json()) as Record<string, unknown>;
    expect(document.openapi).toBe('3.1.0');
    expect(document.info).toMatchObject({ title: 'Open Artifact' });
    expect(Object.keys(document.paths as object).length).toBeGreaterThan(10);
  });

  it('writes path parameters the way OpenAPI does, not the way the router does', () => {
    const document = buildOpenApiDocument('https://artifacts.test');
    const paths = Object.keys(document.paths as object);

    expect(paths).toContain('/api/artifacts/{id}');
    expect(paths.some((path) => path.includes(':'))).toBe(false);
  });

  it('declares path parameters so a generated client takes arguments', () => {
    const document = buildOpenApiDocument('https://artifacts.test') as {
      paths: Record<string, Record<string, { parameters: { name: string }[] }>>;
    };

    const parameters = document.paths['/api/artifacts/{id}']?.get?.parameters ?? [];
    expect(parameters.map((parameter) => parameter.name)).toEqual(['id']);
  });

  it('says which endpoints need a credential and which do not', () => {
    const document = buildOpenApiDocument('https://artifacts.test') as {
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };

    // Publishing needs one.
    expect(document.paths['/api/artifacts']?.post?.security).toHaveLength(2);
    // Asking for a sign-in link cannot.
    expect(document.paths['/api/auth/magic-link']?.post?.security).toEqual([]);
  });

  it('points at this instance, so the docs work on a self-hosted server', () => {
    const document = buildOpenApiDocument('https://artifacts.example.com') as {
      servers: { url: string }[];
    };
    expect(document.servers[0]?.url).toBe('https://artifacts.example.com');
  });
});

describe('every described endpoint', () => {
  it('says what its responses mean', () => {
    for (const [route, operation] of Object.entries(API_OPERATIONS)) {
      expect(Object.keys(operation.responses).length, `${route} lists no responses`).toBeGreaterThan(
        0,
      );
      expect(operation.summary.length, `${route} has no summary`).toBeGreaterThan(0);
    }
  });

  it('says what happens when the caller is not signed in', () => {
    for (const [route, operation] of Object.entries(API_OPERATIONS)) {
      if (operation.auth !== 'required') continue;
      expect(
        Object.keys(operation.responses).some((status) => status === '401'),
        `${route} needs a credential but does not describe what happens without one`,
      ).toBe(true);
    }
  });
});
