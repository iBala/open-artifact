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

import { useCallback, useEffect, useRef, useState } from 'react';
import { endpoints, ApiError, type SharedArtifact } from '../api.js';
import { useAccount } from '../App.jsx';
import { useRouter } from '../router.jsx';
import { Button, Badge, RelativeTime, Spinner, Dialog } from '../components/primitives.js';
import { ShareDialog } from '../components/ShareDialog.js';
import { CommentsPanel, Composer, useMentionCandidates } from '../components/Comments.js';
import { readSelection, locatePassage, type SelectedPassage } from '../components/selection.js';
import { NotFound } from './NotFound.js';
import type { CommentThread } from '@open-artifact/shared';

// ---------------------------------------------------------------------------
// Signed in
// ---------------------------------------------------------------------------

export function Artifact({ slug }: { slug: string }) {
  const { user } = useAccount();
  const { navigate } = useRouter();

  const { artifact, setArtifact, missing } = useArtifact(slug);
  const [sharingOpen, setSharingOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [showComments, setShowComments] = useState(true);

  const conversation = useComments(artifact?.id ?? null, artifact?.youMay?.comment ?? false);

  if (missing) return <NotFound />;
  if (!artifact) return <Loading />;

  const isOwner = artifact.ownerId === user.id;

  return (
    <div className="flex h-dvh flex-col">
      <Bar artifact={artifact} byline={isOwner ? 'You' : ownerOf(artifact)}>
        <Button
          size="sm"
          tone={showComments ? 'default' : 'ghost'}
          onClick={() => setShowComments((shown) => !shown)}
        >
          Comments
          {conversation.openCount > 0 && (
            <span className="ml-0.5 tabular-nums text-ink-3">{conversation.openCount}</span>
          )}
        </Button>

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

      <div className="flex min-h-0 flex-1">
        <Body
          slug={slug}
          artifact={artifact}
          threads={conversation.threads}
          activeThreadId={conversation.activeThreadId}
          onNewThread={conversation.reload}
          canComment={conversation.canComment}
        />

        {showComments && (
          <CommentsPanel
            artifactId={artifact.id}
            threads={conversation.threads}
            loading={conversation.loading}
            canComment={conversation.canComment}
            currentUserId={user.id}
            isArtifactOwner={isOwner}
            activeThreadId={conversation.activeThreadId}
            onFocusThread={conversation.setActiveThreadId}
            onChanged={conversation.reload}
          />
        )}
      </div>

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

function Body({
  slug,
  artifact,
  threads = [],
  activeThreadId = null,
  onNewThread,
  canComment = false,
}: {
  slug: string;
  artifact: SharedArtifact;
  threads?: CommentThread[];
  activeThreadId?: string | null;
  onNewThread?: () => void;
  canComment?: boolean;
}) {
  return (
    <div className="oa-scroll min-h-0 flex-1 overflow-y-auto">
      {artifact.type === 'markdown' ? (
        <RenderedMarkdown
          slug={slug}
          artifactId={artifact.id}
          threads={threads}
          activeThreadId={activeThreadId}
          onNewThread={onNewThread}
          canComment={canComment}
        />
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
function RenderedMarkdown({
  slug,
  artifactId,
  threads,
  activeThreadId,
  onNewThread,
  canComment,
}: {
  slug: string;
  artifactId: string;
  threads: CommentThread[];
  activeThreadId: string | null;
  onNewThread?: () => void;
  canComment: boolean;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedPassage | null>(null);
  const article = useRef<HTMLElement>(null);

  useEffect(() => {
    setHtml(null);
    fetch(`/a/${encodeURIComponent(slug)}/content`, { credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : ''))
      .then(setHtml)
      .catch(() => setHtml(''));
  }, [slug]);

  // Highlight the passage belonging to whichever thread is being touched, so
  // the connection between a remark and the text it is about is visible rather
  // than something the reader has to reconstruct.
  useEffect(() => {
    const element = article.current;
    if (!element || html === null) return;

    element.querySelectorAll('mark[data-oa-anchor]').forEach((mark) => {
      mark.replaceWith(...mark.childNodes);
    });
    element.normalize();

    const thread = threads.find((candidate) => candidate.id === activeThreadId);
    if (!thread || thread.anchor.kind !== 'text') return;

    const range = locatePassage(
      element,
      thread.anchor.headingId,
      thread.anchor.snippet,
      thread.anchor.occurrence,
    );
    if (!range) return;

    try {
      const mark = document.createElement('mark');
      mark.dataset.oaAnchor = thread.id;
      mark.className = 'rounded-[2px] bg-accent-wash text-ink';
      range.surroundContents(mark);
    } catch {
      // surroundContents refuses a range that crosses element boundaries, which
      // happens when a passage spans a link or a bold run. Not worth splitting
      // the DOM for: the thread is still readable in the panel.
    }
  }, [activeThreadId, threads, html]);

  if (html === null) return <Loading />;

  return (
    <div className="relative">
      <article
        ref={article}
        className="prose oa-fade mx-auto w-full max-w-[720px] px-6 py-10"
        onMouseUp={() => {
          if (!canComment) return;
          setSelected(article.current ? readSelection(article.current) : null);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />

      {selected && canComment && (
        <SelectionPopover
          artifactId={artifactId}
          passage={selected}
          onClose={() => setSelected(null)}
          onCommented={() => {
            setSelected(null);
            window.getSelection()?.removeAllRanges();
            onNewThread?.();
          }}
        />
      )}
    </div>
  );
}

/**
 * The box that appears when somebody highlights a passage.
 *
 * Anchored to the selection rather than to a fixed corner, because the whole
 * point is that it is about that text. Clamped to the viewport so a selection
 * near an edge does not put the box off screen.
 */
function SelectionPopover({
  artifactId,
  passage,
  onClose,
  onCommented,
}: {
  artifactId: string;
  passage: SelectedPassage;
  onClose: () => void;
  onCommented: () => void;
}) {
  const candidates = useMentionCandidates(artifactId, true);
  const WIDTH = 280;
  const left = Math.min(
    Math.max(8, passage.rect.left + passage.rect.width / 2 - WIDTH / 2),
    window.innerWidth - WIDTH - 8,
  );

  return (
    <div
      className="oa-pop fixed z-20 rounded-[--radius-lg] border border-line bg-surface p-2.5 shadow-[--shadow-pop]"
      style={{ top: passage.rect.top + passage.rect.height + 8, left, width: WIDTH }}
    >
      <p className="mb-2 border-l-2 border-accent pl-2 text-[11.5px] leading-snug text-ink-2">
        {passage.snippet.length > 80 ? `${passage.snippet.slice(0, 80).trimEnd()}…` : passage.snippet}
      </p>

      <Composer
        placeholder="Comment on this"
        mentionCandidates={candidates}
        onCancel={onClose}
        onSubmit={async (body) => {
          await endpoints.startThread(artifactId, body, {
            headingId: passage.headingId,
            snippet: passage.snippet,
            occurrence: passage.occurrence,
          });
          onCommented();
        }}
      />
    </div>
  );
}

/**
 * The conversation about an artifact.
 *
 * Whether this person may join it comes from the server alongside the artifact.
 * The client could not decide it: seeing who an artifact is shared with is
 * itself something only its owner may do.
 */
function useComments(artifactId: string | null, canComment: boolean) {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);

  const reload = useCallback(() => {
    if (!artifactId) return;

    endpoints
      .comments(artifactId)
      .then((response) => setThreads(response.threads))
      .catch(() => setThreads([]))
      .finally(() => setLoading(false));
  }, [artifactId]);

  useEffect(reload, [reload]);

  return {
    threads,
    loading,
    canComment,
    activeThreadId,
    setActiveThreadId,
    reload,
    openCount: threads.filter((thread) => thread.status === 'open').length,
  };
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
