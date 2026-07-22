/**
 * The written-down API.
 *
 * The HTTP API is the product's contract. Anybody can build their own client
 * against it, which means the description has to be true, and staying true
 * cannot depend on somebody remembering. So this file lists the endpoints, and a
 * test walks the routes the server actually registered and fails if the two
 * disagree in either direction.
 *
 * Written by hand rather than generated from decorators: a spec derived from the
 * code says whatever the code says, including the parts that are wrong. This one
 * is a statement of intent that the code is checked against.
 */

export const OPENAPI_VERSION = '3.1.0';

interface Operation {
  summary: string;
  description?: string;
  /** Whether a credential is required. Checked against the routes by a test. */
  auth: 'required' | 'optional' | 'none';
  responses: Record<string, string>;
}

/**
 * Every endpoint, keyed by "METHOD /path".
 *
 * Paths use the same parameter syntax the router does, so the drift test can
 * compare them without translating.
 */
export const API_OPERATIONS: Record<string, Operation> = {
  'GET /api/docs': {
    summary: 'This document',
    description: 'The API described in OpenAPI form, pointed at this instance.',
    auth: 'none',
    responses: { '200': 'The OpenAPI document' },
  },
  'GET /healthz': {
    summary: 'Is this instance healthy',
    description:
      'Returns 200 when the database answers and migrations are applied. Used by container healthchecks and uptime monitoring.',
    auth: 'none',
    responses: { '200': 'Healthy', '503': 'The database is not reachable' },
  },

  // --- Signing in ----------------------------------------------------------

  'GET /api/auth/methods': {
    summary: 'How you can sign in to this instance',
    description: 'The login page asks this before drawing its buttons.',
    auth: 'none',
    responses: { '200': 'Which methods are available' },
  },
  'POST /api/auth/code': {
    summary: 'Ask for a sign-in code by email',
    description:
      'Sends six digits to the address. Always answers the same way, whether or not the address has an account here and whether or not it would be allowed to create one. Asking is never a way to find out who uses this instance. Asking again replaces whatever code was outstanding for that address.',
    auth: 'none',
    responses: { '200': 'A code is on its way, if that address can sign in', '400': 'Not a valid email address' },
  },
  'POST /api/auth/verify-code': {
    summary: 'Sign in with the emailed code',
    description:
      'Works once, expires after 10 minutes, and allows five attempts before the code is thrown away. Sets the session cookie and answers with where the person was headed, so the page that called it can move them there. Every failure gives the same message: a wrong code, an expired one and an address that never asked for one cannot be told apart.',
    auth: 'none',
    responses: {
      '200': 'Signed in',
      '400': 'Not a valid email address',
      '401': 'The code is wrong, used, expired or out of attempts',
      '403': 'That address is not allowed to create an account here',
    },
  },
  'GET /auth/google/start': {
    summary: 'Begin signing in with Google',
    auth: 'none',
    responses: { '302': 'Off to Google', '404': 'This instance does not offer Google sign-in' },
  },
  'GET /auth/google/callback': {
    summary: 'Return from Google',
    auth: 'none',
    responses: { '302': 'Signed in', '401': 'The sign-in could not be completed' },
  },
  'GET /api/auth/me': {
    summary: 'Who am I',
    auth: 'required',
    responses: { '200': 'The signed-in person', '401': 'Not signed in' },
  },
  'POST /api/auth/sign-out': {
    summary: 'Sign out of this browser',
    auth: 'optional',
    responses: { '200': 'Signed out' },
  },
  'POST /api/auth/token/revoke': {
    summary: 'Revoke the API token this request was made with',
    description: 'What `open-artifact logout` calls.',
    auth: 'required',
    responses: { '204': 'Revoked', '401': 'Not signed in' },
  },

  // --- Signing in from a command line --------------------------------------

  'POST /api/auth/device': {
    summary: 'Start signing in from a command line',
    description:
      'Returns a long device code for the client to keep and a short code for the person to check against their screen.',
    auth: 'none',
    responses: { '200': 'A sign-in has been started' },
  },
  'POST /api/auth/device/token': {
    summary: 'Ask whether the sign-in has been approved yet',
    description: 'Poll this at the interval the start response gave.',
    auth: 'none',
    responses: {
      '200': 'Approved, with the token',
      '202': 'Still waiting for somebody to approve',
      '403': 'Refused in the browser',
      '410': 'The code expired',
      '401': 'No such sign-in, or its token was already collected',
    },
  },
  'GET /auth/device': {
    summary: 'The page where a person approves a command-line sign-in',
    auth: 'optional',
    responses: { '200': 'The approval page', '302': 'Sign in first, then come back here' },
  },
  'POST /api/auth/device/approve': {
    summary: 'Approve or refuse a command-line sign-in',
    auth: 'required',
    responses: {
      '200': 'Answered',
      '400': 'Already answered, or expired',
      '401': 'Not signed in',
      '404': 'No such code',
    },
  },

  // --- Sessions ------------------------------------------------------------

  'GET /api/auth/sessions': {
    summary: 'Everywhere this account is signed in',
    auth: 'required',
    responses: { '200': 'Browsers and command lines', '401': 'Not signed in' },
  },
  'DELETE /api/auth/sessions/:id': {
    summary: 'Sign a browser out',
    description: 'Takes effect on that browser’s next request.',
    auth: 'required',
    responses: {
      '204': 'Signed out',
      '401': 'Not signed in',
      '404': 'No such session on this account',
    },
  },
  'DELETE /api/auth/tokens/:id': {
    summary: 'Revoke a command line’s access',
    auth: 'required',
    responses: {
      '204': 'Revoked',
      '401': 'Not signed in',
      '404': 'No such token on this account',
    },
  },

  // --- Artifacts -----------------------------------------------------------

  'POST /api/artifacts': {
    summary: 'Publish an artifact',
    description: 'Markdown or HTML. The artifact belongs to whoever published it.',
    auth: 'required',
    responses: {
      '201': 'Published',
      '400': 'Bad request, or a type that cannot be rendered safely',
      '401': 'Not signed in',
      '413': 'Larger than this instance allows',
    },
  },
  'GET /api/artifacts': {
    summary: 'Everything you published',
    auth: 'required',
    responses: { '200': 'Your artifacts, newest change first', '401': 'Not signed in' },
  },
  'GET /api/artifacts/:id': {
    summary: 'Read one artifact, with its content',
    auth: 'optional',
    responses: { '200': 'The artifact', '404': 'No such artifact, or you cannot see it' },
  },
  'PUT /api/artifacts/:id': {
    summary: 'Replace an artifact’s content',
    description:
      'Send the version you last read as baseVersion. If it is no longer current the update is refused rather than overwriting somebody’s change. The URL never changes.',
    auth: 'required',
    responses: {
      '200': 'Updated',
      '400': 'Bad request',
      '401': 'Not signed in',
      '404': 'No such artifact, or it is not yours',
      '409': 'Somebody changed it since you read it',
      '413': 'Larger than this instance allows',
    },
  },
  'DELETE /api/artifacts/:id': {
    summary: 'Delete an artifact, permanently',
    description: 'Requires ?confirm=true. Takes the version history with it.',
    auth: 'required',
    responses: {
      '204': 'Deleted',
      '400': 'The confirm flag is missing',
      '401': 'Not signed in',
      '404': 'No such artifact, or it is not yours',
    },
  },

  // --- Sharing -------------------------------------------------------------

  'GET /api/shared-with-me': {
    summary: 'Artifacts other people shared with you',
    description:
      'Includes ones shared with your address and ones shared with everybody at your email domain.',
    auth: 'required',
    responses: { '200': 'Artifacts shared with you', '401': 'Not signed in' },
  },
  'GET /api/artifacts/:id/sharing': {
    summary: 'Who this artifact is shared with',
    auth: 'required',
    responses: {
      '200': 'People, domains and whether it is public',
      '401': 'Not signed in',
      '404': 'No such artifact, or it is not yours',
    },
  },
  'POST /api/artifacts/:id/sharing/people': {
    summary: 'Share with somebody, by email address',
    description:
      'Works for an address that has never signed in here: the invitation waits, and attaches when they first sign in with it. Sharing again with the same address does not send a second email.',
    auth: 'required',
    responses: {
      '201': 'Shared, and an email has gone out',
      '200': 'Already shared with that address, nothing sent',
      '400': 'Not a valid email address, or it is your own',
      '401': 'Not signed in',
      '404': 'No such artifact, or it is not yours',
    },
  },
  'DELETE /api/artifacts/:id/sharing/people/:email': {
    summary: 'Stop sharing with somebody',
    description: 'Takes effect on their next request.',
    auth: 'required',
    responses: {
      '200': 'Removed',
      '401': 'Not signed in',
      '404': 'Not shared with that address, or the artifact is not yours',
    },
  },
  'POST /api/artifacts/:id/sharing/domains': {
    summary: 'Share with everybody at an email domain',
    description:
      'Public email providers such as gmail.com are refused: that would share with most of the internet worded as though it were a company.',
    auth: 'required',
    responses: {
      '201': 'Shared',
      '200': 'Already shared with that domain',
      '400': 'Not a domain, or a public email provider',
      '401': 'Not signed in',
      '404': 'No such artifact, or it is not yours',
    },
  },
  'DELETE /api/artifacts/:id/sharing/domains/:domain': {
    summary: 'Stop sharing with a domain',
    auth: 'required',
    responses: {
      '200': 'Removed',
      '401': 'Not signed in',
      '404': 'Not shared with that domain, or the artifact is not yours',
    },
  },
  'PUT /api/artifacts/:id/sharing/public': {
    summary: 'Make an artifact readable by anybody with the link, or stop',
    description:
      'Public means anybody can read it, signed in or not. Commenting still needs an explicit share.',
    auth: 'required',
    responses: {
      '200': 'Changed',
      '400': 'isPublic is required and must be true or false',
      '401': 'Not signed in',
      '404': 'No such artifact, or it is not yours',
    },
  },

  // --- Viewing -------------------------------------------------------------

  'GET /api/artifacts/by-slug/:slug': {
    summary: 'Read one artifact by the slug in its URL',
    description:
      'What the viewer calls: it has a slug from the address bar rather than an id, and needs to know who published it.',
    auth: 'optional',
    responses: { '200': 'The artifact', '404': 'No such artifact, or you cannot see it' },
  },
  'GET /a/:slug/content': {
    summary: 'The artifact’s own bytes, for the sandboxed frame',
    description:
      'Carries its own Content-Security-Policy sandbox directive, so opening this URL directly in a tab is no more powerful than the frame.',
    auth: 'optional',
    responses: { '200': 'The content', '404': 'No such artifact, or you cannot see it' },
  },
};

/** The OpenAPI document served at /api/docs. */
export function buildOpenApiDocument(baseUrl: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const [key, operation] of Object.entries(API_OPERATIONS)) {
    const [method = '', path = ''] = key.split(' ');
    // OpenAPI writes parameters as {id}; the router writes them as :id.
    const openApiPath = path.replace(/:(\w+)/g, '{$1}');

    paths[openApiPath] ??= {};
    paths[openApiPath][method.toLowerCase()] = {
      summary: operation.summary,
      ...(operation.description ? { description: operation.description } : {}),
      ...(operation.auth === 'required' ? { security: [{ bearerAuth: [] }, { sessionCookie: [] }] } : {}),
      ...(operation.auth === 'none' ? { security: [] } : {}),
      parameters: parametersFor(path),
      responses: Object.fromEntries(
        Object.entries(operation.responses).map(([status, description]) => [
          status,
          { description },
        ]),
      ),
    };
  }

  return {
    openapi: OPENAPI_VERSION,
    info: {
      title: 'Open Artifact',
      version: '0.1.0',
      description:
        'Publish HTML and Markdown artifacts, share them, and comment on them. This API is the contract: the command line, the web app and the skill all speak it, and so can anything you build.',
      license: { name: 'Apache-2.0', url: 'https://www.apache.org/licenses/LICENSE-2.0' },
    },
    servers: [{ url: baseUrl }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'A token from `open-artifact login`.',
        },
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'oa_session',
          description: 'Set when signing in through a browser.',
        },
      },
    },
    paths,
  };
}

function parametersFor(path: string): Record<string, unknown>[] {
  return [...path.matchAll(/:(\w+)/g)].map((match) => ({
    name: match[1],
    in: 'path',
    required: true,
    schema: { type: 'string' },
  }));
}
