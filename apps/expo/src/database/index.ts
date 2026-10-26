// The on-device database (WatermelonDB): SQLite on iOS/Android, LokiJS +
// IndexedDB on web. What lives here, and what must never, is documented in
// docs/LOCAL_DATA.md.
import { Database } from '@nozbe/watermelondb';

import { createAdapter } from './adapter';
import { flushAdapter, installFlushOnHide } from './flush';
import { recoverFromSetUpError, registerRecovery } from './health';
import { StoryModel } from './models/StoryModel';
import { UserStoryModel } from './models/UserStoryModel';
import { PendingActionModel } from './models/PendingActionModel';
import { FeedSnapshotModel } from './models/FeedSnapshotModel';
import { OutboxOpModel } from './models/OutboxOpModel';

const adapter = createAdapter();

export const database = new Database({
  adapter,
  modelClasses: [StoryModel, UserStoryModel, PendingActionModel, FeedSnapshotModel, OutboxOpModel],
});

// A setup failure (corrupt file, failed migration) gets one guarded reset.
registerRecovery(() => recoverFromSetUpError(database));
// Web: persist pending changes when the tab is hidden (native: no-op).
installFlushOnHide(adapter);

/**
 * Make sure every completed write is on disk. Native SQLite already is; on web
 * this saves Loki's in-memory changes to IndexedDB now rather than at the next
 * autosave tick. Used after sign-out so a wipe cannot be undone by closing the
 * tab immediately. Never throws.
 */
export function flushLocalDatabase(): Promise<boolean> {
  return flushAdapter(adapter).catch(() => false);
}

export { getDatabaseHealth } from './health';
export { StoryModel, UserStoryModel, PendingActionModel, FeedSnapshotModel, OutboxOpModel };
export type { PendingActionType, PendingActionData } from './models/PendingActionModel';
