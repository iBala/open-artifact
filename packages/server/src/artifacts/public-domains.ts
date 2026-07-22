/**
 * Email domains that must never be shared with as a domain.
 *
 * "Share with everybody at zorp.one" means a company. "Share with everybody at
 * gmail.com" means the entire internet, worded as though it were a company, and
 * somebody will type it by accident while meaning to share with one person.
 *
 * So domain sharing refuses these outright, with a message that says what to do
 * instead. Sharing with an individual gmail address is fine and always was; it is
 * only the domain-wide form that is refused.
 *
 * This list does not need to be exhaustive to be worth having. It needs to cover
 * what somebody would plausibly type.
 */

const PUBLIC_EMAIL_PROVIDERS = new Set([
  // The ones people actually have
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'hotmail.co.uk',
  'live.com',
  'msn.com',
  'yahoo.com',
  'yahoo.co.uk',
  'yahoo.co.in',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'pm.me',
  'gmx.com',
  'gmx.de',
  'gmx.net',
  'web.de',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'mail.com',
  'mail.ru',
  'fastmail.com',
  'fastmail.fm',
  'hey.com',
  'tutanota.com',
  'tuta.io',
  'rediffmail.com',
  'qq.com',
  '163.com',
  '126.com',
  'naver.com',
  'daum.net',

  // Throwaway addresses. Sharing a domain with these grants access to anybody
  // who can open a browser.
  'mailinator.com',
  'guerrillamail.com',
  '10minutemail.com',
  'yopmail.com',
  'temp-mail.org',
  'trashmail.com',
  'sharklasers.com',
  'dispostable.com',
]);

export function isPublicEmailProvider(domain: string): boolean {
  return PUBLIC_EMAIL_PROVIDERS.has(domain.trim().toLowerCase());
}

/** Only for tests and documentation. */
export function publicEmailProviders(): string[] {
  return [...PUBLIC_EMAIL_PROVIDERS].sort();
}
