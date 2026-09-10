/**
 * `prize-claim` is the notification that tells somebody they won a physical prize
 * and must supply a delivery address before it can be sent. It was emitted by the
 * Worker with no client handling at all, which meant two silent failures:
 *
 *  - it was absent from BOTH category maps, so it fell back to `social` — muting
 *    likes and follows also muted the message about a parcel, and the push landed
 *    on the `social` Android channel;
 *  - `getNotificationDestination` returned null for it, so tapping the one
 *    notification in the app that asks the user to DO something went nowhere (the
 *    in-app row) or to the notification list (the OS tray).
 *
 * The parity test covers the category. These cover the routing.
 */
import { describe, it, expect } from 'vitest';

import {
  categoryForType,
  getNotificationDestination,
  getNotificationTag,
} from '@/src/services/notifications/notificationMeta';

describe('prize-claim notification routing', () => {
  it('deep-links to the specific prize using the match id in targetId', () => {
    // The Worker sends `prize:<matchId>`; the claim's own id is
    // `prize_claim:<matchId>`, so the match id is the addressable part.
    expect(getNotificationDestination('prize-claim', 'prize:match_123')).toBe('/prizes/match_123');
  });

  it('falls back to the prize list rather than nowhere', () => {
    // A row with no targetId, or one whose shape changed, must still land the user
    // somewhere they can act — this is the notification that gates a delivery.
    expect(getNotificationDestination('prize-claim', null)).toBe('/prizes');
    expect(getNotificationDestination('prize-claim', undefined)).toBe('/prizes');
    expect(getNotificationDestination('prize-claim', 'match_123')).toBe('/prizes');
  });

  it('still lets an explicit admin url win', () => {
    expect(getNotificationDestination('prize-claim', 'prize:m1', '/wallet')).toBe('/wallet');
  });

  it('is categorised as a contest notification, not social', () => {
    expect(categoryForType('prize-claim')).toBe('contest');
  });

  it('has its own badge rather than the generic Update pill', () => {
    const tag = getNotificationTag('prize-claim');
    expect(tag.label).toBe('Prize');
    expect(tag.icon).not.toBe('notifications');
  });
});
