/**
 * Where this account is signed in, and taking that away.
 *
 * The screen somebody opens when a laptop has gone missing, so it is built for
 * that moment: everything visible at once, the current browser clearly marked,
 * and revoking takes one press with no dialog in the way. The one thing that does
 * ask twice is signing out the browser you are using, because that one is
 * surprising rather than dangerous.
 */

import { useEffect, useState } from 'react';
import { endpoints, type SessionEntry, type TokenEntry } from '../api.js';
import { Button, ErrorNote, RelativeTime, EmptyState } from '../components/primitives.js';
import { useAccount } from '../App.jsx';

export function Sessions() {
  const { signOut } = useAccount();
  const [sessions, setSessions] = useState<SessionEntry[] | null>(null);
  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [failed, setFailed] = useState(false);
  const [working, setWorking] = useState<string | null>(null);

  const load = () => {
    setFailed(false);
    endpoints
      .sessions()
      .then((response) => {
        setSessions(response.sessions);
        setTokens(response.tokens);
      })
      .catch(() => setFailed(true));
  };

  useEffect(load, []);

  async function revokeSession(session: SessionEntry) {
    if (session.isCurrent) {
      const confirmed = window.confirm(
        'This is the browser you are using. Signing it out will sign you out here. Go ahead?',
      );
      if (!confirmed) return;
    }

    setWorking(session.id);
    try {
      await endpoints.revokeSession(session.id);
      if (session.isCurrent) {
        await signOut();
        return;
      }
      load();
    } finally {
      setWorking(null);
    }
  }

  async function revokeToken(token: TokenEntry) {
    setWorking(token.id);
    try {
      await endpoints.revokeToken(token.id);
      load();
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="text-[21px]">Where you are signed in</h1>
        <p className="mt-1.5 max-w-prose text-[14px] text-ink-soft">
          Every browser and command line with access to this account. Signing one out takes effect
          straight away.
        </p>
      </header>

      {failed && <ErrorNote onRetry={load}>Could not load your sessions.</ErrorNote>}

      <section>
        <Heading>Browsers</Heading>
        {sessions === null && !failed && <Waiting />}
        {sessions?.map((session) => (
          <Row
            key={session.id}
            title={session.label ?? 'Unknown device'}
            badge={session.isCurrent ? 'This browser' : null}
            detail={<RelativeTime iso={session.lastSeenAt} prefix="last used" />}
            busy={working === session.id}
            onRevoke={() => void revokeSession(session)}
            revokeLabel="Sign out"
          />
        ))}
      </section>

      <section>
        <Heading>Command lines</Heading>
        {tokens.length === 0 ? (
          <EmptyState title="No command line is connected">
            Run <Code>open-artifact login</Code> in a terminal to connect one.
          </EmptyState>
        ) : (
          tokens.map((token) => (
            <Row
              key={token.id}
              title={token.label ?? 'Command line'}
              badge={null}
              detail={
                token.lastUsedAt ? (
                  <RelativeTime iso={token.lastUsedAt} prefix="last used" />
                ) : (
                  'never used'
                )
              }
              busy={working === token.id}
              onRevoke={() => void revokeToken(token)}
              revokeLabel="Revoke"
            />
          ))
        )}
      </section>
    </div>
  );
}

function Heading({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="mb-1 border-b border-edge pb-3 text-[13px] font-semibold uppercase tracking-[0.06em] text-ink-faint">
      {children}
    </h2>
  );
}

function Row({
  title,
  badge,
  detail,
  busy,
  onRevoke,
  revokeLabel,
}: {
  title: string;
  badge: string | null;
  detail: React.ReactNode;
  busy: boolean;
  onRevoke: () => void;
  revokeLabel: string;
}) {
  return (
    <div className="oa-rise flex items-center justify-between gap-4 border-b border-edge-soft py-3.5">
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate text-[14.5px] font-medium text-ink">
          {title}
          {badge && (
            <span className="rounded-full bg-accent-wash px-2 py-0.5 text-[11px] font-medium text-accent">
              {badge}
            </span>
          )}
        </p>
        <p className="mt-0.5 text-[13px] text-ink-faint">{detail}</p>
      </div>
      <Button tone="danger" busy={busy} onClick={onRevoke}>
        {revokeLabel}
      </Button>
    </div>
  );
}

function Waiting() {
  return (
    <p className="oa-breathe py-6 text-[14px] text-ink-faint">Loading</p>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded bg-edge-soft px-1.5 py-0.5 font-mono text-[12.5px] text-ink">
      {children}
    </code>
  );
}
