/**
 * The app shell: work out who is signed in, then show them the right thing.
 *
 * Deciding that takes one request, and until it comes back nothing is drawn. A
 * sign-in screen that flashes up and vanishes for somebody who was already
 * signed in is worse than a beat of stillness.
 *
 * The sidebar's contents are loaded here rather than inside the sidebar, because
 * the dashboard shows the same two lists. Loading them once means opening an
 * artifact from the sidebar does not refetch what is already on screen.
 */

import { useEffect, useState, useCallback, createContext, useContext } from 'react';
import {
  endpoints,
  ApiError,
  type CurrentUser,
  type ArtifactSummary,
  type SharedArtifact,
} from './api.js';
import { Router, useRouter } from './router.jsx';
import { SignIn } from './pages/SignIn.jsx';
import { Artifact, PublicArtifact } from './pages/Artifact.jsx';
import { Home } from './pages/Home.jsx';
import { Sessions } from './pages/Sessions.jsx';
import { NotFound } from './pages/NotFound.jsx';
import { AppFrame } from './components/Sidebar.jsx';

interface Account {
  user: CurrentUser;
  signOut: () => Promise<void>;
}

const AccountContext = createContext<Account | null>(null);

export function useAccount(): Account {
  const account = useContext(AccountContext);
  if (!account) throw new Error('useAccount was called outside a signed-in screen');
  return account;
}

type Status = 'checking' | 'signed-in' | 'signed-out';

export function App() {
  return (
    <Router>
      <Shell />
    </Router>
  );
}

function Shell() {
  const [status, setStatus] = useState<Status>('checking');
  const [user, setUser] = useState<CurrentUser | null>(null);
  const { path, search, navigate } = useRouter();

  useEffect(() => {
    endpoints
      .me()
      .then((me) => {
        setUser(me);
        setStatus('signed-in');
      })
      .catch((error: unknown) => {
        // Anything other than "not signed in" means the server is unwell, but
        // the sign-in screen is the only one that works without an account, so
        // it is where we land either way.
        void (error instanceof ApiError);
        setStatus('signed-out');
      });
  }, []);

  if (status === 'checking') {
    // Deliberately blank. Anything here would flash for the fraction of a
    // second the check takes, which is worse than nothing.
    return <div className="min-h-dvh" />;
  }

  if (status === 'signed-out' || !user) {
    // Where they were trying to get to, so signing in takes them there rather
    // than dropping them on the home page.
    const redirectTo =
      search.get('redirectTo') ?? (path === '/' || path === '/login' ? null : path);
    return <SignedOut path={path} redirectTo={redirectTo} />;
  }

  const account: Account = {
    user,
    signOut: async () => {
      await endpoints.signOut().catch(() => undefined);
      setUser(null);
      setStatus('signed-out');
      navigate('/', { replace: true });
    },
  };

  return (
    <AccountContext.Provider value={account}>
      <SignedIn path={path} />
    </AccountContext.Provider>
  );
}

function SignedIn({ path }: { path: string }) {
  const [mine, setMine] = useState<ArtifactSummary[]>([]);
  const [shared, setShared] = useState<SharedArtifact[]>([]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const load = useCallback(() => {
    setFailed(false);
    setLoading(true);

    Promise.all([endpoints.myArtifacts(), endpoints.sharedWithMe()])
      .then(([owned, sharedWithMe]) => {
        setMine(owned.artifacts);
        setShared(sharedWithMe.artifacts);
      })
      .catch(() => setFailed(true))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const artifactSlug = path.startsWith('/a/') ? decodeURIComponent(path.slice(3)) : null;

  return (
    <AppFrame data={{ mine, shared, loading }} focusMode={artifactSlug !== null}>
      {artifactSlug !== null ? (
        <Artifact slug={artifactSlug} />
      ) : path === '/' || path === '/login' ? (
        <Home mine={mine} shared={shared} loading={loading} failed={failed} onRetry={load} />
      ) : path === '/settings/sessions' ? (
        <Sessions />
      ) : (
        <NotFound />
      )}
    </AppFrame>
  );
}

/**
 * Somebody with no account.
 *
 * If they are looking at an artifact, it might be public, in which case they
 * should simply read it: asking somebody to sign in to see something they are
 * already allowed to see is how you lose them. So the artifact is tried first,
 * and the sign-in wall is what happens when it comes back as nothing.
 *
 * That request answers identically for a private artifact and one that does not
 * exist, so trying it first gives nothing away.
 */
function SignedOut({ path, redirectTo }: { path: string; redirectTo: string | null }) {
  const slug = path.startsWith('/a/') ? decodeURIComponent(path.slice(3)) : null;

  const [artifact, setArtifact] = useState<SharedArtifact | null>(null);
  const [checked, setChecked] = useState(slug === null);
  const [wantsToSignIn, setWantsToSignIn] = useState(false);

  useEffect(() => {
    if (slug === null) return;

    endpoints
      .artifactBySlug(slug)
      .then(setArtifact)
      .catch(() => undefined)
      .finally(() => setChecked(true));
  }, [slug]);

  // Same reasoning as the shell above: nothing is drawn until we know, because a
  // sign-in wall that flashes over a public document is worse than a still page.
  if (!checked) return <div className="min-h-dvh" />;

  if (artifact && slug && !wantsToSignIn) {
    return (
      <PublicArtifact slug={slug} artifact={artifact} onSignIn={() => setWantsToSignIn(true)} />
    );
  }

  return <SignIn redirectTo={redirectTo} />;
}
