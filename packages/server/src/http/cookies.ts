/**
 * The session cookie.
 *
 * HttpOnly so script cannot read it. SameSite=Lax so it is not sent on
 * cross-site form posts but survives someone clicking a link into a shared
 * artifact from their email, which is the common case for this product.
 * Secure whenever the instance is served over HTTPS.
 */

import type { Context } from 'hono';
import { setCookie, getCookie, deleteCookie } from 'hono/cookie';
import type { Config } from '../config.js';

export const SESSION_COOKIE = 'oa_session';

export function setSessionCookie(
  c: Context,
  config: Config,
  token: string,
  expiresAt: string,
): void {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.baseUrl.startsWith('https://'),
    sameSite: 'Lax',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export function readSessionCookie(c: Context): string | undefined {
  return getCookie(c, SESSION_COOKIE);
}

export function clearSessionCookie(c: Context, config: Config): void {
  deleteCookie(c, SESSION_COOKIE, {
    path: '/',
    secure: config.baseUrl.startsWith('https://'),
    sameSite: 'Lax',
  });
}
