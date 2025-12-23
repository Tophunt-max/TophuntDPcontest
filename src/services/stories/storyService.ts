import { 
  collection, 
  query, 
  where, 
  getDocs, 
  setDoc,
  Timestamp, 
  serverTimestamp,
  doc,
  getDoc,
  orderBy,
  limit,
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { firestore as db, auth, functions } from '../firebase/initFirebase';
import { Story, UserStories } from '@/src/types/stories';

// Cache for seen status to avoid redundant DB calls in short time
let seenStatusCache: Record<string, { seen: boolean, timestamp: number }> = {};
const CACHE_DURATION = 60000; // 1 minute

export const fetchStories = async (): Promise<UserStories[]> => {
  try {
    const user = auth.currentUser;
    if (!user) return [];

    const now = Timestamp.now();
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    
    // 1. Fetch stories
    const storiesRef = collection(db, 'stories');
    const q = query(
      storiesRef, 
      where('expiresAt', '>', now),
      limit(100) // Reduced limit for faster response
    );

    // 2. Fetch seen status for current user in the last 24 hours
    const viewsRef = collection(db, 'storyViews');
    const viewsQuery = query(
      viewsRef,
      where('viewerUid', '==', user.uid),
      where('viewedAt', '>', Timestamp.fromDate(twentyFourHoursAgo))
    );

    // Execute queries in parallel
    const [querySnapshot, viewsSnapshot] = await Promise.all([
      getDocs(q),
      getDocs(viewsQuery)
    ]);

    const seenStoryIds = new Set(viewsSnapshot.docs.map(d => d.data().storyId));
    
    const stories: Story[] = [];
    querySnapshot.forEach((doc) => {
      const data = doc.data();
      stories.push({ 
        id: doc.id, 
        ...data,
        seen: seenStoryIds.has(doc.id)
      } as Story);
    });

    // Grouping by userId
    const groupedStories: Record<string, Story[]> = {};
    stories.forEach((story) => {
      if (!groupedStories[story.userId]) {
        groupedStories[story.userId] = [];
      }
      groupedStories[story.userId].push(story);
    });

    const userStoriesList: UserStories[] = [];
    
    for (const userId in groupedStories) {
      const userStories = groupedStories[userId];
      
      // Sort each user's stories by time
      userStories.sort((a, b) => {
        const timeA = (a.createdAt as any)?.seconds || 0;
        const timeB = (b.createdAt as any)?.seconds || 0;
        return timeA - timeB; // Oldest first for viewing sequence
      });

      const firstStory = userStories[0];

      userStoriesList.push({
        userId,
        username: (firstStory as any).username || 'Unknown',
        avatarUrl: (firstStory as any).avatarUrl || `https://ui-avatars.com/api/?name=${(firstStory as any).username || 'U'}`,
        stories: userStories,
        hasUnseen: userStories.some(s => !s.seen)
      });
    }

    // Sort users: Unseen first, then by the time of their latest story
    return userStoriesList.sort((a, b) => {
      if (a.hasUnseen && !b.hasUnseen) return -1;
      if (!a.hasUnseen && b.hasUnseen) return 1;
      
      const latestA = (a.stories[a.stories.length - 1].createdAt as any)?.seconds || 0;
      const latestB = (b.stories[b.stories.length - 1].createdAt as any)?.seconds || 0;
      return latestB - latestA;
    });

  } catch (error) {
    console.error("fetchStories error:", error);
    return [];
  }
};

export const createStoryRecord = async (mediaUrl: string, mediaType: 'image' | 'video') => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');

  const createStoryFn = httpsCallable(functions, 'createStory');

  try {
    const result = await createStoryFn({ mediaUrl, mediaType });
    const data = result.data as any;
    
    if (data && data.success) {
      return data.storyId;
    } else {
      throw new Error(data?.message || "Failed to create story record on server");
    }
  } catch (error: any) {
    throw new Error(`Cloud Function Error (${error.code}): ${error.message}`);
  }
};

export const markStoryAsSeen = async (storyId: string) => {
  const user = auth.currentUser;
  if (!user) return;

  try {
    const viewRef = doc(db, 'storyViews', `${storyId}_${user.uid}`);
    await setDoc(viewRef, {
      viewerUid: user.uid,
      storyId,
      viewedAt: serverTimestamp()
    });
  } catch (err) {
    console.error("markStoryAsSeen error:", err);
  }
};
