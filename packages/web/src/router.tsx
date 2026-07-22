/**
 * Routing.
 *
 * Hand-rolled over the History API rather than a routing library. The app has a
 * handful of screens, and this is about forty lines that everyone on the project
 * can read, against a dependency that would need keeping current for years.
 */

import { useState, useEffect, useCallback, createContext, useContext } from 'react';

interface Route {
  path: string;
  search: URLSearchParams;
}

interface RouterValue extends Route {
  navigate: (to: string, options?: { replace?: boolean }) => void;
}

const RouterContext = createContext<RouterValue | null>(null);

function currentRoute(): Route {
  return {
    path: window.location.pathname,
    search: new URLSearchParams(window.location.search),
  };
}

export function Router({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<Route>(currentRoute);

  useEffect(() => {
    const onPopState = () => setRoute(currentRoute());
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigate = useCallback((to: string, options: { replace?: boolean } = {}) => {
    if (options.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setRoute(currentRoute());
    // A new screen starts at the top. Browsers restore scroll on back, which is
    // right, but a forward navigation landing halfway down a page is not.
    window.scrollTo({ top: 0 });
  }, []);

  return (
    <RouterContext.Provider value={{ ...route, navigate }}>{children}</RouterContext.Provider>
  );
}

export function useRouter(): RouterValue {
  const value = useContext(RouterContext);
  if (!value) throw new Error('useRouter was called outside the Router');
  return value;
}

/**
 * An internal link. Uses a real anchor, so middle-click, right-click and
 * "open in new tab" all behave the way a link should, and only intercepts the
 * plain left-click that means "go there".
 */
export function Link({
  to,
  children,
  className,
}: {
  to: string;
  children: React.ReactNode;
  className?: string;
}) {
  const { navigate } = useRouter();

  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        if (event.defaultPrevented) return;
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
