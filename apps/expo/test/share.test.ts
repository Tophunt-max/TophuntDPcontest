/**
 * Battle share links + captions.
 *
 * These pin the exact bugs the old share sheet shipped: a wrong domain
 * (tophunt.app), a dead route, no handles/title in the caption, and every
 * "platform" button doing the same generic thing. The pure builders are where
 * that correctness lives, so they are tested directly.
 */
import { describe, it, expect, vi } from 'vitest';

// react-native + expo native modules can't load in Node; the builders under test
// don't touch them, but the module imports them at top level, so stub them.
vi.mock('react-native', () => ({ Platform: { OS: 'web' }, Share: {}, Linking: {} }));
vi.mock('expo-clipboard', () => ({ setStringAsync: async () => {} }));
vi.mock('expo-image-manipulator', () => ({ ImageManipulator: {}, SaveFormat: { JPEG: 'jpeg' } }));
vi.mock('@/src/lib/vsNativeModules', () => ({ getSharing: () => null }));

import {
  SHARE_ORIGIN,
  battleUrl,
  battleCaption,
  whatsappShareUrl,
  telegramShareUrl,
  twitterShareUrl,
  facebookShareUrl,
  platformShareUrl,
} from '@/src/lib/share';

const match = {
  id: 'm1',
  title: 'Best Smile',
  userA: { username: 'alice' },
  userB: { username: 'bob' },
  vsImageUrl: 'https://cdn.test/vs-cards/images/m1.jpg',
};

describe('battleUrl', () => {
  it('points at the real App-Links host, not tophunt.app', () => {
    const url = battleUrl('m1');
    expect(url).toBe(`${SHARE_ORIGIN}/battle/m1`);
    expect(url).not.toContain('tophunt.app');
    expect(url).toContain('/battle/');
  });

  it('encodes the id', () => {
    expect(battleUrl('a/b?c')).toBe(`${SHARE_ORIGIN}/battle/a%2Fb%3Fc`);
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
