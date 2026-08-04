/**
 * Editing a Markdown artifact in place.
 *
 * The owner turns on edit mode, clicks a block, and gets that block's Markdown
 * source in a textarea. The rest of the page stays rendered, so they keep their
 * place in the document while fixing one line of it.
 *
 * Edit mode is explicit, and it has to be. Selecting text is how a reader
 * creates a comment. If blocks were always click-to-edit, the two would fight
 * over the same gesture, so commenting is off while editing is on and nothing
 * about the page changes for anyone who is not the owner.
 *
 *   click a block
 *        |
 *        v
 *   source.slice(start, end)  ->  textarea
 *        |
 *        v
 *   splice back, PUT the whole document with baseVersion
 *        |
 *        v
 *   re-fetch the rendered HTML, because every later offset has moved
 *
 * The save goes through the same endpoint a CLI publish uses. That is
 * deliberate: one write path means comment re-anchoring and version history
 * keep working here without knowing this screen exists.
 *
 * The editor refuses to open when the rendered page and the source disagree
 * about which version they came from. That case is not cosmetic. Stale offsets
 * put the wrong text in the textarea, and saving it replaces a paragraph the
 * reader never touched while sending a version the server accepts, so the
 * conflict check cannot catch it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { endpoints } from '../api.js';
import {
  editableBlockAt,
  spliceBlock,
  sourceMatchesRender,
  saveFailureMessage,
} from './block-edit.js';
import type { BlockRange } from './block-edit.js';

/** The block currently open for editing. */
interface OpenBlock {
  element: HTMLElement;
  range: BlockRange;
  /** Where the textarea is drawn, inserted after the block and removed with it. */
  host: HTMLElement;
  /** The source as it was when opened, for telling clean from dirty. */
  original: string;
}

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready'; source: string; version: number }
  | { kind: 'failed'; message: string };

export function BlockEditor({
  artifactId,
  article,
  mode,
  renderedVersion,
  onReload,
  onLeave,
}: {
  artifactId: string;
  article: HTMLElement | null;
  /**
   * 'blocks' edits one block at a time on the rendered page. 'source' edits the
   * whole document at once, which is the only way to reach anything no block
   * covers: footnote bodies, link reference definitions, raw HTML the renderer
   * drops, and a document that is empty and so has nothing to click at all.
   */
  mode: 'blocks' | 'source';
  /** The version the HTML on screen was rendered from, per X-Artifact-Version. */
  renderedVersion: number | null;
  /** Ask the page for fresh HTML, because every offset after an edit has moved. */
  onReload: () => void;
  /** Leave edit mode. */
  onLeave: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [open, setOpen] = useState<OpenBlock | null>(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);

  // Keep the newest values reachable from the DOM listeners below without
  // rebinding them on every keystroke.
  const state = useRef({ phase, open, draft, saving, mode });
  state.current = { phase, open, draft, saving, mode };

  /** Closing tidies up the node we added, so the article is left as we found it. */
  const closeBlock = useCallback((block: OpenBlock | null) => {
    if (!block) return;
    block.element.style.display = '';
    block.host.remove();
  }, []);

  const dismiss = useCallback(
    (force = false) => {
      const block = state.current.open;
      if (!block) return true;
      const dirty = state.current.draft !== block.original;
      if (dirty && !force && !window.confirm('Discard your changes to this block?')) return false;
      closeBlock(block);
      setOpen(null);
      setProblem(null);
      return true;
    },
    [closeBlock],
  );

  // --- Load the source once, and refuse to edit against a stale page ---------
  useEffect(() => {
    let cancelled = false;
    setPhase({ kind: 'loading' });

    endpoints
      .artifactSource(artifactId)
      .then((detail) => {
        if (cancelled) return;
        if (!sourceMatchesRender(renderedVersion, detail.version)) {
          // The page and the source are from different versions, so every offset
          // on screen is untrustworthy. Get fresh HTML rather than edit blind.
          onReload();
          return;
        }
        setPhase({ kind: 'ready', source: detail.content, version: detail.version });
      })
      .catch(() => {
        if (!cancelled) {
          setPhase({ kind: 'failed', message: 'Could not load this document to edit it.' });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [artifactId, renderedVersion, onReload]);

  // Leaving block mode with a block open would strand the textarea on a page
  // that is about to be hidden, so close it first, then load the whole document
  // into the box.
  useEffect(() => {
    if (mode !== 'source') return;
    const block = state.current.open;
    if (block) {
      closeBlock(block);
      setOpen(null);
    }
    if (phase.kind === 'ready') {
      setDraft(phase.source);
      setProblem(null);
    }
  }, [mode, phase, closeBlock]);

  // --- Clicking a block opens it --------------------------------------------
  useEffect(() => {
    if (!article || mode !== 'blocks') return;
    const current = state.current.phase;
    if (current.kind !== 'ready') return;
    const { source } = current;

    function onClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !article) return;
      // Clicks inside the open editor belong to the editor.
      if (state.current.open?.host.contains(target)) return;

      const found = editableBlockAt(article, target, source.length);
      // A block with no offsets, or the page margin. Leave the open one alone:
      // clicking outside neither saves nor discards.
      if (!found) return;

      const element = found.element as unknown as HTMLElement;
      if (state.current.open?.element === element) return;
      if (!dismiss()) return;

      const host = document.createElement('div');
      host.dataset.oaBlockEditor = 'true';
      element.after(host);
      element.style.display = 'none';

      const original = source.slice(found.range.start, found.range.end);
      setOpen({ element, range: found.range, host, original });
      setDraft(original);
      setProblem(null);
    }

    article.addEventListener('click', onClick);
    return () => article.removeEventListener('click', onClick);
  }, [article, phase, mode, dismiss]);

  // --- Save -----------------------------------------------------------------
  const save = useCallback(async () => {
    const current = state.current;
    const block = current.open;
    const editingWholeSource = current.mode === 'source';
    if (current.phase.kind !== 'ready' || current.saving) return;
    if (!editingWholeSource && !block) return;

    setSaving(true);
    setProblem(null);
    try {
      // Whole-source mode has already produced the finished document; block mode
      // has produced one block that has to go back where it came from. Both go
      // through the same endpoint, so nothing downstream can tell them apart.
      const next =
        editingWholeSource || !block
          ? current.draft
          : spliceBlock(current.phase.source, block.range, current.draft);
      await endpoints.updateArtifact(artifactId, next, current.phase.version);
      closeBlock(block);
      setOpen(null);
      // Every offset after this block has moved, so the page has to be redrawn
      // before another block can be trusted. Edit mode stays on.
      onReload();
    } catch (error) {
      // Whatever went wrong, the typed text stays in the box. Losing what
      // somebody just wrote is the one failure this feature must not have.
      setProblem(saveFailureMessage(error));
    } finally {
      setSaving(false);
    }
  }, [artifactId, closeBlock, onReload]);

  // --- Keys -----------------------------------------------------------------
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        // Escape closes the open block, or leaves edit mode when none is open.
        if (state.current.open) dismiss();
        else onLeave();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
        // There is something to save if a block is open, or if the whole
        // document is in the box.
        if (!state.current.open && state.current.mode !== 'source') return;
        event.preventDefault();
        void save();
      }
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dismiss, save, onLeave]);

  // Put the cursor where the reader is looking, rather than making them click
  // a second time to start typing.
  useEffect(() => {
    if (open || mode === 'source') textarea.current?.focus();
  }, [open, mode]);

  // Take the block styling off the article while editing, and put it back on
  // the way out, so a half-finished edit never leaves the page altered.
  useEffect(() => {
    if (!article) return;
    article.dataset.oaEditing = 'true';
    return () => {
      delete article.dataset.oaEditing;
      const block = state.current.open;
      if (block) {
        block.element.style.display = '';
        block.host.remove();
      }
    };
  }, [article]);

  if (phase.kind === 'failed') {
    return <Notice tone="bad">{phase.message}</Notice>;
  }

  if (phase.kind === 'loading') {
    return <Notice tone="quiet">Loading the source…</Notice>;
  }

  if (mode === 'source') {
    return (
      <div className="rounded-md border border-accent/40 bg-surface p-2">
        <textarea
          ref={textarea}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          rows={Math.max(12, draft.split('\n').length + 1)}
          className="w-full resize-y bg-transparent font-mono text-sm text-ink outline-none"
          aria-label="Markdown source for the whole document"
        />
        {problem ? (
          <p role="alert" className="px-1 pb-2 text-sm text-danger">
            {problem}
          </p>
        ) : null}
        <div className="flex items-center gap-2 px-1">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || draft === phase.source}
            className="rounded bg-accent px-3 py-1 text-sm text-on-accent disabled:opacity-60"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <span className="ml-auto text-xs text-ink-muted">
            Editing the whole document · Cmd+S saves
          </span>
        </div>
      </div>
    );
  }

  if (!open) {
    return <Notice tone="quiet">Click a block to edit it. Esc leaves editing.</Notice>;
  }

  return createPortal(
    <div className="my-2 rounded-md border border-accent/40 bg-surface p-2">
      <textarea
        ref={textarea}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        spellCheck={false}
        rows={Math.max(3, draft.split('\n').length + 1)}
        className="w-full resize-y bg-transparent font-mono text-sm text-ink outline-none"
        aria-label="Markdown source for this block"
      />
      {problem ? (
        <p role="alert" className="px-1 pb-2 text-sm text-danger">
          {problem}
        </p>
      ) : null}
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded bg-accent px-3 py-1 text-sm text-on-accent disabled:opacity-60"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button
          type="button"
          onClick={() => dismiss()}
          className="rounded px-3 py-1 text-sm text-ink-muted"
        >
          Cancel
        </button>
        <span className="ml-auto text-xs text-ink-muted">Esc cancels · Cmd+S saves</span>
      </div>
    </div>,
    open.host,
  );
}

function Notice({ tone, children }: { tone: 'quiet' | 'bad'; children: React.ReactNode }) {
  return (
    <p className={`text-sm ${tone === 'bad' ? 'text-danger' : 'text-ink-muted'}`}>{children}</p>
  );
}
