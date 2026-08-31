/**
 * Editing a Markdown artifact in place.
 *
 * The owner turns on edit mode, clicks a block, and edits that block in place.
 * The rest of the page stays rendered, so they keep their place in the document
 * while fixing one line of it.
 *
 * Most blocks open in a rich editor: bold looks bold, a selection raises a
 * small toolbar, and `/` offers the block types nobody remembers the Markdown
 * for. It is a surface, not a second source of truth — Markdown goes in and
 * Markdown comes out, and only the clicked block ever makes that trip, so the
 * rest of the file is untouched text. Blocks holding something that editor
 * cannot represent get the raw Markdown box instead; see richTextSafe.
 *
 * Edit mode is explicit, and it has to be. Selecting text is how a reader
 * creates a comment. If blocks were always click-to-edit, the two would fight
 * over the same gesture, so commenting is off while editing is on and nothing
 * about the page changes for anyone who is not the owner.
 *
 *   click a block
 *        |
 *        v
 *   source.slice(start, end)  ->  rich editor, or raw box
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
 * put the wrong text in the box, and saving it replaces a paragraph the
 * reader never touched while sending a version the server accepts, so the
 * conflict check cannot catch it.
 */

import { useCallback, useEffect, useRef, useState, lazy, Suspense } from 'react';
import { createPortal } from 'react-dom';
import { endpoints } from '../api.js';
import { Button } from './primitives.js';
import {
  editableBlockAt,
  spliceBlock,
  sourceMatchesRender,
  saveFailureMessage,
  shouldSeedWholeSource,
  richTextSafe,
  blockDirty,
  linkDefinitionLabels,
} from './block-edit.js';
import type { BlockRange } from './block-edit.js';
/*
 * Loaded only when somebody opens a block.
 *
 * The editor and its ProseMirror stack are about a megabyte of JavaScript, and
 * almost nobody who opens an artifact will ever edit one: most readers here are
 * invited to read. Imported eagerly it went into the entry chunk and every
 * reader paid for it on first paint. Behind lazy() it is a separate chunk that
 * is fetched the first time an owner clicks a paragraph, which is the first
 * moment it can possibly be wanted.
 */
const RichBlock = lazy(() => import('./RichBlock.js'));

/**
 * The rich editor's own pop-ups, while one of them is showing.
 *
 * They mark themselves with data-show, which is how this tells an Escape meant
 * for a menu from an Escape meant for the block underneath it.
 */
const OPEN_RICH_OVERLAY = [
  '.milkdown-slash-menu[data-show="true"]',
  '.milkdown-toolbar[data-show="true"]',
  '.milkdown-link-edit[data-show="true"]',
  '.milkdown-link-preview[data-show="true"]',
].join(', ');

/** The block currently open for editing. */
interface OpenBlock {
  element: HTMLElement;
  range: BlockRange;
  /** Where the editor is drawn, inserted after the block and removed with it. */
  host: HTMLElement;
  /** The source as it was when opened, for telling clean from dirty. */
  original: string;
  /**
   * Whether this block gets the rich editor or the raw Markdown box.
   *
   * Decided once, when the block opens, and never revisited: a box that changed
   * kind underneath somebody mid-sentence would be worse than either kind.
   */
  rich: boolean;
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
  leaveGuard,
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
  /**
   * Filled with a check the bar can call before it turns editing off, so its
   * Done button cannot discard a typed document that Escape would have asked
   * about.
   */
  leaveGuard?: { current: (() => boolean) | null };
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [open, setOpen] = useState<OpenBlock | null>(null);
  /**
   * The two boxes hold two different things and keep them apart.
   *
   * One draft shared between them meant the whole-document box could show a
   * single block's text: open whole source, go back to blocks, edit a block,
   * return to whole source, and the box held the paragraph. Saving that replaced
   * the entire document with one paragraph. They are separate values now, so
   * neither mode can ever be showing the other's text.
   */
  const [blockDraft, setBlockDraft] = useState('');
  const [sourceDraft, setSourceDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  /**
   * Why the rich editor is not being used for the open block, if it is not.
   *
   * Null means it is. Set when the editor fails to start, which drops this
   * block back to the raw box rather than leaving the owner with nothing.
   */
  const [richProblem, setRichProblem] = useState<string | null>(null);
  /**
   * What the rich editor produced from the block before anybody touched it.
   *
   * Not the same string as `original`, and that is the whole reason this exists.
   * The editor re-serialises what it parsed, so a block written `* one` comes
   * back `- one` with nothing edited. Measured against `original` every rich
   * block would look dirty the instant it opened: Save and Cancel would appear
   * on an untouched paragraph, and Escape would ask whether to discard changes
   * nobody made.
   *
   * So the editor's own first output is the baseline, and dirty means different
   * from that. Reset to null whenever a block opens, and filled by the first
   * change the editor reports.
   */
  const richBaseline = useRef<string | null>(null);
  /** Which document and version the whole-source box was filled from. */
  const seededFrom = useRef<{ artifactId: string; version: number } | null>(null);

  // Keep the newest values reachable from the DOM listeners below without
  // rebinding them on every keystroke.
  const state = useRef({ phase, open, blockDraft, sourceDraft, saving, mode });
  state.current = { phase, open, blockDraft, sourceDraft, saving, mode };

  /**
   * Whether anything typed here has not been saved.
   *
   * Deliberately blind to which mode is showing. Unsaved work does not stop
   * being unsaved because the box holding it is off screen: typing into the
   * whole document, switching to blocks, and leaving used to discard it without
   * a word, because the check only looked while whole-source was on screen.
   *
   * The whole-document box only counts once it has been filled from the server.
   * Before that it is an empty string that differs from the document, which is
   * not unsaved work, it is a box nobody has opened.
   */
  const hasUnsavedWork = useCallback(() => {
    const current = state.current;
    if (current.open && blockDirty(current.blockDraft, current.open.original, richBaseline.current))
      return true;

    if (current.phase.kind !== 'ready') return false;
    const seeded = seededFrom.current;
    const filled = seeded !== null && seeded.artifactId === artifactId && seeded.version === current.phase.version;
    return filled && current.sourceDraft !== current.phase.source;
  }, [artifactId]);

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
      const dirty = blockDirty(state.current.blockDraft, block.original, richBaseline.current);
      if (dirty && !force && !window.confirm('Discard your changes to this block?')) return false;
      closeBlock(block);
      setOpen(null);
      setProblem(null);
      return true;
    },
    [closeBlock],
  );

  /**
   * The one question asked on every way out of editing.
   *
   * There are three ways out — Escape, the bar's Done, and switching documents —
   * and each of them used to have its own idea of what counted as unsaved. Only
   * the block path asked. Everything routes through here now, so nothing can
   * lose what somebody just wrote without them saying so.
   */
  const mayLeave = useCallback(
    () => !hasUnsavedWork() || window.confirm('Discard your unsaved changes?'),
    [hasUnsavedWork],
  );

  const leave = useCallback(() => {
    if (!mayLeave()) return;
    // Answered yes, so put the page back the way it was before letting go.
    closeBlock(state.current.open);
    setOpen(null);
    onLeave();
  }, [mayLeave, closeBlock, onLeave]);

  /*
   * The bar's Done button is outside this component and would otherwise drop a
   * typed document without asking, so it borrows the same check. One rule, every
   * way out.
   */
  useEffect(() => {
    if (!leaveGuard) return;
    leaveGuard.current = mayLeave;
    return () => {
      leaveGuard.current = null;
    };
  }, [leaveGuard, mayLeave]);

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
  // that is about to be hidden, so close it first.
  useEffect(() => {
    if (mode !== 'source') return;
    const block = state.current.open;
    if (block) {
      closeBlock(block);
      setOpen(null);
    }
  }, [mode, closeBlock]);

  /*
   * Filling the whole-document box, during render rather than in an effect.
   *
   * This is derived state: the box starts as whatever the server last gave us.
   * An effect is the wrong tool for it. Effects run after paint and can run more
   * than once for the same inputs, which left the box empty the first time
   * whole-source editing was opened and correct only on the second.
   *
   * Setting state while rendering is the supported way to derive from props.
   * React discards this render and immediately redoes it, before anything is
   * painted, so the box is never seen empty.
   *
   * Once per version, and never again while that version is on screen: the page
   * refetches the source for all sorts of unrelated reasons, and refilling the
   * box on any of them would discard whatever had been typed into it.
   */
  const seeded = seededFrom.current;
  const seededVersion =
    seeded !== null && seeded.artifactId === artifactId ? seeded.version : null;
  if (phase.kind === 'ready' && shouldSeedWholeSource(mode, phase.version, seededVersion)) {
    // Keyed by document as well as version, because two different artifacts are
    // both at version 1 on the day they are published, and a bare version number
    // cannot tell them apart.
    seededFrom.current = { artifactId, version: phase.version };
    setSourceDraft(phase.source);
    setProblem(null);
  }

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

      // A paragraph can contain a link, and following it would carry the owner
      // off the page instead of opening the block they meant to edit. While edit
      // mode is on, a click on a block belongs to editing.
      event.preventDefault();

      const element = found.element as unknown as HTMLElement;
      if (state.current.open?.element === element) return;
      if (!dismiss()) return;

      const host = document.createElement('div');
      host.dataset.oaBlockEditor = 'true';
      element.after(host);
      element.style.display = 'none';

      const original = source.slice(found.range.start, found.range.end);
      /*
       * A block whose Markdown holds something the rich editor cannot model
       * gets the raw box, so nothing is lost on the way back out.
       *
       * The whole document's link definitions go in with it. A block using
       * `[the spec][spec]` is only unsafe because the definition it points at
       * lives elsewhere, which is not a thing the block can be asked on its own.
       */
      setOpen({
        element,
        range: found.range,
        host,
        original,
        rich: richTextSafe(original, linkDefinitionLabels(source)),
      });
      setBlockDraft(original);
      setProblem(null);
      // A new block, so the previous block's editor output must not be carried
      // over as this one's baseline.
      richBaseline.current = null;
      setRichProblem(null);
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

    /*
     * Nothing changed, so nothing is written.
     *
     * The Save button already hides itself when the block is clean, but ⌘S does
     * not go through the button, and with the rich editor a clean block is no
     * longer the same string as the source it came from. A reflexive ⌘S on an
     * untouched block would splice the editor's re-serialisation over the
     * author's own text — `* one` becoming `- one`, a setext heading becoming
     * ATX, an indented code block becoming fenced — and publish a new version
     * with nothing visibly different about it.
     */
    if (
      !editingWholeSource &&
      block &&
      !blockDirty(current.blockDraft, block.original, richBaseline.current)
    ) {
      return;
    }

    setSaving(true);
    setProblem(null);
    try {
      // Whole-source mode has already produced the finished document; block mode
      // has produced one block that has to go back where it came from. Both go
      // through the same endpoint, so nothing downstream can tell them apart.
      const next =
        editingWholeSource || !block
          ? current.sourceDraft
          : spliceBlock(current.phase.source, block.range, current.blockDraft);
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
      // Sharing and deleting are still offered while editing, and both open a
      // dialog. Escape in one of those belongs to the dialog; taking it here as
      // well would close the dialog and drop edit mode in the same keypress.
      if (document.querySelector('[role="dialog"]')) return;

      if (event.key === 'Escape') {
        /*
         * An Escape aimed at one of the rich editor's own overlays belongs to
         * it, not to us. Its slash menu and toolbar close themselves and let the
         * key carry on bubbling, so taking it here as well meant one press
         * closed the menu AND threw away the block behind it.
         *
         * Asked by what is on screen rather than by event.defaultPrevented,
         * which the editor sets on Escape whether or not anything was open —
         * reading that instead left Escape unable to close a block at all.
         */
        if (document.querySelector(OPEN_RICH_OVERLAY)) return;
        event.preventDefault();
        // Escape closes the open block, or leaves edit mode when none is open.
        if (state.current.open) dismiss();
        else leave();
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

    /*
     * Captured on the way down, not caught on the way up.
     *
     * The rich editor closes its own slash menu on Escape and marks it hidden
     * before the event finishes bubbling, so by the time a normal listener ran,
     * the menu it was supposed to defer to was already gone and one press both
     * closed the menu and discarded the block. Capturing means this sees the
     * page as it was when the key was pressed.
     */
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [dismiss, save, leave]);

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
    return (
      <p role="alert" className="mx-auto w-full max-w-[720px] px-6 pt-4 text-[13px] text-danger">
        {phase.message}
      </p>
    );
  }

  // Nothing while the source loads. It takes a moment and the document is
  // already on screen; a spinner here would be the page flinching for no reason.
  if (phase.kind === 'loading') return null;

  if (mode === 'source') {
    return (
      <div className="oa-edit-enter mx-auto w-full max-w-[720px] px-6 py-10">
        <textarea
          ref={textarea}
          value={sourceDraft}
          onChange={(event) => setSourceDraft(event.target.value)}
          spellCheck={false}
          rows={Math.max(16, sourceDraft.split('\n').length + 1)}
          className="oa-source w-full resize-y rounded-[--radius] bg-sunken px-4 py-3 outline-none"
          aria-label="Markdown source for the whole document"
        />
        {/*
          Stuck to the bottom of the viewport rather than sitting under the box.
          The box grows to the length of the document, so on anything longer than
          a screen the Save button used to be somewhere below the fold along with
          the only mention of ⌘S: the two ways to keep your work were both
          off screen exactly when the document was big enough to care.
        */}
        <div className="sticky bottom-0 bg-canvas pb-2 pt-1">
          <Footer
            problem={problem}
            saving={saving}
            dirty={sourceDraft !== phase.source}
            onSave={() => void save()}
            onCancel={null}
            hint="⌘S saves"
          />
        </div>
      </div>
    );
  }

  if (!open) return null;

  const useRich = open.rich && richProblem === null;

  return createPortal(
    <div className="oa-edit-enter my-1">
      {useRich ? (
        /*
          No fallback element on purpose. The block's own rendered text is still
          on the page behind this while the chunk is fetched, so there is
          nothing missing to apologise for; a spinner here would replace a
          readable paragraph with a shrug.
        */
        <Suspense fallback={null}>
          <RichBlock
            // Keyed on the block, so clicking a different one builds a new
            // editor rather than reusing this one with someone else's text.
            key={`${open.range.start}-${open.range.end}`}
            initial={open.original}
            onReady={(baseline) => {
              // What the editor made of the block before anybody touched it.
              // Everything after this is measured against it.
              richBaseline.current = baseline;
              setBlockDraft(baseline);
            }}
            onChange={(markdown) => setBlockDraft(markdown)}
            onFallback={(reason) => {
              // Drop to the raw box with the block's Markdown intact. The owner
              // came here to fix a sentence and should still be able to.
              setBlockDraft(open.original);
              richBaseline.current = null;
              setRichProblem(reason);
            }}
          />
        </Suspense>
      ) : (
        <textarea
          ref={textarea}
          value={blockDraft}
          onChange={(event) => setBlockDraft(event.target.value)}
          spellCheck={false}
          rows={Math.max(2, blockDraft.split('\n').length)}
          className="oa-source w-full resize-y rounded-[--radius-sm] border-l-2 border-accent bg-sunken px-3 py-2 outline-none"
          aria-label="Markdown source for this block"
        />
      )}
      {richProblem && (
        <p className="mt-1 text-[12px] text-ink-3">{richProblem} Editing as Markdown instead.</p>
      )}
      <Footer
        problem={problem}
        saving={saving}
        dirty={blockDirty(blockDraft, open.original, richBaseline.current)}
        onSave={() => void save()}
        onCancel={() => dismiss()}
        hint={useRich ? '/ for blocks · ⌘S saves · esc cancels' : '⌘S saves · esc cancels'}
      />
    </div>,
    open.host,
  );
}

/**
 * What sits under an open box.
 *
 * Nothing at all until there is something to say. While the text is untouched
 * the only thing here is a quiet keyboard hint, because there is nothing to save
 * and Esc already closes it. Buttons appear when they mean something, which is
 * the moment the text has actually changed.
 */
function Footer({
  problem,
  saving,
  dirty,
  onSave,
  onCancel,
  hint,
}: {
  problem: string | null;
  saving: boolean;
  dirty: boolean;
  onSave: () => void;
  onCancel: (() => void) | null;
  hint: string;
}) {
  return (
    <>
      {problem ? (
        <p role="alert" className="mt-2 text-[13px] leading-snug text-danger">
          {problem}
        </p>
      ) : null}
      <div className="mt-1.5 flex h-7 items-center gap-2">
        {dirty || saving ? (
          <>
            <Button size="sm" onClick={onSave} busy={saving}>
              Save
            </Button>
            {onCancel && (
              <Button size="sm" tone="ghost" onClick={onCancel}>
                Cancel
              </Button>
            )}
          </>
        ) : null}
        <span className="ml-auto select-none text-[11px] tabular-nums text-ink-3">{hint}</span>
      </div>
    </>
  );
}
