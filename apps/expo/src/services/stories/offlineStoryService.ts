import { Q, type Model } from '@nozbe/watermelondb';
import NetInfo from '@react-native-community/netinfo';

import {
  database,
  StoryModel,
  UserStoryModel,
  PendingActionModel,
  type PendingActionType,
} from '@/src/database';
import { Story, UserStories, storyMediaKind } from '@/src/types/stories';
import { auth } from '../firebase/initFirebase';

/**
 * Offline Story Service — local caching and sync for stories.
 *
 * Two WatermelonDB rules this file has to respect:
 *
 * 1. `create()` / `update()` take an **updater function**, never an object
 *    literal. `collection.create({ ... })` silently does nothing useful.
 * 2. `database.write()` blocks cannot nest. Anything that needs several records
 *    written together resolves its reads first, then emits one batch.
 *
 * Also note `collection.find(id)` **rejects** when the record is absent — it
 * does not resolve to null — hence `findOrNull` below.
 */

// ============================================
// Helpers
// ============================================

/** `find()` that resolves to null instead of rejecting when absent. */
async function findOrNull<T extends Model>(
  tableName: string,
  id: string,
): Promise<T | null> {
  try {
    return await database.get<T>(tableName).find(id);
  } catch {
    return null;
  }
}

/**
 * Copies a server Story onto a local StoryModel. Never sets `updatedAt`.
 *
 * Exported for the round-trip test in test/storyCache.test.ts. That test exists
 * because the field that broke battle stories — `matchId`/`type` being silently
 * dropped here — is exactly the kind of omission nothing else can catch: the code
 * compiled, ran, and cached a story that simply came back missing two fields.
 */
export function applyStoryFields(record: StoryModel, story: Story): void {
  record.userId = story.userId;
  record.username = story.username || '';
  record.avatarUrl = story.avatarUrl || '';
  record.mediaUrl = story.mediaUrl;
  // Normalised on the way into the cache, so a legacy `"photo"` from the contest
  // flows does not get persisted locally and re-read as a non-image.
  record.mediaType = storyMediaKind(story);
  record.createdAt = story.createdAt;
  record.expiresAt = story.expiresAt;
  record.seen = story.seen || false;
  record.overlayText = story.overlayText;
  record.textPosition = story.textPosition ? JSON.stringify(story.textPosition) : undefined;
  record.mentions = story.mentions ? JSON.stringify(story.mentions) : undefined;
  // Contest-story fields. These were previously dropped on the way into the
  // cache, so a battle story served from the cache came back without its
  // `matchId`/`type` and the viewer rendered it as a single photo — showing only
  // that user's own entry instead of the merged VS frame. `?? undefined` keeps a
  // null from the API out of a non-null local column.
  record.matchId = story.matchId ?? undefined;
  record.type = story.type ?? undefined;
  record.contestTitle = story.contestTitle ?? undefined;
  record.isSynced = true;
}

function applyUserStoryFields(record: UserStoryModel, userStories: UserStories): void {
  record.userId = userStories.userId;
  record.username = userStories.username;
  // The local column is non-null; empty string means "no photo".
  record.avatarUrl = userStories.avatarUrl || '';
  record.hasUnseen = userStories.hasUnseen || false;
  record.lastFetched = Date.now();
  record.stories = JSON.stringify(userStories.stories.map((s) => s.id));
}

/** Map a cached StoryModel back to the API-shaped Story. Exported for tests. */
export function mapStoryModelToStory(storyModel: StoryModel): Story {
  return {
    id: storyModel.id,
    userId: storyModel.userId,
    username: storyModel.username,
    avatarUrl: storyModel.avatarUrl,
    mediaUrl: storyModel.mediaUrl,
    mediaType: storyModel.mediaType,
    createdAt: storyModel.createdAt,
    expiresAt: storyModel.expiresAt,
    seen: storyModel.seen,
    overlayText: storyModel.overlayText,
    textPosition: storyModel.getTextPosition(),
    mentions: storyModel.getMentions(),
    // Restore the contest-story fields so a cached battle story still resolves
    // through isVsStory() to the head-to-head frame.
    type: storyModel.type as Story['type'],
    matchId: storyModel.matchId ?? null,
    contestTitle: storyModel.contestTitle ?? null,
  };
}

// ============================================
// Local writes
// ============================================

/**
 * Persist one user's story group plus all of its stories in a single write.
 *
 * The record id is set to the server id (`_raw.id`) so repeat fetches update in
 * place rather than duplicating, and `find(storyId)` / `find(userId)` work.
 */
export const saveUserStoriesLocally = async (userStories: UserStories): Promise<void> => {
  try {
    const storiesCollection = database.get<StoryModel>('stories');
    const userStoriesCollection = database.get<UserStoryModel>('user_stories');

    // Resolve everything that already exists BEFORE opening the write block.
    const storyIds = userStories.stories.map((s) => s.id);
    const existingStories = storyIds.length
      ? await storiesCollection.query(Q.where('id', Q.oneOf(storyIds))).fetch()
      : [];
    const existingStoryById = new Map(existingStories.map((s) => [s.id, s]));
    const existingUser = await findOrNull<UserStoryModel>('user_stories', userStories.userId);

    await database.write(async () => {
      const batch: Model[] = [];

      batch.push(
        existingUser
          ? existingUser.prepareUpdate((r) => applyUserStoryFields(r, userStories))
          : userStoriesCollection.prepareCreate((r) => {
              r._raw.id = userStories.userId;
              applyUserStoryFields(r, userStories);
            }),
      );

      for (const story of userStories.stories) {
        const existing = existingStoryById.get(story.id);
        batch.push(
          existing
            ? existing.prepareUpdate((r) => applyStoryFields(r, story))
            : storiesCollection.prepareCreate((r) => {
                r._raw.id = story.id;
                applyStoryFields(r, story);
              }),
        );
      }

      await database.batch(batch);
    });
  } catch (error) {
    console.error('[saveUserStoriesLocally] Error:', error);
  }
};

/** Persist a single story. */
export const saveStoryLocally = async (story: Story): Promise<void> => {
  try {
    const storiesCollection = database.get<StoryModel>('stories');
    const existing = await findOrNull<StoryModel>('stories', story.id);

    await database.write(async () => {
      if (existing) {
        await existing.update((r) => applyStoryFields(r, story));
      } else {
        await storiesCollection.create((r) => {
          r._raw.id = story.id;
          applyStoryFields(r, story);
        });
      }
    });
  } catch (error) {
    console.error('[saveStoryLocally] Error:', error);
  }
};

// ============================================
// Local reads
// ============================================

export const getUserStoriesLocally = async (): Promise<UserStories[]> => {
  try {
    const userStoriesModels = await database
      .get<UserStoryModel>('user_stories')
      .query()
      .fetch();

    const result: UserStories[] = [];

    for (const userStory of userStoriesModels) {
      const storyIds = userStory.getStoryIds();
      if (!storyIds.length) continue;

      const stories = await database
        .get<StoryModel>('stories')
        .query(Q.where('id', Q.oneOf(storyIds)))
        .fetch();

      const validStories = stories.filter((s) => !s.isExpired());
      if (!validStories.length) continue;

      result.push({
        userId: userStory.userId,
        username: userStory.username,
        avatarUrl: userStory.avatarUrl || null,
        // Preserve the server's chronological order within a user's group.
        stories: validStories
          .map(mapStoryModelToStory)
          .sort((a, b) => a.createdAt - b.createdAt),
        hasUnseen: userStory.hasUnseen,
      });
    }

    return result;
  } catch (error) {
    console.error('[getUserStoriesLocally] Error:', error);
    return [];
  }
};

export const getUserStoriesByUserIdLocally = async (
  userId: string,
): Promise<UserStories | null> => {
  try {
    const userStory = await findOrNull<UserStoryModel>('user_stories', userId);
    if (!userStory) return null;

    const storyIds = userStory.getStoryIds();
    const stories = storyIds.length
      ? await database.get<StoryModel>('stories').query(Q.where('id', Q.oneOf(storyIds))).fetch()
      : [];

    const validStories = stories.filter((s) => !s.isExpired());

    return {
      userId: userStory.userId,
      username: userStory.username,
      avatarUrl: userStory.avatarUrl || null,
      stories: validStories
        .map(mapStoryModelToStory)
        .sort((a, b) => a.createdAt - b.createdAt),
      hasUnseen: userStory.hasUnseen,
    };
  } catch (error) {
    console.error('[getUserStoriesByUserIdLocally] Error:', error);
    return null;
  }
};

// ============================================
// Optimistic local mutations
// ============================================

/**
 * Mark a story seen locally. Does NOT queue a pending action — the caller
 * (`storyService.markStoryAsSeen`) owns the queue, and queueing here as well
 * enqueued every successful view a second time.
 */
export const markStoryAsSeenLocally = async (storyId: string): Promise<void> => {
  try {
    const story = await findOrNull<StoryModel>('stories', storyId);
    if (!story) return;
    await database.write(async () => {
      await story.update((r) => {
        r.seen = true;
      });
    });
  } catch (error) {
    console.error('[markStoryAsSeenLocally] Error:', error);
  }
};

/**
 * Record a reaction locally. Reactions live server-side only, so there is no
 * local column to update; this exists so the caller has a single place to hook
 * optimistic UI into later.
 */
export const reactToStoryLocally = async (_storyId: string, _emoji: string): Promise<void> => {
  // Intentionally a no-op for now — see note above. Kept so the call sites in
  // storyService stay symmetrical with markStoryAsSeenLocally.
};

// ============================================
// Pending action queue
// ============================================

export const queuePendingAction = async (action: {
  type: PendingActionType;
  storyId: string;
  userId: string;
  data: any;
}): Promise<void> => {
  try {
    await database.write(async () => {
      await database.get<PendingActionModel>('pending_actions').create((r) => {
        r.type = action.type;
        r.storyId = action.storyId;
        r.userId = action.userId;
        r.data = JSON.stringify(action.data ?? {});
        r.timestamp = Date.now();
        r.retries = 0;
      });
    });
  } catch (error) {
    console.error('[queuePendingAction] Error:', error);
  }
};

export const getPendingActions = async (): Promise<PendingActionModel[]> => {
  try {
    return await database
      .get<PendingActionModel>('pending_actions')
      .query(Q.sortBy('timestamp', Q.asc))
      .fetch();
  } catch (error) {
    console.error('[getPendingActions] Error:', error);
    return [];
  }
};

export const removePendingAction = async (actionId: string): Promise<void> => {
  try {
    const action = await findOrNull<PendingActionModel>('pending_actions', actionId);
    if (!action) return;
    await database.write(async () => {
      await action.destroyPermanently();
    });
  } catch (error) {
    console.error('[removePendingAction] Error:', error);
  }
};

// ============================================
// Housekeeping
// ============================================

export const clearExpiredStories = async (): Promise<void> => {
  try {
    const expiredStories = await database
      .get<StoryModel>('stories')
      .query(Q.where('expires_at', Q.lt(Date.now())))
      .fetch();
    if (!expiredStories.length) return;

    await database.write(async () => {
      await database.batch(expiredStories.map((s) => s.prepareDestroyPermanently()));
    });
  } catch (error) {
    console.error('[clearExpiredStories] Error:', error);
  }
};

/** Drop queued actions older than a week — they will never usefully replay. */
export const clearOldPendingActions = async (): Promise<void> => {
  try {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const oldActions = await database
      .get<PendingActionModel>('pending_actions')
      .query(Q.where('timestamp', Q.lt(oneWeekAgo)))
      .fetch();
    if (!oldActions.length) return;

    await database.write(async () => {
      await database.batch(oldActions.map((a) => a.prepareDestroyPermanently()));
    });
  } catch (error) {
    console.error('[clearOldPendingActions] Error:', error);
  }
};

// ============================================
// Sync
// ============================================

/** Give up on an action after this many failed replays. */
const MAX_SYNC_RETRIES = 5;

export const syncPendingActions = async (): Promise<void> => {
  try {
    const actions = await getPendingActions();
    if (!actions.length) return;

    // Imported lazily to break the storyService <-> offlineStoryService cycle.
    const { markStoryAsSeen, reactToStory } = await import('./storyService');

    for (const action of actions) {
      try {
        switch (action.type) {
          case 'view':
            await markStoryAsSeen(action.storyId, { queueOnFailure: false });
            break;
          case 'reaction': {
            const emoji = action.getData().emoji;
            if (emoji) {
              await reactToStory(action.storyId, emoji, { queueOnFailure: false });
            }
            break;
          }
          default:
            // Unknown/unsupported type — drop it rather than retry forever.
            break;
        }
        await removePendingAction(action.id);
      } catch (error) {
        console.error(`[syncPendingActions] Failed to sync action ${action.id}:`, error);
        if (action.retries + 1 >= MAX_SYNC_RETRIES) {
          await removePendingAction(action.id);
          continue;
        }
        await database.write(async () => {
          await action.update((r) => {
            r.retries = r.retries + 1;
          });
        });
      }
    }
  } catch (error) {
    console.error('[syncPendingActions] Error:', error);
  }
};

/**
 * Sync if we have connectivity.
 *
 * Uses NetInfo — the same source as OfflineBanner and useOnlineStatus. The
 * previous implementation issued a HEAD request to google.com, which leaks a
 * request to a third party and reports "offline" on any captive portal.
 */
export const checkAndSync = async (): Promise<void> => {
  try {
    if (!auth.currentUser) return;
    const state = await NetInfo.fetch();
    if (!state.isConnected) return;
    await syncPendingActions();
  } catch (error) {
    console.error('[checkAndSync] Error:', error);
  }
};
