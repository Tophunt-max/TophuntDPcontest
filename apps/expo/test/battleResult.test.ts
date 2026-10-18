/**
 * Battle result derivation (src/lib/battleResult.ts): one source of truth for the
 * feed card, the result page and the shared winner card.
 */
import { describe, it, expect } from 'vitest';
import {
  battleOutcome,
  battleResultPath,
  resultHeadline,
  RESULT_REFETCH_DELAYS_MS,
  summarizeResult,
  viewerRole,
  winnerCaption,
} from '@/src/lib/battleResult';

const now = 1_700_000_000_000;
const match = (extra: Record<string, any> = {}) => ({
  id: 'm1',
  title: 'Best Smile',
  type: 'photo',
  status: 'completed',
  winnerUid: 'alice',
  rewardAmount: 100,
  expiresAt: now - 1000,
  userA: { uid: 'alice', username: 'alice', votes: 12, mediaUrl: 'https://cdn/a.jpg', mediaUrlOptimized: 'https://cdn/a-1080.jpg', profilePic: 'https://cdn/pa.jpg' },
  userB: { uid: 'bob', username: 'bob', votes: 7, mediaUrl: 'https://cdn/b.jpg' },
  ...extra,
});

describe('battleOutcome', () => {
  it('maps server status + deadline to what the card shows', () => {
    expect(battleOutcome(match(), now)).toBe('winner');
    expect(battleOutcome(match({ winnerUid: null }), now)).toBe('tie');
    expect(battleOutcome(match({ status: 'cancelled' }), now)).toBe('voided');
    expect(battleOutcome(match({ status: 'waiting_for_opponent' }), now)).toBe('waiting');
    expect(battleOutcome(match({ status: 'active', expiresAt: now + 60_000 }), now)).toBe('live');
    // The window between the deadline and the settlement.
    expect(battleOutcome(match({ status: 'active', expiresAt: now - 1 }), now)).toBe('pending');
  });
});

describe('summarizeResult', () => {
  it('names winner and loser from winnerUid, with margin and share', () => {
    const s = summarizeResult(match(), now);
    expect(s.winner?.username).toBe('alice');
    expect(s.loser?.username).toBe('bob');
    expect(s.totalVotes).toBe(19);
    expect(s.margin).toBe(5);
    expect(s.winnerPct).toBe(63);
    expect(s.winner?.photoUrl).toBe('https://cdn/a-1080.jpg');
    expect(s.prize).toEqual({ kind: 'coins', coins: 100 });
  });

  it('trusts winnerUid even when it is side B', () => {
    const s = summarizeResult(match({ winnerUid: 'bob' }), now);
    expect(s.winner?.uid).toBe('bob');
    expect(s.margin).toBe(0); // bob had fewer votes in this fixture: margin floors at 0
  });

  it('a product prize beats coins, and a video entry has no still photo', () => {
    const s = summarizeResult(match({ type: 'video', prizeType: 'product', prizeProductTitle: 'Headphones', prizeProductValue: 999 }), now);
    expect(s.prize).toEqual({ kind: 'product', title: 'Headphones', imageUrl: null, value: 999 });
    expect(s.winner?.isVideo).toBe(true);
    expect(s.winner?.photoUrl).toBeNull();
  });

  it('no winner, no prize, zero share for a tie', () => {
    const s = summarizeResult(match({ winnerUid: null }), now);
    expect(s.winner).toBeNull();
    expect(s.prize).toBeNull();
    expect(s.winnerPct).toBe(0);
  });
});

describe('viewer copy', () => {
  it('speaks to the winner, the loser and everyone else', () => {
    const s = summarizeResult(match(), now);
    expect(viewerRole(s, 'alice')).toBe('winner');
    expect(viewerRole(s, 'bob')).toBe('loser');
    expect(viewerRole(s, 'carol')).toBe('viewer');
    expect(viewerRole(s, null)).toBe('viewer');
    expect(resultHeadline(s, 'winner').title).toBe('You won! 🏆');
    expect(resultHeadline(s, 'viewer').title).toBe('@alice wins! 🏆');
    expect(resultHeadline(s, 'winner').subtitle).toContain('5 votes');
  });

  it('a player in a tie is a player, not a viewer', () => {
    const s = summarizeResult(match({ winnerUid: null }), now);
    expect(viewerRole(s, 'bob')).toBe('player');
    expect(resultHeadline(s, 'player').title).toContain('tie');
  });

  it('the share caption names the winner, votes and link', () => {
    const c = winnerCaption(summarizeResult(match(), now), 'https://tophunt.in/battle/m1/result');
    expect(c).toContain('@alice');
    expect(c).toContain('12 votes');
    expect(c).toContain('https://tophunt.in/battle/m1/result');
  });
});

describe('routing and refetch', () => {
  it('builds the result route', () => {
    expect(battleResultPath('m 1')).toBe('/battle/m%201/result');
  });
  it('re-reads quickly at first, then backs off, and stops', () => {
    expect(RESULT_REFETCH_DELAYS_MS[0]).toBeLessThanOrEqual(2000);
    expect([...RESULT_REFETCH_DELAYS_MS]).toEqual([...RESULT_REFETCH_DELAYS_MS].sort((x, y) => x - y));
    expect(RESULT_REFETCH_DELAYS_MS.length).toBeLessThanOrEqual(8);
  });
});
