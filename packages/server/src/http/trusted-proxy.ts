/**
 * Trusts a reverse proxy's already-verified identity.
 *
 * Some deployments put an authenticating reverse proxy in front of this app
 * and let it own sign-in entirely: no email code, no Google button, just the
 * proxy's own SSO. That proxy stamps a header with the address it verified —
 * oauth2-proxy's default is `X-Forwarded-Email` — and this app is told the
 * exact header name to trust via TRUSTED_PROXY_EMAIL_HEADER.
 *
 * This is only safe when the app is unreachable except through that proxy: a
 * header anyone could set from outside would let anyone sign in as anyone.
 * loadConfig refuses to boot with this header set unless HOST is also
 * restricted to loopback (see config.ts), which is the one runtime check that
 * can be made — that the app is otherwise firewalled from the outside is a
 * deployment invariant, not something this process can verify itself.
 */

import type { MiddlewareHandler } from 'hono';
import type { AuthService } from '../auth/service.js';
import type { Config } from '../config.js';
import { setSessionCookie } from './cookies.js';
import type { AppEnv } from './app.js';

export function trustProxyHeader(auth: AuthService, config: Config): MiddlewareHandler<AppEnv> {
  const header = config.trustedProxyEmailHeader;

  return async (c, next) => {
    // Nothing to do: this instance signs itself in as usual.
    if (header === null) {
      await next();
      return;
    }

    // /mcp derives its identity from the Authorization header alone, and must
    // never be signed in by a cookie or a proxy header — see attachUser, which
    // this mirrors so the exclusion cannot drift between the two.
    if (c.req.path === '/mcp' || c.req.path.startsWith('/mcp/')) {
      await next();
      return;
    }

    // Already signed in for this request — a live session cookie, or a CLI/MCP
    // bearer token attachUser already resolved — so there is nothing to add.
    if (c.get('user')) {
      await next();
      return;
    }

    const email = c.req.header(header);
    if (!email) {
      await next();
      return;
    }

    const { user } = auth.findOrCreateUser(email, { verified: true });
    const session = auth.createSession(user.id, 'Single sign-on');
    setSessionCookie(c, config, session.token, session.expiresAt);
    c.set('user', user);

    await next();
  };
}
