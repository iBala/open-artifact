/**
 * The sidebar, and the frame around every signed-in screen.
 *
 * It holds what you published and what other people shared with you, so moving
 * between documents never needs a trip back to a dashboard.
 *
 * It collapses to a thin rail when an artifact is open, because somebody who
 * followed a link came to read one document, not to browse. The rail is still a
 * target: one click brings the sidebar back. That choice is remembered per
 * person, so somebody who prefers it open keeps it open.
 */

import { useEffect, useState } from 'react';
import { Link, useRouter } from '../router.jsx';
import { useAccount } from '../App.jsx';
import { type ArtifactSummary, type SharedArtifact } from '../api.js';
import { Spinner } from './primitives.js';
import { NotificationsButton, NotificationsPanel } from './Notifications.js';
import { endpoints } from '../api.js';

const COLLAPSE_PREFERENCE = 'oa.sidebar.collapsed';

export interface SidebarData {
  mine: ArtifactSummary[];
  shared: SharedArtifact[];
  loading: boolean;
}

export function AppFrame({
  data,
  children,
  /** True on an artifact page, where the sidebar starts collapsed. */
  focusMode = false,
}: {
  data: SidebarData;
  children: React.ReactNode;
  focusMode?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => initialCollapsed(focusMode));

  // Following a link into an artifact collapses the sidebar; going back to the
  // dashboard opens it again. Somebody who has set a preference keeps it.
  useEffect(() => {
    if (readPreference() !== null) return;
    setCollapsed(focusMode);
  }, [focusMode]);

  function toggle() {
    setCollapsed((wasCollapsed) => {
      const next = !wasCollapsed;
      try {
        localStorage.setItem(COLLAPSE_PREFERENCE, String(next));
      } catch {
        // Private browsing refuses this. Not remembering is a small loss.
      }
      return next;
    });
  }

  return (
    <div className="flex min-h-dvh">
      <Sidebar data={data} collapsed={collapsed} onToggle={toggle} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function initialCollapsed(focusMode: boolean): boolean {
  return readPreference() ?? focusMode;
}

function readPreference(): boolean | null {
  try {
    const stored = localStorage.getItem(COLLAPSE_PREFERENCE);
    return stored === null ? null : stored === 'true';
  } catch {
    return null;
  }
}

function Sidebar({
  data,
  collapsed,
  onToggle,
}: {
  data: SidebarData;
  collapsed: boolean;
  onToggle: () => void;
}) {
  const { path } = useRouter();

  if (collapsed) {
    return (
      <aside className="sticky top-0 flex h-dvh w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-canvas py-2.5">
        <button
          type="button"
          onClick={onToggle}
          aria-label="Show sidebar"
          aria-expanded={false}
          className="grid size-7 place-items-center rounded-[--radius-sm] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
        >
          <PanelIcon />
        </button>
      </aside>
    );
  }

  return (
    <aside className="oa-fade sticky top-0 flex h-dvh w-[228px] shrink-0 flex-col border-r border-line bg-canvas">
      <div className="flex h-11 shrink-0 items-center justify-between gap-1 px-2.5">
        <Link
          to="/"
          className="rounded-[--radius-sm] px-1.5 py-1 text-[13px] font-semibold tracking-[-0.02em] text-ink transition-colors hover:bg-sunken"
        >
          Open Artifact
        </Link>
        <button
          type="button"
          onClick={onToggle}
          aria-label="Hide sidebar"
          aria-expanded
          className="grid size-7 place-items-center rounded-[--radius-sm] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
        >
          <PanelIcon />
        </button>
      </div>

      <nav className="oa-scroll flex-1 overflow-y-auto px-2 pb-3">
        <Section title="Yours" count={data.mine.length} loading={data.loading}>
          {data.mine.map((artifact) => (
            <ArtifactLink
              key={artifact.id}
              to={`/a/${artifact.slug}`}
              title={artifact.title}
              active={path === `/a/${artifact.slug}`}
              type={artifact.type}
            />
          ))}
          {!data.loading && data.mine.length === 0 && <Nothing>Nothing published yet</Nothing>}
        </Section>

        <Section title="Shared with you" count={data.shared.length} loading={data.loading}>
          {data.shared.map((artifact) => (
            <ArtifactLink
              key={artifact.id}
              to={`/a/${artifact.slug}`}
              title={artifact.title}
              subtitle={artifact.ownerName ?? artifact.ownerEmail ?? undefined}
              active={path === `/a/${artifact.slug}`}
              type={artifact.type}
            />
          ))}
          {!data.loading && data.shared.length === 0 && <Nothing>Nothing yet</Nothing>}
        </Section>
      </nav>

      <AccountRow />
    </aside>
  );
}

function Section({
  title,
  count,
  loading,
  children,
}: {
  title: string;
  count: number;
  loading: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-3 first:mt-1">
      <div className="flex items-center gap-1.5 px-1.5 py-1">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          {title}
        </h2>
        {loading ? (
          <Spinner className="text-ink-3" />
        ) : (
          count > 0 && <span className="text-[11px] tabular-nums text-ink-3">{count}</span>
        )}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function ArtifactLink({
  to,
  title,
  subtitle,
  active,
  type,
}: {
  to: string;
  title: string;
  subtitle?: string;
  active: boolean;
  type: 'markdown' | 'html';
}) {
  return (
    <Link
      to={to}
      className={[
        'group flex items-center gap-2 rounded-[--radius-sm] px-1.5 py-[5px] transition-colors',
        active ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
      ].join(' ')}
    >
      <TypeIcon type={type} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[12.5px] leading-[1.35]">{title}</span>
        {subtitle && <span className="block truncate text-[11px] text-ink-3">{subtitle}</span>}
      </span>
    </Link>
  );
}

function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-[12px] text-ink-3">{children}</p>;
}

function AccountRow() {
  const { user, signOut } = useAccount();
  const { navigate, path } = useRouter();
  const [bellOpen, setBellOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  // Polled rather than pushed. A live connection for a count that changes a few
  // times a day is a lot of moving parts to keep working; a request every half
  // minute is not.
  useEffect(() => {
    let alive = true;

    const check = () => {
      endpoints
        .notifications()
        .then((response) => alive && setUnread(response.unread))
        .catch(() => undefined);
    };

    check();
    const timer = setInterval(check, 30_000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [bellOpen]);

  return (
    <div className="relative shrink-0 border-t border-line p-2">
      <NotificationsButton
        unread={unread}
        open={bellOpen}
        onToggle={() => setBellOpen((wasOpen) => !wasOpen)}
      />

      {bellOpen && (
        <NotificationsPanel
          onCountChanged={setUnread}
          onClose={() => setBellOpen(false)}
          onOpenArtifact={(slug, threadId) => {
            navigate(threadId ? `/a/${slug}?thread=${threadId}` : `/a/${slug}`);
          }}
        />
      )}

      <button
        type="button"
        onClick={() => navigate('/settings/sessions')}
        className={[
          'flex w-full items-center gap-2 rounded-[--radius-sm] px-1.5 py-1.5 text-left transition-colors',
          path.startsWith('/settings') ? 'bg-sunken' : 'hover:bg-sunken',
        ].join(' ')}
      >
        <Avatar email={user.email} />
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
          {user.displayName ?? user.email}
        </span>
      </button>

      <button
        type="button"
        onClick={() => void signOut()}
        className="mt-0.5 w-full rounded-[--radius-sm] px-1.5 py-1.5 text-left text-[12px] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
      >
        Sign out
      </button>
    </div>
  );
}

/**
 * Initials on a colour derived from the address, so the same person is the same
 * colour on every machine without anybody uploading a picture.
 */
export function Avatar({ email, size = 20 }: { email: string; size?: number }) {
  let hash = 0;
  for (const character of email) hash = (hash * 31 + character.charCodeAt(0)) % 360;

  return (
    <span
      aria-hidden="true"
      className="grid shrink-0 place-items-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `oklch(58% 0.12 ${hash})`,
      }}
    >
      {email.slice(0, 1).toUpperCase()}
    </span>
  );
}

function TypeIcon({ type }: { type: 'markdown' | 'html' }) {
  return (
    <span
      aria-hidden="true"
      className="grid size-4 shrink-0 place-items-center rounded-[3px] border border-line text-[7px] font-bold uppercase tracking-tight text-ink-3"
    >
      {type === 'markdown' ? 'M' : 'H'}
    </span>
  );
}

function PanelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" stroke="currentColor" strokeWidth="1.3" />
      <path d="M6.25 2.75v10.5" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}
