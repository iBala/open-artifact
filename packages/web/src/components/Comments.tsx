/**
 * The conversation beside a document.
 *
 * Comments live in a panel to the right rather than inline, because an artifact
 * is something to read and threading remarks through the middle of it makes it
 * unreadable. The connection between a comment and its passage is made by
 * highlighting the passage when you touch the thread, and vice versa.
 *
 * Resolved threads collapse rather than disappear. Somebody scrolling back
 * wants to see that a question was asked and answered; hiding it makes the
 * document look like nobody ever queried anything.
 */

import { useEffect, useRef, useState } from 'react';
import type { CommentThread, Comment as CommentRecord } from '@open-artifact/shared';
import { endpoints, ApiError } from '../api.js';
import { Button, Badge, RelativeTime, Spinner, ErrorNote } from './primitives.js';
import { Avatar } from './Sidebar.js';

export interface CommentsPanelProps {
  artifactId: string;
  threads: CommentThread[];
  loading: boolean;
  /** Null when this person may read the artifact but not comment on it. */
  canComment: boolean;
  currentUserId: string;
  /** True when this person owns the artifact, so they can delete anything. */
  isArtifactOwner: boolean;
  activeThreadId: string | null;
  onFocusThread: (threadId: string | null) => void;
  onChanged: () => void;
}

export function CommentsPanel({
  artifactId,
  threads,
  loading,
  canComment,
  currentUserId,
  isArtifactOwner,
  activeThreadId,
  onFocusThread,
  onChanged,
}: CommentsPanelProps) {
  const [showResolved, setShowResolved] = useState(false);

  const open = threads.filter((thread) => thread.status === 'open');
  const resolved = threads.filter((thread) => thread.status === 'resolved');

  return (
    <aside className="flex h-full w-[320px] shrink-0 flex-col border-l border-line bg-canvas">
      <header className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-line px-3.5">
        <h2 className="text-[12px] font-semibold uppercase tracking-[0.05em] text-ink-3">
          Comments
        </h2>
        {loading && <Spinner className="text-ink-3" />}
      </header>

      <div className="oa-scroll min-h-0 flex-1 overflow-y-auto px-2.5 py-2.5">
        {!loading && threads.length === 0 && (
          <p className="px-1 py-6 text-[12.5px] leading-relaxed text-ink-3">
            {canComment
              ? 'Select any passage in the document to comment on it, or use the box below for a note about the whole thing.'
              : 'Nothing has been said about this yet.'}
          </p>
        )}

        {open.map((thread) => (
          <Thread
            key={thread.id}
            thread={thread}
            active={thread.id === activeThreadId}
            canComment={canComment}
            currentUserId={currentUserId}
            isArtifactOwner={isArtifactOwner}
            onFocus={() => onFocusThread(thread.id)}
            onChanged={onChanged}
          />
        ))}

        {resolved.length > 0 && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setShowResolved((shown) => !shown)}
              className="flex w-full items-center gap-1.5 rounded-[--radius-sm] px-1.5 py-1.5 text-[12px] text-ink-3 transition-colors hover:bg-sunken hover:text-ink"
            >
              <Chevron open={showResolved} />
              {resolved.length} resolved
            </button>

            {showResolved &&
              resolved.map((thread) => (
                <Thread
                  key={thread.id}
                  thread={thread}
                  active={thread.id === activeThreadId}
                  canComment={canComment}
                  currentUserId={currentUserId}
                  isArtifactOwner={isArtifactOwner}
                  onFocus={() => onFocusThread(thread.id)}
                  onChanged={onChanged}
                />
              ))}
          </div>
        )}
      </div>

      {canComment && (
        <div className="shrink-0 border-t border-line p-2.5">
          <NewDocumentComment artifactId={artifactId} onChanged={onChanged} />
        </div>
      )}
    </aside>
  );
}

function Thread({
  thread,
  active,
  canComment,
  currentUserId,
  isArtifactOwner,
  onFocus,
  onChanged,
}: {
  thread: CommentThread;
  active: boolean;
  canComment: boolean;
  currentUserId: string;
  isArtifactOwner: boolean;
  onFocus: () => void;
  onChanged: () => void;
}) {
  const [replying, setReplying] = useState(false);
  const resolved = thread.status === 'resolved';

  async function setStatus(status: 'open' | 'resolved') {
    await endpoints.setThreadStatus(thread.id, status).catch(() => undefined);
    onChanged();
  }

  return (
    <article
      onMouseEnter={onFocus}
      className={[
        'oa-rise mb-1.5 rounded-[--radius] border p-2.5 transition-colors',
        active ? 'border-accent bg-accent-wash/40' : 'border-line bg-surface',
        resolved ? 'opacity-70' : '',
      ].join(' ')}
    >
      {thread.anchor.kind === 'text' && (
        <p className="mb-2 border-l-2 border-accent pl-2 text-[11.5px] leading-snug text-ink-2">
          {truncate(thread.anchor.snippet, 90)}
        </p>
      )}

      {thread.anchorLost && (
        // Said out loud. A comment that quietly changes what it is about is
        // worse than one that admits it lost its place.
        <p className="mb-2 text-[11px] leading-snug text-ink-3">
          The passage this was about is no longer in the document. It now applies to the artifact
          as a whole.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        {thread.comments.map((comment) => (
          <CommentBody
            key={comment.id}
            comment={comment}
            canDelete={
              !comment.deleted && (comment.author?.id === currentUserId || isArtifactOwner)
            }
            canEdit={!comment.deleted && comment.author?.id === currentUserId}
            onChanged={onChanged}
          />
        ))}
      </div>

      {canComment && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {replying ? (
            <Composer
              placeholder="Reply"
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                await endpoints.replyToThread(thread.id, body);
                setReplying(false);
                onChanged();
              }}
            />
          ) : (
            <>
              <Button size="sm" tone="ghost" onClick={() => setReplying(true)}>
                Reply
              </Button>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => void setStatus(resolved ? 'open' : 'resolved')}
              >
                {resolved ? 'Reopen' : 'Resolve'}
              </Button>
              {resolved && <Badge>Resolved</Badge>}
            </>
          )}
        </div>
      )}
    </article>
  );
}

function CommentBody({
  comment,
  canDelete,
  canEdit,
  onChanged,
}: {
  comment: CommentRecord;
  canDelete: boolean;
  canEdit: boolean;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);

  if (editing) {
    return (
      <Composer
        initialValue={comment.body}
        placeholder="Edit"
        onCancel={() => setEditing(false)}
        onSubmit={async (body) => {
          await endpoints.editComment(comment.id, body);
          setEditing(false);
          onChanged();
        }}
      />
    );
  }

  return (
    <div className="group">
      <div className="flex items-center gap-1.5">
        {comment.author ? (
          <Avatar email={comment.author.email} size={16} />
        ) : (
          <span aria-hidden="true" className="size-4 shrink-0 rounded-full bg-line" />
        )}
        <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium text-ink">
          {comment.author?.displayName ?? comment.author?.email ?? 'Deleted user'}
        </span>
        <span className="shrink-0 text-[11px] text-ink-3">
          <RelativeTime iso={comment.createdAt} />
        </span>
      </div>

      <p
        className={[
          'mt-1 whitespace-pre-wrap text-[12.5px] leading-relaxed',
          comment.deleted ? 'italic text-ink-3' : 'text-ink',
        ].join(' ')}
      >
        {comment.body}
        {comment.editedAt && !comment.deleted && (
          <span className="ml-1 text-[11px] text-ink-3">(edited)</span>
        )}
      </p>

      {(canEdit || canDelete) && (
        <div className="mt-0.5 flex gap-2 text-[11px] text-ink-3 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
          {canEdit && (
            <button type="button" onClick={() => setEditing(true)} className="hover:text-ink">
              Edit
            </button>
          )}
          {canDelete && (
            <button
              type="button"
              className="hover:text-danger"
              onClick={() => {
                void endpoints.deleteComment(comment.id).then(onChanged);
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function NewDocumentComment({
  artifactId,
  onChanged,
}: {
  artifactId: string;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-[--radius] border border-line bg-surface px-2.5 py-2 text-left text-[12.5px] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
      >
        Comment on the whole document
      </button>
    );
  }

  return (
    <Composer
      placeholder="A note about the whole document"
      onCancel={() => setOpen(false)}
      onSubmit={async (body) => {
        await endpoints.startThread(artifactId, body);
        setOpen(false);
        onChanged();
      }}
    />
  );
}

/** The one box for writing anything: a new thread, a reply, or an edit. */
export function Composer({
  placeholder,
  initialValue = '',
  onSubmit,
  onCancel,
  autoFocus = true,
}: {
  placeholder: string;
  initialValue?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  autoFocus?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);

  async function send() {
    if (value.trim().length === 0) return;
    setBusy(true);
    setProblem(null);

    try {
      await onSubmit(value.trim());
      setValue('');
    } catch (error) {
      setProblem(error instanceof ApiError ? error.message : 'That did not send.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <textarea
        ref={field}
        rows={3}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // Enter for a newline, modifier-Enter to send. Comments run to more
          // than one line often enough that the other way round loses text.
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
          if (event.key === 'Escape') onCancel();
        }}
        className="w-full resize-none rounded-[--radius] border border-line bg-surface px-2.5 py-2 text-[12.5px] leading-relaxed text-ink placeholder:text-ink-3 transition-colors hover:border-ink-3 focus:border-accent"
      />

      {problem && <ErrorNote>{problem}</ErrorNote>}

      <div className="flex items-center justify-end gap-1.5">
        <Button size="sm" tone="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        <Button size="sm" tone="primary" busy={busy} disabled={value.trim().length === 0} onClick={() => void send()}>
          Send
        </Button>
      </div>
    </div>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 12 12"
      fill="none"
      aria-hidden="true"
      style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform 120ms' }}
    >
      <path d="M4.5 2.5 8 6l-3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit).trimEnd()}…`;
}
