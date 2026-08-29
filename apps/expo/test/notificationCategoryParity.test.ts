/**
 * The notification type → category map is duplicated: the worker owns the
 * authoritative copy (it decides whether a push is actually sent) and the client
 * needs the same mapping for the preferences screen and the Android channel id.
 *
 * Both files have carried a "keep in sync" comment for a while, and it did not
 * work — `match_active` ("someone joined your battle, voting is open") was missing
 * from both, so it silently fell back to `social`. Muting likes and follows also
 * muted your own battle going live, and the push landed on the `social` Android
 * channel, so the OS-level per-category controls were wrong too.
 *
 * A comment cannot fail CI. This can.
 */
import { describe, it, expect } from 'vitest';

import {
  CATEGORY_BY_TYPE as CLIENT_MAP,
  NOTIFICATION_CATEGORIES,
  categoryForType as clientCategoryForType,
} from '@/src/services/notifications/notificationMeta';
// Imported across the monorepo on purpose: comparing against a copy of the
// worker's map would defeat the point of the test.
import {
  CATEGORY_BY_TYPE as WORKER_MAP,
  categoryForType as workerCategoryForType,
} from '../../worker/src/lib/notificationPrefs';

describe('notification category map parity between client and worker', () => {
  it('covers exactly the same notification types', () => {
    expect(Object.keys(CLIENT_MAP).sort()).toEqual(Object.keys(WORKER_MAP).sort());
  });

  it('assigns every type to the same category', () => {
    const drift = Object.keys(WORKER_MAP)
      .filter((type) => CLIENT_MAP[type] !== WORKER_MAP[type])
      .map((type) => `${type}: worker=${WORKER_MAP[type]} client=${CLIENT_MAP[type]}`);
    expect(drift).toEqual([]);
  });

  it('agrees on the fallback for an unknown type', () => {
    expect(clientCategoryForType('some_future_type')).toBe('social');
    expect(workerCategoryForType('some_future_type')).toBe('social');
  });

  it('only uses categories the settings screen can actually display', () => {
    // A type mapped to a category with no row in NOTIFICATION_CATEGORIES would be
    // unmutable: gated server-side by a toggle the user is never shown.
    const shown = new Set(NOTIFICATION_CATEGORIES.map((c) => c.key));
    const orphaned = [...new Set(Object.values(WORKER_MAP))].filter((c) => !shown.has(c));
    expect(orphaned).toEqual([]);
  });

  it('maps the two types that were previously unmapped', () => {
    // Explicit guard so a future refactor cannot quietly drop them back to the
    // fallback while keeping the two maps in agreement.
    expect(workerCategoryForType('match_active')).toBe('contest');
    expect(workerCategoryForType('level_up')).toBe('social');
  });
});
