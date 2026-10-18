/**
 * `/battle/<id>` link previews (what WhatsApp, Telegram, Facebook, iMessage show
 * when the battle LINK is shared). Drives the real `public/_worker.js`.
 *
 * The defect: whenever the VS card was missing, a two-player battle unfurled as
 * ONE participant's photo (userA's entry). Now a two-sided battle previews only
 * its canonical VS card, or no image at all.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { get, stubApi, json } from './helpers/edgeWorker';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const ogImage = (html: string) => /<meta property="og:image" content="([^"]+)"/.exec(html)?.[1] ?? null;
const CARD = 'https://media.tophunt.in/vs-cards/battles/m1-v1.jpg';
const A = 'https://media.tophunt.in/contests/2026/10/alice.jpg';
const B = 'https://media.tophunt.in/contests/2026/10/bob.jpg';

async function preview(match: any) {
  restore = stubApi({ '/read/matches/*': () => json(match) });
  const res = await get('https://tophunt.in/battle/m1');
  return res.text();
}

describe('battle link preview image', () => {
  it('a completed battle previews its two-photo VS card', async () => {
    const html = await preview({ id: 'm1', status: 'active', title: 'Best Smile', vsImageUrl: CARD,
      userA: { uid: 'a', username: 'alice', mediaUrl: A }, userB: { uid: 'b', username: 'bob', mediaUrl: B } });
    expect(ogImage(html)).toBe(CARD);
    expect(html).toContain('@alice vs @bob');
  });

  it('never falls back to one participant\'s photo when the card is missing', async () => {
    const html = await preview({ id: 'm1', status: 'active', title: 'Best Smile', vsImageUrl: null,
      userA: { uid: 'a', username: 'alice', mediaUrl: A }, userB: { uid: 'b', username: 'bob', mediaUrl: B } });
    expect(ogImage(html)).toBeNull();
    expect(html).not.toContain(A);
    expect(html).not.toContain(B);
  });

  it('ignores a legacy client-captured card or another battle\'s card', async () => {
    for (const vsImageUrl of [
      'https://media.tophunt.in/vs-cards/2026/09/client.jpg',
      'https://media.tophunt.in/vs-cards/battles/OTHER-v1.jpg',
    ]) {
      restore?.();
      const html = await preview({ id: 'm1', status: 'active', vsImageUrl,
        userA: { uid: 'a', username: 'alice', mediaUrl: A }, userB: { uid: 'b', username: 'bob', mediaUrl: B } });
      expect(ogImage(html)).toBeNull();
    }
  });

  it('a battle still waiting for an opponent may preview its only entry', async () => {
    const html = await preview({ id: 'm1', status: 'waiting_for_opponent', title: 'Best Smile',
      userA: { uid: 'a', username: 'alice', mediaUrl: A }, userB: null });
    expect(ogImage(html)).toBe(A);
  });
});
