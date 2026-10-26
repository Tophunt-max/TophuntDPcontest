/**
 * Links from content the app does not write itself (admin announcements, blog
 * article HTML) are opened only when they are plain web links.
 *
 * `Linking.openURL` on web calls `window.open(url)`, and a `javascript:` URL
 * there runs script on our origin. On Android an `intent:` URL can launch other
 * apps. The server validates announcement links, but blog HTML (imported or
 * written in the admin panel) is not validated per link, and a check here is the
 * last line before the OS.
 */
const ALLOWED = /^(https?:\/\/|mailto:)/i;

/** The trimmed URL when it is safe to hand to `Linking.openURL`, else null. */
export function safeExternalUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const url = raw.trim();
  // Control characters and whitespace inside the scheme can hide `javascript:`.
  if (!url || /[\u0000-\u001f\u007f\s]/.test(url.slice(0, 16))) return null;
  return ALLOWED.test(url) ? url : null;
}
