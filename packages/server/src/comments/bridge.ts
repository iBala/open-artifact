/**
 * The script that lets somebody comment on part of an HTML artifact.
 *
 * An HTML artifact is the publisher's own document, so it runs in an iframe with
 * `sandbox="allow-scripts"` at an opaque origin. That is the security model of
 * the product and none of it changes here. It does mean the app cannot see what
 * a reader selected inside the frame, which is why HTML artifacts could only
 * take comments about the whole document.
 *
 * This is the smallest thing that fixes that. It is appended to the artifact
 * when the app asks for the framed copy, and it does two jobs:
 *
 *   it tells the app which element the reader selected
 *   it outlines an element the app asks it to
 *
 * ## What it deliberately does not do
 *
 * **It never sends text.** Only a handle: an id, or a path, and a tag name. The
 * app asks the server what that element says and shows the server's answer. This
 * is not about escaping — escaping stops script, and the risk here is not script.
 * A hostile page given a text channel into the app's own chrome can paint "your
 * session has expired, sign in again at…" in the app's own voice. So the channel
 * does not carry text.
 *
 * **It never changes the publisher's document.** Highlighting sets an outline
 * through the element's own inline style and puts back what was there before.
 * Wrapping the selection in a `<mark>`, which is what the Markdown side does,
 * would reparent nodes inside a page whose own script may hold references to
 * them or be watching them.
 *
 * **It does nothing outside a frame.** Somebody can paste the framed URL into a
 * tab. There is no parent there, and a script that would otherwise sit waiting
 * for messages from anybody simply returns.
 *
 * ## What the app must assume about it
 *
 * That it may be missing or lying. The artifact's own script can delete this,
 * replace `postMessage`, or send messages that look like these and are not. The
 * app treats everything from the frame as a claim about which element was
 * selected, checks the message came from the frame it created, and resolves the
 * claim against stored content before showing anybody anything.
 */

/**
 * How the two sides address each other. Namespaced because the publisher's page
 * may well be listening on `message` for its own reasons.
 */
export const BRIDGE_CHANNEL = 'open-artifact.bridge.v1';

/**
 * The bridge, as it is appended to an artifact.
 *
 * Written as a plain string rather than a built asset so that what is served is
 * exactly what is read here, with no build step in between to reason about.
 */
export const BRIDGE_SCRIPT = `<script>
(function () {
  'use strict';

  var CHANNEL = ${JSON.stringify(BRIDGE_CHANNEL)};

  // Pasted into a tab rather than framed by the app. Nothing to talk to.
  if (window.parent === window) return;

  // Blocks that are worth commenting on. A comment on a sentence should attach
  // to the paragraph holding it, not to the page: walking up to find the nearest
  // ancestor that happens to have an id would anchor most comments to <body>.
  var BLOCKS = {
    P: 1, LI: 1, TD: 1, TH: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    BLOCKQUOTE: 1, PRE: 1, FIGURE: 1, FIGCAPTION: 1, TABLE: 1, DL: 1, DT: 1, DD: 1,
    SECTION: 1, ARTICLE: 1, ASIDE: 1, HEADER: 1, FOOTER: 1, MAIN: 1, NAV: 1,
    DIV: 1, CANVAS: 1, IMG: 1, SVG: 1, VIDEO: 1, FORM: 1, UL: 1, OL: 1
  };

  function send(message) {
    // targetOrigin cannot be anything but '*' talking to an opaque origin, so
    // nothing goes this way that the frame does not already have.
    try { window.parent.postMessage(Object.assign({ channel: CHANNEL }, message), '*'); }
    catch (error) { /* the app is gone; nothing to do about it */ }
  }

  function blockFor(node) {
    var element = node && node.nodeType === 3 ? node.parentElement : node;
    while (element && element !== document.body) {
      if (BLOCKS[element.tagName] === 1) return element;
      element = element.parentElement;
    }
    return element || null;
  }

  /** Child indices among element siblings, from the document element down. */
  function pathOf(element) {
    var parts = [];
    var current = element;
    while (current && current.parentNode) {
      var siblings = current.parentNode.children;
      var index = 0;
      for (var i = 0; i < siblings.length; i += 1) {
        if (siblings[i] === current) { index = i; break; }
      }
      parts.unshift(index);
      if (current.parentNode.nodeType === 9) break;
      current = current.parentNode;
    }
    return parts.join('/');
  }

  function describe(element) {
    if (!element || !element.tagName) return null;
    var id = element.getAttribute ? element.getAttribute('id') : null;
    return {
      elementId: id && id.length > 0 && id.length <= 200 ? id : null,
      path: pathOf(element),
      tag: element.tagName.toLowerCase()
    };
  }

  document.addEventListener('mouseup', function () {
    // Let the browser settle the selection before reading it.
    setTimeout(function () {
      var selection = window.getSelection();
      if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        send({ type: 'selection-cleared' });
        return;
      }

      var range = selection.getRangeAt(0);
      // A selection crossing two blocks anchors to what contains both.
      var target = range.commonAncestorContainer;
      var handle = describe(blockFor(target));
      if (handle) send({ type: 'selection', target: handle });
    }, 0);
  });

  var outlined = null;
  var previousOutline = '';

  function clearOutline() {
    if (outlined) { outlined.style.outline = previousOutline; }
    outlined = null;
    previousOutline = '';
  }

  function find(handle) {
    if (handle.elementId) {
      var byId = document.getElementById(handle.elementId);
      if (byId) return byId;
    }
    if (typeof handle.path !== 'string' || handle.path.length === 0) return null;

    var parts = handle.path.split('/');
    var node = document;
    for (var i = 0; i < parts.length; i += 1) {
      var index = Number(parts[i]);
      if (!node || !node.children || !(index >= 0)) return null;
      node = node.children[index];
    }
    return node || null;
  }

  window.addEventListener('message', function (event) {
    // Only the window that framed this document.
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.type === 'highlight') {
      clearOutline();
      if (!data.target) return;
      var element = find(data.target);
      if (!element || !element.style) return;
      previousOutline = element.style.outline;
      outlined = element;
      // The element's own inline style, restored on clear. Never a wrapper
      // element: this document belongs to somebody else.
      element.style.outline = '2px solid rgba(91, 95, 214, 0.9)';
      if (data.scroll && element.scrollIntoView) {
        element.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
      return;
    }

    if (data.type === 'clear-highlight') clearOutline();
  });

  // The app queues anything it wants to say until this arrives, so an emailed
  // link to a thread does not race the load.
  send({ type: 'ready' });
})();
</script>`;
