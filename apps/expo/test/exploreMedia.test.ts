import { describe, it, expect, vi } from 'vitest';

vi.mock('react-native', () => ({ Platform: { OS: 'web', select: (o: any) => o.web ?? o.default } }));
import {
  bannerTarget,
  chunk,
  compactCount,
  enabledSections,
  EXPLORE_SECTION_KEYS,
  joinableOpenBattles,
  leaderboardScore,
  participantThumb,
  pushRecentSearch,
  RECENT_SEARCH_MAX,
  splitPodium,
} from '../src/lib/exploreMedia';

describe('participantThumb', () => {
  it('prefers the resized photo variants over the original', () => {
    expect(participantThumb({ mediaUrl: 'o.jpg', mediaUrlOptimized: 'm.jpg', mediaUrlThumb: 't.jpg' })).toBe('t.jpg');
    expect(participantThumb({ mediaUrl: 'o.jpg', mediaUrlOptimized: 'm.jpg' })).toBe('m.jpg');
    expect(participantThumb({ mediaUrl: 'o.jpg' })).toBe('o.jpg');
    expect(participantThumb(null)).toBeNull();
  });
  it('never hands a video file to an image: Bunny poster or nothing', () => {
    const hls = 'https://vz-x.b-cdn.net/0f8b3b7e-1234-4cde-9abc-0123456789ab/playlist.m3u8';
    expect(participantThumb({ mediaUrl: hls, mediaUrlThumb: 'bogus' }, 'video')).toBe(
      'https://vz-x.b-cdn.net/0f8b3b7e-1234-4cde-9abc-0123456789ab/thumbnail.jpg',
    );
    expect(participantThumb({ mediaUrl: 'https://r2/x.mp4', mediaType: 'video' })).toBeNull();
  });
});

describe('joinableOpenBattles', () => {
  it('hides invite-only battles meant for someone else, and held ones', () => {
    const list = [
      { id: 'a' },
      { id: 'b', isPrivate: true, invitedUid: 'me' },
      { id: 'c', isPrivate: true, invitedUid: 'other' },
      { id: 'd', moderationHeld: true },
    ];
    expect(joinableOpenBattles(list, 'me').map((m) => m.id)).toEqual(['a', 'b']);
    expect(joinableOpenBattles(list, null).map((m) => m.id)).toEqual(['a']);
  });
});

describe('enabledSections', () => {
  it('keeps the admin order, drops disabled, appends missing ones', () => {
    const out = enabledSections({ sections: [{ key: 'grid' }, { key: 'banners', enabled: false }, { key: 'nope' }, { key: 'grid' }] });
    expect(out[0]).toBe('grid');
    expect(out).not.toContain('banners');
    expect(out).toHaveLength(EXPLORE_SECTION_KEYS.length - 1);
    expect(enabledSections(null)).toEqual([...EXPLORE_SECTION_KEYS]);
  });
});

describe('bannerTarget', () => {
  it('routes app paths, opens https, ignores anything else', () => {
    expect(bannerTarget('/referral')).toEqual({ kind: 'route', to: '/referral' });
    expect(bannerTarget('https://tophunt.in')).toEqual({ kind: 'url', to: 'https://tophunt.in' });
    for (const bad of ['', '//evil.com', 'javascript:alert(1)', 'http://x.com', null]) expect(bannerTarget(bad)).toBeNull();
  });
});

describe('leaderboard', () => {
  it('reads the FLAT fields the API returns (wins/votes used to show 0)', () => {
    const u = { wins: 7, totalVotesReceived: 120, xp: 900 };
    expect(leaderboardScore(u, 'wins')).toBe(7);
    expect(leaderboardScore(u, 'votes')).toBe(120);
    expect(leaderboardScore(u, 'xp')).toBe(900);
    expect(leaderboardScore({ stats: { wins: 3 } }, 'wins')).toBe(3);
    expect(leaderboardScore(null, 'wins')).toBe(0);
  });
  it('with fewer than 3 people, lists everyone instead of a blank screen', () => {
    expect(splitPodium([1, 2])).toEqual({ podium: [], rest: [1, 2], restStartRank: 1 });
    expect(splitPodium([1, 2, 3, 4])).toEqual({ podium: [1, 2, 3], rest: [4], restStartRank: 4 });
  });
});

describe('small helpers', () => {
  it('compactCount', () => {
    expect(compactCount(950)).toBe('950');
    expect(compactCount(1200)).toBe('1.2K');
    expect(compactCount(15_000)).toBe('15K');
    expect(compactCount(3_400_000)).toBe('3.4M');
    expect(compactCount(-5)).toBe('0');
  });
  it('chunk', () => {
    expect(chunk([1, 2, 3], 2)).toEqual([[1, 2], [3]]);
  });
  it('recent searches: newest first, de-duplicated case-insensitively, capped', () => {
    let list: string[] = [];
    for (let i = 0; i < 12; i++) list = pushRecentSearch(list, `q${i}`);
    expect(list).toHaveLength(RECENT_SEARCH_MAX);
    expect(pushRecentSearch(['Dance', 'x'], 'dance')).toEqual(['dance', 'x']);
    expect(pushRecentSearch(['x'], 'a')).toEqual(['x']);
  });
});
