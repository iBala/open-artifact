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
  'POST /api/auth/cli-token': {
    summary: 'Exchange an emailed code for a command-line token',
    description:
      'The terminal counterpart of verify-code. Sends back a 90-day API token rather than setting a session cookie, so `open-artifact login` can sign in with the same emailed code the website uses. Same single use, same five attempts, same one message for every failure.',
    auth: 'none',
    responses: {
      '200': 'A token, the address it belongs to, and when it expires',
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

  // --- Closing an account --------------------------------------------------

  'DELETE /api/auth/account': {
    summary: 'Close your account, permanently',
    description:
      'Requires ?confirm=true. Deletes everything you published, along with its versions, sharing and comments, and signs you out everywhere. Your comments on other people’s artifacts stay where they are, word for word, shown as written by a deleted user: taking them out would tear holes in conversations other people are still having.',
    auth: 'required',
    responses: {
      '204': 'Closed',
      '400': 'The confirm flag is missing',
      '401': 'Not signed in',
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

  // --- Comments ------------------------------------------------------------

  'GET /api/artifacts/:id/comments': {
    summary: 'Everything said about an artifact',
    description:
      'Threads newest first, replies within each oldest first. Filter with ?status=open|resolved and ?since=<UTC ISO-8601>. `since` matches on the newest comment in a thread rather than the thread own age, so a reply to an old thread still shows up. Needs only view access, so somebody reading a public artifact can follow the conversation without being able to join it.',
    auth: 'optional',
    responses: {
      '200': 'The threads',
      '400': 'since is not a timestamp, or status is not open or resolved',
      '404': 'No such artifact, or you cannot see it',
    },
  },
  'POST /api/artifacts/:id/comments': {
    summary: 'Start a thread',
    description:
      'Leave out position for a comment about the whole document. Give it as { headingId, snippet, occurrence } to attach the comment to a passage; the anchor is checked against the artifact as it stands, so a passage that is not there is refused. HTML artifacts take document-level comments only. Commenting needs an explicit share: reading a public artifact is open to the world, commenting on it is not.',
    auth: 'required',
    responses: {
      '201': 'The new thread, with its first comment',
      '400': 'Empty comment, or a passage that cannot be anchored to',
      '401': 'Not signed in',
      '404': 'No such artifact, or you cannot comment on it',
    },
  },
  'POST /api/comments/threads/:threadId/replies': {
    summary: 'Reply on a thread',
    description:
      'There is one level of nesting by construction: a reply is another comment on the same thread, and there is nowhere for a reply to a reply to go.',
    auth: 'required',
    responses: {
      '201': 'The reply',
      '400': 'Empty comment',
      '401': 'Not signed in',
      '404': 'No such thread, or you cannot comment on it',
    },
  },
  'PUT /api/comments/threads/:threadId/status': {
    summary: 'Settle a thread, or reopen it',
    description:
      'Whoever started the thread, or whoever owns the artifact. Those are the two who can reasonably say something is settled.',
    auth: 'required',
    responses: {
      '200': 'The thread',
      '400': 'status must be open or resolved',
      '401': 'Not signed in',
      '403': 'You neither raised this nor own the artifact',
      '404': 'No such thread, or you cannot see it',
    },
  },
  'PUT /api/comments/:commentId': {
    summary: 'Change what you said',
    description:
      'The author only, never anybody else, not even the artifact owner. The comment is marked as edited afterwards.',
    auth: 'required',
    responses: {
      '200': 'The comment',
      '400': 'Empty comment, or it was deleted',
      '401': 'Not signed in',
      '404': 'No such comment, or it is not yours',
    },
  },
  'DELETE /api/comments/:commentId': {
    summary: 'Delete a comment',
    description:
      'Yours, or anything on an artifact you own. When replies came after it the row stays as a placeholder, so a reply never becomes an answer to nothing; when it was the only thing said, the thread goes too.',
    auth: 'required',
    responses: {
      '200': 'Deleted, and whether the thread went with it',
      '401': 'Not signed in',
      '404': 'No such comment, or you cannot delete it',
    },
  },

  // --- Notifications -------------------------------------------------------

  'GET /api/notifications': {
    summary: 'Everything waiting for you, newest first',
    description:
      'Held notifications are not included. A mention of somebody who cannot see the artifact is held until they are let in, because pointing at a document they cannot open is worse than saying nothing.',
    auth: 'required',
    responses: { '200': 'Notifications and the unread count', '401': 'Not signed in' },
  },
  'POST /api/notifications/:id/read': {
    summary: 'Mark one as read',
    auth: 'required',
    responses: { '204': 'Marked, or it already was', '401': 'Not signed in' },
  },
  'POST /api/notifications/read-all': {
    summary: 'Mark everything as read',
    auth: 'required',
    responses: { '200': 'How many were marked', '401': 'Not signed in' },
  },
  'GET /api/artifacts/:id/mention-candidates': {
    summary: 'Who may be named in a comment here',
    description:
      'The people it is shared with plus anybody who has already commented, never every account on the instance. On a public artifact that would turn the mention box into a directory of everybody who has ever signed in.',
    auth: 'required',
    responses: {
      '200': 'The candidates',
      '401': 'Not signed in',
      '404': 'No such artifact, or you cannot comment on it',
    },
  },
  'GET /api/access-requests': {
    summary: 'People waiting to be added to your artifacts',
    description:
      'Raised when somebody who does not own an artifact mentions a person who cannot see it. They cannot grant access, so you are asked.',
    auth: 'required',
    responses: { '200': 'The pending requests', '401': 'Not signed in' },
  },
  'POST /api/access-requests/:id/decide': {
    summary: 'Add the person, or do not',
    description:
      'Granting shares the artifact with them and releases the mention that was waiting on it. Refusing leaves them told nothing.',
    auth: 'required',
    responses: {
      '200': 'Answered',
      '400': 'grant is required and must be true or false',
      '401': 'Not signed in',
      '404': 'No such request waiting on you, or it is already answered',
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
  'GET /leaving': {
    summary: 'The page shown before following an off-site link out of a public artifact',
    description:
      'Off-site links in a public Markdown artifact are rewritten to point here, so the reader sees where they are going and chooses to continue. Renders a "not valid" page, with nothing to click through to, for anything that is not an absolute http/https URL.',
    auth: 'none',
    responses: { '200': 'The interstitial, or a "not valid" page' },
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
