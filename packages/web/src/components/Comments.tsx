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
import { endpoints, ApiError, type MentionCandidate, type MentionOutcome } from '../api.js';
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
  /**
   * Set only for a signed-out reader of a public artifact. Turns the panel into
   * a read-only preview of the feature with a way to sign in. Commenting itself
   * still needs an account and a share, so this never promises commenting here.
   */
  onSignIn?: () => void;
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
  onSignIn,
}: CommentsPanelProps) {
  const [showResolved, setShowResolved] = useState(false);
  const candidates = useMentionCandidates(artifactId, canComment);

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
              : onSignIn
                ? 'No comments yet. This is where a conversation lives: on a document shared with you, you can highlight any line and comment on it right here.'
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
            candidates={candidates}
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
                  candidates={candidates}
                />
              ))}
          </div>
        )}
      </div>

      {canComment && (
        <div className="shrink-0 border-t border-line p-2.5">
          <NewDocumentComment
            artifactId={artifactId}
            onChanged={onChanged}
            candidates={candidates}
            isArtifactOwner={isArtifactOwner}
          />
        </div>
      )}

      {/* Signed-out reader of a public page. Commenting needs an account and a
          share, so this offers the door rather than a comment box that would
          not work here. */}
      {!canComment && onSignIn && (
        <div className="shrink-0 border-t border-line p-2.5">
          <Button size="sm" tone="primary" onClick={onSignIn} className="w-full justify-center">
            Sign in
          </Button>
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
  candidates,
}: {
  thread: CommentThread;
  active: boolean;
  canComment: boolean;
  currentUserId: string;
  isArtifactOwner: boolean;
  onFocus: () => void;
  onChanged: () => void;
  candidates: MentionCandidate[];
}) {
  const [replying, setReplying] = useState(false);
  // What the tags in the last reply did — shared, or waiting on the owner.
  const [mentionNote, setMentionNote] = useState<string | null>(null);
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

      {canComment && mentionNote && (
        <p className="mt-2 text-[11px] leading-snug text-ink-3">{mentionNote}</p>
      )}

      {canComment && (
        <div className="mt-2.5 flex items-center gap-1.5">
          {replying ? (
            <Composer
              placeholder="Reply"
              mentionCandidates={candidates}
              isArtifactOwner={isArtifactOwner}
              onCancel={() => setReplying(false)}
              onSubmit={async (body) => {
                const reply = await endpoints.replyToThread(thread.id, body);
                setMentionNote(mentionNoteFor(reply.mentions));
                setReplying(false);
                onChanged();
              }}
            />
          ) : (
            <>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  setMentionNote(null);
                  setReplying(true);
                }}
              >
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
  candidates,
  isArtifactOwner,
}: {
  artifactId: string;
  onChanged: () => void;
  candidates: MentionCandidate[];
  isArtifactOwner: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [mentionNote, setMentionNote] = useState<string | null>(null);

  if (!open) {
    return (
      <>
        {mentionNote && (
          <p className="mb-1.5 px-0.5 text-[11px] leading-snug text-ink-3">{mentionNote}</p>
        )}
        <button
          type="button"
          onClick={() => {
            setMentionNote(null);
            setOpen(true);
          }}
          className="w-full rounded-[--radius] border border-line bg-surface px-2.5 py-2 text-left text-[12.5px] text-ink-3 transition-colors hover:border-ink-3 hover:text-ink"
        >
          Comment on the whole document
        </button>
      </>
    );
  }

  return (
    <Composer
      placeholder="A note about the whole document"
      mentionCandidates={candidates}
      isArtifactOwner={isArtifactOwner}
      onCancel={() => setOpen(false)}
      onSubmit={async (body) => {
        const thread = await endpoints.startThread(artifactId, body);
        setMentionNote(mentionNoteFor(thread.mentions));
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
  /** Who may be named here. Leave out to turn mentions off entirely. */
  mentionCandidates = [],
  /** Decides what the "Tag somebody new" offer says it will do. */
  isArtifactOwner = false,
}: {
  placeholder: string;
  initialValue?: string;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  autoFocus?: boolean;
  mentionCandidates?: MentionCandidate[];
  isArtifactOwner?: boolean;
}) {
  const [value, setValue] = useState(initialValue);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const field = useRef<HTMLTextAreaElement>(null);

  const mentions = useMentionSuggestions(value, field, mentionCandidates);

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
    <div className="relative flex flex-col gap-1.5">
      {mentions.open && (
        <MentionList
          options={mentions.matches}
          activeIndex={mentions.activeIndex}
          isArtifactOwner={isArtifactOwner}
          onChoose={(option) => setValue(mentions.insert(option))}
        />
      )}

      <textarea
        ref={field}
        rows={3}
        value={value}
        placeholder={placeholder}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          // The suggestion list takes the arrow keys and Enter while it is open,
          // so choosing somebody never accidentally sends the comment.
          if (mentions.open && mentions.handleKey(event, (next) => setValue(next))) return;

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


// ---------------------------------------------------------------------------
// Naming somebody
// ---------------------------------------------------------------------------

/**
 * One row in the suggestion list: somebody who can already be named, or the
 * offer to tag a new address the document is not yet shared with. Two kinds
 * rather than a fake candidate, because choosing the second one means
 * something different and the row has to say so.
 */
export type MentionOption =
  | { kind: 'candidate'; candidate: MentionCandidate }
  | { kind: 'invite'; email: string };

const emailOf = (option: MentionOption) =>
  option.kind === 'candidate' ? option.candidate.email : option.email;

/**
 * What to tell the person after their comment went out. Tagging used to fail
 * silently, which is what made it feel broken, so both outcomes get a sentence.
 */
export function mentionNoteFor(outcome: MentionOutcome | undefined): string | null {
  if (!outcome) return null;
  if (outcome.shared.length > 0) {
    return `Shared with ${outcome.shared.join(', ')} and let them know.`;
  }
  if (outcome.awaitingAccess.length > 0) {
    return `The owner has been asked to add ${outcome.awaitingAccess.join(', ')}.`;
  }
  return null;
}

/**
 * Who may be named on this artifact.
 *
 * Asked once for the whole panel rather than per composer. The list is the
 * people it is shared with plus anybody who has commented, decided by the
 * server: the client cannot work it out, because seeing who an artifact is
 * shared with is itself something only the owner may do.
 */
export function useMentionCandidates(artifactId: string, enabled: boolean): MentionCandidate[] {
  const [candidates, setCandidates] = useState<MentionCandidate[]>([]);

  useEffect(() => {
    if (!enabled) return;
    endpoints
      .mentionCandidates(artifactId)
      .then((response) => setCandidates(response.candidates))
      .catch(() => setCandidates([]));
  }, [artifactId, enabled]);

  return candidates;
}

/**
 * The list that appears after an "@".
 *
 * What gets inserted is the person's email address, because that is the one
 * thing that cannot be ambiguous. Display names collide and local parts collide
 * across domains, and a mention that resolves to the wrong person is worse than
 * one that does not resolve at all. The reader sees a name; the text holds an
 * address.
 */
/** A whole address, so the "Tag …" offer never fires on half of one. */
const LOOKS_LIKE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function useMentionSuggestions(
  value: string,
  field: React.RefObject<HTMLTextAreaElement | null>,
  candidates: MentionCandidate[],
) {
  const [activeIndex, setActiveIndex] = useState(0);

  // The "@word" immediately before the cursor, if there is one. Anything with a
  // space in it is somebody typing prose, not choosing a person. An "@" inside
  // the word is allowed, so the list keeps up while a whole address is typed.
  const caret = field.current?.selectionStart ?? value.length;
  const before = value.slice(0, caret);
  const token = /(?:^|\s)@([^\s]*)$/.exec(before);
  const rawQuery = token?.[1] ?? null;
  const query = rawQuery?.toLowerCase() ?? null;

  const matches: MentionOption[] =
    query === null
      ? []
      : candidates
          .filter(
            (candidate) =>
              candidate.email.toLowerCase().includes(query) ||
              (candidate.displayName ?? '').toLowerCase().includes(query),
          )
          .slice(0, 6)
          .map((candidate) => ({ kind: 'candidate' as const, candidate }));

  // A whole address that matches nobody who can already be named is an offer
  // to bring them in, not a dead end.
  if (
    query !== null &&
    LOOKS_LIKE_EMAIL.test(query) &&
    !candidates.some((candidate) => candidate.email.toLowerCase() === query)
  ) {
    matches.push({ kind: 'invite', email: query });
  }

  const open = query !== null && matches.length > 0;

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  /**
   * Replaces the half-typed "@..." with the chosen address. Anchored on the
   * "@" that started the mention token — not the last "@" in the text, which
   * once a domain is typed would be the wrong one and corrupt the address.
   */
  function insert(option: MentionOption): string {
    const start = before.length - (rawQuery?.length ?? 0) - 1;
    return `${value.slice(0, start)}@${emailOf(option)} ${value.slice(caret)}`;
  }

  function handleKey(
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    apply: (next: string) => void,
  ): boolean {
    if (!open) return false;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActiveIndex((index) => (index + 1) % matches.length);
      return true;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActiveIndex((index) => (index - 1 + matches.length) % matches.length);
      return true;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      const chosen = matches[activeIndex];
      if (!chosen) return false;
      event.preventDefault();
      apply(insert(chosen));
      return true;
    }
    return false;
  }

  return { open, matches, activeIndex, insert, handleKey };
}

function MentionList({
  options,
  activeIndex,
  isArtifactOwner,
  onChoose,
}: {
  options: MentionOption[];
  activeIndex: number;
  isArtifactOwner: boolean;
  onChoose: (option: MentionOption) => void;
}) {
  return (
    <ul className="oa-pop absolute bottom-[calc(100%+4px)] left-0 z-20 w-full overflow-hidden rounded-[--radius] border border-line bg-surface shadow-[--shadow-pop]">
      {options.map((option, index) => (
        <li key={emailOf(option)}>
          <button
            type="button"
            // Mouse down rather than click: the textarea would lose focus on
            // blur first, and the caret position with it.
            onMouseDown={(event) => {
              event.preventDefault();
              onChoose(option);
            }}
            className={[
              'flex w-full items-center gap-2 px-2 py-1.5 text-left text-[12.5px] transition-colors',
              index === activeIndex ? 'bg-sunken text-ink' : 'text-ink-2 hover:bg-sunken',
            ].join(' ')}
          >
            {option.kind === 'candidate' ? (
              <>
                <Avatar email={option.candidate.email} size={16} />
                <span className="min-w-0 flex-1 truncate">
                  {option.candidate.displayName ?? option.candidate.email}
                </span>
                {option.candidate.displayName && (
                  <span className="shrink-0 truncate text-[11px] text-ink-3">
                    {option.candidate.email}
                  </span>
                )}
              </>
            ) : (
              <span className="min-w-0 flex-1">
                <span className="block truncate">Tag {option.email}</span>
                {/* Says what choosing this actually does, because the two
                    cases are different powers and silence here is how the
                    old version felt broken. */}
                <span className="block truncate text-[11px] text-ink-3">
                  {isArtifactOwner ? 'Shares this document with them' : 'Asks the owner to let them in'}
                </span>
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}
