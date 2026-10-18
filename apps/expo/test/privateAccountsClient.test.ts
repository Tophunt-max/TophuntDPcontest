/**
 * Client side of private accounts and the guest nudges: the Follow button
 * states (src/lib/followState.ts), the soft login wall (src/lib/guestWall.ts)
 * and where the new notification types lead.
 */
import { describe, it, expect } from 'vitest';
import {
  followButtonLabel,
  followStateFromResult,
  isFollowActive,
  nextFollowState,
  stateInSets,
  withStateInSets,
} from '@/src/lib/followState';
import { GUEST_WALL_EVERY, nextGuestWallAt, seenAfterViewable, shouldShowGuestWall } from '@/src/lib/guestWall';
import { getNotificationDestination, getNotificationTag } from '@/src/services/notifications/notificationMeta';
import { signupHref } from '@/src/lib/authGate';

describe('follow button state', () => {
  it('reads the server answer: a private account answers "requested", not "following"', () => {
    expect(followStateFromResult({ isFollowing: true, requested: false })).toBe('following');
    expect(followStateFromResult({ isFollowing: false, requested: true })).toBe('requested');
    expect(followStateFromResult({ isFollowing: false, requested: false })).toBe('none');
    expect(followStateFromResult(undefined)).toBe('none');
  });

  it('labels and styles each state', () => {
    expect(followButtonLabel('none')).toBe('Follow');
    expect(followButtonLabel('requested')).toBe('Requested');
    expect(followButtonLabel('following')).toBe('Following');
    expect(isFollowActive('requested')).toBe(true);
    expect(isFollowActive('none')).toBe(false);
  });

  it('predicts the next state for optimistic updates', () => {
    expect(nextFollowState('none', true)).toBe('requested');
    expect(nextFollowState('none', false)).toBe('following');
    expect(nextFollowState('requested', true)).toBe('none');
    expect(nextFollowState('following', true)).toBe('none');
  });

  it('list screens keep follows and requests in separate sets', () => {
    const empty = new Set<string>();
    const a = withStateInSets(empty, empty, 'u1', 'requested');
    expect(stateInSets(a.followed, a.requested, 'u1')).toBe('requested');
    const b = withStateInSets(a.followed, a.requested, 'u1', 'following');
    expect([...b.followed]).toEqual(['u1']);
    expect([...b.requested]).toEqual([]);
    const c = withStateInSets(b.followed, b.requested, 'u1', 'none');
    expect(stateInSets(c.followed, c.requested, 'u1')).toBe('none');
    // Inputs are never mutated.
    expect(empty.size).toBe(0);
  });
});

describe('soft login wall', () => {
  it('shows after every N battles seen, for guests only', () => {
    expect(nextGuestWallAt(0)).toBe(GUEST_WALL_EVERY);
    expect(nextGuestWallAt(2)).toBe(GUEST_WALL_EVERY * 3);
    expect(shouldShowGuestWall({ isGuest: true, seen: GUEST_WALL_EVERY - 1, dismissals: 0 })).toBe(false);
    expect(shouldShowGuestWall({ isGuest: true, seen: GUEST_WALL_EVERY, dismissals: 0 })).toBe(true);
    // "Not now" pushes it back by another N.
    expect(shouldShowGuestWall({ isGuest: true, seen: GUEST_WALL_EVERY, dismissals: 1 })).toBe(false);
    expect(shouldShowGuestWall({ isGuest: true, seen: GUEST_WALL_EVERY * 2, dismissals: 1 })).toBe(true);
    expect(shouldShowGuestWall({ isGuest: false, seen: 1000, dismissals: 0 })).toBe(false);
  });

  it('counts the furthest battle seen, so scrolling back does not count twice', () => {
    let seen = 0;
    seen = seenAfterViewable(seen, [0, 1, 2]);
    expect(seen).toBe(3);
    seen = seenAfterViewable(seen, [0, 1]);
    expect(seen).toBe(3);
    seen = seenAfterViewable(seen, [null, 5]);
    expect(seen).toBe(6);
  });
});

describe('follow notifications and battle links', () => {
  it('a follow request opens Follow requests; an acceptance opens their profile', () => {
    expect(getNotificationDestination('follow_request', 'u1')).toBe('/notifications/requests');
    expect(getNotificationDestination('follow_accept', 'u1')).toBe('/profile?userId=u1');
    expect(getNotificationTag('follow_request').label).toBe('Request');
  });

  it('battle likes, comments and results open that battle', () => {
    for (const t of ['match_like', 'match_comment', 'contest-win', 'contest-loss']) {
      expect(getNotificationDestination(t, 'm 1'), t).toBe('/battle/m%201');
    }
    expect(getNotificationDestination('match_like', null)).toBe('/home');
  });

  it('sign-up has one entry point', () => {
    expect(signupHref('/battle/m1')).toBe('/auth/signup');
  });
});
