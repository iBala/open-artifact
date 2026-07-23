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

import { useEffect, useRef, useState } from 'react';
import { Link, useRouter } from '../router.jsx';
import { useAccount } from '../App.jsx';
import { type ArtifactSummary, type SharedArtifact } from '../api.js';
import { Spinner } from './primitives.js';
import { NotificationsButton, NotificationsPanel } from './Notifications.js';
import { endpoints } from '../api.js';
import { useStars } from '../stars.js';

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
  const { user } = useAccount();
  const stars = useStars();
  // Only somebody who has not connected an assistant yet gets the nudge.
  const notConnected = user.connectedApps.length === 0;

  // The starred section draws from both lists: you can star what you own and
  // what was shared with you. Shown only when something is starred, so somebody
  // who never stars is not given an empty header to wonder about. A shared
  // artifact keeps its owner subtitle here too, so it reads the same as below.
  const starred = [
    ...data.mine.map((artifact) => ({ artifact, subtitle: undefined as string | undefined })),
    ...data.shared.map((artifact) => ({
      artifact,
      subtitle: artifact.ownerName ?? artifact.ownerEmail ?? undefined,
    })),
  ].filter((entry) => stars.isStarred(entry.artifact.id));

  if (collapsed) {
    return (
      <aside className="sticky top-0 z-10 flex h-dvh w-11 shrink-0 flex-col items-center gap-1 border-r border-line bg-canvas py-2.5">
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
    // z-10: the notifications panel pops out of this sidebar over the content
    // area. Without an explicit order on the aside, a content row that happens
    // to sit under the panel can win the paint order and swallow its clicks —
    // found when a taller setup guide pushed a row under "Mark all read".
    <aside className="oa-fade sticky top-0 z-10 flex h-dvh w-[228px] shrink-0 flex-col border-r border-line bg-canvas">
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
        {/* An obvious way in for somebody who has not connected an assistant yet
            — usually a person a document was shared with. Styled to catch the eye
            the way a "new feature" highlight does, and it goes to the setup guide.
            Gone the moment they connect one. */}
        {notConnected && <PublishHighlight />}

        {starred.length > 0 && (
          <Section title="Starred" count={starred.length} loading={false}>
            {starred.map(({ artifact, subtitle }) => (
              <ArtifactLink
                key={artifact.id}
                to={`/a/${artifact.slug}`}
                title={artifact.title}
                subtitle={subtitle}
                active={path === `/a/${artifact.slug}`}
                type={artifact.type}
                starred
                onToggleStar={() => stars.toggle(artifact.id)}
              />
            ))}
          </Section>
        )}

        <Section title="Yours" count={data.mine.length} loading={data.loading}>
          {data.mine.map((artifact) => (
            <ArtifactLink
              key={artifact.id}
              to={`/a/${artifact.slug}`}
              title={artifact.title}
              active={path === `/a/${artifact.slug}`}
              type={artifact.type}
              starred={stars.isStarred(artifact.id)}
              onToggleStar={() => stars.toggle(artifact.id)}
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
              starred={stars.isStarred(artifact.id)}
              onToggleStar={() => stars.toggle(artifact.id)}
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
  starred = false,
  onToggleStar,
}: {
  to: string;
  title: string;
  subtitle?: string;
  active: boolean;
  type: 'markdown' | 'html';
  starred?: boolean;
  /** Left out for a row that has no star control, like a loading placeholder. */
  onToggleStar?: () => void;
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
      {onToggleStar && <StarToggle starred={starred} onToggle={onToggleStar} />}
    </Link>
  );
}

/**
 * The star on a sidebar row. It lives inside the row's link, so a click on it
 * must not also follow the link — hence stopping the event before the anchor
 * sees it. A set star is always shown; an unset one appears on hover, so a row
 * stays quiet until you reach for it.
 */
function StarToggle({ starred, onToggle }: { starred: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={starred ? 'Remove star' : 'Star this'}
      aria-pressed={starred}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      className={[
        'grid size-5 shrink-0 place-items-center rounded-[--radius-xs] transition',
        starred
          ? 'opacity-100'
          : 'text-ink-3 opacity-0 hover:text-ink focus-visible:opacity-100 group-hover:opacity-100',
      ].join(' ')}
      style={starred ? { color: 'oklch(74% 0.15 78)' } : undefined}
    >
      <StarIcon filled={starred} />
    </button>
  );
}

function StarIcon({ filled }: { filled: boolean }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill={filled ? 'currentColor' : 'none'}
      aria-hidden="true"
    >
      <path
        d="M8 1.8l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 10.79l-3.52 1.85.67-3.92L2.3 5.94l3.94-.57L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function Nothing({ children }: { children: React.ReactNode }) {
  return <p className="px-1.5 py-1 text-[12px] text-ink-3">{children}</p>;
}

/** The catch-the-eye "get started" card at the top of the sidebar. */
function PublishHighlight() {
  return (
    <Link
      to="/"
      className="oa-rise mx-0.5 mb-2 mt-1 flex items-start gap-2 rounded-[--radius] bg-accent-wash px-2.5 py-2 text-accent transition-opacity hover:opacity-85"
    >
      <SparkIcon />
      <span className="min-w-0 flex-1">
        <span className="block text-[12px] font-semibold text-ink">Publish your own</span>
        <span className="block text-[11px] leading-snug text-ink-2">
          Set up your assistant in a minute →
        </span>
      </span>
    </Link>
  );
}

function SparkIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true" className="mt-[3px] shrink-0">
      <path
        d="M8 1.3l1.5 4 4 1.5-4 1.5L8 12.3 6.5 8.3l-4-1.5 4-1.5z"
        fill="currentColor"
      />
    </svg>
  );
}

function AccountRow() {
  const { user, signOut } = useAccount();
  const { navigate, path } = useRouter();
  const [bellOpen, setBellOpen] = useState(false);
  const [unread, setUnread] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

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

  // The settings menu closes when you click away from it or press Escape, the
  // way a menu is expected to. Bound only while it is open.
  useEffect(() => {
    if (!menuOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

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

      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={() => navigate('/settings/sessions')}
          className={[
            'flex min-w-0 flex-1 items-center gap-2 rounded-[--radius-sm] px-1.5 py-1.5 text-left transition-colors',
            path.startsWith('/settings') ? 'bg-sunken' : 'hover:bg-sunken',
          ].join(' ')}
        >
          <Avatar email={user.email} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">
            {user.displayName ?? user.email}
          </span>
        </button>

        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Account menu"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            className={[
              'grid size-7 place-items-center rounded-[--radius-sm] transition-colors',
              menuOpen ? 'bg-sunken text-ink' : 'text-ink-3 hover:bg-sunken hover:text-ink',
            ].join(' ')}
          >
            <GearIcon />
          </button>

          {menuOpen && (
            <div
              role="menu"
              className="oa-pop absolute bottom-[calc(100%+6px)] right-0 z-20 w-44 overflow-hidden rounded-[--radius] border border-line bg-surface py-1 shadow-[--shadow-pop]"
            >
              <a
                role="menuitem"
                href="mailto:hello@open-artifact.com?subject=Open%20Artifact"
                onClick={() => setMenuOpen(false)}
                className="flex items-center gap-2 px-2.5 py-1.5 text-[12.5px] text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
              >
                <MailIcon />
                Support
              </a>
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  void signOut();
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-[12.5px] text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
              >
                <SignOutIcon />
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="2.1" stroke="currentColor" strokeWidth="1.3" />
      <path
        d="M8 1.5v1.4M8 13.1v1.4M14.5 8h-1.4M2.9 8H1.5M12.6 3.4l-1 1M4.4 11.6l-1 1M12.6 12.6l-1-1M4.4 4.4l-1-1"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MailIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="1.75" y="3.25" width="12.5" height="9.5" rx="1.75" stroke="currentColor" strokeWidth="1.25" />
      <path d="M2.4 4.6L8 8.6l5.6-4" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
    </svg>
  );
}

function SignOutIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.25 2.75H3.75A1.25 1.25 0 0 0 2.5 4v8a1.25 1.25 0 0 0 1.25 1.25h2.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <path d="M9.5 5.5L12.5 8l-3 2.5M12.25 8H6" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
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
