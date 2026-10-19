/**
 * In-app browsers (Instagram, Facebook, Snapchat, LinkedIn … webviews).
 *
 * Google refuses OAuth inside embedded webviews ("disallowed_useragent"), and
 * popups there are unreliable, so social sign-in from a link opened inside
 * Instagram fails no matter what the app does. The fix is to get the user into
 * their real browser; this detects the case and builds the hand-off.
 */

export interface InAppBrowserInfo {
  inApp: boolean;
  /** Display name, e.g. "Instagram". */
  name: string | null;
  os: 'android' | 'ios' | 'other';
}

const APPS: [RegExp, string][] = [
  [/Instagram/i, 'Instagram'],
  [/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i, 'Facebook'],
  [/Messenger|MessengerForiOS/i, 'Messenger'],
  [/Snapchat/i, 'Snapchat'],
  [/LinkedInApp/i, 'LinkedIn'],
  [/Twitter|TwitterAndroid/i, 'X'],
  [/\bLine\//i, 'LINE'],
  [/MicroMessenger/i, 'WeChat'],
  [/musical_ly|BytedanceWebview|TikTok/i, 'TikTok'],
  [/Pinterest/i, 'Pinterest'],
  [/GSA\//i, 'Google app'],
];

export function detectInAppBrowser(ua: string | null | undefined): InAppBrowserInfo {
  const s = String(ua || '');
  const os: InAppBrowserInfo['os'] = /Android/i.test(s) ? 'android' : /iPhone|iPad|iPod/i.test(s) ? 'ios' : 'other';
  for (const [re, name] of APPS) {
    if (re.test(s)) return { inApp: true, name, os };
  }
  // A generic Android WebView ("; wv)") — e.g. an app opening links internally.
  if (os === 'android' && /; wv\)/.test(s)) return { inApp: true, name: null, os };
  return { inApp: false, name: null, os };
}

/**
 * A URL that opens `pageUrl` in the system browser, when one exists.
 * Android: an intent:// link (Chrome, else the user's default browser).
 * iOS has no reliable equivalent from inside a webview — the caller copies the
 * link instead.
 */
export function externalBrowserUrl(pageUrl: string, info: InAppBrowserInfo): string | null {
  if (info.os !== 'android') return null;
  try {
    const u = new URL(pageUrl);
    if (u.protocol !== 'https:') return null;
    const fallback = encodeURIComponent(u.toString());
    return `intent://${u.host}${u.pathname}${u.search}#Intent;scheme=https;S.browser_fallback_url=${fallback};end`;
  } catch {
    return null;
  }
}
