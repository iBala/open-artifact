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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { endpoints, ApiError, type SharedArtifact } from '../api.js';
import { useAccount } from '../App.jsx';
import { useStars } from '../stars.jsx';
import { useRouter, Link } from '../router.jsx';
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
  const stars = useStars();

  const conversation = useComments(artifact?.id ?? null, artifact?.youMay?.comment ?? false);

  // Seed the shared star state from what the server said about this artifact, so
  // the bar's star and the sidebar's agree the moment the page opens.
  useEffect(() => {
    if (artifact) stars.reconcile([{ id: artifact.id, starred: artifact.starred ?? false }]);
  }, [artifact?.id, artifact?.starred, stars]);

  if (missing) return <NotFound />;
  if (!artifact) return <Loading />;

  const isOwner = artifact.ownerId === user.id;
  // Only nudge a reader who has not connected an assistant yet. Somebody already
  // set up does not need to be told how, on every document they open.
  const invitePublish = !isOwner && user.connectedApps.length === 0;

  return (
    <div className="flex h-dvh flex-col">
      <Bar artifact={artifact} byline={isOwner ? 'You' : ownerOf(artifact)}>
        {/* A reader has the sidebar collapsed and the footer a scroll away, so
            the one obvious way to their own setup sits here in the bar. */}
        {invitePublish && <PublishPill />}

        <BarStar id={artifact.id} />

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

      {/* A public artifact this person did not write is a stranger's page. The
          owner already knows what is in their own, so they are spared it. */}
      {artifact.isPublic === 1 && !isOwner && <CautionBar />}

      <div className="flex min-h-0 flex-1">
        <Body
          slug={slug}
          artifact={artifact}
          threads={conversation.threads}
          activeThreadId={conversation.activeThreadId}
          onNewThread={conversation.reload}
          canComment={conversation.canComment}
          isArtifactOwner={isOwner}
          // The owner wrote it and already uses this, and somebody already set up
          // does not need asking; only an unconnected reader is worth the nudge.
          publishCta={invitePublish}
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
      {/* A reader with no account has no sidebar and so no branding and no way
          back to the front door. The wordmark is both. */}
      <Bar artifact={artifact} byline={ownerOf(artifact)} brand>
        <Button size="sm" onClick={onSignIn}>
          Sign in
        </Button>
      </Bar>
      {/* Everybody reading a public artifact signed out is a stranger to it. */}
      <CautionBar />
      <Body slug={slug} artifact={artifact} publishCta />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

function Bar({
  artifact,
  byline,
  brand = false,
  children,
}: {
  artifact: SharedArtifact;
  byline: string | null;
  /** Show the Open Artifact wordmark on the left, for readers with no sidebar. */
  brand?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
      {brand && (
        <Link
          to="/"
          className="shrink-0 text-[12.5px] font-semibold text-ink-2 transition-colors hover:text-ink"
        >
          Open Artifact
        </Link>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {brand && <span className="shrink-0 text-ink-3" aria-hidden="true">/</span>}
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

/**
 * A quiet caution shown to somebody reading a public artifact they did not
 * write.
 *
 * A public artifact is a stranger's page served from this instance's own domain.
 * Script inside it cannot reach the reader (see the view route and its sandbox),
 * but a link inside it can still carry the reader off to somewhere hostile that
 * now looks like it came from a domain they had reason to trust. This says so,
 * once, in one line. It does not shout, because a warning that shouts on every
 * page is one people learn to stop seeing.
 */
function CautionBar() {
  return (
    <div
      role="note"
      className="flex shrink-0 items-center gap-2 border-b border-line bg-sunken px-4 py-1.5 text-[11.5px] leading-snug text-ink-2"
    >
      <CautionIcon />
      <span>
        Published by someone using this instance. Be careful before entering personal information
        or following links to other sites.
      </span>
    </div>
  );
}

function CautionIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="none"
      aria-hidden="true"
      className="shrink-0"
      style={{ color: 'oklch(72% 0.16 70)' }}
    >
      <path
        d="M8 1.75 1.5 13.25h13L8 1.75Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      <path d="M8 6.5v3" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.7" fill="currentColor" />
    </svg>
  );
}

function Body({
  slug,
  artifact,
  threads = [],
  activeThreadId = null,
  onNewThread,
  canComment = false,
  isArtifactOwner = false,
  publishCta = false,
}: {
  slug: string;
  artifact: SharedArtifact;
  threads?: CommentThread[];
  activeThreadId?: string | null;
  onNewThread?: () => void;
  canComment?: boolean;
  isArtifactOwner?: boolean;
  /** Show the reader a quiet way to publish their own, at the end. */
  publishCta?: boolean;
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
          isArtifactOwner={isArtifactOwner}
          publishCta={publishCta}
        />
      ) : (
        <div className="flex min-h-full flex-col">
          <iframe
            title={artifact.title}
            src={`/a/${encodeURIComponent(slug)}/content`}
            // Without allow-same-origin the document runs at an opaque origin.
            // That is the whole of the security model here; do not add to it.
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            className="w-full flex-1 border-0 bg-white"
          />
          {publishCta && <PublishFooter />}
        </div>
      )}
    </div>
  );
}

/**
 * A quiet invitation, shown to a reader who did not write this, at the very end.
 *
 * Only somebody who read to here sees it, which is exactly the person worth
 * asking. It does not interrupt, and it does not sell; it names what this is and
 * offers the door. The link goes to the front page, which is the setup guide.
 */
function PublishFooter() {
  return (
    <div className="border-t border-line px-6 py-5">
      <p className="mx-auto flex max-w-[720px] flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-3">
        <span>Published with Open Artifact.</span>
        <Link to="/" className="font-medium text-accent hover:underline">
          Publish your own →
        </Link>
      </p>
    </div>
  );
}

/**
 * The star in the artifact bar, for a signed-in reader.
 *
 * Its state comes from the shared star store, not from a prop, so starring here
 * lights up the sidebar row at the same instant, and starring in the sidebar
 * lights this up. A filled star reads as on; an outline as off.
 */
function BarStar({ id }: { id: string }) {
  const stars = useStars();
  const starred = stars.isStarred(id);

  return (
    <Button
      size="sm"
      tone="ghost"
      onClick={() => stars.toggle(id)}
      aria-pressed={starred}
      aria-label={starred ? 'Remove star' : 'Star this'}
      style={starred ? { color: 'oklch(74% 0.15 78)' } : undefined}
    >
      <BarStarIcon filled={starred} />
    </Button>
  );
}

function BarStarIcon({ filled }: { filled: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill={filled ? 'currentColor' : 'none'} aria-hidden="true">
      <path
        d="M8 1.8l1.76 3.57 3.94.57-2.85 2.78.67 3.92L8 10.79l-3.52 1.85.67-3.92L2.3 5.94l3.94-.57L8 1.8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The highlighted way to your own setup, in the bar while reading. */
function PublishPill() {
  return (
    <Link
      to="/"
      className="flex items-center gap-1 rounded-[--radius-sm] bg-accent-wash px-2 py-1 text-[12px] font-medium text-accent transition-opacity hover:opacity-85"
    >
      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.3l1.5 4 4 1.5-4 1.5L8 12.3 6.5 8.3l-4-1.5 4-1.5z" fill="currentColor" />
      </svg>
      Publish your own
    </Link>
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
  isArtifactOwner = false,
  publishCta = false,
}: {
  slug: string;
  artifactId: string;
  threads: CommentThread[];
  activeThreadId: string | null;
  onNewThread?: () => void;
  canComment: boolean;
  isArtifactOwner?: boolean;
  publishCta?: boolean;
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

  const onSelect = useCallback(() => {
    if (!canComment) return;
    setSelected(article.current ? readSelection(article.current) : null);
  }, [canComment]);

  // The rendered document, memoised so nothing but its own content ever
  // rebuilds it. React re-applies dangerouslySetInnerHTML whenever it
  // reconciles this element, which wipes and rebuilds the child nodes and
  // collapses any live text selection inside them — so selecting a passage
  // would erase the selection the instant the popover opened, and there would
  // be nothing left to copy. Holding a stable element reference across
  // selection changes makes React skip it entirely; it is rebuilt only when
  // the content itself changes.
  const documentBody = useMemo(
    () => (
      <article
        ref={article}
        className="prose oa-fade mx-auto w-full max-w-[720px] px-6 py-10"
        onMouseUp={onSelect}
        dangerouslySetInnerHTML={{ __html: html ?? '' }}
      />
    ),
    [html, onSelect],
  );

  if (html === null) return <Loading />;

  return (
    <div className="relative">
      {documentBody}

      {selected && canComment && (
        <SelectionPopover
          // Keyed on the passage so a fresh selection starts as the small button
          // again, rather than reopening an already-expanded composer elsewhere.
          key={`${selected.headingId}|${selected.occurrence}|${selected.snippet}`}
          artifactId={artifactId}
          isArtifactOwner={isArtifactOwner}
          passage={selected}
          onClose={() => setSelected(null)}
          onCommented={() => {
            setSelected(null);
            window.getSelection()?.removeAllRanges();
            onNewThread?.();
          }}
        />
      )}

      {publishCta && <PublishFooter />}
    </div>
  );
}

/**
 * What appears when somebody highlights a passage.
 *
 * Two stages, on purpose. Highlighting text first shows only a small "Comment"
 * button — nothing that takes focus — so the selection stays live and the reader
 * can still copy it. The composer, which grabs focus into its box the moment it
 * mounts, opens only when that button is pressed. Before this was one stage, and
 * selecting anything to copy dropped you straight into an empty comment box that
 * had already stolen the selection out from under a Cmd-C.
 *
 * Anchored to the selection rather than a fixed corner, because the whole point
 * is that it is about that text. Clamped to the viewport so a selection near an
 * edge does not put it off screen.
 */
function SelectionPopover({
  artifactId,
  isArtifactOwner,
  passage,
  onClose,
  onCommented,
}: {
  artifactId: string;
  isArtifactOwner: boolean;
  passage: SelectedPassage;
  onClose: () => void;
  onCommented: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Only fetch who can be mentioned once the composer is actually opening, not
  // for every selection made just to copy.
  const candidates = useMentionCandidates(artifactId, expanded);

  const width = expanded ? 280 : 128;
  const left = Math.min(
    Math.max(8, passage.rect.left + passage.rect.width / 2 - width / 2),
    window.innerWidth - width - 8,
  );
  const top = passage.rect.top + passage.rect.height + 8;

  if (!expanded) {
    return (
      <div className="oa-pop fixed z-20" style={{ top, left, width }}>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="flex w-full items-center justify-center gap-1.5 rounded-[--radius-lg] border border-line bg-surface px-2.5 py-1.5 text-[12px] font-medium text-ink-2 shadow-[--shadow-pop] transition-colors hover:text-ink"
        >
          <CommentGlyph />
          Comment
        </button>
      </div>
    );
  }

  return (
    <div
      className="oa-pop fixed z-20 rounded-[--radius-lg] border border-line bg-surface p-2.5 shadow-[--shadow-pop]"
      style={{ top, left, width }}
    >
      <p className="mb-2 border-l-2 border-accent pl-2 text-[11.5px] leading-snug text-ink-2">
        {passage.snippet.length > 80 ? `${passage.snippet.slice(0, 80).trimEnd()}…` : passage.snippet}
      </p>

      <Composer
        placeholder="Comment on this"
        mentionCandidates={candidates}
        isArtifactOwner={isArtifactOwner}
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

function CommentGlyph() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2.75 3.25h10.5a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H6.5l-3 2.5v-2.5H2.75a1 1 0 0 1-1-1v-5.5a1 1 0 0 1 1-1Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
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
