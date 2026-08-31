/**
 * One block of the document, edited as rich text.
 *
 * The box that opens when an owner clicks a paragraph. Bold looks bold, a
 * heading looks like a heading, selecting text raises a small toolbar, and
 * typing `/` offers the block types somebody would otherwise have to know the
 * Markdown for. Nobody has to remember that a table is made of pipes.
 *
 * What it is NOT is a second source of truth. Markdown goes in, Markdown comes
 * out, and the string it produces is spliced back into exactly the range the
 * block was read from:
 *
 *     source.slice(start, end)  ->  Crepe  ->  getMarkdown()  ->  spliced back
 *
 * Only the clicked block makes that trip. Everything else in the document is
 * untouched text, byte for byte, which is what keeps re-serialising from
 * rewriting a file somebody published from the CLI.
 *
 * The block still has to survive the trip, and not every block would. Blocks
 * holding constructs the editor cannot model are kept away from here entirely
 * by `richTextSafe`, which the caller checks first; see block-edit.ts for what
 * is refused and why.
 */

import { useEffect, useRef, useState } from 'react';
import { Crepe } from '@milkdown/crepe';
// Imported here rather than from styles.css so it rides in this module's
// chunk, and a reader who never edits never downloads it. The colour
// mapping onto our own tokens stays in styles.css, where it is three lines
// of variables and costs nothing.
import '@milkdown/crepe/theme/common/style.css';

/** How long the editor is given to start before we give up and say so. */
const READY_TIMEOUT_MS = 8000;

export function RichBlock({
  /**
   * The block's Markdown, read once.
   *
   * Deliberately not kept in sync afterwards. The editor owns the text from the
   * moment it starts, and pushing a prop back into it mid-edit would fight the
   * cursor on every keystroke.
   */
  initial,
  onReady,
  onChange,
  onFallback,
}: {
  initial: string;
  /**
   * The editor's own reading of the block, handed over the moment it starts.
   *
   * This is what "unchanged" means from then on, and it is not the same string
   * as `initial`: the editor re-serialises what it parsed, so `* one` comes
   * back `- one` with nothing edited.
   *
   * It has to be taken here rather than from the first change reported, because
   * the first change reported is the person's first keystroke. Treating that as
   * the baseline made every block look permanently untouched — no Save button
   * ever appeared, and leaving never asked.
   */
  onReady: (baseline: string) => void;
  onChange: (markdown: string) => void;
  /**
   * Called when the editor cannot be used after all, so the caller can put the
   * raw textarea up instead. Failing to start must never leave somebody staring
   * at an empty box with their paragraph hidden behind it.
   */
  onFallback: (reason: string) => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);

  /*
   * The newest callbacks, reachable from a listener bound once at create time.
   *
   * The editor is created in an effect that must not re-run: re-running it
   * destroys and rebuilds the editor, which loses the cursor and the undo
   * history mid-sentence. So the effect depends on nothing that changes, and
   * reads the callbacks through a ref instead of closing over them.
   */
  const handlers = useRef({ onReady, onChange, onFallback });
  handlers.current = { onReady, onChange, onFallback };

  useEffect(() => {
    const root = host.current;
    if (!root) return;

    /*
     * Whether this effect still owns the editor.
     *
     * create() is async, and in development React mounts, unmounts and remounts
     * every component to surface exactly this bug. Without the flag the first
     * mount's editor finishes starting after its own cleanup has run, and
     * attaches a second copy of the editor to a host the second mount is
     * already using — two editors, one box, every keystroke duplicated.
     */
    let owned = true;
    let started: Crepe | null = null;

    const crepe = new Crepe({
      root,
      defaultValue: initial,
      features: {
        // The Notion-shaped part: the slash menu, and the block handle.
        [Crepe.Feature.BlockEdit]: true,
        // The bubble toolbar over a selection: bold, italic, code, link.
        [Crepe.Feature.Toolbar]: true,
        [Crepe.Feature.LinkTooltip]: true,
        [Crepe.Feature.ListItem]: true,
        [Crepe.Feature.Table]: true,
        [Crepe.Feature.CodeMirror]: true,
        [Crepe.Feature.ImageBlock]: true,
        [Crepe.Feature.Cursor]: true,
        [Crepe.Feature.Placeholder]: true,
        /*
         * Off, and both for the same reason: they would let somebody write
         * something this product cannot render.
         *
         * The server renders Markdown through remark-gfm with no math plugin,
         * so `$$...$$` reaches the reader as literal dollar signs. Offering it
         * in the slash menu would be inviting an author to produce a document
         * that looks right while they write it and wrong once it is published.
         */
        [Crepe.Feature.Latex]: false,
        // This document already has a bar of its own, at the top of the page.
        [Crepe.Feature.TopBar]: false,
        [Crepe.Feature.AI]: false,
      },
      featureConfigs: {
        [Crepe.Feature.BlockEdit]: {
          /*
           * The slash menu, without the drag handle.
           *
           * Dragging is how you reorder blocks in Notion, and there is nothing
           * to reorder here: this editor holds the one block that was clicked.
           * A handle offering a rearrangement that cannot happen is a control
           * that lies, so it is turned off and the menu is kept.
           */
          blockHandle: { shouldShow: () => false },
          advancedGroup: {
            // Matches Latex being off above. The menu must not offer what the
            // published page cannot show.
            math: null,
          },
        },
      },
    });

    /*
     * Registered before create(), which is the part that matters.
     *
     * on() takes a different path once the editor exists, and registering after
     * create() had already been called landed the listener too late in the
     * start-up pipeline to ever be attached: every keystroke was typed into a
     * working editor that told nobody about it, so the draft never moved off
     * its baseline and the Save button never appeared.
     */
    crepe.on((api) => {
      api.markdownUpdated((_ctx, markdown) => {
        if (owned) handlers.current.onChange(markdown);
      });
    });

    const failed = (reason: string) => {
      if (!owned) return;
      owned = false;
      handlers.current.onFallback(reason);
    };

    // A start that never resolves would leave the block hidden behind a box
    // that never appears, so it is given a deadline like any other I/O.
    const deadline = window.setTimeout(
      () => failed('The rich editor took too long to start.'),
      READY_TIMEOUT_MS,
    );

    crepe
      .create()
      .then(() => {
        window.clearTimeout(deadline);
        if (!owned) {
          // Unmounted while starting. Tear down the editor nobody will see,
          // rather than leaving it attached to a detached node.
          void crepe.destroy();
          return;
        }
        started = crepe;
        setReady(true);
        handlers.current.onReady(crepe.getMarkdown());
        // Put the cursor where the owner is looking, the same as the raw box
        // does. Clicking a block is already the gesture that says "edit this";
        // asking for a second click to start typing is one too many.
        const editable = root.querySelector<HTMLElement>('.ProseMirror');
        editable?.focus();
      })
      .catch(() => {
        window.clearTimeout(deadline);
        // Tear down whatever got built before it gave up, so a failed start
        // does not leave plugins and listeners attached to a node we are about
        // to stop using.
        void crepe.destroy().catch(() => {});
        failed('The rich editor could not be opened.');
      });

    return () => {
      owned = false;
      window.clearTimeout(deadline);
      // Only destroy what actually started. Calling destroy() on an editor
      // still inside create() throws, and the throw happens during cleanup
      // where nothing is left to catch it.
      if (started) void started.destroy();
    };
    /*
     * Bound once, on purpose. See the note on `handlers` above.
     *
     * `initial` is read inside and deliberately not a dependency: the caller
     * gives this component a key derived from the block, so a different block
     * remounts it rather than re-running this effect with new text. Adding it
     * here would let a re-render tear down a live editor mid-sentence.
     */
  }, []);

  return (
    <div
      ref={host}
      className="oa-rich"
      // Hidden rather than absent while it starts. The node has to be in the
      // document for the editor to attach to it, and showing a half-built
      // editor for a frame is what makes the box appear to flicker.
      style={ready ? undefined : { visibility: 'hidden' }}
    />
  );
}

/** Default too, so the caller can lazy-load this module without a wrapper. */
export default RichBlock;
