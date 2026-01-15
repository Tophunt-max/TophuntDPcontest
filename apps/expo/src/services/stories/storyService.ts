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
  updateDoc,
  deleteDoc,
  startAfter,
  QueryDocumentSnapshot,
  addDoc,
  increment
} from 'firebase/firestore';
import { firestore as db, auth } from '../firebase/initFirebase'; // FIXED: Importing firestore alias
import { Story, UserStories } from '@/src/types/stories';
import { callApi } from '../api'; 
import { Image } from 'expo-image';
import { StatusMediaService } from '../media/StatusMediaService';
import { prefetchMedia } from '../media/MediaCacheService';
import { getOptimizedMediaUrl } from '../../utils/media';

const STORY_LIMIT = 20;

/**
 * 1. UNIFIED STORY FETCHING
 * Fetches stories from the unified 'stories' collection.
 */
export const fetchStories = async (lastVisible?: QueryDocumentSnapshot): Promise<{ userStories: UserStories[], lastDoc: QueryDocumentSnapshot | null }> => {
  try {
    const user = auth.currentUser;
    if (!user) return { userStories: [], lastDoc: null };

    // Safety check for firestore instance
    if (!db) {
        console.error("[fetchStories] Firestore instance 'db' is undefined");
        return { userStories: [], lastDoc: null };
    }

    const now = Timestamp.now();
    const storiesRef = collection(db, 'stories');
    
    let q = query(
      storiesRef, 
      where('expiresAt', '>', now),
      orderBy('expiresAt', 'desc'),
      limit(STORY_LIMIT)
    );

    if (lastVisible) {
      q = query(q, startAfter(lastVisible));
    }

    const querySnapshot = await getDocs(q);
    if (querySnapshot.empty) return { userStories: [], lastDoc: null };

    const rawStories: Story[] = [];
    querySnapshot.forEach((docSnap) => {
      const data = docSnap.data();
      const storyData = { id: docSnap.id, ...data } as Story;
      rawStories.push(storyData);
      
      // Prefetching for performance
      if (storyData.mediaUrl) {
          const optimizedUrl = getOptimizedMediaUrl(storyData.mediaUrl);
          if (storyData.mediaType === 'image') {
              Image.prefetch(optimizedUrl);
          } else {
              prefetchMedia(optimizedUrl);
          }
      }
    });

    // Group stories by user
    const groupedStories: Record<string, Story[]> = {};
    rawStories.forEach((story) => {
      if (!groupedStories[story.userId]) {
        groupedStories[story.userId] = [];
      }
      groupedStories[story.userId].push(story);
    });

    const userStoriesList: UserStories[] = Object.keys(groupedStories).map(userId => ({
      userId,
      username: groupedStories[userId][0].username,
      avatarUrl: groupedStories[userId][0].avatarUrl,
      stories: groupedStories[userId].sort((a, b) => a.createdAt.seconds - b.createdAt.seconds),
      hasUnseen: true 
    }));

    // Put current user stories at the beginning
    const sortedList = userStoriesList.sort((a, b) => {
        if (a.userId === user.uid) return -1;
        if (b.userId === user.uid) return 1;
        return 0;
    });

    return { 
        userStories: sortedList, 
        lastDoc: querySnapshot.docs[querySnapshot.docs.length - 1] 
    };

  } catch (error) {
    console.error("[fetchStories] Error:", error);
    return { userStories: [], lastDoc: null };
  }
};

/**
 * 2. UNIFIED STORY CREATION (OPTIMIZED)
 */
export const createStoryRecordOptimized = async (
    uri: string,
    fileType: 'image' | 'video',
    overlayText?: string | null,
    textPosition?: { x: number, y: number } | null,
    mentions?: string[],
    onProgress?: (progress: number) => void
) => {
  const user = auth.currentUser;
  if (!user) throw new Error("Unauthenticated");

  try {
    const uploadResult = await StatusMediaService.uploadStatus(
      uri, 
      user.uid, 
      fileType === 'video',
      onProgress
    );

    const response = await callApi('storyHandler', { 
        action: 'create',
        mediaUrl: uploadResult.mediaUrl, 
        type: fileType,
        storyId: uploadResult.statusId,
        objectKey: uploadResult.objectKey,
        overlayText,
        textPosition,
        mentions
    });

    return response.storyId;
  } catch (error: any) {
    console.error("[createStoryRecordOptimized] Error:", error);
    throw error;
  }
};

export const createStoryRecord = createStoryRecordOptimized;

/**
 * 3. STORY ENGAGEMENT (VIEW / DELETE)
 */
export const markStoryAsSeen = async (storyId: string) => {
  const user = auth.currentUser;
  if (!user || !db) return;
  
  try {
    const viewRef = doc(db, 'storyViews', storyId, 'users', user.uid);
    const viewDoc = await getDoc(viewRef);
    
    if (!viewDoc.exists()) {
        await setDoc(viewRef, { 
            viewedAt: serverTimestamp(),
            uid: user.uid,
            username: user.displayName || 'User',
            avatarUrl: user.photoURL || null
        });
        callApi('storyHandler', { action: 'view', storyId }).catch(() => {});
    }
  } catch (error) {
    console.error("markStoryAsSeen error:", error);
  }
};

export const deleteStory = async (storyId: string) => {
    if (!db) return;
    try {
        await callApi('storyHandler', { action: 'delete', storyId });
        await deleteDoc(doc(db, 'stories', storyId));
    } catch (error) {
        console.error("deleteStory error:", error);
        await deleteDoc(doc(db, 'stories', storyId));
    }
};

export const fetchStoryViewers = async (storyId: string) => {
    if (!db) return { viewers: [] };
    try {
        const viewersRef = collection(db, 'storyViews', storyId, 'users');
        const q = query(viewersRef, orderBy('viewedAt', 'desc'), limit(50));
        const snapshot = await getDocs(q);
        
        const viewers = snapshot.docs.map(docSnap => ({
            uid: docSnap.id,
            ...docSnap.data()
        }));
        
        return { viewers };
    } catch (error) {
        console.error("fetchStoryViewers error:", error);
        return { viewers: [] };
    }
};

export const reactToStory = async (storyId: string, emoji: string) => {
    const user = auth.currentUser;
    if (!user || !db) return;
    try {
        const viewRef = doc(db, 'storyViews', storyId, 'users', user.uid);
        await setDoc(viewRef, { reaction: emoji, reactedAt: serverTimestamp() }, { merge: true });
    } catch (err) {
        console.error("reactToStory error:", err);
    }
};

/**
 * 4. HIGHLIGHTS MANAGEMENT
 */
export const fetchUserHighlights = async (userId: string) => {
    if (!db) return [];
    try {
        const highlightsRef = collection(db, 'users', userId, 'highlights');
        const q = query(highlightsRef, orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    } catch (error) {
        console.error("fetchUserHighlights error:", error);
        return [];
    }
};

export const createHighlight = async (name: string, coverImageUrl: string, storyIds: string[]) => {
    const user = auth.currentUser;
    if (!user || !db) throw new Error('Unauthenticated');
    const highlightsRef = collection(db, 'users', user.uid, 'highlights');
    return await addDoc(highlightsRef, { 
        name, 
        coverImageUrl, 
        storyIds, 
        createdAt: serverTimestamp() 
    });
};

export const addStoryToHighlight = async (highlightId: string, storyId: string) => {
    const user = auth.currentUser;
    if (!user || !db) return;
    try {
        const highlightRef = doc(db, 'users', user.uid, 'highlights', highlightId);
        const highlightDoc = await getDoc(highlightRef);
        if (highlightDoc.exists()) {
            const storyIds = highlightDoc.data().storyIds || [];
            if (!storyIds.includes(storyId)) {
                await updateDoc(highlightRef, { storyIds: [...storyIds, storyId] });
            }
        }
    } catch (error) {
        console.error("addStoryToHighlight error:", error);
    }
};

export const fetchStoriesByIds = async (storyIds: string[]) => {
    if (!storyIds || storyIds.length === 0 || !db) return [];
    try {
        const validStories: Story[] = [];
        const promises = storyIds.map(id => getDoc(doc(db, 'stories', id)));
        const snapshots = await Promise.all(promises);
        snapshots.forEach(snap => {
            if (snap.exists()) {
                validStories.push({ id: snap.id, ...snap.data() } as Story);
            }
        });
        return validStories;
    } catch (error) {
        console.error("fetchStoriesByIds error:", error);
        return [];
    }
};

export const fetchHighlightStories = async (userId: string, highlightId: string) => {
    if (!db) return [];
    try {
        const highlightRef = doc(db, 'users', userId, 'highlights', highlightId);
        const highlightDoc = await getDoc(highlightRef);
        if (!highlightDoc.exists()) return [];
        const storyIds = highlightDoc.data().storyIds || [];
        return await fetchStoriesByIds(storyIds);
    } catch (error) {
         console.error("fetchHighlightStories error:", error);
         return [];
    }
};
