/**
 * The bell.
 *
 * Sits in the sidebar rather than floating over the page, because it is a place
 * you go rather than something that interrupts you. The unread count is the only
 * thing that ever competes for attention, and it is a small dot with a number.
 *
 * Access requests sit at the top of the same panel rather than somewhere
 * separate. They are the only notification that needs an answer, and burying
 * them under a settings page means somebody waits days to be let into a document.
 */

import { useEffect, useState } from 'react';
import { endpoints, type NotificationView, type AccessRequest } from '../api.js';
import { Button, RelativeTime, Spinner, EmptyState } from './primitives.js';
import { Avatar } from './Sidebar.js';

export function NotificationsPanel({
  onOpenArtifact,
  onClose,
  onCountChanged,
}: {
  onOpenArtifact: (slug: string, threadId: string | null) => void;
  onClose: () => void;
  /** So the bell's count keeps up without waiting for the next poll. */
  onCountChanged: (unread: number) => void;
}) {
  const [items, setItems] = useState<NotificationView[] | null>(null);
  const [requests, setRequests] = useState<AccessRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    endpoints
      .notifications()
      .then((response) => {
        setItems(response.notifications);
        onCountChanged(response.unread);
      })
      .catch(() => setItems([]));
    endpoints
      .accessRequests()
      .then((response) => setRequests(response.requests))
      .catch(() => setRequests([]));
  }

  useEffect(load, []);

  async function decide(request: AccessRequest, grant: boolean) {
    setBusy(request.id);
    try {
      await endpoints.decideAccessRequest(request.id, grant);
      load();
    } finally {
      setBusy(null);
    }
  }

  const unread = items?.filter((item) => !item.read).length ?? 0;

  return (
    <div className="oa-pop absolute bottom-2 left-[calc(100%+8px)] z-30 flex max-h-[70vh] w-[320px] flex-col overflow-hidden rounded-[--radius-lg] border border-line bg-surface shadow-[--shadow-pop]">
      <header className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-line px-3">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          Notifications
        </h2>
        {unread > 0 && (
          <button
            type="button"
            onClick={() => void endpoints.markAllNotificationsRead().then(load)}
            className="text-[11.5px] text-ink-3 transition-colors hover:text-ink"
          >
            Mark all read
          </button>
        )}
      </header>

      <div className="oa-scroll min-h-0 flex-1 overflow-y-auto">
        {requests.length > 0 && (
          <section className="border-b border-line bg-sunken px-3 py-2.5">
            <h3 className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.05em] text-ink-3">
              Waiting on you
            </h3>

            {requests.map((request) => (
              <div key={request.id} className="py-1.5">
                <p className="text-[12.5px] leading-relaxed text-ink">
                  Add <span className="font-medium">{request.email}</span> to{' '}
                  <span className="font-medium">{request.artifactTitle}</span>?
                </p>
                <div className="mt-1.5 flex gap-1.5">
                  <Button
                    size="sm"
                    tone="primary"
                    busy={busy === request.id}
                    onClick={() => void decide(request, true)}
                  >
                    Add them
                  </Button>
                  <Button size="sm" onClick={() => void decide(request, false)}>
                    No
                  </Button>
                </div>
              </div>
            ))}
          </section>
        )}

        {items === null && (
          <div className="grid h-24 place-items-center">
            <Spinner className="text-ink-3" />
          </div>
        )}

        {items?.length === 0 && requests.length === 0 && (
          <EmptyState title="Nothing yet">
            You will hear about anything shared with you, and anywhere you are mentioned.
          </EmptyState>
        )}

        {items?.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => {
              void endpoints.markNotificationRead(item.id).then(load);
              if (item.artifact) {
                onOpenArtifact(item.artifact.slug, item.threadId);
                onClose();
              }
            }}
            className="flex w-full gap-2 border-b border-line-2 px-3 py-2.5 text-left transition-colors last:border-0 hover:bg-sunken"
          >
            {/* Unread is a dot rather than a colour wash, so a long list of them
                does not turn the panel into a block of tint. */}
            <span
              aria-hidden="true"
              className={`mt-1.5 size-1.5 shrink-0 rounded-full ${
                item.read ? 'bg-transparent' : 'bg-accent'
              }`}
            />

            {item.actor ? (
              <Avatar email={item.actor.email} size={18} />
            ) : (
              <span aria-hidden="true" className="size-[18px] shrink-0 rounded-full bg-line" />
            )}

            <span className="min-w-0 flex-1">
              <span className="block text-[12.5px] leading-snug text-ink">{item.summary}</span>
              <span className="mt-0.5 block text-[11px] text-ink-3">
                <RelativeTime iso={item.createdAt} />
              </span>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/** The bell itself, with its count. */
export function NotificationsButton({
  unread,
  open,
  onToggle,
}: {
  unread: number;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={unread > 0 ? `Notifications, ${unread} unread` : 'Notifications'}
      className={[
        'flex w-full items-center gap-2 rounded-[--radius-sm] px-1.5 py-1.5 text-left text-[12.5px] transition-colors',
        open ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken hover:text-ink',
      ].join(' ')}
    >
      <BellIcon />
      <span className="flex-1">Notifications</span>
      {unread > 0 && (
        <span className="grid h-[16px] min-w-[16px] shrink-0 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold tabular-nums text-white">
          {unread > 99 ? '99+' : unread}
        </span>
      )}
    </button>
  );
}

function BellIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M8 2a4 4 0 0 0-4 4c0 2.5-.7 3.6-1.2 4.2-.3.3-.1.8.3.8h9.8c.4 0 .6-.5.3-.8C12.7 9.6 12 8.5 12 6a4 4 0 0 0-4-4ZM6.5 12.5a1.6 1.6 0 0 0 3 0"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
