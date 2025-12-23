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
import { User } from 'firebase/auth';
import { useAuth } from '../services/auth'; 

export const useProfile = (userId: string) => {
  const queryClient = useQueryClient();
  const { user } = useAuth(); 

  return useQuery({
    queryKey: ['profile', userId],
    queryFn: async (): Promise<UserProfile> => {
      if (!userId) throw new Error("User ID is required.");

      const docRef = doc(firestore, 'users', userId);
      const docSnap = await getDoc(docRef);

      // If document exists, return it
      if (docSnap.exists()) {
        return { uid: docSnap.id, ...docSnap.data() } as UserProfile;
      }

      // If doc doesn't exist and the user is viewing their own profile, create it.
      if (!docSnap.exists() && user && user.uid === userId) {
        console.log(`User profile for ${userId} not found. Creating a new one.`);
        
        const newProfileData: Omit<UserProfile, 'createdAt' | 'updatedAt'> = {
            uid: user.uid,
            email: user.email || '',
            username: user.displayName || user.email?.split('@')[0] || `user${user.uid.slice(0, 5)}`,
            fullName: user.displayName || 'New User',
            profileImageUrl: user.photoURL,
            bio: 'Welcome to my profile!',
            postsCount: 0,
            followersCount: 0,
            followingCount: 0,
            isPrivate: false,
        };

        await setDoc(docRef, {
            ...newProfileData,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
        });
        
        console.log(`Successfully created new profile for ${userId}.`);

        const newDocSnap = await getDoc(docRef);
        if (!newDocSnap.exists()) {
             throw new Error("Failed to create and fetch user profile.");
        }
        return { uid: newDocSnap.id, ...newDocSnap.data() } as UserProfile;
      }
      
      throw new Error(`User profile for ${userId} not found.`);
    },
    enabled: !!user?.uid && !!userId,
    retry: 2,
  });
};

export const useUserPosts = (userId: string) => {
  return useInfiniteQuery({
    queryKey: ['userPosts', userId],
    queryFn: async ({ pageParam = null }) => {
      let q = query(
        collection(firestore, 'posts'),
        where('userId', '==', userId),
        orderBy('createdAt', 'desc'),
        limit(12)
      );

      if (pageParam) {
        q = query(q, startAfter(pageParam));
      }

      const snapshot = await getDocs(q);
      const posts: Post[] = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Post));
      const lastVisible = snapshot.docs[snapshot.docs.length - 1];
      
      return { posts, lastVisible };
    },
    getNextPageParam: (lastPage) => lastPage.lastVisible || undefined,
    initialPageParam: null,
    enabled: !!userId,
  });
};

export const useToggleFollow = () => {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const currentUserId = user?.uid;

  return useMutation({
    mutationFn: async (targetUserId: string) => {
      if (!currentUserId) throw new Error("User not authenticated.");
      const toggleFollowFn = httpsCallable(functions, 'toggleFollow');
      return toggleFollowFn({ targetUserId });
    },
    onSuccess: (_, targetUserId) => {
      // Invalidate queries to refetch data
      queryClient.invalidateQueries({ queryKey: ['profile', targetUserId] });
      queryClient.invalidateQueries({ queryKey: ['profile', currentUserId] });
    },
    onError: (error) => {
      console.error("Error toggling follow:", error);
    }
  });
};
