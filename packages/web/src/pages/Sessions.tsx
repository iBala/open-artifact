/**
 * Where this account is signed in, and taking that away.
 *
 * The screen somebody opens when a laptop has gone missing, so it is built for
 * that moment: everything visible at once, the browser they are using clearly
 * marked, and revoking takes one press with nothing in the way.
 *
 * The single exception is signing out the browser you are currently using, which
 * asks first. Not because it is dangerous, but because it is surprising, and a
 * confirmation is the cheapest way to say "this will log you out here too".
 */

import { useEffect, useState } from 'react';
import {
  endpoints,
  type SessionEntry,
  type TokenEntry,
  type McpConnectionEntry,
  type MintedMcpToken,
} from '../api.js';
import { useAccount } from '../App.jsx';
import {
  Button,
  Badge,
  ErrorNote,
  RelativeTime,
  EmptyState,
  Dialog,
  TextInput,
} from '../components/primitives.js';

export function Sessions() {
  const { signOut } = useAccount();
  const [sessions, setSessions] = useState<SessionEntry[]>([]);
  const [tokens, setTokens] = useState<TokenEntry[]>([]);
  const [connections, setConnections] = useState<McpConnectionEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [working, setWorking] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<SessionEntry | null>(null);

  const load = () => {
    setFailed(false);
    endpoints
      .sessions()
      .then((response) => {
        setSessions(response.sessions);
        setTokens(response.tokens);
        setConnections(response.mcpConnections ?? []);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  };

  useEffect(load, []);

  async function revokeSession(session: SessionEntry) {
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
      setConfirming(null);
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

  async function disconnect(connection: McpConnectionEntry) {
    setWorking(connection.id);
    try {
      await endpoints.revokeMcpConnection(connection.id);
      load();
    } finally {
      setWorking(null);
    }
  }

  return (
    <div className="mx-auto w-full max-w-[760px] px-6 py-9">
      <h1 className="text-[17px]">Where you are signed in</h1>
      <p className="mt-1.5 max-w-[60ch] text-[12.5px] leading-relaxed text-ink-3">
        Every browser and command line with access to this account. Signing one out takes effect
        on its very next request.
      </p>

      {failed && (
        <div className="mt-5">
          <ErrorNote onRetry={load}>Could not load your sessions.</ErrorNote>
        </div>
      )}

      <Group title="Browsers">
        {loading && <LoadingRows />}
        {sessions.map((session) => (
          <Row
            key={session.id}
            title={session.label ?? 'Unknown device'}
            badge={session.isCurrent ? 'This browser' : null}
            detail={<RelativeTime iso={session.lastSeenAt} prefix="last used" />}
            busy={working === session.id}
            actionLabel="Sign out"
            onAction={() =>
              session.isCurrent ? setConfirming(session) : void revokeSession(session)
            }
          />
        ))}
      </Group>

      <Group title="Command lines">
        {tokens.length === 0 && !loading ? (
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
              actionLabel="Revoke"
              onAction={() => void revokeToken(token)}
            />
          ))
        )}
      </Group>

      <Group title="Hosted assistants">
        {connections.length === 0 && !loading ? (
          <EmptyState title="No hosted assistant is connected">
            An assistant with no terminal — Claude on the web, ChatGPT — connects here over MCP
            instead of installing anything.
          </EmptyState>
        ) : (
          connections.map((connection) => (
            <Row
              key={connection.id}
              title={connection.label}
              badge={null}
              detail={<RelativeTime iso={connection.createdAt} prefix="connected" />}
              busy={working === connection.id}
              actionLabel="Disconnect"
              onAction={() => void disconnect(connection)}
            />
          ))
        )}
        <ConnectAssistant onConnected={load} />
      </Group>

      <CloseAccount />

      <Dialog
        open={confirming !== null}
        onClose={() => setConfirming(null)}
        title="Sign out this browser?"
        description="This is the browser you are using. You will be signed out here straight away."
        footer={
          <>
            <Button size="sm" onClick={() => setConfirming(null)}>
              Cancel
            </Button>
            <Button
              size="sm"
              tone="danger"
              busy={working === confirming?.id}
              onClick={() => confirming && void revokeSession(confirming)}
            >
              Sign out
            </Button>
          </>
        }
      />
    </div>
  );
}

/**
 * Connecting a hosted assistant by hand: name it, get a token, shown once.
 *
 * This is the path for tools that can send a header. Claude on the web and
 * ChatGPT cannot; they connect through the OAuth consent flow instead and
 * appear in the list above on their own, so this dialog stays out of their way
 * and names them only in passing.
 */
function ConnectAssistant({ onConnected }: { onConnected: () => void }) {
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [minted, setMinted] = useState<MintedMcpToken | null>(null);
  const [copied, setCopied] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  const endpoint = `${window.location.origin}/mcp`;

  function reset() {
    setOpen(false);
    setLabel('');
    setMinted(null);
    setCopied(false);
    setProblem(null);
    // Refreshing on close rather than on mint keeps the token dialog stable
    // while the person copies from it.
    if (minted) onConnected();
  }

  async function mint() {
    setBusy(true);
    setProblem(null);
    try {
      setMinted(await endpoints.mintMcpToken(label.trim()));
    } catch {
      setProblem('That did not work. Try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2.5">
      <Button size="sm" onClick={() => setOpen(true)}>
        Connect an assistant
      </Button>

      <Dialog
        open={open}
        onClose={reset}
        title={minted ? 'Copy the token now' : 'Connect an assistant'}
        description={
          minted
            ? 'This is the only time it is shown. Whoever holds it can publish as you, so treat it like a password.'
            : 'For assistants that can send a request header. Claude on the web and ChatGPT connect themselves when you add this instance as a connector — no token needed.'
        }
        footer={
          minted ? (
            <Button size="sm" tone="primary" onClick={reset}>
              Done
            </Button>
          ) : (
            <>
              <Button size="sm" onClick={reset} disabled={busy}>
                Cancel
              </Button>
              <Button
                size="sm"
                tone="primary"
                busy={busy}
                disabled={label.trim().length === 0}
                onClick={() => void mint()}
              >
                Create token
              </Button>
            </>
          )
        }
      >
        {minted ? (
          <div className="flex flex-col gap-2.5">
            <Secret
              value={minted.token}
              copied={copied}
              onCopy={() => {
                navigator.clipboard?.writeText(minted.token).then(
                  () => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1400);
                  },
                  () => undefined,
                );
              }}
            />
            <p className="text-[11.5px] leading-relaxed text-ink-3">
              Point the assistant at <Code>{endpoint}</Code> and have it send the token as{' '}
              <Code>Authorization: Bearer …</Code> on every request. It lasts ninety days, then
              you connect again.
            </p>
          </div>
        ) : (
          <TextInput
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="What is this assistant called? e.g. Cowork"
            aria-label="A name for this assistant"
          />
        )}
      </Dialog>
    </div>
  );
}

/** The one-time token, in a box built for copying rather than reading. */
function Secret({
  value,
  copied,
  onCopy,
}: {
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={onCopy}
        className="absolute right-2 top-2 z-10 rounded-[--radius] border border-line bg-surface px-2 py-1 text-[11px] text-ink-3 shadow-[--shadow-pop] transition-colors hover:text-ink"
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      <pre className="oa-scroll overflow-x-auto rounded-[--radius] border border-line bg-sunken p-2.5 pr-16 font-mono text-[11.5px] break-all whitespace-pre-wrap text-ink-2">
        {value}
      </pre>
    </div>
  );
}

/**
 * Closing the account.
 *
 * At the bottom, behind a confirmation that asks the person to type their own
 * address. That is more friction than a checkbox on purpose: this is the one
 * action in the product with nothing behind it, and somebody should not be able
 * to do it by clicking twice in the wrong place.
 *
 * The wording says exactly what survives, because "your data will be deleted" is
 * not true here and somebody deciding deserves the real answer.
 */
function CloseAccount() {
  const { user } = useAccount();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);

  const confirmed = typed.trim().toLowerCase() === user.email.toLowerCase();

  async function close() {
    setBusy(true);
    try {
      await endpoints.deleteAccount();
      window.location.assign('/');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mt-12 border-t border-line pt-6">
      <h2 className="text-[13px] font-semibold text-ink">Close this account</h2>
      <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-relaxed text-ink-3">
        Everything you published is deleted, along with the comments on it. Comments you left on
        other people’s artifacts stay where they are, with your name removed, so the conversations
        they are part of still make sense. This cannot be undone.
      </p>

      <Button tone="danger" size="sm" className="mt-3" onClick={() => setOpen(true)}>
        Close account
      </Button>

      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Close this account?"
        description="Everything you published goes, permanently. Type your email address to confirm."
        footer={
          <>
            <Button size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              size="sm"
              tone="danger"
              busy={busy}
              disabled={!confirmed}
              onClick={() => void close()}
            >
              Close it
            </Button>
          </>
        }
      >
        <TextInput
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          placeholder={user.email}
          aria-label="Type your email address to confirm"
        />
      </Dialog>
    </section>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-7">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
        {title}
      </h2>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function Row({
  title,
  badge,
  detail,
  busy,
  actionLabel,
  onAction,
}: {
  title: string;
  badge: string | null;
  detail: React.ReactNode;
  busy: boolean;
  actionLabel: string;
  onAction: () => void;
}) {
  return (
    <div className="oa-rise flex items-center justify-between gap-4 border-b border-line-2 py-2.5 last:border-0">
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate text-[13px] font-medium text-ink">
          {title}
          {badge && <Badge tone="accent">{badge}</Badge>}
        </p>
        <p className="mt-0.5 text-[11.5px] text-ink-3">{detail}</p>
      </div>
      <Button size="sm" tone="danger" busy={busy} onClick={onAction}>
        {actionLabel}
      </Button>
    </div>
  );
}

function LoadingRows() {
  return (
    <>
      {[0, 1].map((row) => (
        <div key={row} aria-hidden="true" className="border-b border-line-2 py-3">
          <span className="oa-breathe block h-[13px] w-40 rounded bg-line" />
        </div>
      ))}
    </>
  );
}

function Code({ children }: { children: React.ReactNode }) {
  return (
    <code className="rounded-[--radius-xs] border border-line-2 bg-sunken px-1 py-0.5 font-mono text-[11.5px] text-ink-2">
      {children}
    </code>
  );
}
