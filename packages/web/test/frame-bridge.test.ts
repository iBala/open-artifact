import { describe, it, expect } from 'vitest';
import {
  readSelectionMessage,
  bridgeMessageType,
  isFromFrame,
  BRIDGE_CHANNEL,
} from '../src/components/frame-bridge.js';

/**
 * What the app accepts from an artifact's frame.
 *
 * The frame holds a page somebody else wrote. It may propose which element the
 * reader selected; it may never say what that element contains, and it may never
 * reach anything by being malformed in an interesting way. These tests are the
 * boundary.
 */

const valid = { elementId: 'pricing-note', path: '0/1/2', tag: 'p' };

describe('reading a selection a frame proposed', () => {
  it('accepts a well-formed handle', () => {
    expect(readSelectionMessage(valid)).toEqual(valid);
  });

  it('accepts a handle with no id, which anchors by path', () => {
    expect(readSelectionMessage({ elementId: null, path: '0/1', tag: 'div' })).toEqual({
      elementId: null,
      path: '0/1',
      tag: 'div',
    });
  });

  it('refuses anything that is not an object', () => {
    expect(readSelectionMessage(null)).toBeNull();
    expect(readSelectionMessage('0/1')).toBeNull();
    expect(readSelectionMessage(42)).toBeNull();
    expect(readSelectionMessage([valid])).toBeNull();
  });

  it('refuses a path that is not a path', () => {
    expect(readSelectionMessage({ ...valid, path: '../../etc' })).toBeNull();
    expect(readSelectionMessage({ ...valid, path: '0/1;drop' })).toBeNull();
    expect(readSelectionMessage({ ...valid, path: '' })).toBeNull();
    expect(readSelectionMessage({ ...valid, path: 7 })).toBeNull();
  });

  it('refuses an id long enough to be a payload rather than an id', () => {
    expect(readSelectionMessage({ ...valid, elementId: 'x'.repeat(201) })).toBeNull();
  });

  it('refuses a tag that is not a tag', () => {
    expect(readSelectionMessage({ ...valid, tag: '<script>' })).toBeNull();
    expect(readSelectionMessage({ ...valid, tag: 'P' })).toBeNull();
    expect(readSelectionMessage({ ...valid, tag: '' })).toBeNull();
  });

  it('drops anything else the frame tried to attach', () => {
    // The point of the whole design: a frame cannot hand the app text to draw.
    const smuggled = {
      ...valid,
      snippet: 'Your session has expired. Sign in again at evil.example.',
      html: '<b>trust me</b>',
    };

    expect(readSelectionMessage(smuggled)).toEqual(valid);
    expect(Object.keys(readSelectionMessage(smuggled) ?? {})).toEqual(['elementId', 'path', 'tag']);
  });
});

describe('recognising a message as ours', () => {
  it('reads the type from a message on our channel', () => {
    expect(bridgeMessageType({ channel: BRIDGE_CHANNEL, type: 'ready' })).toBe('ready');
  });

  it('ignores a message on another channel', () => {
    // The publisher's own page may well be using postMessage for its own
    // reasons, and so may anything else on the page.
    expect(bridgeMessageType({ channel: 'something-else', type: 'ready' })).toBeNull();
    expect(bridgeMessageType({ type: 'ready' })).toBeNull();
  });

  it('ignores a message with no readable type', () => {
    expect(bridgeMessageType({ channel: BRIDGE_CHANNEL })).toBeNull();
    expect(bridgeMessageType({ channel: BRIDGE_CHANNEL, type: 12 })).toBeNull();
  });
});

describe('deciding a message came from our frame', () => {
  const frameWindow = { name: 'the frame' } as unknown as Window;
  const frame = { contentWindow: frameWindow } as unknown as HTMLIFrameElement;

  it('accepts the window we framed', () => {
    expect(isFromFrame({ source: frameWindow } as MessageEvent, frame)).toBe(true);
  });

  it('refuses any other window', () => {
    const other = { name: 'somewhere else' } as unknown as Window;

    expect(isFromFrame({ source: other } as MessageEvent, frame)).toBe(false);
  });

  it('refuses when there is no frame yet', () => {
    expect(isFromFrame({ source: frameWindow } as MessageEvent, null)).toBe(false);
    expect(
      isFromFrame({ source: null } as unknown as MessageEvent, {
        contentWindow: null,
      } as HTMLIFrameElement),
    ).toBe(false);
  });
});
