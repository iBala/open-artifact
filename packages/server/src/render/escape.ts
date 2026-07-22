/**
 * Escapes text for insertion into HTML.
 *
 * Used for the small amount of server-rendered chrome (titles, timestamps) that
 * sits outside the Markdown pipeline. Everything that goes into a page and did not
 * come from the sanitiser goes through here.
 */

const REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => REPLACEMENTS[character] ?? character);
}
