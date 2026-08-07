import { describe, it, expect } from 'vitest';
import { canAccess, accessReason, type ArtifactAccessFacts } from '../src/artifacts/access.js';
import type { UserRow } from '../src/db/schema.js';

/**
 * Who can do what, every combination.
 *
 * This is the function every route in the product calls before letting anybody
 * near an artifact. It is worth writing out in full rather than testing the cases
 * somebody happened to think of, because the case nobody thought of is the one
 * that leaks.
 */

function person(overrides: Partial<UserRow> = {}): UserRow {
  return {
    id: 'usr_reader',
    email: 'reader@example.com',
    displayName: null,
    emailVerified: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    deletedAt: null,
    ...overrides,
  };
}

function artifact(overrides: Partial<ArtifactAccessFacts> = {}): ArtifactAccessFacts {
  return {
    ownerId: 'usr_owner',
    isPublic: false,
    sharedEmails: [],
    sharedDomains: [],
    expiresAt: null,
    ...overrides,
  };
}

const OWNER = person({ id: 'usr_owner', email: 'owner@example.com' });
const STRANGER = person({ id: 'usr_stranger', email: 'stranger@elsewhere.test' });

/** Comfortably in the past and the future, so no test depends on how fast it runs. */
const YESTERDAY = '2020-01-01T00:00:00.000Z';
const NEXT_CENTURY = '2120-01-01T00:00:00.000Z';

/**
 * Every combination of who is asking, how the artifact is shared, and what they
 * are trying to do. Written as a table so a missing row is visible.
 */
const MATRIX: {
  who: string;
  principal: UserRow | null;
  how: string;
  artifact: ArtifactAccessFacts;
  view: boolean;
  comment: boolean;
  manage: boolean;
}[] = [
  // The owner, whatever the sharing state.
  { who: 'the owner', principal: OWNER, how: 'private', artifact: artifact(), view: true, comment: true, manage: true },
  { who: 'the owner', principal: OWNER, how: 'public', artifact: artifact({ isPublic: true }), view: true, comment: true, manage: true },

  // Shared with them by address.
  {
    who: 'somebody it is shared with',
    principal: person(),
    how: 'shared with their address',
    artifact: artifact({ sharedEmails: ['reader@example.com'] }),
    view: true,
    comment: true,
    manage: false,
  },

  // Shared with their domain.
  {
    who: 'a colleague',
    principal: person({ email: 'colleague@zorp.one' }),
    how: 'shared with their domain',
    artifact: artifact({ sharedDomains: ['zorp.one'] }),
    view: true,
    comment: true,
    manage: false,
  },

  // Public, to somebody with no share of their own.
  {
    who: 'a signed-in passer-by',
    principal: STRANGER,
    how: 'public',
    artifact: artifact({ isPublic: true }),
    view: true,
    // The one that surprises people: reading is open to the world, commenting
    // is not. A comment box open to the world is a different product.
    comment: false,
    manage: false,
  },
  {
    who: 'nobody signed in',
    principal: null,
    how: 'public',
    artifact: artifact({ isPublic: true }),
    view: true,
    comment: false,
    manage: false,
  },

  // No relationship at all.
  { who: 'a stranger', principal: STRANGER, how: 'private', artifact: artifact(), view: false, comment: false, manage: false },
  { who: 'nobody signed in', principal: null, how: 'private', artifact: artifact(), view: false, comment: false, manage: false },
  {
    who: 'a stranger',
    principal: STRANGER,
    how: 'shared with somebody else',
    artifact: artifact({ sharedEmails: ['someone-else@example.com'] }),
    view: false,
    comment: false,
    manage: false,
  },
  {
    who: 'somebody at a different domain',
    principal: person({ email: 'outsider@elsewhere.test' }),
    how: 'shared with zorp.one',
    artifact: artifact({ sharedDomains: ['zorp.one'] }),
    view: false,
    comment: false,
    manage: false,
  },

  // Somebody whose address is shared but who has not proved they own it.
  {
    who: 'somebody with an unverified address',
    principal: person({ emailVerified: 0 }),
    how: 'shared with that address',
    artifact: artifact({ sharedEmails: ['reader@example.com'] }),
    view: false,
    comment: false,
    manage: false,
  },

  // A closed account.
  {
    who: 'a deleted account',
    principal: person({ deletedAt: '2026-06-01T00:00:00.000Z' }),
    how: 'shared with that address',
    artifact: artifact({ sharedEmails: ['reader@example.com'] }),
    view: false,
    comment: false,
    manage: false,
  },
  {
    who: 'a deleted owner',
    principal: person({ id: 'usr_owner', deletedAt: '2026-06-01T00:00:00.000Z' }),
    how: 'their own artifact',
    artifact: artifact(),
    view: false,
    comment: false,
    manage: false,
  },

  // --- Expired links -------------------------------------------------------
  // One deadline covers the artifact, so it takes away every way in at once.
  {
    who: 'the owner',
    principal: OWNER,
    how: 'expired',
    artifact: artifact({ expiresAt: YESTERDAY, isPublic: true }),
    // Expiry withdraws a link. It does not lock somebody out of their own
    // document, and it does not stop them setting a new deadline.
    view: true,
    comment: true,
    manage: true,
  },
  {
    who: 'somebody it is shared with',
    principal: person(),
    how: 'expired',
    artifact: artifact({ sharedEmails: ['reader@example.com'], expiresAt: YESTERDAY }),
    view: false,
    comment: false,
    manage: false,
  },
  {
    who: 'a colleague',
    principal: person({ email: 'colleague@zorp.one' }),
    how: 'expired, shared with their domain',
    artifact: artifact({ sharedDomains: ['zorp.one'], expiresAt: YESTERDAY }),
    view: false,
    comment: false,
    manage: false,
  },
  {
    who: 'a signed-in passer-by',
    principal: STRANGER,
    how: 'expired, public',
    artifact: artifact({ isPublic: true, expiresAt: YESTERDAY }),
    view: false,
    comment: false,
    manage: false,
  },
  {
    who: 'a signed-out reader',
    principal: null,
    how: 'expired, public',
    artifact: artifact({ isPublic: true, expiresAt: YESTERDAY }),
    view: false,
    comment: false,
    manage: false,
  },
  {
    who: 'somebody it is shared with',
    principal: person(),
    how: 'a deadline still in the future',
    artifact: artifact({ sharedEmails: ['reader@example.com'], expiresAt: NEXT_CENTURY }),
    view: true,
    comment: true,
    manage: false,
  },
];

describe('the access matrix', () => {
  for (const row of MATRIX) {
    describe(`${row.who}, ${row.how}`, () => {
      it(`can${row.view ? '' : 'not'} view it`, () => {
        expect(canAccess(row.principal, row.artifact, 'view')).toBe(row.view);
      });

      it(`can${row.comment ? '' : 'not'} comment on it`, () => {
        expect(canAccess(row.principal, row.artifact, 'comment')).toBe(row.comment);
      });

      it(`can${row.manage ? '' : 'not'} manage it`, () => {
        expect(canAccess(row.principal, row.artifact, 'manage')).toBe(row.manage);
      });
    });
  }
});

describe('rules that must hold whatever the sharing state', () => {
  it('never lets anybody but the owner manage an artifact', () => {
    for (const row of MATRIX) {
      if (row.principal?.id === 'usr_owner' && !row.principal.deletedAt) continue;
      expect(
        canAccess(row.principal, row.artifact, 'manage'),
        `${row.who}, ${row.how}`,
      ).toBe(false);
    }
  });

  it('never lets anybody comment who cannot view', () => {
    for (const row of MATRIX) {
      if (canAccess(row.principal, row.artifact, 'comment')) {
        expect(canAccess(row.principal, row.artifact, 'view'), `${row.who}, ${row.how}`).toBe(true);
      }
    }
  });

  it('never gives a deleted account anything', () => {
    const closed = person({ deletedAt: '2026-06-01T00:00:00.000Z' });
    const wideOpen = artifact({
      ownerId: closed.id,
      isPublic: true,
      sharedEmails: [closed.email],
      sharedDomains: ['example.com'],
    });

    for (const action of ['view', 'comment', 'manage'] as const) {
      expect(canAccess(closed, wideOpen, action)).toBe(false);
    }
  });
});

describe('why somebody has access', () => {
  it('says which rule let them in, most specific first', () => {
    // The owner of a public artifact is the owner, not a member of the public.
    expect(accessReason(OWNER, artifact({ isPublic: true }))).toBe('owner');

    expect(
      accessReason(person(), artifact({ sharedEmails: ['reader@example.com'], isPublic: true })),
    ).toBe('shared-with-you');

    expect(
      accessReason(person({ email: 'a@zorp.one' }), artifact({ sharedDomains: ['zorp.one'] })),
    ).toBe('shared-with-your-domain');

    expect(accessReason(STRANGER, artifact({ isPublic: true }))).toBe('public');
    expect(accessReason(STRANGER, artifact())).toBe('no-access');
  });
});

describe('an expired link', () => {
  it('takes access away from everybody except the owner', () => {
    const dead = artifact({
      isPublic: true,
      sharedEmails: ['reader@example.com'],
      sharedDomains: ['zorp.one'],
      expiresAt: YESTERDAY,
    });

    expect(accessReason(OWNER, dead)).toBe('owner');
    expect(accessReason(person(), dead)).toBe('expired');
    expect(accessReason(person({ email: 'a@zorp.one' }), dead)).toBe('expired');
    expect(accessReason(STRANGER, dead)).toBe('expired');
    expect(accessReason(null, dead)).toBe('expired');
  });

  /**
   * The one that makes 'expired' safe to tell people about.
   *
   * Somebody who never had access must not learn that an artifact exists just
   * because its deadline has passed. If this ever flips, an expired private
   * artifact becomes a way to confirm ids by probing them, and the whole reason
   * refusals say "no such artifact" is gone.
   */
  it('does not turn a refusal into a disclosure for somebody who never had access', () => {
    const privateAndExpired = artifact({ expiresAt: YESTERDAY });

    expect(accessReason(STRANGER, privateAndExpired)).toBe('no-access');
    expect(accessReason(null, privateAndExpired)).toBe('no-access');

    // Shared with somebody else, expired: still nothing to do with this reader.
    expect(
      accessReason(STRANGER, artifact({ sharedEmails: ['someone@else.test'], expiresAt: YESTERDAY })),
    ).toBe('no-access');

    // And an unverified address stays out, expired or not: expiry must not
    // become a second path around the verification rule.
    expect(
      accessReason(
        person({ emailVerified: 0 }),
        artifact({ sharedEmails: ['reader@example.com'], expiresAt: YESTERDAY }),
      ),
    ).toBe('no-access');
  });

  it('still refuses a closed account rather than calling it expired', () => {
    const closed = person({ deletedAt: '2026-06-01T00:00:00.000Z' });
    expect(
      accessReason(closed, artifact({ sharedEmails: [closed.email], expiresAt: YESTERDAY })),
    ).toBe('no-access');
  });

  it('treats null as forever rather than as already expired', () => {
    expect(accessReason(person(), artifact({ sharedEmails: ['reader@example.com'] }))).toBe(
      'shared-with-you',
    );
  });

  it('lets nobody but the owner do anything once it has passed', () => {
    const dead = artifact({ isPublic: true, sharedEmails: ['reader@example.com'], expiresAt: YESTERDAY });

    for (const action of ['view', 'comment', 'manage'] as const) {
      expect(canAccess(person(), dead, action), action).toBe(false);
      expect(canAccess(STRANGER, dead, action), action).toBe(false);
      expect(canAccess(null, dead, action), action).toBe(false);
    }
  });
});

describe('matching addresses and domains', () => {
  it('ignores case on both sides', () => {
    expect(
      canAccess(person({ email: 'Reader@Example.COM' }), artifact({ sharedEmails: ['reader@example.com'] }), 'view'),
    ).toBe(true);

    expect(
      canAccess(person({ email: 'A@ZORP.ONE' }), artifact({ sharedDomains: ['zorp.one'] }), 'view'),
    ).toBe(true);
  });

  it('does not treat a domain as matching just because it ends the same way', () => {
    // notzorp.one must not pass because it ends in zorp.one.
    expect(
      canAccess(person({ email: 'a@notzorp.one' }), artifact({ sharedDomains: ['zorp.one'] }), 'view'),
    ).toBe(false);

    expect(
      canAccess(person({ email: 'a@zorp.one.evil.test' }), artifact({ sharedDomains: ['zorp.one'] }), 'view'),
    ).toBe(false);
  });

  it('does not treat a subdomain as the parent domain', () => {
    expect(
      canAccess(person({ email: 'a@mail.zorp.one' }), artifact({ sharedDomains: ['zorp.one'] }), 'view'),
    ).toBe(false);
  });
});
