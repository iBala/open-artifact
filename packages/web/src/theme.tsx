/**
 * Light or dark, and who decides.
 *
 * There are two separate things here and confusing them is what makes theme
 * switching feel broken:
 *
 * - The *preference* is what the person asked for: follow the system, always
 *   light, or always dark. It is what gets remembered.
 * - The *theme* is what is actually on screen right now: light or dark. It is
 *   derived, never stored.
 *
 * The resolved theme is written to `data-theme` on the html element and the
 * stylesheet keys off nothing else. One attribute, one source of truth. An
 * inline script in index.html writes the same attribute before the first paint,
 * so a person who chose dark never sees a white page flash first — which is the
 * whole reason that duplicated snippet exists. If you change the storage key or
 * the attribute here, change it there too.
 *
 * Following the system is the default, and it stays live: somebody on a Mac that
 * turns dark at sunset gets dark at sunset without touching this app. That only
 * works while the preference is "system"; an explicit choice stops listening,
 * because they already told us the answer.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
} from 'react';

/** What the person asked for. */
export type ThemePreference = 'system' | 'light' | 'dark';

/** What is actually on screen. */
export type Theme = 'light' | 'dark';

/** Shared with the inline script in index.html. Keep the two in step. */
export const THEME_STORAGE_KEY = 'oa.theme';

const DARK_QUERY = '(prefers-color-scheme: dark)';

export interface ThemeApi {
  /** What the person asked for: system, light or dark. */
  preference: ThemePreference;
  /** What that works out to right now. */
  theme: Theme;
  setPreference: (preference: ThemePreference) => void;
}

// ---------------------------------------------------------------------------
// The rules, with nothing attached
// ---------------------------------------------------------------------------

/**
 * Anything that can hold a string by key. Narrower than Storage on purpose, so
 * the rules below can be exercised without a browser.
 */
export interface PreferenceStore {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
}

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || value === 'light' || value === 'dark';
}

/**
 * What is on screen, given what was asked for and what the system says.
 * "system" is the only case that consults the machine.
 */
export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): Theme {
  if (preference === 'light') return 'light';
  if (preference === 'dark') return 'dark';
  return systemPrefersDark ? 'dark' : 'light';
}

/**
 * The stored preference, or "system" when there is nothing usable there.
 * A value written by an older or newer version is treated as absent rather than
 * trusted, so a stray string can never leave somebody stuck on a theme.
 */
export function readPreference(store: PreferenceStore | null): ThemePreference {
  if (!store) return 'system';
  try {
    const stored = store.getItem(THEME_STORAGE_KEY);
    return isThemePreference(stored) ? stored : 'system';
  } catch {
    // Private browsing can refuse this. Following the system is a fine answer.
    return 'system';
  }
}

export function writePreference(store: PreferenceStore | null, preference: ThemePreference): void {
  if (!store) return;
  try {
    store.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // Not remembering is a small loss; the choice still holds for this session.
  }
}

// ---------------------------------------------------------------------------
// The same rules, wired to the page
// ---------------------------------------------------------------------------

const ThemeContext = createContext<ThemeApi | null>(null);

export function useTheme(): ThemeApi {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error('useTheme was called outside a ThemeProvider');
  return theme;
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

function storage(): PreferenceStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() =>
    readPreference(storage()),
  );
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Only worth listening while the answer depends on it.
  useEffect(() => {
    if (preference !== 'system' || typeof window === 'undefined') return;

    const query = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);

    // Read once on the way in: the system may have flipped while an explicit
    // preference was in force and nothing was listening.
    setSystemDark(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [preference]);

  const theme = resolveTheme(preference, systemDark);

  // The attribute the stylesheet reads. Set on the html element rather than a
  // wrapper so it also reaches things outside the React tree — the page
  // background, native scrollbars, form controls.
  //
  // Before paint, not after. A plain effect would let the browser draw the
  // control's indicator in its new position while the page was still the old
  // colour — one frame of the switch looking half-done, on the one interaction
  // whose entire job is changing the colour.
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    writePreference(storage(), next);
  }, []);

  return (
    <ThemeContext.Provider value={{ preference, theme, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}
