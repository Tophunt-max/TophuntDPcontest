import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { 
  doc, 
  getDoc, 
  collection, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit, 
  startAfter,
} from 'firebase/firestore';
import { firestore } from '../services/firebase/initFirebase'; 
import { UserProfile, Post } from '../types/user';
import { useAuth } from '../services/auth'; 
import { callApi } from '../services/api'; 

export const useProfile = (userId: string) => {
  const { user: currentUser } = useAuth(); 

  return useQuery({
    queryKey: ['profile', userId],
    queryFn: async (): Promise<UserProfile | null> => {
      console.log("[useProfile] Fetching for:", userId);
      
      if (!userId) return null;

      const docRef = doc(firestore, 'users', userId);
      
      try {
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          return { uid: docSnap.id, ...docSnap.data() } as UserProfile;
        }

        // REMOVED AUTO-CREATE LOGIC
        // Hooks should not perform write operations during a read query.
        // This was causing duplicate "New User" accounts to be created 
        // before the migration logic could finish.

        console.warn(`[useProfile] No document found for UID: ${userId}`);
        return null; 
      } catch (err: any) {
        console.error("[useProfile] Firestore Error:", err);
        throw err;
      }
    },
    enabled: !!userId,
  });
};

export const useUserPosts = (userId: string) => {
  return useInfiniteQuery({
    queryKey: ['userPosts', userId],
    queryFn: async ({ pageParam = null }) => {
      try {
        const postsRef = collection(firestore, 'posts');
        let q = query(
          postsRef,
          where('userId', '==', userId),
          orderBy('createdAt', 'desc'),
          limit(12)
        );

        if (pageParam) {
          q = query(q, startAfter(pageParam));
        }

        const snapshot = await getDocs(q);
        const posts: Post[] = snapshot.docs.map(doc => ({ 
          id: doc.id, 
          ...doc.data() 
        } as Post));
        
        const lastVisible = snapshot.docs[snapshot.docs.length - 1];
        return { posts, lastVisible };
      } catch (err) {
        return { posts: [], lastVisible: null };
      }
    },
    getNextPageParam: (lastPage) => lastPage.lastVisible || undefined,
    initialPageParam: null,
    enabled: !!userId,
  });
};

export const useUserBookmarks = (userId: string) => {
  return useQuery({
    queryKey: ['userBookmarks', userId],
    queryFn: async () => {
      try {
        const bookmarksRef = collection(firestore, `users/${userId}/bookmarks`);
        const snapshot = await getDocs(bookmarksRef);
        const matchIds = snapshot.docs.map(doc => doc.id);
        
        if (matchIds.length === 0) return [];

        const matches: any[] = [];
        const promises = matchIds.map(id => getDoc(doc(firestore, 'contestMatches', id)));
        const snaps = await Promise.all(promises);
        
        return snaps
            .filter(s => s.exists())
            .map(s => ({ id: s.id, ...s.data() }));
      } catch (err) {
        console.error("Error fetching bookmarks:", err);
        return [];
      }
    },
    enabled: !!userId,
  });
};

export const useToggleFollow = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (targetUserId: string) => {
      if (!user) throw new Error("Authentication required");
      return await callApi('toggleFollow', { targetUserId });
    },
    onSuccess: (_, targetUserId) => {
      queryClient.invalidateQueries({ queryKey: ['profile', targetUserId] });
      queryClient.invalidateQueries({ queryKey: ['profile', user?.uid] });
    },
  });
};
