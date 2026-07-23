/**
 * One person's stars, shared across the whole signed-in app.
 *
 * A star is set in two places — the artifact's top bar and a sidebar row — and
 * has to look the same in both the instant it changes. So the set of starred ids
 * lives here, above both, rather than in either. Toggling updates the set at once
 * and tells the server after; if the server refuses, the change is rolled back.
 *
 * A fresh listing is the source of truth for ids the person has not just acted
 * on. `reconcile` brings the local set into line with what a listing said,
 * touching only the ids it was told about — so a star set on a document not in
 * the sidebar lists (a public one opened by link) is never dropped by a refresh
 * that never mentioned it.
 *
 * The one exception is an id the person has toggled this session: their own
 * click wins over a listing, because a listing fetched a moment before the click
 * still carries the old value and would otherwise flip the star back the instant
 * it resolves. Once toggled, an id is left to the local state until a reload.
 */

import { createContext, useCallback, useContext, useRef, useState } from 'react';
import { endpoints } from './api.js';

export interface StarsApi {
  isStarred: (id: string) => boolean;
  toggle: (id: string) => void;
  reconcile: (entries: { id: string; starred: boolean }[]) => void;
}

const StarsContext = createContext<StarsApi | null>(null);

export function useStars(): StarsApi {
  const stars = useContext(StarsContext);
  if (!stars) throw new Error('useStars was called outside a StarsProvider');
  return stars;
}

export function StarsProvider({ children }: { children: React.ReactNode }) {
  const [starred, setStarred] = useState<Set<string>>(() => new Set());

  // A live mirror of the state, so toggle can read the current value without
  // depending on it and going stale between renders.
  const latest = useRef(starred);
  latest.current = starred;

  // Ids the person has toggled this session. A listing is not allowed to
  // override these, because one fetched just before the click carries the old
  // value and would otherwise undo the click when it lands.
  const toggledHere = useRef<Set<string>>(new Set());

  const isStarred = useCallback((id: string) => starred.has(id), [starred]);

  const reconcile = useCallback((entries: { id: string; starred: boolean }[]) => {
    setStarred((current) => {
      const next = new Set(current);
      let changed = false;
      for (const { id, starred: on } of entries) {
        // The person's own click wins over a listing for the rest of the session.
        if (toggledHere.current.has(id)) continue;
        if (on && !next.has(id)) {
          next.add(id);
          changed = true;
        } else if (!on && next.has(id)) {
          next.delete(id);
          changed = true;
        }
      }
      // Return the same set when nothing moved, so this never forces a render.
      return changed ? next : current;
    });
  }, []);

  const toggle = useCallback((id: string) => {
    toggledHere.current.add(id);
    const willStar = !latest.current.has(id);

    setStarred((current) => {
      const next = new Set(current);
      if (willStar) next.add(id);
      else next.delete(id);
      return next;
    });

    const request = willStar ? endpoints.starArtifact(id) : endpoints.unstarArtifact(id);
    request.catch(() => {
      // The server refused; undo the optimistic change so the star reflects reality.
      setStarred((current) => {
        const reverted = new Set(current);
        if (willStar) reverted.delete(id);
        else reverted.add(id);
        return reverted;
      });
    });
  }, []);

  return (
    <StarsContext.Provider value={{ isStarred, toggle, reconcile }}>
      {children}
    </StarsContext.Provider>
  );
}
