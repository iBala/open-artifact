/**
 * The frame around every signed-in screen.
 *
 * One bar, and it holds only what is true everywhere: where you are, who you are,
 * and the way out. Anything belonging to a particular screen lives on that screen.
 */

import { useState, useRef, useEffect } from 'react';
import { useAccount } from '../App.jsx';
import { Link, useRouter } from '../router.jsx';

export function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh">
      <TopBar />
      <main className="mx-auto w-full max-w-[880px] px-5 pb-24 pt-8 sm:px-6">{children}</main>
    </div>
  );
}

function TopBar() {
  return (
    <header className="sticky top-0 z-10 border-b border-edge bg-paper/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 w-full max-w-[880px] items-center justify-between gap-4 px-5 sm:px-6">
        <Link
          to="/"
          className="text-[15px] font-semibold tracking-[-0.02em] text-ink transition-opacity hover:opacity-70"
        >
          Open Artifact
        </Link>
        <AccountMenu />
      </div>
    </header>
  );
}

function AccountMenu() {
  const { user, signOut } = useAccount();
  const { navigate } = useRouter();
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    // Clicking anywhere else, or pressing Escape, closes it. Both, because
    // people reach for whichever is nearer.
    const onPointerDown = (event: MouseEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div ref={container} className="relative">
      <button
        type="button"
        onClick={() => setOpen((wasOpen) => !wasOpen)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 rounded-[--radius] px-2 py-1.5 text-[13px] text-ink-soft transition-colors hover:bg-edge-soft hover:text-ink"
      >
        <Avatar email={user.email} />
        <span className="hidden sm:inline">{user.displayName ?? user.email}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="oa-rise absolute right-0 top-[calc(100%+6px)] w-60 overflow-hidden rounded-[--radius-lg] border border-edge bg-paper-raised shadow-[--shadow-lift]"
        >
          <div className="border-b border-edge-soft px-3.5 py-3">
            <p className="truncate text-[13px] font-medium text-ink">{user.email}</p>
          </div>
          <MenuItem
            onClick={() => {
              setOpen(false);
              navigate('/settings/sessions');
            }}
          >
            Where you are signed in
          </MenuItem>
          <MenuItem
            onClick={() => {
              setOpen(false);
              void signOut();
            }}
          >
            Sign out
          </MenuItem>
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="block w-full px-3.5 py-2.5 text-left text-[13.5px] text-ink transition-colors hover:bg-edge-soft"
    >
      {children}
    </button>
  );
}

/**
 * Initials on a colour derived from the address, so the same person is the same
 * colour on every machine without anybody uploading a picture.
 */
function Avatar({ email }: { email: string }) {
  let hash = 0;
  for (const character of email) hash = (hash * 31 + character.charCodeAt(0)) % 360;

  return (
    <span
      aria-hidden="true"
      className="grid size-6 place-items-center rounded-full text-[10px] font-semibold text-white"
      style={{ background: `oklch(58% 0.11 ${hash})` }}
    >
      {email.slice(0, 2).toUpperCase()}
    </span>
  );
}
