// Database setup for WatermelonDB (local stories cache).
import { Database } from '@nozbe/watermelondb';

import { adapter } from './adapter';
import { StoryModel } from './models/StoryModel';
import { UserStoryModel } from './models/UserStoryModel';
import { PendingActionModel } from './models/PendingActionModel';
import { FeedSnapshotModel } from './models/FeedSnapshotModel';

export const database = new Database({
  adapter,
  modelClasses: [StoryModel, UserStoryModel, PendingActionModel, FeedSnapshotModel],
});

export { StoryModel, UserStoryModel, PendingActionModel, FeedSnapshotModel };
export type { PendingActionType, PendingActionData } from './models/PendingActionModel';
