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
  addDoc,
  documentId,
  updateDoc,
  deleteDoc
} from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { firestore as db, auth, functions } from '../firebase/initFirebase';
import { Story, UserStories } from '@/src/types/stories';

// Cache for user profile data to avoid repeated fetches
const userProfileCache: Record<string, { username: string, avatarUrl: string, timestamp: number }> = {};
const CACHE_DURATION = 5 * 60 * 1000; // 5 minutes

export const fetchStories = async (): Promise<UserStories[]> => {
  try {
    const user = auth.currentUser;
    if (!user) return [];

    console.log("[fetchStories] Started for:", user.uid);

    const now = Timestamp.now();
    const storiesRef = collection(db, 'stories');
    
    // 1. Get the latest stories first. 
    // We use a broader query and filter in memory to avoid index requirements while debugging.
    const q = query(
      storiesRef, 
      orderBy('createdAt', 'desc'),
      limit(100)
    );

    const querySnapshot = await getDocs(q);
    console.log("[fetchStories] Fetched docs count:", querySnapshot.size);

    if (querySnapshot.empty) {
        return [];
    }

    const rawStories: any[] = [];
    const uniqueUserIds = new Set<string>();
    const nowSeconds = now.seconds;

    querySnapshot.forEach((doc) => {
      const data = doc.data();
      const expiresAt = data.expiresAt;
      
      // Manual expiration check (24h)
      const isActive = expiresAt ? expiresAt.seconds > nowSeconds : (data.createdAt?.seconds + 86400) > nowSeconds;

      if (isActive) {
        rawStories.push({ 
          id: doc.id, 
          ...data,
          seen: false 
        });
        uniqueUserIds.add(data.userId);
      }
    });

    console.log("[fetchStories] Active unique users with stories:", uniqueUserIds.size);

    // 2. Fetch User Profile Data (with basic caching)
    const userDataMap: Record<string, { username: string, avatarUrl: string }> = {};
    const uidsToFetch = Array.from(uniqueUserIds).filter(uid => {
        const cached = userProfileCache[uid];
        if (cached && (Date.now() - cached.timestamp < CACHE_DURATION)) {
            userDataMap[uid] = { username: cached.username, avatarUrl: cached.avatarUrl };
            return false;
        }
        return true;
    });

    if (uidsToFetch.length > 0) {
        await Promise.all(uidsToFetch.map(async (uid) => {
            try {
                const uDoc = await getDoc(doc(db, 'users', uid));
                if (uDoc.exists()) {
                    const d = uDoc.data();
                    const info = {
                        username: d?.username || d?.fullName || 'User',
                        avatarUrl: d?.profileImageUrl || `https://ui-avatars.com/api/?name=${d?.username || 'U'}`,
                        timestamp: Date.now()
                    };
                    userProfileCache[uid] = info;
                    userDataMap[uid] = { username: info.username, avatarUrl: info.avatarUrl };
                } else {
                    userDataMap[uid] = { username: 'User', avatarUrl: 'https://ui-avatars.com/api/?name=U' };
                }
            } catch (e) {
                console.error(`Error fetching user profile for ${uid}:`, e);
                userDataMap[uid] = { username: 'User', avatarUrl: 'https://ui-avatars.com/api/?name=U' };
            }
        }));
    }

    // 3. Group and sort stories
    const groupedStories: Record<string, Story[]> = {};
    rawStories.forEach((story) => {
      if (!groupedStories[story.userId]) {
        groupedStories[story.userId] = [];
      }
      groupedStories[story.userId].push(story as Story);
    });

    const userStoriesList: UserStories[] = [];
    for (const userId in groupedStories) {
      const userStories = groupedStories[userId];
      // Sort stories for this user: oldest first (for playback)
      userStories.sort((a, b) => (a.createdAt as any)?.seconds - (b.createdAt as any)?.seconds);

      userStoriesList.push({
        userId,
        username: userDataMap[userId]?.username || 'User',
        avatarUrl: userDataMap[userId]?.avatarUrl || `https://ui-avatars.com/api/?name=U`,
        stories: userStories,
        hasUnseen: true // Simplified for now
      });
    }

    // Move current user to front if they have stories
    const currentUserIndex = userStoriesList.findIndex(us => us.userId === user.uid);
    if (currentUserIndex > -1) {
        const [currentUserStory] = userStoriesList.splice(currentUserIndex, 1);
        userStoriesList.unshift(currentUserStory);
    }

    console.log("[fetchStories] Finished. Returning list of size:", userStoriesList.length);
    return userStoriesList;

  } catch (error) {
    console.error("[fetchStories] Fatal error:", error);
    return [];
  }
};

export const createStoryRecord = async (
    mediaUrl: string, 
    mediaType: 'image' | 'video', 
    visibility: 'public' | 'followers' = 'followers',
    overlayText?: string | null,
    textPosition?: { x: number, y: number } | null,
    mentions?: string[]
) => {
  const user = auth.currentUser;
  if (!user) throw new Error('User not authenticated');

  const createStoryFn = httpsCallable(functions, 'createStory');

  try {
    const result = await createStoryFn({ 
        mediaUrl, 
        mediaType, 
        visibility,
        overlayText,
        textPosition,
        mentions
    });
    const data = result.data as any;
    
    if (data && data.success) {
      return data.storyId;
    } else {
      throw new Error(data?.message || "Failed to create story record on server.");
    }
  } catch (error: any) {
    throw new Error(`Cloud Function Error: ${error.message}`);
  }
};

export const deleteStory = async (storyId: string) => {
    const user = auth.currentUser;
    if (!user) throw new Error('Unauthenticated');
    
    const deleteStoryFn = httpsCallable(functions, 'deleteStory');
    try {
        await deleteStoryFn({ storyId });
    } catch (error: any) {
        console.warn("Cloud delete failed, trying client side:", error);
        await deleteDoc(doc(db, 'stories', storyId));
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
    }, { merge: true });
  } catch (err) {
    console.error("markStoryAsSeen error:", err);
  }
};

export const fetchStoryViewers = async (storyId: string) => {
    try {
        const viewsRef = collection(db, 'storyViews');
        const q = query(viewsRef, where('storyId', '==', storyId));
        const snapshot = await getDocs(q);
        
        const viewers = await Promise.all(snapshot.docs.map(async (vDoc) => {
            const data = vDoc.data();
            const userDoc = await getDoc(doc(db, 'users', data.viewerUid));
            const userData = userDoc.data();
            return {
                uid: data.viewerUid,
                username: userData?.username || 'Unknown',
                avatarUrl: userData?.profileImageUrl || `https://ui-avatars.com/api/?name=${userData?.username || 'U'}`,
                viewedAt: data.viewedAt,
                reaction: data.reaction || null
            };
        }));
        
        return viewers;
    } catch (error) {
        console.error("fetchStoryViewers error:", error);
        return [];
    }
};

export const createHighlight = async (name: string, coverImageUrl: string, storyIds: string[]) => {
    const user = auth.currentUser;
    if (!user) throw new Error('Unauthenticated');

    const highlightsRef = collection(db, 'users', user.uid, 'highlights');
    return await addDoc(highlightsRef, {
        name,
        coverImageUrl,
        storyIds,
        createdAt: serverTimestamp(),
    });
};

export const fetchUserHighlights = async (userId: string) => {
    try {
        const highlightsRef = collection(db, 'users', userId, 'highlights');
        const q = query(highlightsRef, orderBy('createdAt', 'desc'));
        const snapshot = await getDocs(q);
        
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data()
        }));
    } catch (error) {
        console.error("fetchUserHighlights error:", error);
        return [];
    }
};

export const addStoryToHighlight = async (highlightId: string, storyId: string) => {
    const user = auth.currentUser;
    if (!user) return;

    const highlightRef = doc(db, 'users', user.uid, 'highlights', highlightId);
    const highlightDoc = await getDoc(highlightRef);
    if (highlightDoc.exists()) {
        const storyIds = highlightDoc.data().storyIds || [];
        if (!storyIds.includes(storyId)) {
            await setDoc(highlightRef, { 
                storyIds: [...storyIds, storyId] 
            }, { merge: true });
        }
    }
};

export const fetchHighlightStories = async (userId: string, highlightId: string): Promise<UserStories | null> => {
    try {
        const highlightRef = doc(db, 'users', userId, 'highlights', highlightId);
        const highlightDoc = await getDoc(highlightRef);
        
        if (!highlightDoc.exists()) return null;
        
        const highlightData = highlightDoc.data();
        const storyIds = highlightData.storyIds || [];
        
        if (storyIds.length === 0) return null;

        const storiesRef = collection(db, 'stories');
        const q = query(storiesRef, where(documentId(), 'in', storyIds.slice(0, 10))); 
        const storiesSnapshot = await getDocs(q);
        
        const rawStories: any[] = [];
        storiesSnapshot.forEach(doc => {
            rawStories.push({
                id: doc.id,
                ...doc.data(),
                seen: true
            });
        });

        const userDoc = await getDoc(doc(db, 'users', userId));
        const userData = userDoc.data();

        return {
            userId,
            username: userData?.username || highlightData.name,
            avatarUrl: userData?.profileImageUrl || highlightData.coverImageUrl,
            stories: rawStories.sort((a, b) => (a.createdAt as any)?.seconds - (b.createdAt as any)?.seconds),
            hasUnseen: false
        };
    } catch (error) {
        console.error("fetchHighlightStories error:", error);
        return null;
    }
};

export const reactToStory = async (storyId: string, emoji: string) => {
    const user = auth.currentUser;
    if (!user) return;

    try {
        const viewRef = doc(db, 'storyViews', `${storyId}_${user.uid}`);
        await updateDoc(viewRef, {
            reaction: emoji,
            reactedAt: serverTimestamp()
        });
    } catch (err) {
        const viewRef = doc(db, 'storyViews', `${storyId}_${user.uid}`);
        await setDoc(viewRef, {
            viewerUid: user.uid,
            storyId,
            viewedAt: serverTimestamp(),
            reaction: emoji,
            reactedAt: serverTimestamp()
        });
    }
};

export const searchUsers = async (searchTerm: string) => {
    try {
        if (!searchTerm || searchTerm.length < 2) return [];
        
        const usersRef = collection(db, 'users');
        const q = query(
            usersRef, 
            where('username', '>=', searchTerm.toLowerCase()),
            where('username', '<=', searchTerm.toLowerCase() + '\uf8ff'),
            limit(5)
        );
        
        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({
            id: doc.id,
            username: doc.data().username,
            avatarUrl: doc.data().profileImageUrl
        }));
    } catch (error) {
        console.error("searchUsers error:", error);
        return [];
    }
};

// New function to fetch a specific user's stories by ID
export const fetchUserStoriesByUserId = async (userId: string): Promise<UserStories | null> => {
    try {
        const userDoc = await getDoc(doc(db, 'users', userId));
        if (!userDoc.exists()) return null;
        const userData = userDoc.data();

        const now = Timestamp.now();
        const storiesRef = collection(db, 'stories');
        const q = query(
            storiesRef,
            where('userId', '==', userId),
            orderBy('createdAt', 'desc'),
            limit(50)
        );
        const storiesSnapshot = await getDocs(q);

        if (storiesSnapshot.empty) return null;

        const stories: Story[] = [];
        const nowSeconds = now.seconds;

        storiesSnapshot.forEach(doc => {
            const data = doc.data();
            if (data.expiresAt && data.expiresAt.seconds > nowSeconds) {
                stories.push({ id: doc.id, ...data, seen: false } as Story);
            }
        });

        if (stories.length === 0) return null;

        return {
            userId,
            username: userData?.username || userData?.fullName || 'User',
            avatarUrl: userData?.profileImageUrl || `https://ui-avatars.com/api/?name=${userData?.username || 'U'}`,
            stories: stories.reverse(), // Newest last for playback
            hasUnseen: true
        };

    } catch (error) {
        console.error("fetchUserStoriesByUserId error:", error);
        return null;
    }
};

// Existing function to fetch a specific user's stories by username, now using fetchUserStoriesByUserId
export const fetchUserStoriesByUsername = async (username: string): Promise<UserStories | null> => {
    try {
        const usersRef = collection(db, 'users');
        const userQuery = query(usersRef, where('username', '==', username.toLowerCase()), limit(1));
        const userSnapshot = await getDocs(userQuery);

        if (userSnapshot.empty) return null;

        const userId = userSnapshot.docs[0].id;
        return await fetchUserStoriesByUserId(userId);

    } catch (error) {
        console.error("fetchUserStoriesByUsername error:", error);
        return null;
    }
};