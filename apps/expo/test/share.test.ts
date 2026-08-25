/**
 * Battle share links + captions.
 *
 * These pin the exact bugs the old share sheet shipped: a wrong domain
 * (tophunt.app), a dead route, no handles/title in the caption, and every
 * "platform" button doing the same generic thing. The pure builders are where
 * that correctness lives, so they are tested directly.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// react-native + expo native modules can't load in Node; the builders under test
// don't touch them, but the module imports them at top level, so stub them.
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Share: {}, Linking: {} }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('@/src/lib/vsNativeModules', () => ({ getSharing: () => null }));
// Native fallback origin when there's no window.location.
vi.mock('@/src/services/api', () => ({ API_BASE_URL: 'https://tophunt-api.example.workers.dev' }));

import {
  shareOrigin,
  battleUrl,
  battleCaption,
  whatsappShareUrl,
  telegramShareUrl,
  twitterShareUrl,
  facebookShareUrl,
  platformShareUrl,
} from '@/src/lib/share';

// Node/vitest has no window by default; each test sets/clears it explicitly.
afterEach(() => {
  delete (globalThis as any).window;
});

const match = {
  id: 'm1',
  title: 'Best Smile',
  userA: { username: 'alice' },
  userB: { username: 'bob' },
  vsImageUrl: 'https://cdn.test/vs-cards/images/m1.jpg',
};

describe('shareOrigin / battleUrl', () => {
  it('uses whatever host the web app is served from — not a hard-coded domain', () => {
    (globalThis as any).window = { location: { origin: 'https://tophuntdpcontest-89t.pages.dev' } };
    expect(shareOrigin()).toBe('https://tophuntdpcontest-89t.pages.dev');
    const url = battleUrl('m1');
    expect(url).toBe('https://tophuntdpcontest-89t.pages.dev/battle/m1');
    // The old wrong host must never come back.
    expect(url).not.toContain('tophunt.app');
  });

  it('follows a different host automatically (custom domain / staging)', () => {
    (globalThis as any).window = { location: { origin: 'https://app.example.com/' } };
    expect(battleUrl('m1')).toBe('https://app.example.com/battle/m1');
  });

  it('falls back to the deployment API origin when there is no browser location (native)', () => {
    // no window
    expect(shareOrigin()).toBe('https://tophunt-api.example.workers.dev');
    expect(battleUrl('m1')).toContain('/battle/m1');
  });

  it('encodes the id', () => {
    (globalThis as any).window = { location: { origin: 'https://h.test' } };
    expect(battleUrl('a/b?c')).toBe('https://h.test/battle/a%2Fb%3Fc');
  });
});

describe('battleCaption', () => {
  it('includes both handles, the title and the link', () => {
    const url = battleUrl('m1');
    const cap = battleCaption(match, url);
    expect(cap).toContain('Best Smile');
    expect(cap).toContain('@alice');
    expect(cap).toContain('@bob');
    expect(cap).toContain(url);
  });

  it('degrades gracefully when handles/title are missing', () => {
    const cap = battleCaption({}, battleUrl('m1'));
    expect(cap).toContain('someone');
    expect(cap).toContain('a rival');
    expect(cap).toContain('This battle');
  });
});

describe('per-app share intents', () => {
  const url = battleUrl('m1');
  const cap = battleCaption(match, url);

  it('WhatsApp uses wa.me with the caption', () => {
    expect(whatsappShareUrl(cap)).toBe(`https://wa.me/?text=${encodeURIComponent(cap)}`);
  });
  it('Telegram uses t.me/share with url + text', () => {
    const u = telegramShareUrl(url, 'Best Smile');
    expect(u).toContain('https://t.me/share/url?url=');
    expect(u).toContain(encodeURIComponent(url));
  });
  it('Twitter uses the web intent', () => {
    expect(twitterShareUrl(cap)).toContain('https://twitter.com/intent/tweet?text=');
  });
  it('Facebook sharer takes the url', () => {
    expect(facebookShareUrl(url)).toBe(`https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`);
  });

  it('platformShareUrl maps known ids and returns null for image-only apps', () => {
    expect(platformShareUrl('wa', cap, url)).toContain('wa.me');
    expect(platformShareUrl('tg', cap, url)).toContain('t.me');
    expect(platformShareUrl('tw', cap, url)).toContain('twitter.com');
    expect(platformShareUrl('fb', cap, url)).toContain('facebook.com');
    // Instagram, Snapchat, Messenger have no prefilled web intent → null → OS sheet.
    expect(platformShareUrl('ig', cap, url)).toBeNull();
    expect(platformShareUrl('sc', cap, url)).toBeNull();
    expect(platformShareUrl('ms', cap, url)).toBeNull();
  });
});
