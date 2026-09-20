/**
 * The announcement BANNER's show/hide + link rules, and its persisted dismissal.
 *
 * These are the two regressions this feature is meant to prevent, and both are
 * silent if wrong:
 *
 *  - The banner is mounted globally, so the ONLY thing keeping it off the login /
 *    splash / onboarding screens is the home-only gate. If that gate weakened,
 *    the banner would quietly return to overlaying every screen.
 *  - Dismissal must survive a reload (it used to be in-memory and came back every
 *    time). It is keyed by message text so a NEW admin message re-appears while
 *    the one the user closed stays closed.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { bannerLink, bannerMessage, shouldShowBanner } from '@/src/lib/announcementBanner';

// In-memory AsyncStorage stand-in — the persistence lib is the unit under test.
const store = new Map<string, string>();
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    getItem: async (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: async (k: string, v: string) => void store.set(k, v),
    removeItem: async (k: string) => void store.delete(k),
  },
}));

const { loadDismissedBanner, dismissBanner } = await import('@/src/lib/bannerDismiss');

beforeEach(() => store.clear());

describe('bannerMessage', () => {
  it('trims, and treats blank/whitespace/missing as nothing to show', () => {
    expect(bannerMessage({ message: '  Hello  ' })).toBe('Hello');
    expect(bannerMessage({ message: '   ' })).toBeUndefined();
    expect(bannerMessage({ message: '' })).toBeUndefined();
    expect(bannerMessage({})).toBeUndefined();
    expect(bannerMessage(null)).toBeUndefined();
  });
});

describe('bannerLink — only real http(s) URLs are tappable', () => {
  it('accepts http and https', () => {
    expect(bannerLink('https://tophunt.in')).toBe('https://tophunt.in');
    expect(bannerLink('  http://x.co/y  ')).toBe('http://x.co/y');
  });

  it('rejects the free-text junk that a link field attracts', () => {
    // The exact class of value seen in production: diagnostic text pasted into
    // the "Optional link URL" box.
    expect(bannerLink('App version: 1.0.0 Platform: web Update: embedded')).toBeUndefined();
    expect(bannerLink('tophunt.in')).toBeUndefined(); // no scheme
    expect(bannerLink('javascript:alert(1)')).toBeUndefined(); // not http(s)
    expect(bannerLink('https://')).toBeUndefined(); // scheme but no host
    expect(bannerLink('')).toBeUndefined();
    expect(bannerLink(null)).toBeUndefined();
    expect(bannerLink(undefined)).toBeUndefined();
  });
});

describe('shouldShowBanner', () => {
  const base = { onHome: true, ready: true, enabled: true, message: 'Hi', dismissedMessage: null };

  it('shows when on home, hydrated, enabled, has a message, and not dismissed', () => {
    expect(shouldShowBanner(base)).toBe(true);
  });

  it('is hidden everywhere except home', () => {
    expect(shouldShowBanner({ ...base, onHome: false })).toBe(false);
  });

  it('is hidden until the persisted dismissal has hydrated (no flash)', () => {
    expect(shouldShowBanner({ ...base, ready: false })).toBe(false);
  });

  it('is hidden when disabled or empty', () => {
    expect(shouldShowBanner({ ...base, enabled: false })).toBe(false);
    expect(shouldShowBanner({ ...base, message: undefined })).toBe(false);
  });

  it('is hidden for the exact message the user dismissed, shown for a new one', () => {
    expect(shouldShowBanner({ ...base, dismissedMessage: 'Hi' })).toBe(false);
    expect(shouldShowBanner({ ...base, message: 'New notice', dismissedMessage: 'Hi' })).toBe(true);
  });
});

describe('persisted dismissal (bannerDismiss)', () => {
  it('remembers the dismissed message across a reload', async () => {
    expect(await loadDismissedBanner()).toBeNull();
    await dismissBanner('Server maintenance tonight');
    // A fresh read (simulating an app restart) still sees it.
    expect(await loadDismissedBanner()).toBe('Server maintenance tonight');
  });

  it('a dismissed message stays hidden, a changed message shows again — end to end', async () => {
    await dismissBanner('Old message');
    const dismissed = await loadDismissedBanner();

    expect(
      shouldShowBanner({ onHome: true, ready: true, enabled: true, message: 'Old message', dismissedMessage: dismissed }),
    ).toBe(false);
    expect(
      shouldShowBanner({ onHome: true, ready: true, enabled: true, message: 'Old message v2', dismissedMessage: dismissed }),
    ).toBe(true);
  });
});
