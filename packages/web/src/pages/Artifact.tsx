/**
 * The artifact viewer.
 *
 * The screen this whole product exists to show, so the chrome around it is one
 * thin bar and nothing else. Title, who published it, when it changed, and the
 * two things the owner might want.
 *
 * How the two formats are shown, and why they differ:
 *
 * - Markdown is fetched already rendered and sanitised by the server and placed
 *   in the page. Every script, event handler and dangerous URL was removed
 *   before that HTML existed. Being in the page rather than a frame is what will
 *   let a reader select a paragraph and comment on it.
 *
 * - HTML is the publisher's own document, scripts and all, so it never touches
 *   this page. It loads in an iframe with sandbox="allow-scripts", which gives
 *   it an opaque origin: no cookies, no same-origin calls to the API. Removing
 *   that attribute would hand every artifact author the reader's session.
 *
 * There are two ways in. Somebody signed in gets the viewer inside the app, with
 * a sidebar. Somebody who is not signed in gets it only if the artifact is
 * public, standalone, with a way to sign in. Both use the same body.
 */

import { useEffect, useState } from 'react';
import { endpoints, ApiError, type SharedArtifact } from '../api.js';
import { useAccount } from '../App.jsx';
import { useRouter } from '../router.jsx';
import { Button, Badge, RelativeTime, Spinner, Dialog } from '../components/primitives.js';
import { ShareDialog } from '../components/ShareDialog.js';
import { NotFound } from './NotFound.js';

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

export function Artifact({ slug }: { slug: string }) {
  const { user } = useAccount();
  const { navigate } = useRouter();

  const { artifact, setArtifact, missing } = useArtifact(slug);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  if (missing) return <NotFound />;
  if (!artifact) return <Loading />;

  const isOwner = artifact.ownerId === user.id;

  return (
    <div className="flex h-dvh flex-col">
      <Bar artifact={artifact} byline={isOwner ? 'You' : ownerOf(artifact)}>
        {isOwner && (
          <>
            <Button size="sm" onClick={() => setSharingOpen(true)}>
              Share
            </Button>
            <Button
              size="sm"
              tone="ghost"
              onClick={() => setDeleteOpen(true)}
              aria-label="Delete this artifact"
            >
              <TrashIcon />
            </Button>
          </>
        )}
      </Bar>

      <Body slug={slug} artifact={artifact} />

      {isOwner && (
        <>
          <ShareDialog
            artifact={artifact}
            open={sharingOpen}
            onClose={() => setSharingOpen(false)}
            onChanged={(isPublic) =>
              setArtifact((current) =>
                current ? { ...current, isPublic: isPublic ? 1 : 0 } : current,
              )
            }
          />
          <DeleteDialog
            artifact={artifact}
            open={deleteOpen}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => navigate('/')}
          />
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Not signed in
// ---------------------------------------------------------------------------

/**
 * A public artifact, read by somebody with no account.
 *
 * No sidebar, because there is nothing of theirs to navigate. The sign-in button
 * is offered rather than demanded: they can already read this, and being asked
 * to sign in to see what you are already looking at is the kind of thing that
 * makes people close the tab.
 */
export function PublicArtifact({
  slug,
  artifact,
  onSignIn,
}: {
  slug: string;
  artifact: SharedArtifact;
  onSignIn: () => void;
}) {
  return (
    <div className="flex h-dvh flex-col">
      <Bar artifact={artifact} byline={ownerOf(artifact)}>
        <Button size="sm" onClick={onSignIn}>
          Sign in
        </Button>
      </Bar>
      <Body slug={slug} artifact={artifact} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Bar({
  artifact,
  byline,
  children,
}: {
  artifact: SharedArtifact;
  byline: string | null;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <h1 className="truncate text-[13px] font-semibold text-ink">{artifact.title}</h1>
        {artifact.isPublic === 1 && <Badge tone="accent">Public</Badge>}
      </div>

      <p className="hidden shrink-0 text-[12px] text-ink-3 sm:block">
        {byline ? `${byline} · ` : ''}
        <RelativeTime iso={artifact.updatedAt} prefix="updated" />
      </p>

      {children && <div className="flex shrink-0 items-center gap-1.5">{children}</div>}
    </header>
  );
}

function Body({ slug, artifact }: { slug: string; artifact: SharedArtifact }) {
  return (
    <div className="oa-scroll min-h-0 flex-1 overflow-y-auto">
      {artifact.type === 'markdown' ? (
        <RenderedMarkdown slug={slug} />
      ) : (
        <iframe
          title={artifact.title}
          src={`/a/${encodeURIComponent(slug)}/content`}
          // Without allow-same-origin the document runs at an opaque origin.
          // That is the whole of the security model here; do not add to it.
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          className="h-full w-full border-0 bg-white"
        />
      )}
    </div>
  );
}

/**
 * Markdown, rendered by the server and placed in the page.
 *
 * This HTML has already been through the sanitising pipeline, which drops raw
 * HTML, script, event handlers and javascript: URLs before the string exists.
 * That is what makes putting it in the page acceptable. If the server ever stops
 * sanitising, this line is where it becomes a hole.
 */
function RenderedMarkdown({ slug }: { slug: string }) {
  const [html, setHtml] = useState<string | null>(null);

  useEffect(() => {
    setHtml(null);
    fetch(`/a/${encodeURIComponent(slug)}/content`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : ''))
      .then(setHtml)
      .catch(() => setHtml(''));
  }, [slug]);

  if (html === null) return <Loading />;

  return (
    <article
      className="prose oa-fade mx-auto w-full max-w-[720px] px-6 py-10"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** Loads an artifact by the slug in the URL. */
export function useArtifact(slug: string) {
  const [artifact, setArtifact] = useState<SharedArtifact | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let current = true;
    setArtifact(null);
    setMissing(false);

    endpoints
      .artifactBySlug(slug)
      .then((loaded) => current && setArtifact(loaded))
      .catch((error: unknown) => {
        // "Not yours" and "does not exist" are deliberately the same answer from
        // the server, and this screen must not undo that by telling them apart.
        void (error instanceof ApiError);
        if (current) setMissing(true);
      });

    return () => {
      current = false;
    };
  }, [slug]);

  return { artifact, setArtifact, missing };
}

function Loading() {
  return (
    <div className="grid h-40 flex-1 place-items-center">
      <Spinner className="text-ink-3" />
    </div>
  );
}

function ownerOf(artifact: SharedArtifact): string | null {
  return artifact.ownerName ?? artifact.ownerEmail ?? null;
}

function DeleteDialog({
  artifact,
  open,
  onClose,
  onDeleted,
}: {
  artifact: SharedArtifact;
  open: boolean;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [busy, setBusy] = useState(false);

  async function confirm() {
    setBusy(true);
    try {
      await endpoints.deleteArtifact(artifact.id);
      onDeleted();
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Delete this artifact?"
      // Naming it is what stops somebody deleting the wrong one from a list.
      description={`“${artifact.title}” and its history will be gone, and anybody holding the link will get nothing. This cannot be undone.`}
      footer={
        <>
          <Button size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" tone="danger" busy={busy} onClick={() => void confirm()}>
            Delete
          </Button>
        </>
      }
    />
  );
}

function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 4.25h10.5M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25M12 4.25 11.5 13a.75.75 0 0 1-.75.7h-5.5a.75.75 0 0 1-.75-.7L4 4.25"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
