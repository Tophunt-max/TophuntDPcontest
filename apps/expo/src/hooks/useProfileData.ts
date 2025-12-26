import { useQuery, useMutation, useQueryClient, useInfiniteQuery } from '@tanstack/react-query';
import { 
  doc, 
  getDoc, 
  setDoc,
  serverTimestamp,
  collection, 
  getDocs, 
  query, 
  where, 
  orderBy, 
  limit, 
  startAfter,
} from 'firebase/firestore';
import { firestore, functions } from '../services/firebase/initFirebase'; 
import { httpsCallable } from 'firebase/functions';
import { UserProfile, Post } from '../types/user';
import { useAuth } from '../services/auth'; 

export const useProfile = (userId: string) => {
  const { user: currentUser } = useAuth(); 

  return useQuery({
    queryKey: ['profile', userId],
    queryFn: async (): Promise<UserProfile> => {
      console.log("[useProfile] Fetching for:", userId);
      
      if (!userId) throw new Error("No User ID");

      const docRef = doc(firestore, 'users', userId);
      
      try {
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          return { uid: docSnap.id, ...docSnap.data() } as UserProfile;
        }

        if (currentUser && currentUser.uid === userId) {
          const newProfile: Omit<UserProfile, 'createdAt' | 'updatedAt'> = {
            uid: currentUser.uid,
            email: currentUser.email || '',
            username: currentUser.displayName?.replace(/\s+/g, '').toLowerCase() || `user_${userId.slice(0, 5)}`,
            fullName: currentUser.displayName || 'New User',
            profileImageUrl: currentUser.photoURL || '',
            bio: 'Hi there! I am new here.',
            isPrivate: false,
          };

          await setDoc(docRef, {
            ...newProfile,
            postsCount: 0,
            followersCount: 0,
            followingCount: 0,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          }, { merge: true });

          return { ...newProfile, uid: userId } as UserProfile;
        }

        throw new Error("User profile not found");
      } catch (err: any) {
        console.error("[useProfile] Error:", err);
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

export const useToggleFollow = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (targetUserId: string) => {
      if (!user) throw new Error("Authentication required");
      const toggleFollowFn = httpsCallable(functions, 'toggleFollow');
      return toggleFollowFn({ targetUserId });
    },
    onSuccess: (_, targetUserId) => {
      queryClient.invalidateQueries({ queryKey: ['profile', targetUserId] });
      queryClient.invalidateQueries({ queryKey: ['profile', user?.uid] });
    },
  });
};
