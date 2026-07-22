/**
 * Managing who can see an artifact.
 *
 * Everything in one panel, because "who can see this" is a single question and
 * answering it across three screens would be worse. Adding somebody is one field
 * that takes either an address or a domain, since the difference is an @ and the
 * server can tell.
 *
 * Two things get spelled out rather than assumed. Somebody who has not signed in
 * yet is marked as waiting, so their absence does not look like a failure. And
 * the public toggle says what public actually means, because "anybody with the
 * link" is a much bigger step than the size of a toggle suggests.
 */

import { useEffect, useState } from 'react';
import { endpoints, ApiError, type SharedArtifact, type SharingState } from '../api.js';
import { Button, TextInput, Badge, Spinner, ErrorNote, Divider, Dialog } from './primitives.js';

export function ShareDialog({
  artifact,
  open,
  onClose,
  onChanged,
}: {
  artifact: SharedArtifact;
  open: boolean;
  onClose: () => void;
  /** So the page's own "Public" badge keeps up with the toggle. */
  onChanged: (isPublic: boolean) => void;
}) {
  const [state, setState] = useState<SharingState | null>(null);
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setProblem(null);
    endpoints.sharing(artifact.id).then(setState).catch(() => setProblem('Could not load sharing.'));
  }, [open, artifact.id]);

  /** One field, two meanings. An @ makes it a person; anything else is a domain. */
  async function add(event: React.FormEvent) {
    event.preventDefault();
    const value = entry.trim();
    if (!value) return;

    setBusy(true);
    setProblem(null);
    try {
      const next = value.includes('@')
        ? await endpoints.sharePerson(artifact.id, value)
        : await endpoints.shareDomain(artifact.id, value);
      setState(next);
      setEntry('');
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function run(action: Promise<SharingState>) {
    setBusy(true);
    setProblem(null);
    try {
      setState(await action);
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  }

  async function togglePublic(next: boolean) {
    await run(endpoints.setPublic(artifact.id, next));
    onChanged(next);
  }

  function copyLink() {
    void navigator.clipboard.writeText(artifact.url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }

  const nobodyElse =
    state !== null && !state.isPublic && state.people.length === 0 && state.domains.length === 0;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Share"
      description={artifact.title}
      width={440}
      footer={
        <>
          <Button size="sm" onClick={copyLink}>
            {copied ? 'Link copied' : 'Copy link'}
          </Button>
          <Button size="sm" tone="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      <form onSubmit={add} className="flex gap-1.5">
        <TextInput
          value={entry}
          onChange={(event) => setEntry(event.target.value)}
          placeholder="Email address, or a domain like example.com"
          aria-label="Share with an email address or a domain"
          disabled={busy}
        />
        <Button type="submit" tone="primary" busy={busy} disabled={!entry.trim()}>
          Share
        </Button>
      </form>

      {problem && (
        <div className="mt-2.5">
          <ErrorNote>{problem}</ErrorNote>
        </div>
      )}

      <div className="mt-3">
        {state === null ? (
          <div className="grid h-16 place-items-center">
            <Spinner className="text-ink-3" />
          </div>
        ) : (
          <>
            {nobodyElse && (
              <p className="px-0.5 py-2 text-[12.5px] text-ink-3">
                Only you can see this at the moment.
              </p>
            )}

            <ul className="flex flex-col">
              {state.people.map((person) => (
                <Row
                  key={person.id}
                  label={person.email}
                  badge={person.pending ? 'Not signed in yet' : null}
                  onRemove={() => void run(endpoints.unsharePerson(artifact.id, person.email))}
                  disabled={busy}
                />
              ))}
              {state.domains.map((domain) => (
                <Row
                  key={domain.id}
                  label={`Everybody at ${domain.domain}`}
                  badge={null}
                  onRemove={() => void run(endpoints.unshareDomain(artifact.id, domain.domain))}
                  disabled={busy}
                />
              ))}
            </ul>

            <Divider className="my-3" />

            <label className="flex cursor-pointer items-start gap-2.5">
              <Switch
                checked={state.isPublic}
                disabled={busy}
                onChange={(next) => void togglePublic(next)}
              />
              <span className="flex-1">
                <span className="block text-[12.5px] font-medium text-ink">
                  Anybody with the link
                </span>
                <span className="mt-0.5 block text-[11.5px] leading-relaxed text-ink-3">
                  {state.isPublic
                    ? 'Anyone who has the link can read this without signing in. Only the people above can comment.'
                    : 'Off. Only the people above can open it, and only after signing in.'}
                </span>
              </span>
            </label>
          </>
        )}
      </div>
    </Dialog>
  );
}

function Row({
  label,
  badge,
  onRemove,
  disabled,
}: {
  label: string;
  badge: string | null;
  onRemove: () => void;
  disabled: boolean;
}) {
  return (
    <li className="group flex items-center gap-2 rounded-[--radius-sm] px-0.5 py-1.5 hover:bg-sunken">
      <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink">{label}</span>
      {badge && <Badge>{badge}</Badge>}
      <button
        type="button"
        onClick={onRemove}
        disabled={disabled}
        aria-label={`Stop sharing with ${label}`}
        // Visible on hover for a mouse, and always once focused by keyboard.
        className="shrink-0 rounded-[--radius-xs] px-1.5 py-0.5 text-[11.5px] text-ink-3 opacity-0 transition-opacity hover:text-danger focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30"
      >
        Remove
      </button>
    </li>
  );
}

/** A switch, because the public toggle is a state rather than an action. */
function Switch({
  checked,
  disabled,
  onChange,
}: {
  checked: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={[
        'mt-px h-[18px] w-[30px] shrink-0 rounded-full border transition-colors duration-150',
        checked ? 'border-transparent bg-accent' : 'border-line bg-sunken',
        'disabled:opacity-50',
      ].join(' ')}
    >
      <span
        className="block size-3.5 rounded-full bg-white shadow-sm transition-transform duration-150"
        style={{ transform: `translateX(${checked ? 13 : 1.5}px)` }}
      />
    </button>
  );
}
