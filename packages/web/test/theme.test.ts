/**
 * The theme rules, and the one thing about them that is duplicated.
 *
 * The rules themselves are small enough to read, so the tests worth having are
 * the ones covering what is easy to get wrong: a stored value that is not one of
 * the three, storage that throws, and — the real risk — the copy of this logic
 * sitting inline in index.html drifting away from the copy here. That snippet
 * cannot import anything, so the only thing keeping the two honest is a test
 * that reads the file.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  THEME_STORAGE_KEY,
  isThemePreference,
  readPreference,
  resolveTheme,
  writePreference,
  type PreferenceStore,
  type ThemePreference,
} from '../src/theme.jsx';

/** A stand-in for localStorage that can also be made to fail. */
function fakeStore(initial: Record<string, string> = {}, throws = false): PreferenceStore {
  return {
    getItem(key) {
      if (throws) throw new Error('storage is unavailable');
      return initial[key] ?? null;
    },
    setItem(key, value) {
      if (throws) throw new Error('storage is unavailable');
      initial[key] = value;
    },
  };
}

describe('resolveTheme', () => {
  it('follows the system only when asked to', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('ignores the system when the person chose for themselves', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
  });
});

describe('readPreference', () => {
  it('returns what was stored', () => {
    for (const preference of ['system', 'light', 'dark'] as ThemePreference[]) {
      expect(readPreference(fakeStore({ [THEME_STORAGE_KEY]: preference }))).toBe(preference);
    }
  });

  it('follows the system when nothing was stored', () => {
    expect(readPreference(fakeStore())).toBe('system');
  });

  it('follows the system rather than trusting an unrecognised value', () => {
    // A value from an older build, another tab, or somebody editing storage by
    // hand must never be able to strand anyone on a theme.
    expect(readPreference(fakeStore({ [THEME_STORAGE_KEY]: 'midnight' }))).toBe('system');
    expect(readPreference(fakeStore({ [THEME_STORAGE_KEY]: '' }))).toBe('system');
  });

  it('survives storage that refuses to be read', () => {
    expect(readPreference(fakeStore({}, true))).toBe('system');
    expect(readPreference(null)).toBe('system');
  });
});

describe('writePreference', () => {
  it('stores the choice under the shared key', () => {
    const stored: Record<string, string> = {};
    writePreference(fakeStore(stored), 'dark');
    expect(stored[THEME_STORAGE_KEY]).toBe('dark');
  });

  it('does not throw when storage refuses to be written', () => {
    expect(() => writePreference(fakeStore({}, true), 'dark')).not.toThrow();
    expect(() => writePreference(null, 'dark')).not.toThrow();
  });
});

describe('isThemePreference', () => {
  it('accepts exactly the three', () => {
    expect(['system', 'light', 'dark'].every(isThemePreference)).toBe(true);
    expect(isThemePreference('auto')).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

describe('the copy of these rules inline in index.html', () => {
  const html = readFileSync(fileURLToPath(new URL('../index.html', import.meta.url)), 'utf8');

  it('reads the same storage key this module writes', () => {
    expect(html).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });

  it('writes the same attribute the stylesheet reads', () => {
    expect(html).toContain('document.documentElement.dataset.theme');
    const styles = readFileSync(fileURLToPath(new URL('../src/styles.css', import.meta.url)), 'utf8');
    expect(styles).toContain("[data-theme='dark']");
  });

  it('treats an unrecognised stored value as "follow the system", as readPreference does', () => {
    // The snippet checks for the two explicit values and falls through to the
    // media query for everything else, which is the same rule stated the other
    // way round. Anything narrower here would flash the wrong theme.
    expect(html).toContain("stored === 'light' || stored === 'dark'");
    expect(html).toContain("matchMedia('(prefers-color-scheme: dark)')");
  });
});
