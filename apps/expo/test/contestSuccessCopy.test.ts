/**
 * What the contest congratulations screen is allowed to claim.
 *
 * The defect behind this: a creator's lone entry was being published as a Story
 * while the battle still waited for an opponent, and the screen said "Your entry
 * is now live!". The copy must now follow the SERVER-confirmed VS Story state.
 */
import { describe, it, expect } from 'vitest';
import { contestSuccessCopy, type VsStoryState } from '@/src/lib/contestSuccess';

describe('contestSuccessCopy', () => {
  it('a creator is told they are waiting — never that anything is live', () => {
    for (const status of [null, 'waiting_for_opponent', 'live', 'preparing'] as (VsStoryState | null)[]) {
      const copy = contestSuccessCopy('create', status);
      expect(copy.subtitle).toBe('Entry submitted — waiting for an opponent.');
      expect(`${copy.title} ${copy.subtitle} ${copy.info}`.toLowerCase()).not.toContain('story is now live');
      expect(copy.poll).toBe(false);
    }
  });

  it('a joiner sees "preparing" until the server confirms, and polls meanwhile', () => {
    for (const status of [null, 'preparing'] as const) {
      const copy = contestSuccessCopy('join', status);
      expect(copy.subtitle).toBe('Battle created. Preparing your VS Story…');
      expect(copy.poll).toBe(true);
      expect(copy.subtitle).not.toContain('live');
    }
  });

  it('"VS Story is now live" appears only for the server\'s `live`', () => {
    const states: VsStoryState[] = ['waiting_for_opponent', 'preparing', 'live', 'failed', 'unavailable'];
    const claimsLive = states.filter((s) => contestSuccessCopy('join', s).subtitle.includes('VS Story is now live'));
    expect(claimsLive).toEqual(['live']);
    expect(contestSuccessCopy('join', 'live').subtitle).toBe('Battle ready! Your VS Story is now live.');
    expect(contestSuccessCopy('join', 'live').poll).toBe(false);
  });

  it('a failed story is reported honestly, with a re-check rather than a re-submit', () => {
    const copy = contestSuccessCopy('join', 'failed');
    expect(copy.subtitle).toContain('couldn’t prepare your VS Story');
    expect(copy.info).toContain('voting is open');
    expect(copy.canRefresh).toBe(true);
    expect(copy.poll).toBe(false);
  });
});
