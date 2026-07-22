import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  createTestServer,
  signIn,
  jsonBody,
  type TestServer,
  type SignedInUser,
  type PublishedArtifact,
} from './helpers/server.js';

let server: TestServer;
let owner: SignedInUser;
let artifact: PublishedArtifact;

beforeEach(async () => {
  server = createTestServer({ SIGNUP_MODE: 'open' });
  owner = await signIn(server, 'owner@example.com');
  artifact = await owner.publish({ type: 'markdown', content: '# Quarterly report' });
});

afterEach(() => {
  server.close();
});

interface SharingState {
  isPublic: boolean;
  people: { email: string; pending: boolean }[];
  domains: { domain: string }[];
}

const shareWith = (email: string) =>
  owner.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email }));

const shareWithDomain = (domain: string) =>
  owner.as(`/api/artifacts/${artifact.id}/sharing/domains`, jsonBody({ domain }));

const setPublic = (isPublic: boolean) =>
  owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isPublic }),
  });

async function sharingState(): Promise<SharingState> {
  const response = await owner.as(`/api/artifacts/${artifact.id}/sharing`);
  return (await response.json()) as SharingState;
}

describe('sharing with a person', () => {
  it('gives them access straight away', async () => {
    const colleague = await signIn(server, 'colleague@example.com');
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(404);

    expect((await shareWith('colleague@example.com')).status).toBe(201);

    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
    expect((await colleague.as(`/a/${artifact.slug}`)).status).toBe(200);
  });

  it('sends them an email with a working link', async () => {
    await shareWith('colleague@example.com');

    const email = server.mailer.lastTo('colleague@example.com');
    expect(email?.subject).toContain('Quarterly report');
    expect(email?.subject).toContain('owner@example.com');
    expect(email?.text).toContain(`/a/${artifact.slug}`);
  });

  it('does not send a second email when the same person is added again', async () => {
    const sharesTo = (email: string) =>
      server.mailer.sent.filter(
        (message) => message.to === email && message.subject.includes('shared'),
      ).length;

    await shareWith('colleague@example.com');
    expect(sharesTo('colleague@example.com')).toBe(1);

    // Somebody re-opens the dialog and types a name that is already there.
    const again = await shareWith('colleague@example.com');
    expect(again.status).toBe(200);
    expect(sharesTo('colleague@example.com')).toBe(1);
  });

  it('tells somebody who has never signed in here what will happen', async () => {
    await shareWith('newcomer@elsewhere.test');

    const email = server.mailer.lastTo('newcomer@elsewhere.test');
    // Otherwise the link looks like it leads to a wall.
    expect(email?.text).toContain('sign-in link');
  });

  it('treats the address as case-insensitive', async () => {
    await shareWith('Colleague@Example.COM');
    expect((await sharingState()).people[0]?.email).toBe('colleague@example.com');

    const colleague = await signIn(server, 'colleague@example.com');
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
  });

  it('refuses something that is not an email address', async () => {
    expect((await shareWith('not-an-address')).status).toBe(400);
  });

  it('refuses to share with yourself, and says why', async () => {
    const response = await shareWith('owner@example.com');
    expect(response.status).toBe(400);
    expect(await messageOf(response)).toContain('your own');
  });
});

describe('taking a person’s access away', () => {
  it('takes effect on their next request', async () => {
    const colleague = await signIn(server, 'colleague@example.com');
    await shareWith('colleague@example.com');
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/people/colleague%40example.com`, {
      method: 'DELETE',
    });

    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(404);
    expect((await colleague.as(`/a/${artifact.slug}`)).status).toBe(404);
  });

  it('says so when the artifact was not shared with that address', async () => {
    const response = await owner.as(
      `/api/artifacts/${artifact.id}/sharing/people/nobody%40example.com`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(404);
  });
});

describe('sharing with a domain', () => {
  it('gives everybody at that domain access', async () => {
    const colleague = await signIn(server, 'colleague@zorp.one');
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(404);

    expect((await shareWithDomain('zorp.one')).status).toBe(201);

    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
  });

  it('accepts a domain however it was typed', async () => {
    await shareWithDomain('@ZORP.one');
    expect((await sharingState()).domains[0]?.domain).toBe('zorp.one');

    await shareWithDomain('https://example.org/some/path');
    expect((await sharingState()).domains.map((entry) => entry.domain)).toContain('example.org');
  });

  it('refuses a public email provider, and says what to do instead', async () => {
    // "Everybody at gmail.com" is most of the internet, worded as though it were
    // a company. Somebody will type it while meaning to share with one person.
    for (const provider of ['gmail.com', 'Outlook.com', 'yahoo.co.uk', 'proton.me']) {
      const response = await shareWithDomain(provider);
      expect(response.status, provider).toBe(400);
      expect(await messageOf(response)).toMatch(/individual addresses|public/i);
    }
  });

  it('still allows sharing with an individual address at those providers', async () => {
    expect((await shareWith('someone@gmail.com')).status).toBe(201);
  });

  it('refuses something that is not a domain', async () => {
    expect((await shareWithDomain('not a domain')).status).toBe(400);
    expect((await shareWithDomain('localhost')).status).toBe(400);
  });

  it('takes access away when the domain is removed', async () => {
    const colleague = await signIn(server, 'colleague@zorp.one');
    await shareWithDomain('zorp.one');
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);

    await owner.as(`/api/artifacts/${artifact.id}/sharing/domains/zorp.one`, { method: 'DELETE' });
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(404);
  });
});

describe('making an artifact public', () => {
  it('lets anybody read it, signed in or not', async () => {
    expect((await server.request(`/a/${artifact.slug}`)).status).toBe(404);

    await setPublic(true);

    const anonymous = await server.request(`/a/${artifact.slug}`);
    expect(anonymous.status).toBe(200);
    expect(await anonymous.text()).toContain('Quarterly report');
  });

  it('serves public content with the sandbox still in place', async () => {
    const dashboard = await owner.publish({ type: 'html', content: '<h1>Dashboard</h1>' });
    await owner.as(`/api/artifacts/${dashboard.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: true }),
    });

    const response = await server.request(`/a/${dashboard.slug}/content`);
    expect(response.status).toBe(200);

    // Being public changes who may read it, not what it is allowed to do.
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(policy).toContain('sandbox allow-scripts');
    expect(policy).toContain("connect-src 'none'");
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('takes access away again when it is made private', async () => {
    await setPublic(true);
    expect((await server.request(`/a/${artifact.slug}`)).status).toBe(200);

    await setPublic(false);
    expect((await server.request(`/a/${artifact.slug}`)).status).toBe(404);
  });

  it('refuses anything but true or false', async () => {
    const response = await owner.as(`/api/artifacts/${artifact.id}/sharing/public`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isPublic: 'yes' }),
    });
    expect(response.status).toBe(400);
  });
});

describe('what a private artifact gives away', () => {
  it('nothing: a stranger gets the same answer as for an id that never existed', async () => {
    const stranger = await signIn(server, 'stranger@elsewhere.test');

    const real = await stranger.as(`/api/artifacts/${artifact.id}`);
    const invented = await stranger.as('/api/artifacts/art_never_existed');

    expect(real.status).toBe(invented.status);
    expect(await real.json()).toEqual(await invented.json());
  });

  it('and a stranger cannot see or change its sharing', async () => {
    const stranger = await signIn(server, 'stranger@elsewhere.test');

    expect((await stranger.as(`/api/artifacts/${artifact.id}/sharing`)).status).toBe(404);
    expect(
      (await stranger.as(`/api/artifacts/${artifact.id}/sharing/people`, jsonBody({ email: 'x@y.test' })))
        .status,
    ).toBe(404);
  });

  it('and somebody it is shared with still cannot change who else sees it', async () => {
    const colleague = await signIn(server, 'colleague@example.com');
    await shareWith('colleague@example.com');

    // They can read it, but sharing is the owner's alone.
    expect((await colleague.as(`/api/artifacts/${artifact.id}`)).status).toBe(200);
    expect((await colleague.as(`/api/artifacts/${artifact.id}/sharing`)).status).toBe(404);
    expect(
      (await colleague.as(`/api/artifacts/${artifact.id}/sharing/public`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isPublic: true }),
      })).status,
    ).toBe(404);
  });

  it('and somebody it is shared with cannot change or delete it', async () => {
    const colleague = await signIn(server, 'colleague@example.com');
    await shareWith('colleague@example.com');

    expect(
      (await colleague.as(`/api/artifacts/${artifact.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: '# Vandalised', baseVersion: 1 }),
      })).status,
    ).toBe(404);

    expect(
      (await colleague.as(`/api/artifacts/${artifact.id}?confirm=true`, { method: 'DELETE' }))
        .status,
    ).toBe(404);
  });
});

describe('the shared-with-me list', () => {
  it('holds what other people shared, and not your own work', async () => {
    const colleague = await signIn(server, 'colleague@example.com');
    await colleague.publish({ type: 'markdown', content: '# Their own work' });
    await shareWith('colleague@example.com');

    const response = await colleague.as('/api/shared-with-me');
    const body = (await response.json()) as { artifacts: { title: string; ownerEmail: string }[] };

    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]?.title).toBe('Quarterly report');
    // Who shared it, so the dashboard can say.
    expect(body.artifacts[0]?.ownerEmail).toBe('owner@example.com');
  });

  it('includes artifacts shared with your whole domain', async () => {
    const colleague = await signIn(server, 'colleague@zorp.one');
    await shareWithDomain('zorp.one');

    const body = (await (await colleague.as('/api/shared-with-me')).json()) as {
      artifacts: unknown[];
    };
    expect(body.artifacts).toHaveLength(1);
  });

  it('does not list something twice when it is shared both ways', async () => {
    const colleague = await signIn(server, 'colleague@zorp.one');
    await shareWith('colleague@zorp.one');
    await shareWithDomain('zorp.one');

    const body = (await (await colleague.as('/api/shared-with-me')).json()) as {
      artifacts: unknown[];
    };
    expect(body.artifacts).toHaveLength(1);
  });

  it('does not include public artifacts nobody shared with you', async () => {
    const stranger = await signIn(server, 'stranger@elsewhere.test');
    await setPublic(true);

    // They can read it if they have the link, but it is not "shared with them"
    // and would otherwise fill everybody's dashboard with everything public.
    const body = (await (await stranger.as('/api/shared-with-me')).json()) as {
      artifacts: unknown[];
    };
    expect(body.artifacts).toHaveLength(0);
  });
});

async function messageOf(response: Response): Promise<string> {
  return ((await response.json()) as { error: { message: string } }).error.message;
}
