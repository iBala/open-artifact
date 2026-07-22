/**
 * The app shell: work out who is signed in, then show them the right thing.
 *
 * Deciding that takes one request, and until it comes back we show nothing
 * rather than guessing. A sign-in screen that flashes up and vanishes for
 * somebody who was already signed in is worse than a beat of stillness.
 */

import { useEffect, useState, createContext, useContext } from 'react';
import { endpoints, ApiError, type CurrentUser } from './api.js';
import { Router, useRouter } from './router.jsx';
import { SignIn } from './pages/SignIn.jsx';
import { Home } from './pages/Home.jsx';
import { Sessions } from './pages/Sessions.jsx';
import { AppLayout } from './components/AppLayout.jsx';

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
        if (error instanceof ApiError && error.isUnauthenticated) {
          setStatus('signed-out');
          return;
        }
        // Anything else is the server being unwell rather than us being signed
        // out. Showing the sign-in page would be a lie, but it is also the only
        // screen that works without an account, so it is where we land.
        setStatus('signed-out');
      });
  }, []);

  if (status === 'checking') {
    return (
      <div className="grid min-h-dvh place-items-center">
        <span className="oa-breathe text-[14px] text-ink-faint">Loading</span>
      </div>
    );
  }

  if (status === 'signed-out' || !user) {
    // Where they were trying to get to, so signing in takes them there rather
    // than dumping them on the home page.
    const redirectTo =
      search.get('redirectTo') ?? (path === '/' || path === '/login' ? null : path);
    return <SignIn redirectTo={redirectTo} />;
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
      <AppLayout>{screenFor(path)}</AppLayout>
    </AccountContext.Provider>
  );
}

function screenFor(path: string) {
  switch (path) {
    case '/':
    case '/login':
      return <Home />;
    case '/settings/sessions':
      return <Sessions />;
    default:
      return <NotFound />;
  }
}

function NotFound() {
  return (
    <div className="oa-rise py-20 text-center">
      <h1 className="text-[19px]">There is nothing at this address</h1>
      <p className="mt-2 text-[14px] text-ink-soft">
        The link may be wrong, or whatever was here has been deleted.
      </p>
    </div>
  );
}
