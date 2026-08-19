import { database, StoryModel, UserStoryModel, PendingActionModel } from '@/src/database';
import { Story, UserStories } from '@/src/types/stories';
import { auth } from '../firebase/initFirebase';
import { Q } from '@nozbe/watermelondb';

/**
 * Offline Story Service - Handles local caching and sync for stories
 */

// ============================================
// Local Database Operations
// ============================================

/**
 * Save a story to local database
 */
export const saveStoryLocally = async (story: Story): Promise<void> => {
  try {
    await database.write(async () => {
      const existing = await database
        .get<StoryModel>('stories')
        .find(story.id);

      if (existing) {
        await existing.update({
          id: story.id,
          userId: story.userId,
          username: story.username || '',
          avatarUrl: story.avatarUrl || '',
          mediaUrl: story.mediaUrl,
          mediaType: story.mediaType,
          createdAt: story.createdAt.toMillis(),
          expiresAt: story.expiresAt.toMillis(),
          seen: story.seen || false,
          overlayText: story.overlayText,
          textPosition: story.textPosition ? JSON.stringify(story.textPosition) : undefined,
          mentions: story.mentions ? JSON.stringify(story.mentions) : undefined,
          isSynced: true,
          updatedAt: Date.now(),
        });
      } else {
        await database.get<StoryModel>('stories').create({
          id: story.id,
          userId: story.userId,
          username: story.username || '',
          avatarUrl: story.avatarUrl || '',
          mediaUrl: story.mediaUrl,
          mediaType: story.mediaType,
          createdAt: story.createdAt.toMillis(),
          expiresAt: story.expiresAt.toMillis(),
          seen: story.seen || false,
          overlayText: story.overlayText,
          textPosition: story.textPosition ? JSON.stringify(story.textPosition) : undefined,
          mentions: story.mentions ? JSON.stringify(story.mentions) : undefined,
          isSynced: true,
          updatedAt: Date.now(),
        });
      }
    });
  } catch (error) {
    console.error('[saveStoryLocally] Error:', error);
  }
};

/**
 * Save user stories to local database
 */
export const saveUserStoriesLocally = async (userStories: UserStories): Promise<void> => {
  try {
    await database.write(async () => {
      const existing = await database
        .get<UserStoryModel>('user_stories')
        .find(userStories.userId);

      if (existing) {
        await existing.update({
          userId: userStories.userId,
          username: userStories.username,
          avatarUrl: userStories.avatarUrl,
          hasUnseen: userStories.hasUnseen || false,
          lastFetched: Date.now(),
          stories: JSON.stringify(userStories.stories.map(s => s.id)),
        });
      } else {
        await database.get<UserStoryModel>('user_stories').create({
          userId: userStories.userId,
          username: userStories.username,
          avatarUrl: userStories.avatarUrl,
          hasUnseen: userStories.hasUnseen || false,
          lastFetched: Date.now(),
          stories: JSON.stringify(userStories.stories.map(s => s.id)),
        });
      }

      // Save all stories
      for (const story of userStories.stories) {
        await saveStoryLocally(story);
      }
    });
  } catch (error) {
    console.error('[saveUserStoriesLocally] Error:', error);
  }
};

/**
 * Get all user stories from local database
 */
export const getUserStoriesLocally = async (): Promise<UserStories[]> => {
  try {
    const userStoriesModels = await database
      .get<UserStoryModel>('user_stories')
      .query()
      .fetch();

    const result: UserStories[] = [];

    for (const userStory of userStoriesModels) {
      const storyIds = userStory.getStoryIds();
      const stories = await database
        .get<StoryModel>('stories')
        .query(Q.where('id', Q.oneOf(storyIds)))
        .fetch();

      // Filter expired stories
      const validStories = stories.filter(s => !s.isExpired());

      if (validStories.length > 0) {
        result.push({
          userId: userStory.userId,
          username: userStory.username,
          avatarUrl: userStory.avatarUrl,
          stories: validStories.map(mapStoryModelToStory),
          hasUnseen: userStory.hasUnseen,
        });
      }
    }

    return result;
  } catch (error) {
    console.error('[getUserStoriesLocally] Error:', error);
    return [];
  }
};

/**
 * Get a specific user's stories from local database
 */
export const getUserStoriesByUserIdLocally = async (userId: string): Promise<UserStories | null> => {
  try {
    const userStory = await database
      .get<UserStoryModel>('user_stories')
      .find(userId);

    if (!userStory) return null;

    const storyIds = userStory.getStoryIds();
    const stories = await database
      .get<StoryModel>('stories')
      .query(Q.where('id', Q.oneOf(storyIds)))
      .fetch();

    // Filter expired stories
    const validStories = stories.filter(s => !s.isExpired());

    return {
      userId: userStory.userId,
      username: userStory.username,
      avatarUrl: userStory.avatarUrl,
      stories: validStories.map(mapStoryModelToStory),
      hasUnseen: userStory.hasUnseen,
    };
  } catch (error) {
    console.error('[getUserStoriesByUserIdLocally] Error:', error);
    return null;
  }
};

/**
 * Mark a story as seen locally
 */
export const markStoryAsSeenLocally = async (storyId: string): Promise<void> => {
  try {
    await database.write(async () => {
      const story = await database.get<StoryModel>('stories').find(storyId);
      if (story) {
        await story.update({
          seen: true,
          updatedAt: Date.now(),
        });
      }

      // Queue for sync
      await queuePendingAction({
        type: 'view',
        storyId,
        userId: auth.currentUser?.uid || '',
        data: {},
      });
    });
  } catch (error) {
    console.error('[markStoryAsSeenLocally] Error:', error);
  }
};

/**
 * Add a reaction to a story locally
 */
export const reactToStoryLocally = async (storyId: string, emoji: string): Promise<void> => {
  try {
    await database.write(async () => {
      // Queue for sync
      await queuePendingAction({
        type: 'reaction',
        storyId,
        userId: auth.currentUser?.uid || '',
        data: { emoji },
      });
    });
  } catch (error) {
    console.error('[reactToStoryLocally] Error:', error);
  }
};

/**
 * Queue a pending action for sync when online
 */
export const queuePendingAction = async (action: {
  type: PendingActionType;
  storyId: string;
  userId: string;
  data: any;
}): Promise<void> => {
  try {
    await database.write(async () => {
      await database.get<PendingActionModel>('pending_actions').create({
        id: `${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        type: action.type,
        storyId: action.storyId,
        userId: action.userId,
        data: JSON.stringify(action.data),
        timestamp: Date.now(),
        retries: 0,
      });
    });
  } catch (error) {
    console.error('[queuePendingAction] Error:', error);
  }
};

/**
 * Get all pending actions
 */
export const getPendingActions = async (): Promise<PendingActionModel[]> => {
  try {
    return await database
      .get<PendingActionModel>('pending_actions')
      .query()
      .fetch();
  } catch (error) {
    console.error('[getPendingActions] Error:', error);
    return [];
  }
};

/**
 * Remove a pending action after successful sync
 */
export const removePendingAction = async (actionId: string): Promise<void> => {
  try {
    await database.write(async () => {
      const action = await database.get<PendingActionModel>('pending_actions').find(actionId);
      if (action) {
        await action.destroyPermanently();
      }
    });
  } catch (error) {
    console.error('[removePendingAction] Error:', error);
  }
};

/**
 * Clear expired stories from local database
 */
export const clearExpiredStories = async (): Promise<void> => {
  try {
    await database.write(async () => {
      const expiredStories = await database
        .get<StoryModel>('stories')
        .query(Q.where('expires_at', Q.lt(Date.now())))
        .fetch();

      for (const story of expiredStories) {
        await story.destroyPermanently();
      }
    });
  } catch (error) {
    console.error('[clearExpiredStories] Error:', error);
  }
};

/**
 * Clear old pending actions (older than 7 days)
 */
export const clearOldPendingActions = async (): Promise<void> => {
  try {
    const oneWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    await database.write(async () => {
      const oldActions = await database
        .get<PendingActionModel>('pending_actions')
        .query(Q.where('timestamp', Q.lt(oneWeekAgo)))
        .fetch();

      for (const action of oldActions) {
        await action.destroyPermanently();
      }
    });
  } catch (error) {
    console.error('[clearOldPendingActions] Error:', error);
  }
};

// ============================================
// Helper Functions
// ============================================

/**
 * Map StoryModel to Story type
 */
function mapStoryModelToStory(storyModel: StoryModel): Story {
  return {
    id: storyModel.id,
    userId: storyModel.userId,
    username: storyModel.username,
    avatarUrl: storyModel.avatarUrl,
    mediaUrl: storyModel.mediaUrl,
    mediaType: storyModel.mediaType,
    createdAt: { seconds: Math.floor(storyModel.createdAt / 1000), nanoseconds: 0 } as any,
    expiresAt: { seconds: Math.floor(storyModel.expiresAt / 1000), nanoseconds: 0 } as any,
    seen: storyModel.seen,
    overlayText: storyModel.overlayText,
    textPosition: storyModel.getTextPosition(),
    mentions: storyModel.getMentions(),
  };
}

// ============================================
// Sync Functions
// ============================================

/**
 * Sync local changes with server when online
 */
export const syncPendingActions = async (): Promise<void> => {
  try {
    const actions = await getPendingActions();
    
    for (const action of actions) {
      try {
        // Import here to avoid circular dependency
        const { markStoryAsSeen, reactToStory } = await import('./storyService');

        switch (action.type) {
          case 'view':
            await markStoryAsSeen(action.storyId);
            break;
          case 'reaction':
            const data = action.getData();
            await reactToStory(action.storyId, data.emoji || '');
            break;
          // Add other action types as needed
        }

        // Remove successful action
        await removePendingAction(action.id);
      } catch (error) {
        console.error(`[syncPendingActions] Failed to sync action ${action.id}:`, error);
        // Increment retries
        await database.write(async () => {
          await action.update({
            retries: action.retries + 1,
          });
        });
      }
    }
  } catch (error) {
    console.error('[syncPendingActions] Error:', error);
  }
};

/**
 * Check if we're online and sync if needed
 */
export const checkAndSync = async (): Promise<void> => {
  try {
    // Simple online check
    const isOnline = await fetch('https://www.google.com', { method: 'HEAD' })
      .then(() => true)
      .catch(() => false);

    if (isOnline) {
      await syncPendingActions();
    }
  } catch (error) {
    console.error('[checkAndSync] Error:', error);
  }
};
